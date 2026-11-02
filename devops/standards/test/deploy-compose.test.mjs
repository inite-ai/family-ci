// node --test devops/standards/test
// The family deploy (.github/workflows/deploy-compose.yml): the renderer
// (render.mjs), the host script (deploy.sh) against a fake docker that
// records every call, and the two rules that hold repos to its shape
// (lib/deploy-rules.mjs). Everything it writes is under the OS temp dir.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { edgeProblems, hostRewriteProblems, imageProblem, pinnedImageProblems } from '../lib/deploy-rules.mjs';
import { destroyProblems } from '../lib/host-safety.mjs';
import { deployProblems, sharedCalls } from '../lib/workflows.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, '../../..');
const action = path.join(shared, '.github/actions/deploy-compose');
const { envFile, parseDomains, parseEnv, renderCompose, writeEnvFile } = await import(path.join(action, 'render.mjs'));

const temps = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-deploy-compose-'));
  temps.push(d);
  return d;
};
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const RENT = {
  app: 'initerent',
  edge: 'initerent-r41-1',
  image: 'mikefluff/initerent:0123456789abcdef0123456789abcdef01234567',
  domains: 'inite.rent www.inite.rent',
  port: 3000,
  healthPath: '/api/version',
  volumes: 'uploads-data:/app/data',
  priority: 1762000000,
};

describe('render: the env file', () => {
  it('fills secrets, keeps literals, and refuses a missing required secret before anything changes', () => {
    const t = 'NODE_ENV=production\n# a comment\nDATABASE_URL=postgresql://${secrets.U}:${secrets.P}@postgres:5432/initerent\nCRON_SECRET=${secrets.CRON_SECRET?}\n';
    const ok = parseEnv(t, { U: 'orch', P: 'p$ss#1' });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.lines, [
      ['NODE_ENV', 'production'],
      ['DATABASE_URL', 'postgresql://orch:p$ss#1@postgres:5432/initerent'],
      ['CRON_SECRET', ''],
    ]);
    assert.match(parseEnv('A=${secrets.MISSING}', {}).problems[0], /MISSING is not set/);
    assert.match(parseEnv('A=1\nA=2', {}).problems[0], /set twice/);
    assert.match(parseEnv('not a line', {}).problems[0], /not KEY=value/);
    assert.match(parseEnv("A=${secrets.Q}", { Q: "it's" }).problems[0], /single quote/);
  });
  it('quotes every value so compose reads $ and # literally, and writes it 600', () => {
    const text = envFile([['P', 'p$ss #x']]);
    assert.match(text, /^P='p\$ss #x'$/m);
    const f = path.join(tmp(), '.env');
    writeEnvFile(f, text);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  });
});

describe('render: the compose file', () => {
  const { text, problems } = renderCompose(RENT);
  it('renders without problems', () => assert.deepEqual(problems, []));
  it('pins the image, keeps the container name, reads secrets from the env file', () => {
    assert.match(text, /image: "mikefluff\/initerent:0123456789abcdef/);
    assert.match(text, /container_name: "initerent"/);
    assert.match(text, /env_file:\n {6}- "\.env"/);
    assert.doesNotMatch(text, /environment:/);
  });
  it('reuses the family middlewares and never declares one', () => {
    assert.doesNotMatch(text, /traefik\.http\.middlewares\./);
    assert.match(text, /routers\.initerent-r41-1-http\.middlewares=redirect-to-https@file/);
    assert.match(text, /routers\.initerent-r41-1-www\.rule=Host\(`www\.inite\.rent`\)/);
    assert.match(text, /routers\.initerent-r41-1-www\.middlewares=www-to-apex@file/);
    assert.match(text, /routers\.initerent-r41-1\.rule=Host\(`inite\.rent`\)"/);
    assert.deepEqual(edgeProblems(text), []);
    assert.deepEqual(pinnedImageProblems(text), []);
  });
  it('the app volume keeps its name across deploys', () => {
    assert.match(text, /volumes:\n {2}uploads-data:\n {4}name: "initerent_uploads-data"\n {4}external: true/);
  });
  it('a $ in anything rendered is escaped from compose interpolation', () => {
    const r = renderCompose({ ...RENT, healthCommand: 'test -n "$HOME"' });
    assert.match(r.text, /\$\$HOME/);
  });
  it('refuses a moving tag, no tag, and a www twin of a host it does not serve', () => {
    assert.match(renderCompose({ ...RENT, image: 'mikefluff/initerent:latest' }).problems[0], /moving tag/);
    assert.match(renderCompose({ ...RENT, image: 'mikefluff/initerent' }).problems[0], /no tag/);
    assert.match(renderCompose({ ...RENT, domains: 'inite.rent www.inite.shop' }).problems[0], /not in the list/);
  });
  it('the first non-www host is canonical', () => {
    assert.equal(parseDomains('www.inite.rent inite.rent').canonical, 'inite.rent');
    assert.equal(parseDomains('auth.inite.ai').www.length, 0);
  });
});

// A docker that keeps containers as files and logs every call.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
S="$FAKE_STATE"; echo "$*" >> "$S/calls.log"
c() { [ -f "$S/c/$1" ]; }
case "$1" in
  compose)
    shift
    [ "$1" = version ] && exit 0
    proj=""; file=""
    while [ $# -gt 0 ]; do case "$1" in -p) proj=$2; shift 2 ;; -f) file=$2; shift 2 ;; *) break ;; esac; done
    case "$1" in
      up)
        [ "$2" = --help ] && { echo "  --wait  Wait for services"; exit 0; }
        [ "\${UP_EXIT:-0}" = 0 ] || exit 1
        img=$(sed -n 's/^    image: "\(.*\)"$/\1/p' "$file")
        printf '%s\n%s\nid-%s\n' "$img" "$proj" "$proj" > "$S/c/$APP"; exit 0 ;;
      run) exit "\${MIGRATE_EXIT:-0}" ;;
      down) c "$APP" && [ "$(sed -n 2p "$S/c/$APP")" = "$proj" ] && rm -f "$S/c/$APP"; exit 0 ;;
      logs) exit 0 ;;
    esac ;;
  network) exit 0 ;;
  inspect)
    [ "$2" = -f ] || exit 1
    name=$4
    case "$3" in
      *State.Running*) [ "$name" = traefik-global ] && echo true; exit 0 ;;
      *Config.Image*) c "$name" && sed -n 1p "$S/c/$name" && exit 0; exit 1 ;;
      *.Image*) echo "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"; exit 0 ;;
    esac ;;
  container) c "$3"; exit $? ;;
  exec)
    if [ "$2" = traefik-global ]; then cat "$S/edge.yml" 2>/dev/null; exit 0; fi
    img=$(sed -n 1p "$S/c/$2"); echo "{\"sha\":\"\${VERSION_SAYS:-\${img##*:}}\"}"; exit 0 ;;
  ps) for f in "$S"/c/"$APP"*; do [ -f "$f" ] && sed -n 3p "$f"; done; exit 0 ;;
  rename) mv "$S/c/$2" "$S/c/$3"; exit 0 ;;
  stop) exit 0 ;;
  rm) for f in "$S"/c/*; do [ "$(sed -n 3p "$f")" = "$2" ] && rm -f "$f"; done; exit 0 ;;
  images) cat "$S/images" 2>/dev/null; exit 0 ;;
  volume|tag|pull|rmi|image) exit 0 ;;
esac
exit 0
`.replaceAll('\\${', '${');

const EDGE = fs.readFileSync(path.join(shared, 'devops/host/traefik/family-edge.yml'), 'utf8');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function host({ edge = EDGE, running = 'mikefluff/initerent:latest' } = {}) {
  const root = tmp();
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(state, 'c'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/docker'), FAKE_DOCKER, { mode: 0o755 });
  if (edge) fs.writeFileSync(path.join(state, 'edge.yml'), edge);
  if (running) fs.writeFileSync(path.join(state, 'c/initerent'), `${running}\niniterent\nid-heredoc\n`);
  // A heredoc deploy left secrets in a world-readable compose file.
  fs.mkdirSync(path.join(root, 'projects/initerent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects/initerent/docker-compose.yml'), 'services: {} # AUTH_SECRET=s3cret\n', { mode: 0o644 });
  const run = (cmd, env = {}) =>
    spawnSync('bash', [path.join(action, 'deploy.sh'), cmd], {
      encoding: 'utf8',
      env: {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        FAKE_STATE: state,
        DEPLOY_ROOT: path.join(root, 'projects'),
        APP: 'initerent',
        IMAGE: 'mikefluff/initerent',
        SHA,
        DOMAINS: 'inite.rent www.inite.rent',
        PORT: '3000',
        VOLUMES: 'uploads-data:/app/data',
        VERSION_PATH: '/api/version',
        EDGE_SUFFIX: 'r41-1',
        SETTLE_SECONDS: '0',
        ENV_TEMPLATE: 'NODE_ENV=production\nAUTH_SECRET=${secrets.AUTH_SECRET}',
        SECRETS_JSON: JSON.stringify({ AUTH_SECRET: 's3cret' }),
        ...env,
      },
    });
  const dir = path.join(root, 'projects/initerent');
  const calls = () => fs.readFileSync(path.join(state, 'calls.log'), 'utf8');
  const live = () => (fs.existsSync(path.join(state, 'c/initerent')) ? fs.readFileSync(path.join(state, 'c/initerent'), 'utf8').split('\n')[0] : null);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
  return { run, dir, calls, live, read, state };
}

describe('deploy.sh against a fake docker', () => {
  it('stops before touching anything when the edge middlewares are not installed', () => {
    const h = host({ edge: 'http:\n  routers: {}\n' });
    const r = h.run('deploy');
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /family-edge\.yml/);
    assert.doesNotMatch(h.calls(), /\b(?:pull|rename|compose -p)\b/);
    assert.equal(h.live(), 'mikefluff/initerent:latest');
  });

  it('first run: the old heredoc container keeps serving until the new one is healthy and reports the commit, then retires', () => {
    const h = host();
    const r = h.run('deploy');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(h.live(), `mikefluff/initerent:${SHA}`);
    const calls = h.calls();
    // renamed (still running), new one up, only then the old one stopped
    const rename = calls.indexOf('rename initerent initerent-retiring-');
    const up = calls.indexOf('compose -p initerent-r41-1 -f docker-compose.yml up -d --wait');
    const stop = calls.indexOf('stop -t 30 id-heredoc');
    assert.ok(rename >= 0 && up > rename && stop > up, calls);
    assert.doesNotMatch(calls, /prune|--remove-orphans|down -v/);
    // the moving tag it ran is pinned by image id for a rollback
    assert.match(h.read('.previous'), /^mikefluff\/initerent:pre-abcdef012345$/m);
    assert.equal(h.read('.deployed').trim(), `mikefluff/initerent:${SHA}`);
    // secrets: in .env (600) only; the old world-readable compose is gone
    assert.equal(fs.statSync(path.join(h.dir, '.env')).mode & 0o777, 0o600);
    assert.match(h.read('.env'), /AUTH_SECRET='s3cret'/);
    assert.doesNotMatch(h.read('docker-compose.yml'), /s3cret/);
    assert.equal(h.read('docker-compose.prev.yml'), null);
  });

  it('a new container that never gets healthy goes; the old one gets its name back and the files are restored', () => {
    const h = host();
    const r = h.run('deploy', { UP_EXIT: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(h.live(), 'mikefluff/initerent:latest');
    assert.doesNotMatch(h.calls(), /stop -t 30/);
    assert.match(h.read('docker-compose.yml'), /AUTH_SECRET=s3cret/); // what was there before, untouched in content
    assert.equal(h.read('.deployed'), null);
  });

  it('a container that answers with another commit is not kept', () => {
    const h = host();
    const r = h.run('deploy', { VERSION_SAYS: 'ffffffff' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /does not report/);
    assert.equal(h.live(), 'mikefluff/initerent:latest');
  });

  it('a failed migration changes nothing', () => {
    const h = host();
    const r = h.run('deploy', { MIGRATE: 'sh scripts/deploy/deploy-db.sh', MIGRATE_EXIT: '3' });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(h.calls(), /rename|up -d/);
    assert.equal(h.live(), 'mikefluff/initerent:latest');
  });

  it('a required secret that is not set stops it before the image is pulled', () => {
    const h = host();
    const r = h.run('deploy', { SECRETS_JSON: '{}' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /AUTH_SECRET is not set/);
    assert.doesNotMatch(h.calls(), /\bpull\b/);
  });

  it('rollback after a failed verify brings the previous image back, and refuses when production moved on', () => {
    const h = host();
    assert.equal(h.run('deploy').status, 0);
    const r = h.run('rollback', { EDGE_SUFFIX: 'r41-1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(h.live(), 'mikefluff/initerent:pre-abcdef012345');
    assert.equal(h.read('.deployed').trim(), 'mikefluff/initerent:pre-abcdef012345');
    const again = h.run('rollback');
    assert.notEqual(again.status, 0);
    assert.match(again.stdout, /someone deployed since|not mikefluff/);
  });

  it('cleanup removes only this app\'s images beyond the newest three, never the live or previous one', () => {
    const h = host();
    fs.writeFileSync(path.join(h.state, 'images'), ['a', 'b', 'c', 'd', 'pre-abcdef012345'].map((t) => `mikefluff/initerent:${t}`).join('\n'));
    assert.equal(h.run('deploy').status, 0);
    const rmi = h.calls().split('\n').filter((l) => l.startsWith('rmi'));
    assert.deepEqual(rmi, ['rmi mikefluff/initerent:d']);
  });
});

describe('the shared files pass the family rules themselves', () => {
  const files = ['.github/workflows/deploy-compose.yml', '.github/actions/deploy-compose/deploy.sh', '.github/actions/deploy-compose/action.yml', '.github/workflows/verify-deploy.yml'];
  for (const f of files) {
    it(f, () => {
      const text = fs.readFileSync(path.join(shared, f), 'utf8');
      assert.deepEqual(destroyProblems(text, { repoName: 'inite-shared' }), []);
      assert.deepEqual(pinnedImageProblems(text), []);
      assert.deepEqual(edgeProblems(text), []);
    });
  }
  it('bash -n deploy.sh', () => execFileSync('bash', ['-n', path.join(action, 'deploy.sh')]));
});

// initerent's deploy.yml before deploy-compose (01.11.2026), the lines that matter.
const RENT_HEREDOC = String.raw`
    - name: Build and push Docker image (sha-tagged only)
      uses: ./inite-shared/.github/actions/docker-build-push
      with:
        image: $\{{ secrets.DOCKERHUB_USERNAME }}/initerent
        tag: $\{{ github.sha }}
    - name: Deploy to server
      run: |
        tee docker-compose.yml > /dev/null << EOF
        services:
          $\{{ env.PROJECT_NAME }}:
            image: $\{{ secrets.DOCKERHUB_USERNAME }}/initerent:latest
            labels:
              - "traefik.http.routers.$\{{ env.PROJECT_NAME }}.rule=Host(\`$\{{ env.DOMAIN }}\`) || Host(\`www.$\{{ env.DOMAIN }}\`)"
              - "traefik.http.routers.$\{{ env.PROJECT_NAME }}-http.middlewares=redirect-to-https"
              - "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https"
        EOF
        docker pull $\{{ secrets.DOCKERHUB_USERNAME }}/initerent:latest
        docker run --rm --network traefik-global \
          -e DATABASE_URL="x" \
          $\{{ secrets.DOCKERHUB_USERNAME }}/initerent:latest \
          sh scripts/deploy/deploy-db.sh
`.replaceAll('$\\{', '${');

describe('deploy-pinned-image', () => {
  it('finds :latest in a heredoc compose, a pull and a run; an action input `image:` is not a deploy', () => {
    const p = pinnedImageProblems(RENT_HEREDOC);
    assert.deepEqual(
      p.map((x) => x.line),
      [12, 18, 19],
    );
  });
  it('a commit, a version, a digest or a variable passes; no tag and a moving tag do not', () => {
    for (const ok of ['${{ secrets.DOCKERHUB_USERNAME }}/initeai:${{ github.sha }}', 'postgres:14', 'pgvector/pgvector:pg14', '${IMAGE}', 'x/y@sha256:abc', '"${{ inputs.postgres && \'postgres:16-alpine\' || \'\' }}"'])
      assert.equal(imageProblem(ok), null, ok);
    for (const bad of ['mikefluff/initerent:latest', 'ghcr.io/berriai/litellm:main-latest', 'temporalio/ui:latest', 'redis', 'mikefluff/initeservices']) assert.ok(imageProblem(bad), bad);
  });
  it('a marked line passes', () => {
    assert.deepEqual(pinnedImageProblems('# deploy-pinned: the dev stack only, never on the host\nimage: redis\n'), []);
  });
});

describe('canonical-host', () => {
  it('flags the per-container redirect-to-https, a router using it, and a router serving www itself', () => {
    const p = edgeProblems(RENT_HEREDOC).map((x) => x.problem);
    assert.equal(p.length, 3, p.join('\n'));
    assert.ok(p.some((x) => /serves www itself/.test(x)));
    assert.ok(p.some((x) => /uses redirect-to-https; use redirect-to-https@file/.test(x)));
    assert.ok(p.some((x) => /declares redirect-to-https on a container/.test(x)));
  });
  it('a www router through www-to-apex@file passes', () => {
    const ok = '- "traefik.http.routers.x-www.rule=Host(`www.inite.rent`)"\n- "traefik.http.routers.x-www.middlewares=www-to-apex@file"\n';
    assert.deepEqual(edgeProblems(ok), []);
  });
  it('an app that rewrites the host in its middleware is flagged (31.10.2026, :3000)', () => {
    const club = "const url = request.nextUrl.clone();\nurl.host = hostname.replace('www.', '');\nreturn NextResponse.redirect(url, 301);\n";
    assert.equal(hostRewriteProblems(club).length, 1);
    assert.deepEqual(hostRewriteProblems("if (url.host === 'x') {}\n"), []);
  });
});

describe('deploy-on-release with deploy-compose', () => {
  it('calling deploy-compose.yml counts as calling verify', () => {
    const wf = `on:\n  release:\n    types: [published]\n  workflow_dispatch:\nconcurrency:\n  group: deploy-production\njobs:\n  gate:\n    uses: inite-ai/inite-shared/.github/workflows/release-gate.yml@main\n  deploy:\n    uses: inite-ai/inite-shared/.github/workflows/deploy-compose.yml@main\n`;
    assert.ok(sharedCalls(wf).has('deploy-compose.yml'));
    assert.deepEqual(deployProblems('deploy.yml', wf), []);
  });
});
