// node --test devops/standards/test
// The family auth rules on throwaway repos.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AUTH_RULES, BACKCHANNEL_LOGOUT_PATH } from '../lib/auth-rules.mjs';
import { check, mayStillAddDebt } from '../lib/checks.mjs';
import { loadRepo } from '../lib/repo.mjs';

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-auth-'));
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

const PKG = JSON.stringify({ name: 'x', dependencies: { next: '16.4.3', '@inite/auth': 'workspace:*' } });
const KIT = `import { createIniteAuth } from '@inite/auth/next';\nexport const auth = createIniteAuth();\n`;
const ROUTE = `import { auth } from '@/lib/auth';\nexport const { GET, POST } = auth.route;\n`;
const rule = (id) => AUTH_RULES.find((r) => r.id === id);
const run = (id, repo) => rule(id).run(repo);

describe('auth rules', () => {
  const good = () =>
    repoWith({
      'package.json': PKG,
      'src/lib/auth.ts': KIT,
      'src/app/api/auth/[...inite]/route.ts': ROUTE,
      'src/app/callback/route.ts': ROUTE,
      'src/lib/auth.test.ts': `import { SignJWT } from 'jose'; const t = new SignJWT({}); // tests may forge`,
    });

  it('a product on the kit meets every rule', () => {
    const repo = good();
    for (const r of AUTH_RULES) assert.deepEqual(r.run(repo), [], r.id);
  });

  it('auth-kit: a product with no kit import fails; the IdP and a no-auth repo pass', () => {
    const repo = repoWith({ 'package.json': PKG, 'src/x.ts': 'export {}' });
    assert.equal(run('auth-kit', repo).length, 1);
    const idp = repoWith({ 'package.json': PKG, '.inite/standards.json': '{"profile":"node","auth":"idp"}', 'src/x.ts': 'export {}' });
    assert.deepEqual(run('auth-kit', idp), []);
  });

  it('auth-no-local-credentials: bcrypt, argon2, scrypt and passlib', () => {
    for (const [file, body] of [['src/a.ts', `import bcrypt from 'bcryptjs'`], ['src/a.ts', `const a = require('argon2')`], ['src/a.ts', `await crypto.scrypt(password, salt, 64)`], ['web/auth.py', `from passlib.hash import argon2`]]) {
      const repo = repoWith({ 'package.json': PKG, 'src/lib/auth.ts': KIT, [file]: body });
      assert.equal(run('auth-no-local-credentials', repo).length, 1, body);
    }
    // A TypeScript import is not read as Python.
    assert.deepEqual(run('auth-no-own-jwt', repoWith({ 'package.json': PKG, 'src/a.ts': `import jwtDecodeLike from './x'` })), []);
  });

  it('auth-no-own-jwt: jsonwebtoken, jose signing/verifying, a hand-rolled OAuth client', () => {
    for (const body of [
      `import jwt from 'jsonwebtoken'`,
      `await new SignJWT({}).sign(k)`,
      `await jwtVerify(t, keys)`,
      `fetch(issuer + '/v1/oauth/token', { body: new URLSearchParams({ code_verifier: v }) })`,
    ]) {
      const repo = repoWith({ 'package.json': PKG, 'src/lib/auth.ts': KIT, 'src/a.ts': body });
      assert.equal(run('auth-no-own-jwt', repo).length, 1, body);
    }
  });

  it('auth-no-hs256 and auth-no-browser-tokens', () => {
    const repo = repoWith({
      'package.json': PKG,
      'src/lib/auth.ts': KIT,
      'src/a.ts': `const alg = "HS256";`,
      'src/b.tsx': `localStorage.setItem('cover_gen_access_token', t)`,
    });
    assert.equal(run('auth-no-hs256', repo).length, 1);
    assert.equal(run('auth-no-browser-tokens', repo).length, 1);
  });

  it('auth-backchannel-path: only the family path, in a route file or a string', () => {
    assert.equal(BACKCHANNEL_LOGOUT_PATH, '/api/auth/backchannel-logout');
    const ok = repoWith({ 'package.json': PKG, 'src/app/api/auth/backchannel-logout/route.ts': ROUTE, 'src/x.ts': `const u = "/api/auth/backchannel-logout";` });
    assert.deepEqual(run('auth-backchannel-path', ok), []);
    const wrong = repoWith({ 'package.json': PKG, 'src/app/(site)/api/auth/backchannel/route.ts': ROUTE });
    assert.match(run('auth-backchannel-path', wrong)[0], /\/api\/auth\/backchannel;/);
    const nest = repoWith({ 'package.json': PKG, 'src/auth.controller.ts': `@Post('/oidc/backchannel')` });
    assert.equal(run('auth-backchannel-path', nest).length, 1);
    assert.equal(rule('auth-backchannel-path').debtable, false);
  });

  it('a new auth rule may still be recorded as debt until its date, then not', () => {
    assert.equal(mayStillAddDebt('auth-kit', '2026-11-01'), true);
    assert.equal(mayStillAddDebt('auth-kit', '2027-01-01'), false);
    assert.equal(mayStillAddDebt('eslint', '2026-11-01'), false);
  });

  it('check() runs the auth rules with the rest', () => {
    const repo = good();
    const ids = check(repo, { offline: true }).results.map((r) => r.id);
    for (const r of AUTH_RULES) assert.ok(ids.includes(r.id), r.id);
  });
});
