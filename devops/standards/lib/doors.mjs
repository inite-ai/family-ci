// Every door to the production host goes through the release gate.
//
// 01.11.2026: nine repos kept a `manual-deploy.yml` beside their gated
// deploy. It ran on a dispatch from any branch, with no release gate, no
// verify and no concurrency, built `:latest` and restarted the app on the
// host. Its "staging" choice used the production database and ran
// `prisma migrate deploy` from branch code. The standards never saw it: the
// release rule read only `deploy*.yml`.
//
// A workflow is a deploy when it reaches the host: a job on a self-hosted
// runner (the family's runners live on the host), or a step that deploys
// over ssh. Each such workflow
//   - listens for `release: published` (a dispatch of a released tag is the
//     hotfix and rollback door), calls inite-shared's release-gate.yml and
//     verify-deploy.yml, and has a top-level concurrency group;
//   - is never a dispatch-only "staging" that reaches a database: staging,
//     if it is wanted, gets its own database and its own image tag. That
//     problem cannot be carried as debt.
// The one exemption is a read-only ops workflow (a diagnostic), named in
// .inite/standards.json `host.ops` as { "file.yml": "<why, 8+ characters>" }.
// An ops workflow that starts containers, migrates or seeds is not read-only.
import { declaredDeploys, hostDoors } from './repo.mjs';
import { deployProblems, reachesHost, selfHostedJob, stagingTouchesDb, triggers } from './workflows.mjs';

const STAGING = 'dispatch-only staging';
const WRITES = /\b(?:docker[- ]compose\b[^\n]*\bup\b|docker\s+run\b|migrate\s+(?:deploy|resolve)\b|db\s+push\b|seed\b)/;

/** Problems of one door, by its name and text. */
export function doorProblems(name, text) {
  const out = [];
  if (!triggers(text).has('release') && stagingTouchesDb(text)) {
    out.push(`${name}: ${STAGING} that reaches a database is refused; staging gets its own database and image tag, or goes`);
  }
  return [...out, ...deployProblems(name, text)];
}

export const DOOR_RULE = {
  id: 'deploy-every-door',
  profiles: ['next', 'node', 'python'],
  // Debt covers a door not yet on the release path, never a staging run
  // against a production database.
  debtable: (problems) => !problems.some((p) => p.includes(STAGING)),
  what: 'every workflow that reaches the host (self-hosted job or ssh deploy) goes through the release gate, verify and a concurrency group; no dispatch-only staging on a real database',
  run(repo) {
    const out = [];
    const ops = repo.config.host?.ops ?? {};
    for (const [wf, why] of Object.entries(ops)) {
      const text = repo.read(`.github/workflows/${wf}`);
      if (typeof why !== 'string' || why.trim().length < 8) out.push(`host.ops "${wf}" needs its reason beside it`);
      else if (text === null) out.push(`host.ops names .github/workflows/${wf}, which is missing; strike it`);
      else if (!reachesHost(text)) out.push(`host.ops names ${wf}, which does not reach the host; strike it`);
      else if (WRITES.test(text.replace(/^\s*#.*$/gm, ''))) out.push(`host.ops: ${wf} starts containers, migrates or seeds, so it is a deploy, not read-only ops`);
    }
    const declared = new Set(declaredDeploys(repo));
    for (const wf of hostDoors(repo)) {
      const text = repo.read(`.github/workflows/${wf}`) ?? '';
      // A declared deploy is already held to the release rule by deploy-on-release.
      const problems = doorProblems(wf, text);
      out.push(...(declared.has(wf) ? problems.filter((p) => p.includes(STAGING)) : problems));
    }
    return out;
  },
};

// A pull request is tested on GitHub's runners, never on the host's.
//
// 06.11.2026: content-generator's e2e.yml ran a pull request on
// [self-hosted, sfo] - a webpack build, a Postgres and a Playwright browser on
// the production host's four cores and 15 GB. The host swapped to a stop
// (load 167) and inite.ai and the other sites on it went unanswered until the
// run was cancelled. A pull request is anyone's branch and any amount of work;
// the host's runner is there to deploy. Not debt: a repo moves the job to
// `ubuntu-latest` (private packages through a token, as ci.yml does).
const PR_EVENTS = ['pull_request', 'pull_request_target'];

/** Problems of one workflow under ci-off-the-host, by its name and text. */
export function prOnHostProblems(name, text) {
  const on = triggers(text);
  const pr = PR_EVENTS.filter((e) => on.has(e));
  if (!pr.length || !selfHostedJob(text)) return [];
  return [`${name}: runs on ${pr.join(', ')} with a job on a self-hosted runner, the production host; a pull request runs on GitHub's runners (runs-on: ubuntu-latest)`];
}

export const PR_HOST_RULE = {
  id: 'ci-off-the-host',
  profiles: ['next', 'node', 'python'],
  debtable: () => false,
  what: "a workflow a pull request starts runs on GitHub's runners, never on the production host's self-hosted runner",
  run(repo) {
    const out = [];
    for (const f of repo.files.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x))) {
      out.push(...prOnHostProblems(f.replace(/^\.github\/workflows\//, ''), repo.read(f) ?? ''));
    }
    return out;
  },
};
