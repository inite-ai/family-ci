// node --test devops/standards/test
// api-errors-problem-json (lib/api-rules.mjs): route handlers answer 4xx/5xx
// as application/problem+json. Pure functions, plus throwaway repos under the
// OS temp dir for the rule as `check` runs it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { argsSpan, jsonErrors, routeFiles } from '../lib/api-rules.mjs';
import { check, FAMILY } from '../lib/checks.mjs';
import { loadRepo } from '../lib/repo.mjs';

const ID = 'api-errors-problem-json';

describe('routeFiles', () => {
  it('app/api route handlers only, outside vendored and test trees', () => {
    assert.deepEqual(
      routeFiles([
        'app/api/route.ts',
        'app/api/lead/route.ts',
        'src/app/api/v1/[id]/route.js',
        'apps/web/app/api/x/route.mts',
        'app/lead/route.ts',
        'app/api/lead/handler.ts',
        'inite-shared/packages/og/src/app/api/og/route.ts',
        'node_modules/x/app/api/y/route.ts',
        'app/api/lead/route.test.ts',
      ]),
      ['app/api/route.ts', 'app/api/lead/route.ts', 'src/app/api/v1/[id]/route.js', 'apps/web/app/api/x/route.mts'],
    );
  });
});

describe('argsSpan', () => {
  it('stops at the matching parenthesis, skipping strings', () => {
    const t = 'f({ a: ")", b: g(1) }, { status: 400 }) + h()';
    assert.equal(argsSpan(t, 1), '{ a: ")", b: g(1) }, { status: 400 }');
  });
});

describe('jsonErrors', () => {
  it('a literal 4xx/5xx status in NextResponse.json or Response.json', () => {
    const t = [
      'export async function POST() {',
      "  if (!ok) return NextResponse.json({ error: 'Bad' }, { status: 400 });",
      '  if (down) return Response.json(',
      "    { ok: false, error: 'Down' },",
      '    { status: 503, headers: { "Retry-After": "5" } },',
      '  );',
      '  return NextResponse.json({ ok: true }, { status: 201 });',
      '}',
    ].join('\n');
    assert.deepEqual(jsonErrors(t), [
      { line: 2, status: 400, call: 'NextResponse.json' },
      { line: 3, status: 503, call: 'Response.json' },
    ]);
  });

  it('a success, a status in a variable, and problem() pass', () => {
    const t = [
      "return NextResponse.json({ ok: true });",
      'return NextResponse.json(body, { status });',
      "return problem(404, 'not-found', 'No such report');",
    ].join('\n');
    assert.deepEqual(jsonErrors(t), []);
  });

  it('a call that already sends application/problem+json passes', () => {
    const t = "return NextResponse.json(body, { status: 404, headers: { 'Content-Type': 'application/problem+json' } });";
    assert.deepEqual(jsonErrors(t), []);
  });

  it('a status further on is not the call\'s', () => {
    const t = "const a = NextResponse.json({ ok: true });\nconst b = { status: 500 };";
    assert.deepEqual(jsonErrors(t), []);
  });

  it('a reason on the line or the one above exempts it', () => {
    const t = [
      '// problem-json: OAuth token errors are { error } by RFC 6749 section 5.2',
      "return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });",
      "return NextResponse.json({ error: 'x' }, { status: 401 }); // problem-json: why",
    ].join('\n');
    assert.deepEqual(jsonErrors(t), [{ line: 3, status: 401, call: 'NextResponse.json' }]);
  });
});

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function repoWith(files, profile = 'next') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inite-api-')), 'site');
  made.push(path.dirname(dir));
  fs.mkdirSync(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  for (const [p, body] of Object.entries({ '.inite/standards.json': JSON.stringify({ profile }), ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  g('add', '-A');
  return dir;
}

const ENFORCED = FAMILY.enforce[ID];
const run = (dir, today = ENFORCED) => check(loadRepo(dir), { only: [ID], today }).results.find((r) => r.id === ID);
const BAD = { 'app/api/lead/route.ts': "export const POST = () => NextResponse.json({ error: 'Bad' }, { status: 422 });\n" };

describe('the rule in check', () => {
  it('is warn-only until 31.01.2027, and debt may be recorded until then', () => {
    assert.equal(FAMILY.enforce[ID], '2027-01-31');
    assert.equal(FAMILY.introduced[ID], '2027-01-31');
  });

  it('a route answering problem() passes', () => {
    const r = run(repoWith({ 'app/api/lead/route.ts': "export const POST = () => problem(422, 'unprocessable', 'Bad');\n" }));
    assert.equal(r.status, 'ok', r.problems.join('\n'));
  });

  it('lists a JSON error with file:line, warns before the day and fails from it', () => {
    const dir = repoWith(BAD);
    const before = run(dir, '2026-11-06');
    assert.equal(before.status, 'warn');
    assert.match(before.problems[0], /^app\/api\/lead\/route\.ts:1: 422 answered with NextResponse\.json\(\)/);
    assert.equal(run(dir).status, 'fail');
  });

  it('can be carried as debt with its reason', () => {
    const r = run(repoWith({ ...BAD, '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { [ID]: 'forty routes move to problem() in December' } }) }));
    assert.equal(r.status, 'debt');
  });

  it('holds next repos only', () => {
    assert.equal(run(repoWith(BAD, 'node')), undefined);
  });
});
