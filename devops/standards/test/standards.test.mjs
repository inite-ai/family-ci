// node --test devops/standards/test
// Each test builds a throwaway git repo under the OS temp dir and removes it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { check, FAMILY } from '../lib/checks.mjs';
import { verdict } from '../lib/pin.mjs';
import { checkSizes, compareLint, countErrors, lintRecordRises, lowerLint, lowerSizes } from '../lib/ratchets.mjs';
import { protectionProblems, summarize } from '../lib/remote.mjs';
import { loadRepo, stepCommand } from '../lib/repo.mjs';
import { envFileProblems, isPlaceholder, keyProblems } from '../lib/secrets.mjs';
import { deployProblems, jobIds, sharedCalls, triggers } from '../lib/workflows.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = fs.readFileSync(path.join(here, '..', 'family', 'family.sh'), 'utf8');
const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-std-'));
  made.push(dir);
  // A hook's GIT_DIR must not leak into the throwaway repo (initeai, 25.10.2026).
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
  return { dir, g };
}

const lines = (n) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i};`).join('\n') + '\n';

const DEPLOY_OK = `name: Deploy
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
      - run: echo deploy
  verify:
    needs: deploy
    uses: inite-ai/inite-shared/.github/workflows/verify-deploy.yml@main
    with:
      urls: https://example.invalid
`;

const CI_OK = `name: ci
on:
  pull_request:
  workflow_dispatch:
jobs:
  checks:
    uses: inite-ai/inite-shared/.github/workflows/ci.yml@main
    secrets: inherit
  ci:
    needs: checks
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: test "\${{ needs.checks.result }}" = success
`;

function conformingNext(extra = {}) {
  return {
    '.inite/standards.json': JSON.stringify({ profile: 'next' }),
    'package.json': JSON.stringify({
      packageManager: 'pnpm@10.33.2',
      scripts: { lint: FAMILY.scripts.lint, typecheck: 'tsc --noEmit', test: 'vitest run', build: 'next build', release: FAMILY.scripts.release },
      dependencies: { next: FAMILY.next },
      prettier: '@inite/prettier-config',
    }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    '.nvmrc': '22\n',
    Dockerfile: 'FROM node:22-alpine AS base\nFROM base AS run\nUSER node\n',
    'tsconfig.json': '{ "extends": "@inite/tsconfig/nextjs.json" }',
    'eslint.config.mjs': "import { family } from '@inite/eslint-config/family';\nexport default family();\n",
    'scripts/family.sh': WRAPPER,
    '.husky/pre-commit': 'GATE_SCOPE=commit sh scripts/family.sh gate HEAD\n',
    // The security baseline (lib/security.mjs): token permissions stated, dependencies kept current.
    '.github/workflows/ci.yml': `permissions:\n  contents: read\n${CI_OK}`,
    '.github/workflows/deploy.yml': `permissions:\n  contents: read\n${DEPLOY_OK}`,
    '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule: { interval: weekly }\n    groups:\n      actions: { patterns: ["*"] }\n',
    'src/app/page.tsx': lines(10),
    // A family product signs in through the kit (auth rules).
    'src/lib/auth.ts': "import { createIniteAuth } from '@inite/auth/next';\nexport const auth = createIniteAuth();\n",
    ...extra,
  };
}

const statusOf = (results, id) => results.find((r) => r.id === id)?.status;

describe('workflows', () => {
  it('reads block, list and scalar triggers', () => {
    assert.deepEqual([...triggers(DEPLOY_OK)], ['release', 'workflow_dispatch']);
    assert.deepEqual([...triggers('on: [push, pull_request]\njobs: {}\n')], ['push', 'pull_request']);
    assert.deepEqual([...triggers('"on": push\n')], ['push']);
    assert.deepEqual([...triggers('name: x\non:\n  push:\n    branches: [ main ]\n    tags: [ "v*" ]\n\nenv:\n  A: 1\n')], ['push']);
  });
  it('accepts the public mirror family-ci as the shared source', () => {
    const mirrored = DEPLOY_OK.replaceAll('inite-ai/inite-shared/', 'inite-ai/family-ci/');
    assert.deepEqual([...sharedCalls(mirrored)].sort(), ['release-gate.yml', 'verify-deploy.yml']);
    assert.deepEqual(deployProblems('deploy.yml', mirrored).filter((p) => /release-gate|verify-deploy/.test(p)), []);
  });
  it('finds shared calls and job ids', () => {
    assert.deepEqual([...sharedCalls(DEPLOY_OK)].sort(), ['release-gate.yml', 'verify-deploy.yml']);
    assert.deepEqual(jobIds(CI_OK), ['checks', 'ci']);
  });
  it('a deploy on push to main is refused, a release deploy passes', () => {
    assert.deepEqual(deployProblems('deploy.yml', DEPLOY_OK), []);
    const push = DEPLOY_OK.replace('  release:\n    types: [published]\n', '  push:\n    branches: [main]\n');
    const p = deployProblems('deploy.yml', push);
    assert.ok(p.some((x) => /deploys on push/.test(x)));
    assert.ok(p.some((x) => /release: published/.test(x)));
  });
});

describe('ratchets', () => {
  it('a new big file fails, a recorded one may shrink, never grow', () => {
    const { dir } = repoWith({ 'src/big.ts': lines(700), 'src/small.ts': lines(10), 'src/big.test.ts': lines(900) });
    assert.match(checkSizes(loadRepo(dir)).problems.join(), /src\/big\.ts: 700 lines, a new file/);
    fs.mkdirSync(path.join(dir, '.inite'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.inite/file-size-baseline.json'), JSON.stringify({ 'src/big.ts': 650 }));
    assert.match(checkSizes(loadRepo(dir)).problems.join(), /700 lines, up from 650/);
    fs.writeFileSync(path.join(dir, '.inite/file-size-baseline.json'), JSON.stringify({ 'src/big.ts': 700 }));
    assert.deepEqual(checkSizes(loadRepo(dir)).problems, []);
  });
  it('the size record may not rise against a ref', () => {
    const { dir, g } = repoWith({ 'src/big.ts': lines(700), '.inite/file-size-baseline.json': JSON.stringify({ 'src/big.ts': 690 }) });
    fs.writeFileSync(path.join(dir, '.inite/file-size-baseline.json'), JSON.stringify({ 'src/big.ts': 700 }));
    g('add', '-A');
    assert.match(checkSizes(loadRepo(dir), { against: 'HEAD' }).problems.join(), /raises src\/big\.ts from 690 to 700/);
  });
  it('lowering keeps only what is still over the limit', () => {
    assert.deepEqual(lowerSizes({ a: 900, b: 700 }, new Map([['a', 800], ['b', 500]])), { a: 800 });
  });
  it('lint errors are held per file and rule', () => {
    const results = [{ filePath: '/r/a.ts', messages: [{ severity: 2, ruleId: 'x' }, { severity: 2, ruleId: 'x' }, { severity: 1, ruleId: 'y' }] }];
    const { found, warnings } = countErrors(results, '/r');
    assert.deepEqual(found, { 'a.ts': { x: 2 } });
    assert.equal(warnings, 1);
    assert.deepEqual(compareLint(found, { 'a.ts': { x: 2 } }), []);
    assert.match(compareLint(found, { 'a.ts': { x: 1 } })[0], /2 × x, the record holds 1/);
    assert.deepEqual(lowerLint({ 'a.ts': { x: 5 }, 'b.ts': { z: 1 } }, found), { 'a.ts': { x: 2 } });
    assert.match(lintRecordRises({ 'a.ts': { x: 3 } }, { 'a.ts': { x: 2 } })[0], /raises a\.ts x from 2 to 3/);
  });
});

describe('secrets', () => {
  it('env files are refused, examples are not', () => {
    assert.equal(envFileProblems(['.env', 'a/.env.production', '.env.example', '.env.local.sample']).length, 2);
  });
  it('a key-shaped string is reported by place, a placeholder is not', () => {
    const key = ['sk-ant-api03-', 'Q9w8E7r6T5y4U3i2O1p0AaSsDdFfGgHh'].join('');
    const { dir } = repoWith({ 'a.txt': `ANTHROPIC_API_KEY=${key}\n`, 'b.txt': 'ANTHROPIC_API_KEY=sk-ant-your_anthropic_key_here_000\n' });
    const found = keyProblems(dir);
    assert.equal(found.length, 1);
    assert.match(found[0], /^a\.txt:1: looks like a Anthropic key/);
    assert.ok(!found[0].includes(key));
    assert.ok(isPlaceholder('sk-ant-your_key_here'));
  });
});

describe('check', () => {
  it('a conforming next repo passes offline', () => {
    const { dir } = repoWith(conformingNext());
    const { results } = check(loadRepo(dir), { offline: true });
    const failed = results.filter((r) => r.status === 'fail');
    assert.deepEqual(failed, []);
  });
  it('a gap named as debt is carried, a paid debt fails, new debt fails against a ref', () => {
    const { dir, g } = repoWith(conformingNext({ '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { tsconfig: 'tsconfig strictness differs; migrating separately' } }) }));
    let { results } = check(loadRepo(dir), { offline: true });
    assert.equal(statusOf(results, 'tsconfig'), 'fail'); // paid: it already extends the shared one
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    ({ results } = check(loadRepo(dir), { offline: true }));
    assert.equal(statusOf(results, 'tsconfig'), 'debt');
    fs.writeFileSync(path.join(dir, '.inite/standards.json'), JSON.stringify({ profile: 'next', debt: { tsconfig: 'tsconfig strictness differs; migrating separately', prettier: 'prettier config is local for now' } }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), prettier: undefined }));
    g('add', '-A');
    ({ results } = check(loadRepo(dir), { offline: true, against: 'HEAD~0' }));
    assert.equal(statusOf(results, 'debt'), 'fail');
  });
  it('the file-size and secret rules cannot be carried as debt', () => {
    const { dir } = repoWith(conformingNext({ 'src/big.ts': lines(650), '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { 'file-sizes': 'too many big files right now' } }) }));
    const { results } = check(loadRepo(dir), { offline: true });
    assert.equal(statusOf(results, 'file-sizes'), 'fail');
  });
  it('next lint and a differing wrapper are refused', () => {
    const files = conformingNext({ 'scripts/family.sh': WRAPPER + '# local edit\n' });
    const pkg = JSON.parse(files['package.json']);
    pkg.scripts.lint = 'next lint';
    files['package.json'] = JSON.stringify(pkg);
    const { dir } = repoWith(files);
    const { results } = check(loadRepo(dir), { offline: true });
    assert.equal(statusOf(results, 'scripts'), 'fail');
    assert.equal(statusOf(results, 'family-wrapper'), 'fail');
  });
  it('python repos get the python rules and python commands', () => {
    const { dir } = repoWith({ '.inite/standards.json': JSON.stringify({ profile: 'python', commands: { test: 'pytest -q tests' } }), 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n', 'requirements.txt': 'x==1\n', '.python-version': '3.13\n', Dockerfile: 'FROM python:3.13-slim\n' });
    const repo = loadRepo(dir);
    const ids = check(repo, { offline: true }).results.map((r) => r.id);
    assert.ok(ids.includes('python-tools') && !ids.includes('eslint'));
    assert.equal(stepCommand(repo, 'lint'), 'ruff check .');
    assert.equal(stepCommand(repo, 'test'), 'pytest -q tests');
    assert.equal(statusOf(check(repo, { offline: true }).results, 'python-version'), 'ok');
  });
  it('the Dockerfile and .nvmrc must agree', () => {
    const { dir } = repoWith(conformingNext({ Dockerfile: 'FROM node:20-alpine\n' }));
    assert.equal(statusOf(check(loadRepo(dir), { offline: true }).results, 'node-version'), 'fail');
  });
});

describe('remote verdicts', () => {
  it('protection needs ci, strict, no force push', () => {
    assert.deepEqual(protectionProblems(null), ['main is not protected']);
    const good = { required_status_checks: { strict: true, contexts: ['build-test', 'ci'] }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    assert.deepEqual(protectionProblems(good), []);
    assert.equal(protectionProblems({ ...good, required_status_checks: { strict: false, contexts: ['x'] } }).length, 2);
  });
  it('a check summary prefers success, then pending', () => {
    assert.equal(summarize([{ status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'success' }]), 'success');
    assert.equal(summarize([{ status: 'in_progress', conclusion: null }]), 'pending');
    assert.equal(summarize([]), 'none');
  });
  it('a pin verdict', () => {
    const pin = { what: 'inite-shared', sha: 'a'.repeat(40) };
    assert.equal(verdict(pin, { status: 'identical' }).ok, true);
    assert.equal(verdict(pin, { status: 'diverged' }).ok, false);
    assert.equal(verdict(pin, { status: 'ahead', behindBy: 3, days: 2 }).ok, true);
    assert.equal(verdict(pin, { status: 'ahead', behindBy: 30, days: 12 }).ok, false);
    assert.equal(verdict(pin, null).ok, true);
  });
});

describe('MANIFEST', () => {
  it('lists every file family.sh must fetch', () => {
    const root = path.join(here, '..');
    const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const want = [...['bin', 'lib', 'family', 'security'].flatMap(walk), 'family.json'].sort();
    const listed = fs.readFileSync(path.join(root, 'MANIFEST'), 'utf8').split('\n').filter(Boolean).sort();
    // A file missing here is missing on every machine: 29.10.2026, lib/auth-rules.mjs
    // was not listed and `sh scripts/family.sh` failed in every repo.
    assert.deepEqual(listed, want);
  });
});
