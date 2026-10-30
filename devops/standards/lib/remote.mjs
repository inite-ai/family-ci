// What only GitHub knows: a commit's ci verdict, main's protection. Reads
// with the gh CLI; `protect` is the one writer, and it only adds.
import { execFileSync } from 'node:child_process';

export const REQUIRED = 'ci';

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}

function ghJson(args) {
  return JSON.parse(gh(args) || 'null');
}

/** Conclusions of the `ci` check runs on a commit. */
function ciRuns(repo, sha) {
  const runs = ghJson(['api', `repos/${repo}/commits/${sha}/check-runs?check_name=${REQUIRED}&per_page=20`, '-q', '[.check_runs[] | {status, conclusion}]']);
  return runs ?? [];
}

export function summarize(runs) {
  if (runs.some((r) => r.conclusion === 'success')) return 'success';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  if (runs.length) return runs[0].conclusion ?? 'unknown';
  return 'none';
}

/**
 * The ci verdict of a commit on main: its own `ci` check, else that of the
 * PR it was merged from (a squash merge is a new commit with the PR head's
 * tree, and main's strict protection made that head up to date).
 */
export function ciVerdict(repo, sha) {
  const own = summarize(ciRuns(repo, sha));
  if (own === 'success') return 'success (own check)';
  let pulls;
  try {
    pulls = ghJson(['api', `repos/${repo}/commits/${sha}/pulls`, '-q', '[.[] | select(.merged_at != null) | {number, merge_commit_sha, head: .head.sha}]']) ?? [];
  } catch (err) {
    // Say why, instead of a stack: a token without pull-requests: read is the usual cause.
    return `${own}; could not read the PR of ${sha.slice(0, 8)} (${String(err.stderr ?? err.message).trim().split('\n')[0]})`;
  }
  for (const pr of pulls) {
    if (pr.merge_commit_sha !== sha) continue;
    const v = summarize(ciRuns(repo, pr.head));
    if (v === 'success') return `success (PR #${pr.number})`;
    return `${v} (PR #${pr.number})`;
  }
  return own;
}

/** Problems with main's protection, from the API's JSON (null = unprotected). */
export function protectionProblems(p) {
  if (!p) return ['main is not protected'];
  const out = [];
  const contexts = p.required_status_checks?.contexts ?? [];
  if (!contexts.includes(REQUIRED)) out.push(`main does not require the "${REQUIRED}" check`);
  if (!p.required_status_checks?.strict) out.push('main does not require branches to be up to date');
  if (p.allow_force_pushes?.enabled) out.push('main allows force pushes');
  if (p.allow_deletions?.enabled) out.push('main can be deleted');
  return out;
}

export function readProtection(repo, branch = 'main') {
  try {
    return ghJson(['api', `repos/${repo}/branches/${branch}/protection`]);
  } catch (err) {
    if (/Branch not protected|404/.test(String(err.stderr ?? err.message))) return null;
    throw err;
  }
}

/**
 * Brings main's protection up to the contract, only ever adding: an
 * unprotected main gets the whole rule; a protected one gets `ci` added to its
 * checks and `strict` turned on, and keeps everything else it had.
 */
export function protect(repo, { dry = false, branch = 'main' } = {}) {
  const now = readProtection(repo, branch);
  const done = [];
  if (!now) {
    const body = {
      required_status_checks: { strict: true, checks: [{ context: REQUIRED }] },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    };
    if (!dry) gh(['api', '-X', 'PUT', `repos/${repo}/branches/${branch}/protection`, '--input', '-'], JSON.stringify(body));
    done.push('protected main: requires ci, up to date, no force push, no deletion, admins included');
    return done;
  }
  const contexts = now.required_status_checks?.contexts ?? [];
  if (!now.required_status_checks) {
    if (!dry) gh(['api', '-X', 'PATCH', `repos/${repo}/branches/${branch}/protection/required_status_checks`, '--input', '-'], JSON.stringify({ strict: true, contexts: [REQUIRED] }));
    done.push('added required checks: ci, strict');
  } else {
    if (!contexts.includes(REQUIRED)) {
      if (!dry) gh(['api', '-X', 'POST', `repos/${repo}/branches/${branch}/protection/required_status_checks/contexts`, '--input', '-'], JSON.stringify({ contexts: [REQUIRED] }));
      done.push(`added "${REQUIRED}" beside ${contexts.join(', ') || 'no other check'}`);
    }
    if (!now.required_status_checks.strict) {
      if (!dry) gh(['api', '-X', 'PATCH', `repos/${repo}/branches/${branch}/protection/required_status_checks`, '-F', 'strict=true']);
      done.push('turned on "up to date before merging"');
    }
  }
  if (now.allow_force_pushes?.enabled) done.push('force pushes are allowed and were left as they are: turning them off rewrites the whole rule, do it in the settings');
  return done;
}

/** The newest published release and how its deploy runs ended. */
export function lastRelease(repo) {
  try {
    const rel = ghJson(['release', 'list', '--repo', repo, '--limit', '1', '--exclude-drafts', '--json', 'tagName,publishedAt', '-q', '.[0]']);
    return rel ?? null;
  } catch {
    return null;
  }
}

export { gh };
