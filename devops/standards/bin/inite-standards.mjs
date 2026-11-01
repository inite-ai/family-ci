#!/usr/bin/env node
// inite-standards: the family contract, checked. Run in a family repo
// (through `sh scripts/family.sh standards ...`) or across all of them.
//
//   check [--against <ref>] [--offline] [--json] [--today YYYY-MM-DD]   conformance of this repo (--today: as on that day)
//   lint [--update] [--against <ref>] [--seed]      ESLint, errors held to .inite/lint-baseline.json
//   sizes [--update] [--seed]                       the file-size ratchet alone
//   protection <owner/repo> [--apply] [--dry]       main's protection against the contract
//   ci-verdict <owner/repo> <sha>                   is this commit green on ci
//   drift [--issue] [--only a,b]                    every family repo; --issue updates the report issue
//   profile | pm | command <step> | deploy-workflows   facts the shell scripts read
//   security [--update] [--seed]                    the security sink ratchet alone
//   audit                                           High/Critical advisories in prod deps fail (.inite/audit-allow.json)
//   probe <url...> | --family [--issue]             security headers, cookies and exposed paths, from outside
//   shared-env [--update]                           (in inite-shared) the env names packages/<name>/src read, held in shared-env.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, FAMILY, RULES } from '../lib/checks.mjs';
import { drift } from '../lib/drift.mjs';
import { checkSizes, countLines, lint, LINT, seedSizes, SIZES } from '../lib/ratchets.mjs';
import { ciVerdict, protect, protectionProblems, readProtection } from '../lib/remote.mjs';
import { deployWorkflows, loadRepo, stepCommand } from '../lib/repo.mjs';
import { runAudit } from '../lib/audit.mjs';
import { probeSite, report } from '../lib/probe.mjs';
import { checkSinks, SECURITY, seedSinks } from '../lib/security.mjs';
import { scanSharedReads, SHARED_ENV } from '../lib/env-rules.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i > -1 ? rest[i + 1] : null;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--against', '--only', '--today'].includes(rest[i - 1])));

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const icon = { ok: '✓', debt: '◐', warn: '!', fail: '✗', skipped: '·' };

switch (cmd) {
  case 'check': {
    const repo = loadRepo();
    const { results, notes } = check(repo, { against: opt('--against'), offline: flag('--offline'), ...(opt('--today') ? { today: opt('--today') } : {}) });
    if (flag('--json')) {
      console.log(JSON.stringify({ profile: repo.profile, results, notes }, null, 1));
    } else {
      for (const r of results) {
        console.log(`${icon[r.status]} ${r.id}${r.status === 'debt' ? ` (debt: ${r.reason})` : ''}`);
        if (r.status === 'warn') console.log(`    warning until ${FAMILY.enforce[r.id]}, then it fails unless named as debt in .inite/standards.json:`);
        if (r.status === 'fail' || r.status === 'warn') for (const p of r.problems) console.log(`    ${p}`);
      }
      for (const n of notes) console.log(`  note: ${n}`);
    }
    const failed = results.filter((r) => r.status === 'fail');
    if (failed.length) fail(`\n✗ standards: ${failed.length} rule(s) fail. Fix them; a legacy gap is named in .inite/standards.json "debt" with its reason, once, and only shrinks.`);
    console.log(`\n✓ standards: ${repo.profile} profile, ${results.filter((r) => r.status === 'ok').length} rules met, ${results.filter((r) => r.status === 'debt').length} carried as debt${results.some((r) => r.status === 'warn') ? `, ${results.filter((r) => r.status === 'warn').length} warning(s)` : ''}`);
    break;
  }
  case 'lint': {
    const repo = loadRepo();
    if (flag('--seed') && fs.existsSync(LINT)) fail(`${LINT} exists; the record is never raised. Fix the errors.`);
    const r = lint(repo, { update: flag('--update'), seed: flag('--seed'), against: opt('--against') });
    if (r.problems.length) {
      console.error(`\n✗ lint: errors above the record (${LINT}):\n\n  ${r.problems.join('\n  ')}`);
      fail('\nFix the code. A rule that is noise for this repo is turned off in eslint.config.* with the reason beside it; the record only goes down.');
    }
    console.log(`✓ lint: ${r.files} file(s), errors within the record (${r.held} held${r.found !== undefined && r.found < r.held ? `, ${r.found} now: run with --update to lower it` : ''}), ${r.warnings} warning(s)`);
    break;
  }
  case 'sizes': {
    const repo = loadRepo();
    if (flag('--seed')) {
      if (fs.existsSync(SIZES)) fail(`${SIZES} exists; the record is never raised. Split the file.`);
      const rec = seedSizes(countLines(repo));
      fs.mkdirSync('.inite', { recursive: true });
      fs.writeFileSync(SIZES, JSON.stringify(rec, null, 1) + '\n');
      console.log(`seeded ${SIZES}: ${Object.keys(rec).length} file(s) over the limit`);
      break;
    }
    const r = checkSizes(repo, { against: opt('--against'), update: flag('--update') });
    if (r.problems.length) fail(`✗ file sizes:\n  ${r.problems.join('\n  ')}`);
    console.log(`✓ file sizes: none new over 600 lines, ${r.held} recorded`);
    break;
  }
  case 'protection': {
    const [name] = positional;
    if (!name) fail('usage: protection <owner/repo> [--apply] [--dry]', 2);
    if (flag('--apply')) {
      const done = protect(name, { dry: flag('--dry') });
      console.log(done.length ? done.map((d) => `${name}: ${d}`).join('\n') : `${name}: already meets the contract`);
    }
    const problems = protectionProblems(readProtection(name));
    if (problems.length && !flag('--dry')) fail(`✗ ${name}: ${problems.join('; ')}`);
    if (!problems.length) console.log(`✓ ${name}: main requires ci, up to date, no force push`);
    break;
  }
  case 'ci-verdict': {
    const [name, sha] = positional;
    if (!name || !sha) fail('usage: ci-verdict <owner/repo> <sha>', 2);
    const v = ciVerdict(name, sha);
    console.log(v);
    if (!v.startsWith('success')) process.exit(1);
    break;
  }
  case 'drift': {
    const only = opt('--only')?.split(',') ?? null;
    const r = drift({ issue: flag('--issue'), only });
    process.stdout.write(r.body);
    if (r.issue) console.error(`report issue: ${r.issue}`);
    break;
  }
  case 'profile':
    console.log(loadRepo().profile);
    break;
  case 'pm':
    console.log(loadRepo().pm);
    break;
  case 'command':
    console.log(stepCommand(loadRepo(), positional[0]));
    break;
  case 'deploy-workflows':
    console.log(deployWorkflows(loadRepo()).join('\n'));
    break;
  case 'shared-env': {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const now = scanSharedReads(path.join(here, '..', '..', '..', 'packages'));
    if (flag('--update')) {
      fs.writeFileSync(path.join(here, '..', 'lib', 'shared-env.json'), JSON.stringify(now, null, 1) + '\n');
      console.log(`shared-env.json: ${now.length} name(s)`);
      break;
    }
    const added = now.filter((n) => !SHARED_ENV.includes(n));
    const gone = SHARED_ENV.filter((n) => !now.includes(n));
    if (added.length || gone.length) fail(`shared-env.json is stale (+${added.join(', +') || ''} -${gone.join(', -') || ''}); run with --update`);
    console.log(`✓ shared-env.json: ${now.length} name(s)`);
    break;
  }
  case 'security': {
    const repo = loadRepo();
    if (flag('--seed')) {
      if (fs.existsSync(SECURITY)) fail(`${SECURITY} exists; the record is never raised. Fix the code.`);
      const rec = seedSinks(repo);
      fs.mkdirSync('.inite', { recursive: true });
      fs.writeFileSync(SECURITY, JSON.stringify(rec, null, 1) + '\n');
      console.log(`seeded ${SECURITY}: ${Object.entries(rec).map(([k, f]) => `${k} ${Object.keys(f).length}`).join(', ') || 'nothing'}`);
      break;
    }
    const r = checkSinks(repo, { against: opt('--against'), update: flag('--update') });
    if (r.problems.length) fail(`✗ security sinks:\n  ${r.problems.join('\n  ')}`);
    console.log(`✓ security sinks: nothing new, ${r.held} recorded`);
    break;
  }
  case 'audit': {
    const r = runAudit(loadRepo());
    if (r.problems.length) fail(`✗ dependency audit (prod):\n  ${r.problems.join('\n  ')}\n\nUpgrade, or name it in .inite/audit-allow.json with a reason and an expiry within 90 days.`);
    console.log(`✓ dependency audit: no High/Critical outside the allowance (${r.list.length} advisories of any severity)`);
    break;
  }
  case 'probe': {
    let urls = positional;
    if (flag('--family')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      urls = JSON.parse(fs.readFileSync(path.join(here, '..', 'security', 'domains.json'), 'utf8')).sites;
    }
    if (!urls.length) fail('usage: probe <url...> | --family [--issue]', 2);
    const results = [];
    for (const u of urls) results.push(await probeSite(u));
    const body = report(results);
    if (flag('--issue')) {
      const { execFileSync } = await import('node:child_process');
      const title = 'Family security scan';
      const repoName = process.env.GITHUB_REPOSITORY ?? 'inite-ai/inite-shared';
      const found = execFileSync('gh', ['issue', 'list', '--repo', repoName, '--state', 'open', '--search', `in:title "${title}"`, '--json', 'number', '-q', '.[0].number'], { encoding: 'utf8' }).trim();
      if (found) execFileSync('gh', ['issue', 'edit', found, '--repo', repoName, '--body', body]);
      else execFileSync('gh', ['issue', 'create', '--repo', repoName, '--title', title, '--body', body]);
    }
    process.stdout.write(body + '\n');
    if (!flag('--issue') && results.some((r) => r.problems.length)) process.exit(1);
    break;
  }
  case 'rules':
    for (const r of RULES) console.log(`${r.id.padEnd(18)} ${r.profiles.join('/').padEnd(18)} ${r.what}`);
    break;
  default:
    fail('usage: inite-standards check|lint|sizes|security|audit|probe|protection|ci-verdict|drift|rules|profile|pm|command|deploy-workflows', 2);
}

