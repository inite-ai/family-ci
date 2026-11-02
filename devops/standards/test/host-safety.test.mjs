// node --test devops/standards/test
// deploy-no-host-wide-destroy (lib/host-safety.mjs): a deploy on the shared
// host removes only what it created. Pure functions, plus one throwaway repo
// under the OS temp dir for the rule as `check` runs it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { check, mayStillAddDebt } from '../lib/checks.mjs';
import { deployFiles, destroyProblems } from '../lib/host-safety.mjs';
import { loadRepo } from '../lib/repo.mjs';

const ctx = { repoName: 'initeshop' };
const problems = (text, c = ctx) => destroyProblems(text, c).map((p) => p.problem);
const refused = (text, c) => assert.equal(problems(text, c).length, 1, `should refuse:\n${text}\ngot ${JSON.stringify(problems(text, c))}`);
const allowed = (text, c) => assert.deepEqual(problems(text, c), [], `should allow:\n${text}`);

describe('host-wide prune is refused', () => {
  it('system, container, volume and network prune, with any flags', () => {
    for (const cmd of [
      'docker system prune -f',
      'docker system prune -af --volumes',
      '        docker system prune -f || true',
      'run: docker system prune -f',
      'docker container prune -f',
      'docker container prune -f --filter "until=24h"',
      'docker volume prune -f',
      'docker network prune -f || true',
      'sudo docker system prune -f',
    ])
      refused(cmd);
  });
  it('image prune without a label filter, whatever else it filters on', () => {
    refused('docker image prune -f');
    refused('docker image prune -af');
    refused('docker image prune -af --filter "until=72h" || true');
    refused('docker image prune -a -f --filter until=24h');
  });
  it('builder prune without a filter', () => {
    refused('docker builder prune -a -f');
  });
  it('the line where it starts is the line reported', () => {
    const wf = ['jobs:', '  d:', '    steps:', '      - run: |', '          echo cleanup', '          docker system prune -f'].join('\n');
    assert.deepEqual(destroyProblems(wf, ctx).map((p) => p.line), [6]);
  });
});

describe('compose down', () => {
  it('-v, --volumes and --remove-orphans are refused, both spellings of compose', () => {
    for (const cmd of [
      'docker-compose down --remove-orphans',
      'docker compose down --remove-orphans 2>/dev/null || true',
      'docker compose down -v',
      'docker-compose -f deploy/docker-compose.prod.yml down --volumes 2>/dev/null || true',
      'docker compose -f docker-compose.test.yml down -v --remove-orphans',
      'docker-compose -p "$EDGE" down --remove-orphans',
    ])
      refused(cmd);
  });
  it('plain down, and a down followed by another command with -v, are fine', () => {
    allowed('docker-compose down');
    allowed('docker compose -p initeshop down || true');
    allowed('docker-compose down && docker images -v');
  });
});

describe('rm of what the repo owns', () => {
  it('its own containers, by literal name or by the PROJECT_NAME it sets', () => {
    allowed('docker rm -f initeshop');
    allowed('docker rm -f initeshop-worker 2>/dev/null || true');
    allowed('env:\n  PROJECT_NAME: smart-chat-admin\n  x: |\n    docker rm -f ${{ env.PROJECT_NAME }} || true', { repoName: 'break3-admin' });
    allowed('PROJECT_NAME=shop\ndocker rm -f "$PROJECT_NAME-worker"', ctx);
    allowed('docker run -d --name ci-pg-$RUN postgres:16\ndocker rm -f "ci-pg-$RUN"', ctx);
    allowed('docker rm -f "authmig-$$-pg"\n# made by: docker run --name "authmig-$$-pg" postgres', ctx);
  });
  it('the shared services and other repos are refused', () => {
    refused('docker rm -f postgres');
    refused('docker rm -f redis');
    refused('docker rm -f traefik-global');
    refused('docker rm -f initeai');
    refused('docker volume rm inite-temporal_postgres-data');
    refused('docker rmi postgres:14');
    // a name guess does not make the shared database ours
    refused('env:\n  DB_CONTAINER: postgres\nrun: docker rm -f $DB_CONTAINER');
  });
  it('a name it cannot read is refused unless the line says why it is ours', () => {
    refused('for id in $OLD_IDS; do docker stop "$id" && docker rm "$id"; done');
    allowed('# deploy-owns: OLD_IDS are this project\'s own containers, filtered by its compose label above\nfor id in $OLD_IDS; do docker stop "$id" && docker rm "$id"; done');
    refused('# deploy-owns: ok\ndocker rm "$id"'); // a reason, not a word
  });
  it('a list is fine when it is filtered to the repo, refused when it is not', () => {
    allowed('docker ps -aq --filter "name=^initeshop" --filter "status=exited" | xargs -r docker rm');
    allowed('docker ps -aq --filter "label=com.docker.compose.project=initeshop" | xargs -r docker rm -f');
    allowed('docker images ${{ secrets.DOCKERHUB_USERNAME }}/initeshop --format "{{.Tag}}" | tail -n +4 | xargs -r -I{} docker rmi x/initeshop:{}');
    allowed('IMAGE: ${{ secrets.DOCKERHUB_USERNAME }}/initeshop\nrun: docker images $IMAGE --format x | xargs -r docker rmi');
    allowed('docker rm -f $(docker ps -aq --filter "name=^initeshop-")');
    allowed('docker images --filter "reference=*/initeshop" --format x | tail -n +4 | xargs -r docker rmi 2>/dev/null || true');
    refused('docker ps -aq --filter "status=exited" | xargs -r docker rm');
    refused('docker rm -f $(docker ps -aq)');
    refused('docker images -q | xargs docker rmi');
    refused('docker volume ls -qf dangling=true | xargs -r docker volume rm');
    refused('docker volume ls -qf dangling=true --filter name=initeshop | xargs -r docker volume rm');
  });
  it('the scoped cleanup the family uses instead of prune passes', () => {
    const cleanup = [
      'env:',
      '  IMAGE: ${{ secrets.DOCKERHUB_USERNAME }}/initeshop',
      'run: |',
      "  docker images \"$IMAGE\" --format '{{if eq .Tag \"<none>\"}}{{.ID}}{{else}}{{.Repository}}:{{.Tag}}{{end}}' \\",
      '    | tail -n +4 | xargs -r docker rmi 2>/dev/null || true',
      '  docker image prune -f --filter "label=org.opencontainers.image.title=initeshop" --filter "until=72h"',
      '  docker builder prune -f --filter "until=72h"',
    ].join('\n');
    allowed(cleanup);
  });
  it('an image the file deploys is its own, whatever the repo is called; postgres beside it is not', () => {
    const c = { repoName: 'initeeducation-landing' };
    const compose = '            image: ${{ secrets.DOCKERHUB_USERNAME }}/initeeducation:latest\n            image: postgres:14\n';
    allowed(`${compose}        docker images "\${{ secrets.DOCKERHUB_USERNAME }}/initeeducation" --format x | tail -n +4 | xargs -r docker rmi || true`, c);
    refused(`${compose}        docker rmi postgres:14`, c);
    refused('        docker images "${{ secrets.DOCKERHUB_USERNAME }}/initeeducation" --format x | xargs -r docker rmi', c);
  });
  it('comments and prose about prune are not commands', () => {
    allowed('# `docker system prune -f` deleted the shared postgres on 25.10');
    allowed("        # docker system prune would remove the stopped postgres; we don't");
  });
});

describe('which files are a deploy', () => {
  it('workflows, composite actions and shell scripts; not tests or vendored code', () => {
    assert.deepEqual(
      deployFiles([
        '.github/workflows/deploy.yml',
        '.github/actions/cleanup/action.yml',
        'deploy.sh',
        'scripts/cleanup-and-restart.sh',
        'scripts/test.sh',
        'tests/e2e/up.sh',
        'node_modules/x/deploy.sh',
        'inite-shared/devops/scripts/x.sh',
        'src/index.ts',
      ]),
      ['.github/workflows/deploy.yml', '.github/actions/cleanup/action.yml', 'deploy.sh', 'scripts/cleanup-and-restart.sh'],
    );
  });
});

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(name, files) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inite-host-')), name);
  made.push(path.dirname(dir));
  fs.mkdirSync(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  g('add', '-A');
  return dir;
}

describe('the rule in check', () => {
  const run = (dir) => check(loadRepo(dir), { only: ['deploy-no-host-wide-destroy'] }).results[0];
  it('fails with file:line, and cannot be carried as debt', () => {
    const dir = repoWith('initeshop', {
      '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { 'deploy-no-host-wide-destroy': 'we will get to it later' } }),
      '.github/workflows/deploy.yml': 'jobs:\n  d:\n    steps:\n      - run: docker system prune -f\n',
    });
    const r = run(dir);
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join('\n'), /\.github\/workflows\/deploy\.yml:4: docker system prune/);
    assert.match(r.problems.join('\n'), /cannot be carried as debt/);
  });
  it('passes a repo that removes only its own images', () => {
    const dir = repoWith('initeshop', {
      '.inite/standards.json': JSON.stringify({ profile: 'next' }),
      '.github/workflows/deploy.yml': "jobs:\n  d:\n    steps:\n      - run: docker images x/initeshop --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi || true\n",
    });
    assert.equal(run(dir).status, 'ok');
  });
  it('host.owns names a shared service the repo really runs', () => {
    const files = { '.github/workflows/ops.yml': 'run: docker volume rm inite-temporal_surrealdb-data-v3\n' };
    assert.equal(run(repoWith('content-generator', { ...files, '.inite/standards.json': JSON.stringify({ profile: 'next' }) })).status, 'fail');
    assert.equal(run(repoWith('content-generator', { ...files, '.inite/standards.json': JSON.stringify({ profile: 'next', host: { owns: ['inite-temporal_surrealdb-data-v3'] } }) })).status, 'ok');
  });
});

describe('compose up --remove-orphans (01.11.2026)', () => {
  it('is refused like down --remove-orphans, both spellings of compose', () => {
    refused('docker-compose up -d --remove-orphans');
    refused('docker compose -f compose.yml up -d --remove-orphans --wait');
    refused('docker compose -p initeshop up -d --remove-orphans');
  });
  it('plain up, and up beside another command with the flag, are fine', () => {
    allowed('docker compose up -d --wait');
    allowed('docker-compose up -d && echo --remove-orphans');
  });
  it('may be carried as debt until the date in family.json; a prune beside it may not', () => {
    const debt = JSON.stringify({ profile: 'next', debt: { 'deploy-no-host-wide-destroy': 'the deploy drops --remove-orphans in its own PR' } });
    const runIt = (dir) => check(loadRepo(dir), { only: ['deploy-no-host-wide-destroy'] }).results[0];
    const up = repoWith('bloomcheck', { '.inite/standards.json': debt, '.github/workflows/deploy.yml': 'run: docker compose up -d --remove-orphans\n' });
    assert.equal(runIt(up).status, 'debt');
    const both = repoWith('bloomcheck', { '.inite/standards.json': debt, '.github/workflows/deploy.yml': 'run: docker compose up -d --remove-orphans\nrun: docker system prune -f\n' });
    assert.equal(runIt(both).status, 'fail');
    assert.equal(mayStillAddDebt('deploy-no-host-wide-destroy', '2026-11-30'), true);
    assert.equal(mayStillAddDebt('deploy-no-host-wide-destroy', '2026-12-01'), false);
  });
});
