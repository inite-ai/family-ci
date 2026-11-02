// Reading GitHub workflow files without a YAML parser: the family's
// workflows are plain, and only two facts are needed from them - which
// events start one, and which shared workflows it calls.

/** The events in a workflow's top-level `on:`. */
export function triggers(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^(?:on|"on"|'on'|true)\s*:/.test(l));
  if (at < 0) return new Set();
  const inline = lines[at].replace(/^[^:]+:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (inline) {
    return new Set(
      inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean),
    );
  }
  const events = new Set();
  let indent = null;
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const m = /^(\s+)([A-Za-z_]+)\s*:/.exec(line);
    if (!m) continue;
    if (indent === null) indent = m[1].length;
    if (m[1].length === indent) events.add(m[2]);
  }
  return events;
}

/**
 * The shared workflows a workflow calls: from inite-ai/inite-shared, or
 * from inite-ai/family-ci, its public mirror (public repos cannot call a
 * private repo's reusable workflow; devops/standards/sync-family-ci.sh).
 */
export function sharedCalls(text) {
  const out = new Set();
  for (const m of text.matchAll(/uses:\s*["']?inite-ai\/(?:inite-shared|family-ci)\/\.github\/workflows\/([\w.-]+\.ya?ml)@([\w./-]+)/g)) out.add(m[1]);
  return out;
}

/** The top-level job ids of a workflow. */
export function jobIds(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (at < 0) return [];
  const ids = [];
  let indent = null;
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const m = /^(\s+)([\w-]+)\s*:/.exec(line);
    if (!m) continue;
    if (indent === null) indent = m[1].length;
    if (m[1].length === indent) ids.push(m[2]);
  }
  return ids;
}

/** Problems with a deploy workflow under the release rule, or []. */
export function deployProblems(name, text) {
  const problems = [];
  const on = triggers(text);
  if (on.has('push')) problems.push(`${name} deploys on push; production moves on a release (on: release: types: [published]) or a dispatch`);
  if (!on.has('release')) problems.push(`${name} does not listen for release: published`);
  const calls = sharedCalls(text);
  if (!calls.has('release-gate.yml')) problems.push(`${name} does not call inite-shared's release-gate.yml (the commit must have a green ci)`);
  // deploy-compose.yml verifies inside (expect-build, www), so calling it is calling verify.
  if (!calls.has('verify-deploy.yml') && !calls.has('deploy-compose.yml')) problems.push(`${name} does not call inite-shared's verify-deploy.yml after the deploy (or deploy through deploy-compose.yml, which does)`);
  if (!/^concurrency\s*:/m.test(text)) problems.push(`${name} has no top-level concurrency group (one deploy at a time)`);
  return problems;
}

/**
 * Does this workflow reach the production host? A job on a self-hosted
 * runner (the family's runners live on the host) or a step that deploys over
 * ssh/scp/rsync to user@host, or through an ssh/scp action. Fetching over
 * ssh from GitHub (a submodule key, ssh-keyscan) is not a deploy.
 */
export function reachesHost(text) {
  const code = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  if (/^\s*runs-on\s*:[^\n]*\bself-hosted\b/m.test(code)) return true;
  if (/^\s*runs-on\s*:\s*\n(?:\s*-\s*[^\n]*\n)*?\s*-\s*["']?self-hosted\b/m.test(code)) return true;
  if (/uses:\s*["']?[\w.-]+\/(?:ssh|scp|rsync)[\w.-]*-action\b/i.test(code)) return true;
  for (const m of code.matchAll(/(?:^|[\s;&|(`"'])(ssh|scp|rsync)\s+([^\n;&|]*)/g)) {
    const args = m[2];
    if (/\bgit@github\.com\b/.test(args)) continue;
    if (/(?:^|\s)["']?[\w.${}-]+@[\w.${}-]+/.test(args)) return true;
  }
  return false;
}

/** The workflow's text says staging, and it reaches a database. */
export function stagingTouchesDb(text) {
  const code = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  return /\bstaging\b/i.test(code) && /\b(?:migrate\s+deploy|db\s+push|migrate\s+resolve|DATABASE_URL|@postgres:\d+|seed)\b/.test(code);
}
