// The inite-shared a repo builds against tracks the head of inite-shared's
// main: a submodule gitlink, or the commit named in a vendored tarball
// (vendor/inite-<pkg>-<version>-<sha>.tgz).
//
// A pin that is not on main fails (CI cannot clone it, and it is nobody's
// shared code). A pin more than MAX_DAYS behind main's head fails. Asking needs
// the network: gh when it is signed in, else a fetch inside the submodule;
// when neither can ask, the check says so and passes, like initeai's
// check-shared-pin.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { git } from './repo.mjs';

export const MAX_DAYS = 7;
const SHARED = 'inite-ai/inite-shared';

export function pins(repo) {
  const out = [];
  try {
    // The index, not HEAD: the commit that moves the pin must be judged by
    // the pin it carries (break3-backend, 29.10.2026, failed its own hook).
    const line = git(repo.root, ['ls-files', '-s', '--', 'inite-shared']).trim();
    const m = /^160000 ([0-9a-f]{40}) \d+\tinite-shared$/m.exec(line);
    if (m) out.push({ kind: 'submodule', what: 'inite-shared', sha: m[1] });
  } catch {
    // no index yet, or no submodule
  }
  for (const f of repo.files) {
    const m = /^vendor\/(inite-[\w-]+?)-\d+\.\d+\.\d+-([0-9a-f]{7,40})\.tgz$/.exec(f);
    if (m) out.push({ kind: 'tarball', what: f, sha: m[2] });
  }
  return out;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim();
}

/** {status, behindBy, days} from GitHub's compare, or null when gh cannot ask. */
function askGh(sha) {
  try {
    const out = gh(['api', `repos/${SHARED}/compare/${sha}...main`, '-q', '{status, behind_by: .ahead_by, base: .base_commit.commit.committer.date, head: (.commits[-1].commit.committer.date // .base_commit.commit.committer.date)}']);
    const j = JSON.parse(out);
    const days = (Date.parse(j.head) - Date.parse(j.base)) / 864e5;
    // compare base...head: "ahead" = main has commits the pin lacks; "identical"; "diverged"/"behind" = the pin has commits main lacks
    return { status: j.status, behindBy: j.behind_by, days };
  } catch {
    return null;
  }
}

/** The same from the checked-out submodule, or null. */
function askSubmodule(root, sha) {
  const dir = path.join(root, 'inite-shared');
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    git(dir, ['fetch', '-q', '--depth=300', 'origin', 'main'], { timeout: 60000 });
    const head = git(dir, ['rev-parse', 'FETCH_HEAD']).trim();
    if (head === sha) return { status: 'identical', behindBy: 0, days: 0 };
    try {
      git(dir, ['merge-base', '--is-ancestor', sha, head]);
    } catch {
      return { status: 'diverged', behindBy: null, days: null };
    }
    const behindBy = Number(git(dir, ['rev-list', '--count', `${sha}..${head}`]).trim());
    const t = (ref) => Number(git(dir, ['log', '-1', '--format=%ct', ref]).trim());
    return { status: 'ahead', behindBy, days: (t(head) - t(sha)) / 86400 };
  } catch {
    return null;
  }
}

export function verdict(pin, answer) {
  if (!answer) return { ok: true, note: `${pin.what}: could not ask inite-shared whether ${pin.sha.slice(0, 7)} is current` };
  if (answer.status === 'identical') return { ok: true };
  if (answer.status !== 'ahead') return { ok: false, problem: `${pin.what}: ${pin.sha.slice(0, 7)} is not on inite-shared's main` };
  if (answer.days !== null && answer.days > MAX_DAYS) {
    return { ok: false, problem: `${pin.what}: ${pin.sha.slice(0, 7)} is ${answer.behindBy} commit(s) and ${Math.round(answer.days)} days behind inite-shared's main (at most ${MAX_DAYS})` };
  }
  return { ok: true, note: `${pin.what}: ${answer.behindBy} commit(s) behind main, within ${MAX_DAYS} days` };
}

export function checkPins(repo) {
  const problems = [];
  const notes = [];
  for (const pin of pins(repo)) {
    const answer = askGh(pin.sha) ?? (pin.kind === 'submodule' ? askSubmodule(repo.root, pin.sha) : null);
    const v = verdict(pin, answer);
    if (!v.ok) problems.push(v.problem);
    if (v.note) notes.push(v.note);
  }
  return { problems, notes };
}
