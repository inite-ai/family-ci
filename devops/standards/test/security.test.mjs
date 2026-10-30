// node --test devops/standards/test
// The security baseline's rules (lib/security.mjs), the audit allowance
// (lib/audit.mjs), the deploy probe (lib/probe.mjs) and the credential files
// (lib/secrets.mjs). Pure functions; no network, no repo writes outside the OS temp dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { advisories, auditProblems } from '../lib/audit.mjs';
import { check } from '../lib/checks.mjs';
import { EXPOSED, headerProblems, report } from '../lib/probe.mjs';
import { loadRepo } from '../lib/repo.mjs';
import { credentialFileProblems } from '../lib/secrets.mjs';
import { compareSinks, finalUser, permissionProblems, prTargetProblems, sinksIn, unpinnedUses } from '../lib/security.mjs';

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-sec-'));
  made.push(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 't');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'init', '--no-gpg-sign');
  return dir;
}

describe('actions', () => {
  it('a tag is not a pin; a SHA, a local action and the family are', () => {
    const wf = [
      'steps:',
      '  - uses: actions/checkout@v4',
      '  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
      '  - uses: ./.github/actions/x',
      '  - uses: inite-ai/inite-shared/.github/actions/family@main',
      "  - uses: 'pnpm/action-setup@v4'",
    ].join('\n');
    assert.deepEqual(unpinnedUses(wf).map((u) => u.ref), ['actions/checkout@v4', 'pnpm/action-setup@v4']);
  });
  it('permissions at the top, or on every job', () => {
    assert.deepEqual(permissionProblems('on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n'), []);
    assert.deepEqual(permissionProblems('on: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      contents: read\n'), []);
    assert.equal(permissionProblems('on: push\njobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: x\n    permissions: {}\n').length, 1);
  });
  it('a comment between jobs is not a job', () => {
    const wf = 'on: push\njobs:\n  # Only a commit main took through a green ci goes out.\n  gate:\n    uses: inite-ai/inite-shared/.github/workflows/release-gate.yml@main\n\n  # then the image\n  build:\n    runs-on: x\n    permissions:\n      contents: read\n';
    assert.deepEqual(permissionProblems(wf), []);
    const missing = 'on: push\njobs:\n  # first\n  a:\n    runs-on: x\n  # second\n  b:\n    runs-on: x\n';
    assert.deepEqual(permissionProblems(missing), ['no top-level permissions: and job(s) a, b set none']);
  });
  it('pull_request_target must not run the PR', () => {
    const pwn = 'on:\n  pull_request_target:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@x\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n';
    assert.equal(prTargetProblems(pwn).length, 1);
    const pasted = 'on:\n  pull_request_target:\njobs:\n  a:\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n';
    assert.equal(prTargetProblems(pasted).length, 1);
    const safe = 'on:\n  pull_request_target:\njobs:\n  a:\n    steps:\n      - env:\n          T: ${{ github.event.pull_request.title }}\n        run: echo "$T"\n';
    assert.deepEqual(prTargetProblems(safe), []);
  });
});

describe('containers', () => {
  it('reads the final stage only', () => {
    assert.equal(finalUser('FROM node AS b\nUSER node\nFROM node\nCMD x\n'), null);
    assert.equal(finalUser('FROM node AS b\nFROM node\nUSER nextjs\nCMD x\n'), 'nextjs');
  });
});

describe('the sink ratchet', () => {
  it('counts raw fetch of a dynamic URL on the server, not a literal one, and honours the marker', () => {
    const t = [
      "const a = await fetch(body.url)",
      "const b = await fetch('https://api.example.com/x')",
      'const d = await fetch(`https://x/${id}`)',
      'const c = await fetch(`${process.env.BILLING_URL}/x`) // security: raw-fetch BILLING_URL is our own service',
    ].join('\n');
    assert.equal(sinksIn('src/lib/import.ts', t)['raw-fetch'], 2);
    assert.equal(sinksIn('src/components/x.tsx', t)['raw-fetch'], undefined); // client code: not counted
  });
  it('a mutation route without an authz call is counted; with one, or marked public, it is not', () => {
    const route = 'app/api/things/route.ts';
    assert.equal(sinksIn(route, 'export async function POST(req) { return db.thing.create({}) }')['route-authz'], 1);
    assert.equal(sinksIn(route, 'export async function POST(req) { await requirePermission(c, "x"); }')['route-authz'], undefined);
    assert.equal(sinksIn(route, "export const access = 'public'\nexport async function POST() {}")['route-authz'], undefined);
    assert.equal(sinksIn(route, 'export async function GET() {}')['route-authz'], undefined);
  });
  it("a server-action module is counted at its directive, not a page's inline action", () => {
    assert.equal(sinksIn('src/app/actions/x.ts', "'use server'\nexport async function del(id) { await prisma.x.delete({ where: { id } }) }")['route-authz'], 1);
    assert.equal(sinksIn('src/app/page.tsx', "export default function P() { async function a() { 'use server'; }; }")['route-authz'], undefined);
  });
  it('a lookup by id is unscoped unless the where names an owner or a row check precedes it', () => {
    const f = 'src/app/actions/x.ts';
    const head = "'use server'\nexport async function f(id, companyId) {\n  await requireSession()\n";
    assert.equal(sinksIn(f, head + '  await prisma.x.update({ where: { id }, data: {} })\n}')['tenant-unscoped'], 1);
    assert.equal(sinksIn(f, head + '  await prisma.x.update({ where: { id, companyId }, data: {} })\n}')['tenant-unscoped'], undefined);
    assert.equal(sinksIn(f, head + '  const { entity } = await requireEntityAccess(() => prisma.x.findUniqueOrThrow({ where: { id } }))\n}')['tenant-unscoped'], undefined);
  });
  it('a webhook receiver must verify; a signed-in route that manages webhooks is not a receiver', () => {
    assert.equal(sinksIn('app/api/webhooks/pay/route.ts', 'export async function POST(r) { const e = await r.json(); await markPaid(e) }')['webhook-unsigned'], 1);
    assert.equal(sinksIn('app/api/webhooks/pay/route.ts', 'export async function POST(r) { if (!verifyHmac({})) return; }')['webhook-unsigned'], undefined);
    assert.equal(sinksIn('app/api/me/webhooks/route.ts', 'export async function POST(r) { await requireSession(); }')['webhook-unsigned'], undefined);
  });
  it('innerHTML through the sanitiser is not counted; raw SQL is', () => {
    assert.equal(sinksIn('x.tsx', '<div dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(t) }} />')['inner-html'], undefined);
    assert.equal(sinksIn('x.tsx', '<div dangerouslySetInnerHTML={{ __html: t }} />')['inner-html'], 1);
    assert.equal(sinksIn('src/lib/q.ts', 'await prisma.$queryRawUnsafe(`select * from x where id = ${id}`)')['raw-sql'], 1);
    assert.equal(sinksIn('src/lib/q.ts', 'await db.query(`select * from x where id = ${id}`)')['raw-sql'], 1);
  });
  it('new and grown sinks fail; the record cannot rise against the base', () => {
    const rec = { 'raw-fetch': { 'lib/a.ts': 2 } };
    assert.deepEqual(compareSinks({ 'raw-fetch': { 'lib/a.ts': 2 } }, rec), []);
    assert.equal(compareSinks({ 'raw-fetch': { 'lib/a.ts': 3 } }, rec).length, 1);
    assert.equal(compareSinks({ 'raw-fetch': { 'lib/b.ts': 1 } }, rec).length, 1);
    assert.equal(compareSinks({}, { 'raw-fetch': { 'lib/a.ts': 3 } }, rec).length, 1);
  });
  it('check runs the security rules for a repo', () => {
    const dir = repoWith({
      '.inite/standards.json': JSON.stringify({ profile: 'node' }),
      'package.json': '{"name":"x"}',
      'Dockerfile': 'FROM node:22\nCMD ["node","x"]\n',
      '.github/workflows/ci.yml': 'on: pull_request\njobs:\n  ci:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n',
      'src/lib/get.ts': 'export const get = (u) => fetch(u)\n',
    });
    const { results } = check(loadRepo(dir), { offline: true, only: ['actions-pinned', 'actions-permissions', 'container-user', 'dependency-updates', 'security-sinks'] });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const id of ['actions-pinned', 'actions-permissions', 'container-user', 'dependency-updates', 'security-sinks']) assert.equal(byId[id].status, 'fail', id);
    assert.match(byId['security-sinks'].problems[0], /src\/lib\/get\.ts: raw-fetch 1/);
  });
});

describe('credential files', () => {
  it('a WhatsApp session directory and private keys are credentials', () => {
    const p = credentialFileProblems(['data/whatsapp-sessions/c1/creds.json', 'data/whatsapp-sessions/c1/pre-key-1.json', 'deploy/id_ed25519', 'certs/ca.pem', 'src/x.ts']);
    assert.equal(p.length, 2);
    assert.match(p[0], /data\/whatsapp-sessions:/);
    assert.deepEqual(credentialFileProblems(['deploy/id_ed25519'], ['^deploy/']), []);
  });
});

describe('dependency audit', () => {
  const npm = {
    vulnerabilities: {
      next: { name: 'next', severity: 'critical', via: [{ source: 1, name: 'next', title: 'SSRF in middleware', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'critical' }], fixAvailable: { name: 'next', version: '16.4.1' } },
      lodash: { name: 'lodash', severity: 'moderate', via: [{ source: 2, name: 'lodash', title: 'x', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'moderate' }], fixAvailable: true },
    },
  };
  it('reads npm and pnpm shapes', () => {
    assert.deepEqual(advisories(npm).map((a) => [a.advisory, a.severity]), [['GHSA-aaaa-bbbb-cccc', 'critical'], ['GHSA-dddd-eeee-ffff', 'moderate']]);
    const pnpm = { advisories: { 1: { github_advisory_id: 'GHSA-1', module_name: 'x', severity: 'high', title: 't', patched_versions: '>=2' } } };
    assert.equal(advisories(pnpm)[0].advisory, 'GHSA-1');
  });
  it('High/Critical fail unless allowed with a reason and an unexpired date within 90 days', () => {
    const list = advisories(npm);
    const today = '2026-10-29';
    assert.equal(auditProblems(list, [], today).length, 1);
    assert.deepEqual(auditProblems(list, [{ advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'upgrade PR #12 open', expires: '2026-11-15' }], today), []);
    assert.equal(auditProblems(list, [{ advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'upgrade PR #12 open', expires: '2026-10-01' }], today).length, 2);
    assert.match(auditProblems(list, [{ advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'upgrade later on', expires: '2027-06-01' }], today)[0], /90 days/);
  });
});

describe('the deploy probe', () => {
  const H = (o, cookies = []) => Object.assign(new Headers(o), { getSetCookie: () => cookies });
  const good = {
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=()',
    'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; object-src 'none'; frame-ancestors 'none'",
  };
  it('a hardened page passes', () => assert.deepEqual(headerProblems(H(good, ['__Host-sid=1; Path=/; Secure; HttpOnly; SameSite=Lax'])), []));
  it('names what is missing', () => {
    const p = headerProblems(H({ 'x-powered-by': 'Next.js', 'content-security-policy': "script-src 'self' 'unsafe-inline'" }, ['session=1; Path=/']));
    for (const want of ['Strict-Transport-Security', 'nosniff', 'Referrer-Policy', "'unsafe-inline'", 'framed', 'X-Powered-By', 'cookie session: no Secure', 'readable by script']) {
      assert.ok(p.some((x) => x.includes(want)), want);
    }
  });
  it("an SPA's index is not an exposed file; the file's own shape is", () => {
    const env = EXPOSED.find(([p]) => p === '/.env')[1];
    assert.equal(env('<!doctype html><html>'), false);
    assert.equal(env('DATABASE_URL=postgres://x'), true);
  });
  it('reports one line per site', () => assert.match(report([{ origin: 'https://x', problems: ['no HSTS'] }], new Date('2026-10-29')), /1 of 1 sites[\s\S]*- no HSTS/));
});
