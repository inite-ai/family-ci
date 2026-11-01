// The weekly look across the family: each repo in family.json cloned at
// main's head, checked, its protection and last release read, and one
// report written - to stdout, or to the one open "Family drift report"
// issue in inite-shared (opened when there is none).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { check, FAMILY } from './checks.mjs';
import { gh, lastRelease, protectionProblems, readProtection } from './remote.mjs';
import { loadRepo } from './repo.mjs';

export const TITLE = 'Family drift report';
const ORG = 'inite-ai';

function clone(name, into) {
  execFileSync('gh', ['repo', 'clone', `${ORG}/${name}`, into, '--', '--depth', '1', '-q'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300000 });
}

export function auditRepo(name, workdir) {
  const dir = path.join(workdir, name);
  const row = { name, results: [], notes: [], protection: [], release: null, error: null };
  try {
    clone(name, dir);
    const out = check(loadRepo(dir));
    row.results = out.results;
    row.notes = out.notes;
  } catch (err) {
    row.error = `could not clone or check: ${String(err.stderr ?? err.message).split('\n')[0]}`;
  }
  try {
    row.protection = protectionProblems(readProtection(`${ORG}/${name}`));
  } catch (err) {
    row.protection = [`could not read protection: ${String(err.message).split('\n')[0]}`];
  }
  row.release = lastRelease(`${ORG}/${name}`);
  return row;
}

const mark = { ok: '✓', debt: '◐', warn: '!', fail: '✗', skipped: '·' };

export function renderReport(rows, when = new Date()) {
  const ids = [...new Set(rows.flatMap((r) => r.results.map((x) => x.id)))];
  const lines = [];
  lines.push(`Run ${when.toISOString().slice(0, 10)} by \`inite-standards drift\` (inite-shared/devops/standards). ✓ conforms, ◐ named debt, ! warning before the rule's enforce date, ✗ drift, · not checked.`);
  lines.push('');
  const failing = rows.filter((r) => r.error || r.protection.length || r.results.some((x) => x.status === 'fail'));
  lines.push(`**${rows.length - failing.length} of ${rows.length} repos conform** (debt allowed).`);
  lines.push('');
  lines.push(`| repo | ${ids.join(' | ')} | protection | last release |`);
  lines.push(`|---|${ids.map(() => ':-:').join('|')}|:-:|---|`);
  for (const r of rows) {
    const cells = ids.map((id) => mark[r.results.find((x) => x.id === id)?.status] ?? (r.error ? '?' : ''));
    const rel = r.release ? `${r.release.tagName}` : 'none';
    lines.push(`| ${r.name} | ${cells.join(' | ')} | ${r.protection.length ? '✗' : '✓'} | ${rel} |`);
  }
  lines.push('');
  lines.push('## Drift');
  for (const r of rows) {
    const items = [
      ...(r.error ? [r.error] : []),
      ...r.protection,
      ...r.results.filter((x) => x.status === 'fail').flatMap((x) => x.problems.map((p) => `${x.id}: ${p}`)),
    ];
    if (!items.length) continue;
    lines.push(`### ${r.name}`);
    for (const i of items.slice(0, 10)) lines.push(`- ${i.slice(0, 300)}`);
    if (items.length > 10) lines.push(`- … and ${items.length - 10} more (\`sh scripts/family.sh standards check\` in the repo lists them)`);
  }
  lines.push('');
  lines.push('## Debt (named, shrinking)');
  for (const r of rows) {
    const owed = r.results.filter((x) => x.status === 'debt');
    if (!owed.length) continue;
    lines.push(`- **${r.name}**: ${owed.map((x) => `${x.id} (${x.reason})`).join('; ')}`);
  }
  return lines.join('\n') + '\n';
}

export function drift({ issue = false, only = null } = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-drift-'));
  const names = FAMILY.repos.filter((r) => !r.own).map((r) => r.repo).filter((n) => !only || only.includes(n));
  const rows = [];
  try {
    for (const name of names) rows.push(auditRepo(name, workdir));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
  const own = FAMILY.repos.filter((r) => r.own).map((r) => `- **${r.repo}** ${r.own}`);
  const body = renderReport(rows) + (own.length ? `\n## Outside the family gate\n${own.join('\n')}\n` : '');
  if (!issue) return { body, rows };
  // GitHub refuses an issue body over 65,536 characters (29.10.2026, once
  // the security rules listed every unpinned action).
  const LIMIT = 60000;
  const posted = body.length > LIMIT ? `${body.slice(0, LIMIT)}\n\n… cut at ${LIMIT} characters; run \`inite-standards drift\` for the whole report.\n` : body;
  const repo = `${ORG}/inite-shared`;
  const open = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--search', `"${TITLE}" in:title`, '--json', 'number,title']) || '[]').find((i) => i.title === TITLE);
  if (open) gh(['issue', 'edit', String(open.number), '--repo', repo, '--body-file', '-'], posted);
  else gh(['issue', 'create', '--repo', repo, '--title', TITLE, '--body-file', '-'], posted);
  return { body, rows, issue: open?.number ?? 'new' };
}
