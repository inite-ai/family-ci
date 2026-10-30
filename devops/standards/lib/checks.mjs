// The family contract, as checks. Each rule returns the problems it found
// ([] when the repo conforms). A failing rule the repo lists under "debt" in
// .inite/standards.json (with the reason) is reported as debt, not failed;
// a debt that is paid fails until it is struck from the list, and against a
// ref the list may not grow. That is the ratchet for everything that is not
// a number: legacy gaps are named, and the names only go away.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_RULES } from './auth-rules.mjs';
import { checkPins } from './pin.mjs';
import { checkLintRecord, checkSizes } from './ratchets.mjs';
import { CONFIG, deployWorkflows, PROFILES } from './repo.mjs';
import { credentialFileProblems, envFileProblems, keyProblems } from './secrets.mjs';
import { SECURITY_RULES } from './security.mjs';
import { deployProblems, jobIds, sharedCalls, triggers } from './workflows.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAMILY = JSON.parse(fs.readFileSync(path.join(here, '..', 'family.json'), 'utf8'));
const WRAPPER = fs.readFileSync(path.join(here, '..', 'family', 'family.sh'), 'utf8');

const NODE = ['next', 'node'];
const ALL = PROFILES;

const nodeMajor = (s) => (/(\d+)/.exec(s ?? '') ?? [])[1];

export const RULES = [
  {
    id: 'config',
    profiles: ALL,
    debtable: false,
    what: `${CONFIG} names the profile and the debt`,
    run(repo) {
      if (!repo.hasConfig) return [`${CONFIG} is missing`];
      if (repo.configError) return [`${CONFIG}: ${repo.configError}`];
      if (!PROFILES.includes(repo.config.profile)) return [`${CONFIG}: profile must be one of ${PROFILES.join(', ')}`];
      return Object.entries(repo.config.debt ?? {})
        .filter(([, why]) => typeof why !== 'string' || why.trim().length < 8)
        .map(([id]) => `${CONFIG}: debt "${id}" needs its reason beside it`);
    },
  },
  {
    id: 'scripts',
    profiles: NODE,
    what: 'package.json has lint, typecheck, test, build and release (and e2e with Playwright)',
    run(repo) {
      const s = repo.pkg?.scripts ?? {};
      const out = [];
      for (const name of ['lint', 'typecheck', 'test', 'build']) if (!s[name]) out.push(`no "${name}" script`);
      const deps = { ...repo.pkg?.dependencies, ...repo.pkg?.devDependencies };
      if (deps['@playwright/test'] && !s.e2e) out.push('Playwright is installed but there is no "e2e" script');
      if (s.lint && s.lint !== FAMILY.scripts.lint) out.push(`"lint" is "${s.lint}"; the family's is "${FAMILY.scripts.lint}" (eslint, errors held to the record)`);
      if (s.release !== FAMILY.scripts.release) out.push(`"release" must be "${FAMILY.scripts.release}"`);
      for (const [name, cmd] of Object.entries(s)) if (/\bnext lint\b/.test(cmd)) out.push(`"${name}" runs \`next lint\`, which Next 16 removed`);
      return out;
    },
  },
  {
    id: 'family-wrapper',
    profiles: ALL,
    debtable: false,
    what: 'scripts/family.sh is the shared one, byte for byte',
    run(repo) {
      const text = repo.read('scripts/family.sh');
      if (text === null) return ['scripts/family.sh is missing (copy inite-shared/devops/standards/family/family.sh)'];
      return text === WRAPPER ? [] : ['scripts/family.sh differs from inite-shared/devops/standards/family/family.sh; copy it again'];
    },
  },
  {
    id: 'eslint',
    profiles: NODE,
    what: 'ESLint flat config built on @inite/eslint-config; no legacy .eslintrc',
    run(repo) {
      const out = [];
      const legacy = repo.files.filter((f) => /^\.eslintrc(?:\.\w+)?$/.test(f));
      for (const f of legacy) out.push(`${f} is a legacy config ESLint 9 ignores; delete it`);
      const flat = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts'].find((f) => repo.has(f));
      if (!flat) out.push('no eslint.config.* (flat config)');
      else if (!/@inite\/eslint-config/.test(repo.read(flat) ?? '')) out.push(`${flat} does not build on @inite/eslint-config`);
      return out;
    },
  },
  {
    id: 'tsconfig',
    profiles: NODE,
    what: 'tsconfig.json extends @inite/tsconfig',
    run(repo) {
      const text = repo.read('tsconfig.json');
      if (text === null) return ['no tsconfig.json'];
      return /"extends"\s*:\s*(?:"[^"]*@inite\/tsconfig|\[[^\]]*@inite\/tsconfig)/.test(text) ? [] : ['tsconfig.json does not extend @inite/tsconfig'];
    },
  },
  {
    id: 'prettier',
    profiles: NODE,
    what: 'Prettier config is @inite/prettier-config',
    run(repo) {
      if (/@inite\/prettier-config/.test(JSON.stringify(repo.pkg?.prettier ?? ''))) return [];
      const f = ['prettier.config.mjs', 'prettier.config.js', 'prettier.config.cjs', '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.mjs'].find((x) => repo.has(x));
      if (f && /@inite\/prettier-config/.test(repo.read(f) ?? '')) return [];
      return ['no Prettier config built on @inite/prettier-config'];
    },
  },
  {
    id: 'next-version',
    profiles: ['next'],
    what: `next is ${FAMILY.next}`,
    run(repo) {
      const spec = { ...repo.pkg?.dependencies, ...repo.pkg?.devDependencies }.next;
      return spec && spec.replace(/^[\^~]/, '') === FAMILY.next ? [] : [`next is "${spec}"; the family runs ${FAMILY.next}`];
    },
  },
  {
    id: 'node-version',
    profiles: NODE,
    what: '.nvmrc names the Node major the Dockerfile runs',
    run(repo) {
      const nvmrc = repo.read('.nvmrc');
      if (nvmrc === null) return ['no .nvmrc'];
      const want = nodeMajor(nvmrc);
      const out = [];
      for (const f of repo.files.filter((x) => /(?:^|\/)Dockerfile[^/]*$/.test(x) && !x.startsWith('inite-shared/'))) {
        for (const m of (repo.read(f) ?? '').matchAll(/^FROM\s+(?:--platform=\S+\s+)?node:(\d+)/gm)) {
          if (m[1] !== want) out.push(`${f} runs node:${m[1]}, .nvmrc says ${want}`);
        }
      }
      return out;
    },
  },
  {
    id: 'node-lts',
    profiles: NODE,
    what: `Node is at least ${FAMILY.nodeMin} (20 left support in April 2026)`,
    run(repo) {
      const major = Number(nodeMajor(repo.read('.nvmrc')));
      return major >= FAMILY.nodeMin ? [] : [`Node ${major || '?'} is below ${FAMILY.nodeMin}`];
    },
  },
  {
    id: 'python-version',
    profiles: ['python'],
    what: '.python-version names the Python the Dockerfile runs',
    run(repo) {
      const want = (repo.read('.python-version') ?? '').trim().split('.').slice(0, 2).join('.');
      if (!want) return ['no .python-version'];
      const out = [];
      for (const f of repo.files.filter((x) => /(?:^|\/)Dockerfile[^/]*$/.test(x))) {
        for (const m of (repo.read(f) ?? '').matchAll(/^FROM\s+(?:--platform=\S+\s+)?python:(\d+\.\d+)/gm)) {
          if (m[1] !== want) out.push(`${f} runs python:${m[1]}, .python-version says ${want}`);
        }
      }
      return out;
    },
  },
  {
    id: 'python-tools',
    profiles: ['python'],
    what: 'pyproject.toml configures ruff, mypy and pytest',
    run(repo) {
      const py = repo.read('pyproject.toml') ?? '';
      const out = [];
      if (!/^\[tool\.ruff/m.test(py) && !repo.has('ruff.toml')) out.push('no ruff config ([tool.ruff])');
      if (!/^\[tool\.mypy/m.test(py) && !repo.has('mypy.ini')) out.push('no mypy config ([tool.mypy])');
      if (!/^\[tool\.pytest/m.test(py) && !repo.has('pytest.ini')) out.push('no pytest config ([tool.pytest.ini_options])');
      return out;
    },
  },
  {
    id: 'lockfile',
    profiles: ALL,
    what: 'one lockfile, of the declared package manager',
    run(repo) {
      if (repo.profile === 'python') {
        return ['requirements.txt', 'uv.lock', 'poetry.lock'].some((f) => repo.tracked(f)) ? [] : ['no pinned requirements (requirements.txt, uv.lock or poetry.lock)'];
      }
      const locks = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].filter((f) => repo.tracked(f));
      if (locks.length === 0) return ['no lockfile is tracked'];
      if (locks.length > 1) return [`${locks.join(' and ')}: one package manager, one lockfile`];
      const declared = repo.pkg?.packageManager?.split('@')[0];
      if (declared && declared !== repo.pm) return [`packageManager says ${declared}, the lockfile is ${locks[0]}`];
      if (repo.pm === 'pnpm' && !declared) return ['pnpm repo without "packageManager" (pnpm@<version>)'];
      return [];
    },
  },
  {
    id: 'shared-pin',
    profiles: ALL,
    what: "inite-shared (submodule or vendored tarball) tracks the head of inite-shared's main",
    network: true,
    run: (repo, ctx) => {
      const { problems, notes } = checkPins(repo);
      ctx.notes.push(...notes);
      return problems;
    },
  },
  {
    id: 'file-sizes',
    profiles: ALL,
    debtable: false,
    what: `no new source file over 600 lines; recorded ones only shrink (.inite/file-size-baseline.json)`,
    run: (repo, ctx) => checkSizes(repo, { against: ctx.against }).problems,
  },
  {
    id: 'lint-record',
    profiles: NODE,
    debtable: false,
    what: 'the lint record (.inite/lint-baseline.json) does not rise',
    run: (repo, ctx) => (ctx.against ? checkLintRecord(repo, ctx.against) : []),
  },
  {
    id: 'secrets',
    profiles: ALL,
    debtable: false,
    what: 'no tracked env file, no key-shaped string',
    run: (repo) => [...envFileProblems(repo.files), ...credentialFileProblems(repo.files, repo.config.secrets?.allow ?? []), ...keyProblems(repo.root, repo.config.secrets?.allow ?? [])],
  },
  {
    id: 'ci-workflow',
    profiles: ALL,
    what: ".github/workflows/ci.yml calls inite-shared's ci.yml on pull requests and ends in a job named ci",
    run(repo) {
      const text = repo.read('.github/workflows/ci.yml');
      if (text === null) return ['no .github/workflows/ci.yml'];
      const out = [];
      if (!sharedCalls(text).has('ci.yml')) out.push('ci.yml does not call inite-ai/inite-shared (or inite-ai/family-ci) /.github/workflows/ci.yml');
      if (!triggers(text).has('pull_request')) out.push('ci.yml does not run on pull_request');
      if (!jobIds(text).includes('ci')) out.push('ci.yml has no job "ci" (the check main requires)');
      return out;
    },
  },
  {
    id: 'deploy-on-release',
    profiles: ALL,
    what: 'deploys run on a release or a dispatch, through the shared gate and verify',
    run(repo) {
      if (repo.config.deploy === false) return [];
      const out = [];
      for (const wf of deployWorkflows(repo)) {
        const text = repo.read(`.github/workflows/${wf}`);
        if (text === null) out.push(`.github/workflows/${wf} is missing`);
        else out.push(...deployProblems(wf, text));
      }
      return out;
    },
  },
  {
    id: 'pre-commit',
    profiles: ALL,
    what: 'the pre-commit hook runs the family gate',
    run(repo) {
      const hook = repo.profile === 'python' ? '.githooks/pre-commit' : '.husky/pre-commit';
      const text = repo.read(hook);
      if (text === null) return [`no ${hook}`];
      return /family\.sh gate/.test(text) ? [] : [`${hook} does not run \`sh scripts/family.sh gate\``];
    },
  },
  // The security baseline (lib/security.mjs, .planning/family-security-baseline-2026-10.md).
  ...SECURITY_RULES,
  ...AUTH_RULES,
];

/**
 * A rule added after repos joined fails in every repo at once, and the debt
 * list may not grow. family.json "introduced" names such a rule with the last
 * day its debt may still be added, so each repo records its gap once (with
 * the reason) and then only pays it down.
 */
export function mayStillAddDebt(id, today = new Date().toISOString().slice(0, 10)) {
  const until = FAMILY.introduced?.[id];
  return typeof until === 'string' && today <= until;
}

/** Debt ids the ref did not have: new debt is refused. */
export function newDebt(repo, against) {
  if (!against) return [];
  const before = repo.readAt(against, CONFIG);
  if (before === null) return [];
  let was;
  try {
    was = JSON.parse(before).debt ?? {};
  } catch {
    return [];
  }
  return Object.keys(repo.config.debt ?? {}).filter((id) => !(id in was) && !mayStillAddDebt(id));
}

/** Runs every rule for the repo's profile. */
export function check(repo, { against = null, offline = false, only = null } = {}) {
  const ctx = { against, notes: [] };
  const debt = repo.config.debt ?? {};
  const results = [];
  for (const rule of RULES) {
    if (!rule.profiles.includes(repo.profile)) continue;
    if (only && !only.includes(rule.id)) continue;
    if (offline && rule.network) {
      results.push({ id: rule.id, status: 'skipped', problems: [], what: rule.what });
      continue;
    }
    let problems;
    try {
      problems = rule.run(repo, ctx);
    } catch (err) {
      problems = [`the check itself failed: ${err.message.split('\n')[0]}`];
    }
    const owed = rule.id in debt;
    let status = problems.length ? 'fail' : 'ok';
    if (owed && problems.length && rule.debtable !== false) status = 'debt';
    else if (owed && !problems.length) {
      status = 'fail';
      problems = [`paid: strike "${rule.id}" from the debt in ${CONFIG}`];
    } else if (owed && rule.debtable === false) problems.push(`"${rule.id}" cannot be carried as debt`);
    results.push({ id: rule.id, status, problems, what: rule.what, reason: debt[rule.id] });
  }
  const grown = newDebt(repo, against);
  if (grown.length) {
    results.push({ id: 'debt', status: 'fail', what: 'the debt list does not grow', problems: grown.map((id) => `new debt "${id}": fix it instead (the list only shrinks)`) });
  }
  for (const id of Object.keys(debt)) {
    if (!RULES.some((r) => r.id === id)) results.push({ id, status: 'fail', what: 'debt names a rule', problems: [`debt "${id}" names no rule`] });
  }
  return { results, notes: ctx.notes };
}
