// node --test devops/standards/test
// The family env rules on throwaway repos.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { check, FAMILY, mayStillAddDebt, warnsOnly } from '../lib/checks.mjs';
import { buildArgs, ENV_RULES, isSecretName, isServerFile, LEGACY_ALIASES, scanSharedReads, SHARED_ENV } from '../lib/env-rules.mjs';
import { loadRepo } from '../lib/repo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-env-'));
  made.push(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  g('add', '-A');
  return loadRepo(dir);
}

const PKG = JSON.stringify({ name: 'x', dependencies: { next: '16.4.3' } });
const run = (id, repo) => ENV_RULES.find((r) => r.id === id).run(repo);

const DEPLOY = (envLines, buildArgLines = []) => `name: deploy
on:
  release:
    types: [published]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v6
        with:
          build-args: |
${buildArgLines.map((l) => `            ${l}`).join('\n')}
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: |
          cat > docker-compose.yml <<EOF
          services:
            app:
              environment:
${envLines.map((l) => `                - ${l}`).join('\n')}
          EOF
`;

describe('env-no-secret-fallback', () => {
  it('a secret that falls back to a literal fails, with the line', () => {
    const repo = repoWith({
      'package.json': PKG,
      'app/lib/buyerAuth.js': `const S = process.env.SF_JWT_SECRET || 'storefront-dev-secret-change-me';\n`,
      'lib/cashless/hmac.ts': `\nconst k = process.env["CASHLESS_HMAC_SECRET"] ?? "inite-cashless-default-secret";\n`,
      'src/guest.ts': 'const salt = process.env.GUEST_KEY_SALT || `inite-club-guest-lane`;\n',
      'web/auth.py': `import os\nSECRET = os.environ.get("SESSION_SECRET", "dev")\nPW = os.getenv("DB_PASSWORD") or "root"\n`,
    });
    const p = run('env-no-secret-fallback', repo);
    assert.equal(p.length, 5, p.join('\n'));
    assert.match(p.find((x) => x.includes('SF_JWT_SECRET')), /app\/lib\/buyerAuth\.js:1: .*requireSecret\('SF_JWT_SECRET'\)/);
    assert.match(p.find((x) => x.includes('CASHLESS')), /hmac\.ts:2:/);
  });

  it('not a secret, no literal, an empty literal, tests and scripts pass', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/a.ts': [
        `const url = process.env.BILLING_SERVICE_URL || 'https://billing.inite.ai';`,
        `const ttl = process.env.ACCESS_TOKEN_TTL ?? '15m';`,
        `const pub = process.env.NEXT_PUBLIC_MAPS_KEY || 'none';`,
        `const k = process.env.API_KEY || process.env.LEGACY_API_KEY;`,
        `const e = process.env.WEBHOOK_SECRET ?? '';`,
        'const t = process.env.TOKEN_ADDRESS || `0xabc`;',
      ].join('\n'),
      'src/a.test.ts': `const s = process.env.JWT_SECRET || 'test-secret';`,
      'scripts/seed.ts': `const s = process.env.JWT_SECRET || 'seed-secret';`,
    });
    assert.deepEqual(run('env-no-secret-fallback', repo), []);
  });

  it('names', () => {
    for (const n of ['SF_JWT_SECRET', 'GUEST_KEY_SALT', 'ENCRYPTION_KEY', 'BILLING_SERVICE_API_KEY', 'SMTP_PASS', 'DB_PASSWORD', 'GITHUB_TOKEN', 'PRIVATE_KEY_PEM']) assert.ok(isSecretName(n), n);
    for (const n of ['NEXT_PUBLIC_GA_ID', 'TOKEN_TTL', 'JWT_SECRET_HEADER', 'STRIPE_PUBLISHABLE_KEY', 'KEYCLOAK_URL', 'MONKEY', 'AWS_ACCESS_KEY_ID']) assert.ok(!isSecretName(n), n);
  });
});

describe('env-public-not-server', () => {
  it('route handlers, proxy, next.config, "use server" and server imports fail', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/app/api/x/route.ts': `export const GET = () => Response.redirect(process.env.NEXT_PUBLIC_APP_URL + '/x');`,
      'src/proxy.ts': `const AUTH = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? 'https://auth.inite.ai';`,
      'next.config.ts': `const a = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL;`,
      'src/app/actions/a.ts': `'use server';\nexport async function f() { return process.env.NEXT_PUBLIC_APP_URL; }`,
      'src/lib/auth/inite.ts': `import { createIniteAuth } from '@inite/auth/next';\nconst id = process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID;`,
      'src/app/[lang]/billing/page.tsx': `export default function P() { return process.env.NEXT_PUBLIC_APP_URL; }`,
    });
    const p = run('env-public-not-server', repo);
    assert.equal(p.length, 6, p.join('\n'));
    assert.ok(p.some((x) => x.startsWith('src/lib/auth/inite.ts: reads NEXT_PUBLIC_OAUTH_CLIENT_ID')));
  });

  it('client components, a publicEnv module, comments and plain lib files pass', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/components/Map.tsx': `'use client';\nconst k = process.env.NEXT_PUBLIC_MAPS_KEY;`,
      'src/lib/public-env.ts': `import { publicEnv } from '@inite/env';\nexport const pub = publicEnv({ NEXT_PUBLIC_GA_ID: process.env.NEXT_PUBLIC_GA_ID });`,
      'src/app/api/y/route.ts': `// was process.env.NEXT_PUBLIC_APP_URL\nimport { appOrigin } from '@inite/env';\nexport const GET = () => Response.redirect(appOrigin());`,
      'scripts/audit.ts': `import fs from 'fs';\nconsole.log(process.env.NEXT_PUBLIC_APP_URL);`,
    });
    assert.deepEqual(run('env-public-not-server', repo), []);
  });

  it('server file detection', () => {
    assert.ok(isServerFile('src/middleware.ts', ''));
    assert.ok(isServerFile('src/lib/x.ts', `import { cookies } from 'next/headers';`));
    assert.ok(!isServerFile('src/app/x/page.tsx', `"use client";\nexport default 1`));
    assert.ok(!isServerFile('src/lib/format.ts', `export const f = 1;`));
  });
});

describe('env-public-build-args', () => {
  const READS = `'use client';\nexport const ga = process.env.NEXT_PUBLIC_GA_ID;\nexport const site = process.env.NEXT_PUBLIC_SITE_URL || 'https://x';\n`;

  it('a public value read with no default must be an ARG and a build-arg', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/c.tsx': READS,
      Dockerfile: 'FROM node:22\nRUN pnpm build\n',
      '.github/workflows/deploy.yml': DEPLOY(['NEXT_PUBLIC_GA_ID=${{ vars.GA }}'], ['OTHER=1']),
    });
    const p = run('env-public-build-args', repo);
    assert.deepEqual(p, [
      'NEXT_PUBLIC_GA_ID (read in src/c.tsx) is not an ARG in Dockerfile',
      '.github/workflows/deploy.yml builds the image without NEXT_PUBLIC_GA_ID (read in src/c.tsx)',
    ]);
  });

  it('passes with the ARG and the build-arg; a default on the line needs neither', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/c.tsx': READS,
      Dockerfile: 'FROM node:22\nARG NEXT_PUBLIC_GA_ID\nRUN pnpm build\n',
      '.github/workflows/deploy.yml': DEPLOY([], ['NEXT_PUBLIC_GA_ID=${{ vars.GA }}']),
      '.github/workflows/ci.yml': 'name: ci\non: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n',
    });
    assert.deepEqual(run('env-public-build-args', repo), []);
  });

  it('reads build-args blocks and --build-arg', () => {
    const args = buildArgs(`      build-args: |\n        A=1\n        # note\n        B=\${{ x }}\n      tags: y\n    - run: docker build --build-arg C=1 --build-arg=D .\n`);
    assert.deepEqual([...args].sort(), ['A', 'B', 'C', 'D']);
  });
});

describe('env-example-sync', () => {
  it('no .env.example fails when the code reads env', () => {
    const repo = repoWith({ 'package.json': PKG, 'src/a.ts': 'const u = process.env.DATABASE_URL;' });
    assert.match(run('env-example-sync', repo)[0], /no \.env\.example/);
  });

  it('read but undocumented, and documented but read nowhere', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/a.ts': `const u = process.env.DATABASE_URL;\nconst k = requireSecret('CRON_SECRET');\nconst n = process.env.NODE_ENV;`,
      '.env.example': 'DATABASE_URL=\n# OLD_THING=1\nDEPLOY_ONLY=\n',
      'docker-compose.yml': 'services:\n  app:\n    environment:\n      - DEPLOY_ONLY=1\n',
    });
    assert.deepEqual(run('env-example-sync', repo), ['CRON_SECRET is read (src/a.ts) but not in .env.example', 'OLD_THING is in .env.example but nothing reads it']);
  });

  it('a legacy alias read beside its documented canonical name is not drift', () => {
    const repo = repoWith({
      'package.json': PKG,
      'next.config.ts': `const i = process.env.INITE_AUTH_ISSUER || process.env.AUTH_SERVICE_ISSUER;`,
      '.env.example': 'INITE_AUTH_ISSUER=\n',
    });
    assert.deepEqual(run('env-example-sync', repo), []);
  });

  it('a defineEnv schema counts as reads; a shared package name counts for a repo on @inite/*', () => {
    const repo = repoWith({
      'package.json': JSON.stringify({ name: 'x', dependencies: { next: '16.4.3', '@inite/env': 'workspace:*' } }),
      'src/env.ts': `import { defineEnv, envSpec, familyAuthEnv } from '@inite/env';\nexport const spec = envSpec({\n  server: {\n    ...familyAuthEnv(),\n    DATABASE_URL: z.string(),\n  },\n});\n`,
      '.env.example': ['INITE_AUTH_CLIENT_ID=', 'INITE_AUTH_CLIENT_SECRET=', 'INITE_AUTH_COOKIE_SECRET=', 'INITE_AUTH_ISSUER=', 'APP_URL=', 'DATABASE_URL=', `${SHARED_ENV[0]}=`].join('\n'),
    });
    assert.deepEqual(run('env-example-sync', repo), []);
  });
});

describe('env-required-in-deploy', () => {
  const files = (deploy) => ({
    'package.json': PKG,
    'src/a.ts': `import { requireSecret } from '@inite/env';\nexport const s = () => requireSecret('CASHLESS_HMAC_SECRET');`,
    '.env.example': '# @required\nAPP_URL=\n# @optional\nFEATURE=\n# @required @build\nNEXT_PUBLIC_GA_ID=\n',
    '.github/workflows/deploy.yml': deploy,
  });

  it('every requireSecret name and @required entry is set by each deploy', () => {
    const repo = repoWith(files(DEPLOY(['NODE_ENV=production'])));
    assert.deepEqual(run('env-required-in-deploy', repo), [
      'deploy.yml does not set CASHLESS_HMAC_SECRET (required by src/a.ts)',
      'deploy.yml does not set APP_URL (required by .env.example @required)',
    ]);
  });

  it('a legacy name is named as such', () => {
    const repo = repoWith(files(DEPLOY(['CASHLESS_HMAC_SECRET=${{ secrets.X }}', 'APP_BASE_URL=https://x'])));
    assert.deepEqual(run('env-required-in-deploy', repo), ['deploy.yml sets APP_BASE_URL, the legacy name of APP_URL (required by .env.example @required); set APP_URL']);
  });

  it('passes when set, also through compose ${VAR:?} or an env map', () => {
    const repo = repoWith({
      ...files(DEPLOY(['CASHLESS_HMAC_SECRET=${{ secrets.X }}'])),
      'docker-compose.prod.yml': 'services:\n  app:\n    environment:\n      APP_URL: ${APP_URL:?}\n',
    });
    assert.deepEqual(run('env-required-in-deploy', repo), []);
    const none = repoWith({ ...files('name: x'), '.inite/standards.json': '{"profile":"next","deploy":false}' });
    assert.deepEqual(run('env-required-in-deploy', none), []);
  });
});

describe('env rules in the checker', () => {
  it('are in RULES, debtable during their window', () => {
    const repo = repoWith({
      'package.json': PKG,
      '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { 'env-no-secret-fallback': 'content-generator storefront lane, Wave 0.2 PR' } }),
      'src/a.ts': `const S = process.env.SF_JWT_SECRET || 'change-me';`,
    });
    const r = check(repo, { offline: true, only: ['env-no-secret-fallback'] }).results.find((x) => x.id === 'env-no-secret-fallback');
    assert.equal(r.status, 'debt');
    assert.ok(mayStillAddDebt('env-no-secret-fallback', '2026-11-15'));
    assert.ok(!mayStillAddDebt('env-no-secret-fallback', '2026-11-16'));
    assert.ok(mayStillAddDebt('env-public-not-server', '2026-12-31'));
  });

  it('before its enforce date a failing env rule only warns; from the date it fails unless named as debt', () => {
    const files = {
      'package.json': PKG,
      'src/a.ts': `const S = process.env.SF_JWT_SECRET || 'change-me';\nexport const u = process.env.DATABASE_URL;`,
      'src/app/api/x/route.ts': `export const GET = () => Response.redirect(process.env.NEXT_PUBLIC_APP_URL + '/x');`,
    };
    const repo = repoWith({ ...files, '.inite/standards.json': JSON.stringify({ profile: 'next' }) });
    const ids = ['env-no-secret-fallback', 'env-public-not-server', 'env-example-sync'];
    const at = (today, r = repo) => Object.fromEntries(check(r, { offline: true, only: ids, today }).results.map((x) => [x.id, x.status]));

    // Today (01.11.2026): warnings, nothing fails, so `standards check` and the gate pass.
    assert.deepEqual(at('2026-11-01'), { 'env-no-secret-fallback': 'warn', 'env-public-not-server': 'warn', 'env-example-sync': 'warn' });
    // The secret rule is enforced from 15.11; the others still warn.
    assert.deepEqual(at('2026-11-15'), { 'env-no-secret-fallback': 'fail', 'env-public-not-server': 'warn', 'env-example-sync': 'warn' });
    // From 31.12 all fail.
    assert.deepEqual(at('2026-12-31'), { 'env-no-secret-fallback': 'fail', 'env-public-not-server': 'fail', 'env-example-sync': 'fail' });
    // Named debt carries them past the date.
    const debt = { 'env-no-secret-fallback': 'storefront lane, Wave 0.2 PR', 'env-public-not-server': 'moves to appOrigin() with @inite/env', 'env-example-sync': 'generated once the schema lands' };
    const owing = repoWith({ ...files, '.inite/standards.json': JSON.stringify({ profile: 'next', debt }) });
    assert.deepEqual(at('2027-01-15', owing), { 'env-no-secret-fallback': 'debt', 'env-public-not-server': 'debt', 'env-example-sync': 'debt' });
    // A repo can record that debt up to the enforce day, not after.
    for (const id of ids) {
      assert.equal(FAMILY.introduced[id], FAMILY.enforce[id], id);
      assert.ok(mayStillAddDebt(id, FAMILY.enforce[id]) && !warnsOnly(id, FAMILY.enforce[id]), id);
    }
  });

  it('every env rule has an enforce date; the rules before them have none (unchanged)', () => {
    for (const r of ENV_RULES) assert.match(FAMILY.enforce[r.id] ?? '', /^\d{4}-\d{2}-\d{2}$/, r.id);
    assert.equal(FAMILY.enforce['auth-kit'], undefined);
    assert.ok(!warnsOnly('secrets', '2000-01-01'));
  });

  it('the CLI exits 0 on warnings today and 1 on the enforce date', () => {
    const repo = repoWith({ 'package.json': PKG, '.inite/standards.json': JSON.stringify({ profile: 'next' }), 'src/a.ts': `const S = process.env.SF_JWT_SECRET || 'change-me';` });
    const cli = path.join(here, '..', 'bin', 'inite-standards.mjs');
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    const runAt = (today) => {
      try {
        return { code: 0, out: execFileSync('node', [cli, 'check', '--offline', '--today', today], { cwd: repo.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (e) {
        return { code: e.status, out: String(e.stdout) };
      }
    };
    const before = runAt('2026-11-01');
    assert.match(before.out, /! env-no-secret-fallback\n {4}warning until 2026-11-15/);
    const after = runAt('2026-11-15');
    assert.match(after.out, /✗ env-no-secret-fallback/);
    assert.equal(after.code, 1);
    // Other (non-env) rules fail in a bare throwaway repo, so compare the env line only for the exit:
    assert.ok(!/✗ env-/.test(before.out), before.out);
  });

  it('the alias table is the one @inite/env reads', () => {
    const src = fs.readFileSync(path.join(here, '../../../packages/env/src/family.ts'), 'utf8');
    const block = /LEGACY_ALIASES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)[1];
    const parsed = Object.fromEntries([...block.matchAll(/([A-Z_]+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1])]));
    assert.deepEqual(parsed, LEGACY_ALIASES);
  });

  it('shared-env.json is what the shared packages read (regenerate: node devops/standards/bin/inite-standards.mjs shared-env --update)', () => {
    assert.deepEqual(SHARED_ENV, scanSharedReads(path.join(here, '../../../packages')));
  });
});
