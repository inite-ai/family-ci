// The two records that only go down: big files and lint errors. Ported from
// initeai's scripts/check-file-sizes.mjs and scripts/check-lint.mjs.
//
// - A file over LIMIT lines that the record does not hold fails; a held file
//   fails when it grew past its record. `--update` lowers the record.
// - Lint: an error count per file and rule above the record fails (a file or
//   rule the record does not hold is 0). `--update` lowers the record.
// - Against a ref, neither record may rise: raising a number is the same as
//   raising the limit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { git } from './repo.mjs';

export const LIMIT = 600;
export const SIZES = '.inite/file-size-baseline.json';
export const LINT = '.inite/lint-baseline.json';

const CODE = /\.(?:[cm]?[jt]sx?|py)$/;
const OUT = [
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|spec|fixtures|vendor|generated|migrations|locales|public|node_modules|dist|build|\.next)\//,
  /\.(?:test|spec)\.[^/]+$/,
  /\.d\.ts$/,
  /\.min\.js$/,
  /(?:^|\/)test_[^/]+\.py$/,
];

export function inSizeScope(p, extraOut = []) {
  if (!CODE.test(p)) return false;
  if (p.startsWith('inite-shared/')) return false;
  return !OUT.some((re) => re.test(p)) && !extraOut.some((re) => re.test(p));
}

/** Line counts of the staged blobs of the files in scope. */
export function countLines(repo) {
  const extra = (repo.config.sizes?.exclude ?? []).map((s) => new RegExp(s));
  const paths = repo.files.filter((p) => inSizeScope(p, extra));
  const lines = new Map();
  if (!paths.length) return lines;
  const raw = execFileSync('git', ['cat-file', '--batch'], { cwd: repo.root, input: paths.map((p) => `:${p}`).join('\n') + '\n', maxBuffer: 1 << 30 });
  let at = 0;
  for (const p of paths) {
    const nl = raw.indexOf(10, at);
    const header = raw.subarray(at, nl).toString();
    at = nl + 1;
    if (header.endsWith('missing')) continue;
    const size = Number(header.split(' ')[2]);
    const body = raw.subarray(at, at + size);
    at += size + 1;
    let n = 0;
    for (const b of body) if (b === 10) n++;
    if (size && body[size - 1] !== 10) n++;
    lines.set(p, n);
  }
  return lines;
}

function readRecord(repo, file) {
  const text = repo.read(file);
  return text ? JSON.parse(text) : {};
}

function recordAt(repo, ref, file) {
  if (!ref) return null;
  const text = repo.readAt(ref, file);
  return text ? JSON.parse(text) : null;
}

/** Problems with file sizes; with update, writes the lowered record. */
export function checkSizes(repo, { against = null, update = false } = {}) {
  const lines = countLines(repo);
  const record = readRecord(repo, SIZES);
  const problems = [];
  const before = recordAt(repo, against, SIZES);
  if (before) {
    for (const [p, n] of Object.entries(record)) {
      if (before[p] === undefined) problems.push(`${SIZES} adds ${p} (${n}), which ${against} does not hold`);
      else if (n > before[p]) problems.push(`${SIZES} raises ${p} from ${before[p]} to ${n}`);
    }
  }
  for (const [p, n] of lines) {
    if (n <= LIMIT) continue;
    const was = record[p];
    if (was === undefined) problems.push(`${p}: ${n} lines, a new file over ${LIMIT}; split it`);
    else if (n > was) problems.push(`${p}: ${n} lines, up from ${was}; move ${n - was} out before adding`);
  }
  if (update && !problems.length) writeRecord(repo, SIZES, lowerSizes(record, lines));
  return { problems, held: Object.keys(record).length };
}

export function lowerSizes(record, lines) {
  const next = {};
  for (const p of Object.keys(record).sort()) {
    const n = lines.get(p);
    if (n !== undefined && n > LIMIT) next[p] = Math.min(n, record[p]);
  }
  return next;
}

/** A first record: every file over the limit as it is today. */
export function seedSizes(lines) {
  const next = {};
  for (const [p, n] of [...lines].sort(([a], [b]) => a.localeCompare(b))) if (n > LIMIT) next[p] = n;
  return next;
}

function writeRecord(repo, file, value) {
  const text = JSON.stringify(value, null, 1) + '\n';
  const full = path.join(repo.root, file);
  if (Object.keys(value).length === 0 && !fs.existsSync(full)) return;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== text) fs.writeFileSync(full, text);
}

function eslintBin(root) {
  const local = path.join(root, 'node_modules', '.bin', 'eslint');
  return fs.existsSync(local) ? [local, []] : ['npx', ['--no-install', 'eslint']];
}

/** ESLint's JSON report for the repo (cached by content in node_modules/.cache). */
export function runEslint(repo) {
  const [bin, pre] = eslintBin(repo.root);
  const targets = repo.config.lint?.paths ?? ['.'];
  const argv = [...pre, '--cache', '--cache-strategy', 'content', '--cache-location', 'node_modules/.cache/eslint/', '--format', 'json', ...targets];
  let out;
  try {
    out = execFileSync(bin, argv, { cwd: repo.root, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    if (!err.stdout) throw err;
    out = err.stdout;
  }
  return JSON.parse(out);
}

/** path -> rule -> errors, from an ESLint report. */
export function countErrors(results, root) {
  const found = {};
  let warnings = 0;
  for (const r of results) {
    const p = path.relative(root, r.filePath);
    for (const m of r.messages) {
      if (m.severity === 2 || m.fatal) {
        const rule = m.ruleId ?? (m.fatal ? 'parse-error' : 'eslint-directive');
        (found[p] ??= {})[rule] = (found[p]?.[rule] ?? 0) + 1;
      } else warnings++;
    }
  }
  return { found, warnings };
}

export function compareLint(found, record) {
  const problems = [];
  for (const [p, rules] of Object.entries(found)) {
    for (const [rule, n] of Object.entries(rules)) {
      const was = record[p]?.[rule] ?? 0;
      if (n > was) problems.push(`${p}: ${n} × ${rule}, the record holds ${was}`);
    }
  }
  return problems;
}

export function lowerLint(record, found) {
  const next = {};
  for (const p of Object.keys(record).sort()) {
    for (const [rule, n] of Object.entries(record[p])) {
      const now = Math.min(n, found[p]?.[rule] ?? 0);
      if (now > 0) (next[p] ??= {})[rule] = now;
    }
  }
  return next;
}

export function lintRecordRises(record, before) {
  const problems = [];
  if (!before) return problems;
  for (const [p, rules] of Object.entries(record)) {
    for (const [rule, n] of Object.entries(rules)) {
      const was = before[p]?.[rule] ?? 0;
      if (n > was) problems.push(`${LINT} raises ${p} ${rule} from ${was} to ${n}`);
    }
  }
  return problems;
}

export function checkLintRecord(repo, against) {
  return lintRecordRises(readRecord(repo, LINT), recordAt(repo, against, LINT));
}

/** `inite-standards lint`: run ESLint and hold its errors to the record. */
export function lint(repo, { update = false, seed = false, against = null } = {}) {
  const results = runEslint(repo);
  const { found, warnings } = countErrors(results, repo.root);
  const record = readRecord(repo, LINT);
  if (seed) {
    writeRecord(repo, LINT, found);
    return { problems: [], files: results.length, held: total(found), warnings };
  }
  const problems = [...lintRecordRises(record, recordAt(repo, against, LINT)), ...compareLint(found, record)];
  if (update && !problems.length) writeRecord(repo, LINT, lowerLint(record, found));
  return { problems, files: results.length, held: total(record), found: total(found), warnings };
}

export function total(record) {
  return Object.values(record).reduce((s, rules) => s + Object.values(rules).reduce((a, b) => a + b, 0), 0);
}

export { git };
