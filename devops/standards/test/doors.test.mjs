// node --test devops/standards/test
// deploy-every-door (lib/doors.mjs) and the door half of deployWorkflows
// (lib/repo.mjs): every workflow that reaches the host is a deploy, gated.
// Fixtures are throwaway repos under the OS temp dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { check, mayStillAddDebt } from '../lib/checks.mjs';
import { deployWorkflows, loadRepo } from '../lib/repo.mjs';
import { reachesHost, stagingTouchesDb } from '../lib/workflows.mjs';

const GATED = `name: Deploy
on:
  release:
    types: [published]
  workflow_dispatch:
concurrency:
  group: deploy-production
  cancel-in-progress: false
jobs:
  gate:
    uses: inite-ai/inite-shared/.github/workflows/release-gate.yml@main
  deploy:
    needs: gate
    runs-on: [self-hosted, sfo]
    steps:
      - run: docker-compose up -d
  verify:
    needs: deploy
    uses: inite-ai/inite-shared/.github/workflows/verify-deploy.yml@main
`;

// The shape of the nine manual-deploy.yml files removed on 01.11.2026.
const MANUAL = `name: Manual Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [production, staging]
jobs:
  deploy:
    runs-on: [self-hosted, sfo]
    environment: \${{ inputs.environment }}
    steps:
      - run: |
          cat > docker-compose.yml <<EOF
            DATABASE_URL: postgresql://u:p@postgres:5432/initetraining
          EOF
          docker run --rm x npx prisma migrate deploy
          docker-compose up -d
`;

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-doors-'));
  made.push(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore', env });
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', env });
  return dir;
}

const cfg = (c = {}) => JSON.stringify({ profile: 'next', ...c });
const run = (files) => check(loadRepo(repoWith(files)), { only: ['deploy-every-door'] }).results[0];

describe('what reaches the host', () => {
  it('a self-hosted job, inline or as a list', () => {
    assert.equal(reachesHost('jobs:\n  d:\n    runs-on: [self-hosted, sfo]\n'), true);
    assert.equal(reachesHost('jobs:\n  d:\n    runs-on: self-hosted\n'), true);
    assert.equal(reachesHost('jobs:\n  d:\n    runs-on:\n      - self-hosted\n      - sfo\n'), true);
  });
  it('a deploy over ssh, scp, rsync or an ssh action', () => {
    assert.equal(reachesHost('      - run: ssh -i key root@143.198.50.15 "docker compose up -d"\n'), true);
    assert.equal(reachesHost('      - run: scp compose.yml deploy@$HOST:/opt/projects/x/\n'), true);
    assert.equal(reachesHost('      - run: rsync -az dist/ deploy@host:/srv/x\n'), true);
    assert.equal(reachesHost('      - uses: appleboy/ssh-action@v1\n'), true);
  });
  it('a hosted runner, ssh to GitHub and comments are not', () => {
    assert.equal(reachesHost('jobs:\n  ci:\n    runs-on: ubuntu-latest\n'), false);
    assert.equal(reachesHost('      - run: ssh-keyscan github.com >> ~/.ssh/known_hosts\n      - run: git config core.sshCommand "ssh -i ~/.ssh/k"\n'), false);
    assert.equal(reachesHost('      - run: ssh -T git@github.com || true\n'), false);
    assert.equal(reachesHost('# runs-on: [self-hosted, sfo]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n'), false);
  });
  it('staging that reaches a database', () => {
    assert.equal(stagingTouchesDb(MANUAL), true);
    assert.equal(stagingTouchesDb('options: [production, staging]\nrun: docker-compose up -d\n'), false);
  });
});

describe('deployWorkflows', () => {
  it('adds a door of any name that listens for a release, not one that does not', () => {
    const dir = repoWith({
      '.inite/standards.json': cfg({ deploy: { workflows: ['deploy.yml'] } }),
      '.github/workflows/deploy.yml': GATED,
      '.github/workflows/ship-worker.yml': GATED,
      '.github/workflows/manual-deploy.yml': MANUAL,
      '.github/workflows/ci.yml': 'on: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n',
    });
    assert.deepEqual(deployWorkflows(loadRepo(dir)), ['deploy.yml', 'ship-worker.yml']);
  });
  it('without config: the deploy*.yml files, as before', () => {
    const dir = repoWith({ '.inite/standards.json': cfg(), '.github/workflows/deploy.yml': GATED });
    assert.deepEqual(deployWorkflows(loadRepo(dir)), ['deploy.yml']);
  });
});

describe('the rule in check', () => {
  it('passes a repo whose only door is the gated deploy', () => {
    assert.equal(run({ '.inite/standards.json': cfg(), '.github/workflows/deploy.yml': GATED }).status, 'ok');
  });
  it('fails a manual-deploy.yml: no release, gate, verify or concurrency, and staging on a real database', () => {
    const r = run({ '.inite/standards.json': cfg(), '.github/workflows/deploy.yml': GATED, '.github/workflows/manual-deploy.yml': MANUAL });
    assert.equal(r.status, 'fail');
    const text = r.problems.join('\n');
    for (const want of [/dispatch-only staging/, /does not listen for release/, /release-gate\.yml/, /verify-deploy\.yml/, /concurrency/]) assert.match(text, want);
  });
  it('a door hidden by deploy.workflows is still checked', () => {
    const ungated = 'on:\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: [self-hosted, sfo]\n    steps:\n      - run: docker compose up -d\n';
    const r = run({ '.inite/standards.json': cfg({ deploy: { workflows: ['deploy.yml'] } }), '.github/workflows/deploy.yml': GATED, '.github/workflows/deploy-gateway.yml': ungated });
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join('\n'), /deploy-gateway\.yml does not call inite-shared's release-gate\.yml/);
  });
  it('an ungated door may be carried as debt, staging on a database may not', () => {
    const ungated = 'on:\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: [self-hosted, sfo]\n    steps:\n      - run: docker compose up -d\n';
    const debt = { debt: { 'deploy-every-door': 'the gateway deploy moves onto the release path in its own PR' } };
    // (a deploy*.yml is already held by deploy-on-release; this door has another name)
    assert.equal(run({ '.inite/standards.json': cfg(debt), '.github/workflows/deploy.yml': GATED, '.github/workflows/ops-gateway.yml': ungated }).status, 'debt');
    const r = run({ '.inite/standards.json': cfg(debt), '.github/workflows/deploy.yml': GATED, '.github/workflows/manual-deploy.yml': MANUAL });
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join('\n'), /cannot be carried as debt/);
  });
  it('host.ops exempts a read-only diagnostic with a reason, never one that deploys', () => {
    const diag = 'on:\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: [self-hosted, sfo]\n    steps:\n      - run: docker logs inite-gateway --tail 200\n';
    const base = { '.github/workflows/deploy.yml': GATED, '.github/workflows/ops-diag.yml': diag };
    assert.equal(run({ ...base, '.inite/standards.json': cfg({ host: { ops: { 'ops-diag.yml': 'reads gateway logs; changes nothing on the host' } } }) }).status, 'ok');
    assert.match(run({ ...base, '.inite/standards.json': cfg({ host: { ops: { 'ops-diag.yml': 'ok' } } }) }).problems.join('\n'), /needs its reason/);
    const migrate = { '.github/workflows/deploy.yml': GATED, '.github/workflows/ops-migrate.yml': diag.replace('docker logs inite-gateway --tail 200', 'docker run --rm x npx prisma migrate deploy') };
    assert.match(run({ ...migrate, '.inite/standards.json': cfg({ host: { ops: { 'ops-migrate.yml': 'migrates the gateway store by hand' } } }) }).problems.join('\n'), /not read-only ops/);
  });
  it('a repo may record the gap until the date in family.json, not after', () => {
    assert.equal(mayStillAddDebt('deploy-every-door', '2026-11-01'), true);
    assert.equal(mayStillAddDebt('deploy-every-door', '2026-12-01'), false);
  });
});

// ci-off-the-host (lib/doors.mjs): 06.11.2026 a pull request's E2E on the
// host's runner swapped the production host to a stop.
import { prOnHostProblems, PR_HOST_RULE } from '../lib/doors.mjs';

describe('a pull request is tested off the host', () => {
  const job = (runsOn) => `jobs:\n  e2e:\n    runs-on: ${runsOn}\n    steps:\n      - run: pnpm build\n`;
  it('refuses a pull_request workflow with a self-hosted job, in either runs-on form', () => {
    assert.equal(prOnHostProblems('e2e.yml', `on:\n  pull_request:\n  push:\n    branches: [main]\n${job('[self-hosted, sfo]')}`).length, 1);
    assert.equal(prOnHostProblems('e2e.yml', `on: [pull_request]\njobs:\n  e2e:\n    runs-on:\n      - self-hosted\n      - sfo\n`).length, 1);
    assert.equal(prOnHostProblems('t.yml', `on:\n  pull_request_target:\n${job('self-hosted')}`).length, 1);
  });
  it('lets a pull request run on GitHub, and a deploy run on the host', () => {
    assert.deepEqual(prOnHostProblems('e2e.yml', `on:\n  pull_request:\n${job('ubuntu-latest')}`), []);
    assert.deepEqual(prOnHostProblems('deploy.yml', `on:\n  release:\n    types: [published]\n${job('[self-hosted, sfo]')}`), []);
    // A commented-out runner is not a runner.
    assert.deepEqual(prOnHostProblems('e2e.yml', `on:\n  pull_request:\njobs:\n  e2e:\n    # runs-on: [self-hosted, sfo]\n    runs-on: ubuntu-latest\n`), []);
  });
  it('is never carried as debt', () => {
    assert.equal(PR_HOST_RULE.debtable(['anything']), false);
  });
});
