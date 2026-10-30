// Dependency audit: High and Critical advisories in what ships (prod
// dependencies) fail, unless named in .inite/audit-allow.json with a reason
// and a date it expires. An expired entry fails too, so an allowance is a
// deadline, not a silence.
//
//   [{ "advisory": "GHSA-xxxx-xxxx-xxxx", "package": "next", "reason": "fixed in 16.4.1, upgrade PR #12", "expires": "2026-11-15" }]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ALLOW = '.inite/audit-allow.json';
const BAD = new Set(['high', 'critical']);

/** Advisories from `npm audit --json` (v7+) or `pnpm audit --json`, normalised. Pure, for tests. */
export function advisories(json) {
  const out = [];
  if (json?.advisories) {
    // pnpm (and npm v6) shape
    for (const a of Object.values(json.advisories)) {
      out.push({ advisory: a.github_advisory_id ?? String(a.id), package: a.module_name, severity: a.severity, title: a.title, fixed: a.patched_versions });
    }
  } else if (json?.vulnerabilities) {
    for (const v of Object.values(json.vulnerabilities)) {
      for (const via of v.via ?? []) {
        if (typeof via !== 'object') continue;
        const id = /GHSA-[\w-]+/.exec(via.url ?? '')?.[0] ?? String(via.source);
        out.push({ advisory: id, package: via.name ?? v.name, severity: via.severity ?? v.severity, title: via.title, fixed: typeof v.fixAvailable === 'object' ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : v.fixAvailable ? 'yes' : 'no' });
      }
    }
  }
  const seen = new Set();
  return out.filter((a) => (seen.has(a.advisory + a.package) ? false : seen.add(a.advisory + a.package)));
}

export function auditProblems(list, allow = [], today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  for (const e of allow) {
    if (!e.reason || e.reason.length < 8) out.push(`${ALLOW}: ${e.advisory ?? e.package} needs a reason`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '')) out.push(`${ALLOW}: ${e.advisory ?? e.package} needs an "expires" date (YYYY-MM-DD)`);
    else if (e.expires < today) out.push(`${ALLOW}: ${e.advisory ?? e.package} expired on ${e.expires}; upgrade or renew it with a new reason`);
    else if (e.expires > new Date(Date.parse(today) + 90 * 86400000).toISOString().slice(0, 10)) out.push(`${ALLOW}: ${e.advisory ?? e.package} is allowed past 90 days`);
  }
  for (const a of list) {
    if (!BAD.has(a.severity)) continue;
    const ok = allow.some((e) => (e.advisory ? e.advisory === a.advisory : e.package === a.package) && /^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '') && e.expires >= today);
    if (!ok) out.push(`${a.severity}: ${a.package} ${a.advisory} ${a.title ?? ''} (fix: ${a.fixed ?? '?'})`.trim());
  }
  return out;
}

export function runAudit(repo) {
  const cmd = repo.pm === 'pnpm' ? ['pnpm', ['audit', '--prod', '--json']] : repo.pm === 'yarn' ? ['npm', ['audit', '--omit=dev', '--json']] : ['npm', ['audit', '--omit=dev', '--json']];
  let text;
  try {
    text = execFileSync(cmd[0], cmd[1], { cwd: repo.root, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    text = e.stdout; // audit exits non-zero when it finds anything
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { problems: [`${cmd[0]} audit gave no JSON (is the lockfile installed?)`], list: [] };
  }
  const file = path.join(repo.root, ALLOW);
  const allow = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const list = advisories(json);
  return { problems: auditProblems(list, allow), list };
}
