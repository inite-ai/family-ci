// The family security baseline, as checks (.planning/family-security-baseline-2026-10.md).
//
// Two kinds:
//   - posture rules, each a list of problems like the rest of checks.mjs:
//     actions pinned by SHA, least-privilege permissions, no pull_request_target
//     running the PR's code, containers not root, grouped dependency updates;
//   - the sink ratchet: risky code shapes counted per file and held to
//     .inite/security-baseline.json, which only goes down. A new file with a
//     raw fetch of a dynamic URL, an unsigned webhook, a mutation without an
//     authz call, an unscoped lookup by id, raw SQL or dangerouslySetInnerHTML
//     fails; legacy ones are named in the record and shrink.
//
// A line that is right as it stands says so beside it, with the reason:
//   // security: <rule> <reason of 8+ characters>
// e.g. `// security: raw-fetch BILLING_URL is our own service from env`.
import fs from 'node:fs';
import path from 'node:path';

export const SECURITY = '.inite/security-baseline.json';

const FAMILY_ACTIONS = /^inite-ai\//;
const SHA = /@[0-9a-f]{40}(?:\s|$)/;

/** `uses:` lines that are not pinned to a commit. Local (./) and the family's own (inite-ai/*) are exempt. */
export function unpinnedUses(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*-?\s*uses:\s*['"]?([^'"\s#]+)/.exec(line);
    if (!m) return;
    const ref = m[1];
    if (ref.startsWith('./') || ref.startsWith('docker://') || FAMILY_ACTIONS.test(ref)) return;
    if (!SHA.test(`${ref} `)) out.push({ line: i + 1, ref });
  });
  return out;
}

/** Jobs with no permissions when the workflow has none at the top. */
export function permissionProblems(text) {
  if (/^permissions:/m.test(text)) return [];
  const jobs = text.split(/^jobs:\s*$/m)[1];
  if (!jobs) return ['no top-level permissions:'];
  // Only a line `  <id>:` starts a job; comment lines and blank lines between
  // jobs belong to no job (a comment before the first job was read as a job
  // id: "job(s) # Only a commit main took ... set none").
  const blocks = jobs
    .split(/^ {2}(?=[A-Za-z0-9_-]+:\s*$)/m)
    .filter((b) => /^[A-Za-z0-9_-]+:\s*$/m.test(b.split('\n')[0]));
  const missing = blocks.filter((b) => !/^\s{4}permissions:/m.test(b) && !/^\s{4}uses:/m.test(b)).map((b) => b.split(':')[0].trim());
  return missing.length ? [`no top-level permissions: and job(s) ${missing.join(', ')} set none`] : [];
}

/** pull_request_target that checks out or runs the PR's code: the classic "pwn request". */
export function prTargetProblems(text) {
  if (!/pull_request_target/.test(text)) return [];
  const out = [];
  if (/github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref|refs\/pull\/.*\/(head|merge)/.test(text) && /actions\/checkout/.test(text)) {
    out.push("pull_request_target checks out the PR's head: fork code would run with this repo's token and secrets");
  }
  // `KEY: ${{ github.event.pull_request.title }}` (env:, with:, if:) is data; anywhere else it is pasted into a script.
  const pasted = text
    .split('\n')
    .filter((l) => /\$\{\{\s*github\.event\.pull_request\.(?:title|body|head\.ref|head\.label)/.test(l) && !/^\s*-?\s*[A-Za-z_][\w-]*:\s*['"]?\$\{\{/.test(l));
  if (pasted.length) out.push('pull_request_target interpolates PR text into a run: script (pass it through env:)');
  return out;
}

function workflows(repo) {
  return repo.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
}

function dockerfiles(repo) {
  return repo.files.filter((f) => /(?:^|\/)Dockerfile[^/]*$/.test(f) && !f.startsWith('inite-shared/') && !/(?:^|\/)(?:vendor|node_modules|test|tests|fixtures)\//.test(f));
}

/** The USER of a Dockerfile's final stage, or null when it never sets one (root). */
export function finalUser(text) {
  const stages = text.split(/^FROM\s/im);
  const last = stages[stages.length - 1] ?? '';
  const users = [...last.matchAll(/^USER\s+(\S+)/gim)].map((m) => m[1]);
  return users.length ? users[users.length - 1] : null;
}

export const SECURITY_RULES = [
  {
    id: 'actions-pinned',
    profiles: ['next', 'node', 'python'],
    what: "third-party actions are pinned to a commit SHA (a tag can be moved under you; inite-ai/* is the family's own)",
    run(repo) {
      const out = [];
      for (const f of workflows(repo)) for (const u of unpinnedUses(repo.read(f) ?? '')) out.push(`${f}:${u.line}: ${u.ref} is not pinned to a SHA`);
      return out;
    },
  },
  {
    id: 'actions-permissions',
    profiles: ['next', 'node', 'python'],
    what: 'every workflow states its token permissions (least privilege)',
    run(repo) {
      return workflows(repo).flatMap((f) => permissionProblems(repo.read(f) ?? '').map((p) => `${f}: ${p}`));
    },
  },
  {
    id: 'pr-target',
    profiles: ['next', 'node', 'python'],
    debtable: false,
    what: 'no pull_request_target workflow runs or interpolates the PR',
    run(repo) {
      return workflows(repo).flatMap((f) => prTargetProblems(repo.read(f) ?? '').map((p) => `${f}: ${p}`));
    },
  },
  {
    id: 'container-user',
    profiles: ['next', 'node', 'python'],
    what: 'every Dockerfile runs its final stage as a non-root USER',
    run(repo) {
      const out = [];
      for (const f of dockerfiles(repo)) {
        const u = finalUser(repo.read(f) ?? '');
        if (!u) out.push(`${f}: the final stage never sets USER, so it runs as root`);
        else if (/^(root|0)(:|$)/.test(u)) out.push(`${f}: USER ${u}`);
      }
      return out;
    },
  },
  {
    id: 'dependency-updates',
    profiles: ['next', 'node', 'python'],
    what: 'Dependabot (or Renovate) keeps dependencies and actions current, grouped',
    run(repo) {
      const dep = repo.read('.github/dependabot.yml') ?? repo.read('.github/dependabot.yaml');
      if (dep !== null) {
        const out = [];
        if (!/package-ecosystem:\s*['"]?github-actions/.test(dep)) out.push('dependabot.yml does not update github-actions');
        if (!/^\s+groups:/m.test(dep)) out.push('dependabot.yml has no groups: (one PR per family of updates, not fifty)');
        return out;
      }
      if (repo.has('renovate.json') || repo.has('.github/renovate.json')) return [];
      return ['no .github/dependabot.yml or renovate.json'];
    },
  },
  {
    id: 'security-sinks',
    profiles: ['next', 'node'],
    debtable: false,
    what: `risky code shapes (raw fetch, raw SQL, innerHTML, unsigned webhooks, unauthorised mutations, unscoped lookups) only shrink (${SECURITY})`,
    run: (repo, ctx) => checkSinks(repo, { against: ctx.against }).problems,
  },
];

// ---- the sink ratchet ----------------------------------------------------

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|coverage|__tests__|__mocks__|e2e|tests?|fixtures|scripts\/oneoff)\/|\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$/;
const MARK = (id) => new RegExp(`(?:\\/\\/|\\/\\*|\\{\\/\\*)\\s*security:\\s*${id}\\s+\\S.{7,}`);

const AUTHZ = /\b(?:require[A-Z]\w*|assert(?:Member|Admin|Owner|Access|InTenant)\w*|with(?:Auth|Admin|Session|Company|ApiKey|Door|McpDoor)\w*|auth|getSession|getServerSession|currentUser|getCurrentUser|getAuthContext|authorize|apiHandler|verifyWebhook|verifyHmac|verifySignature)\s*\(/;
// A where with one of these is scoped to its owner.
const OWNER_KEY = /\b(?:companyId|tenantId|orgId|organizationId|workspaceId|accountId|userId|ownerId|customerId|memberId|projectId)\b/;
// Within a few lines before a lookup by id, one of these checks the row against the session.
const ROW_CHECK = /\b(?:requireEntityAccess|requirePermission|requireCompanyAccess|requireRole|assertInTenant|requireOwner|scoped)\s*\(/;
const PUBLIC_MARK = /export\s+const\s+access\s*=\s*['"]public['"]|security:\s*public\s+\S.{7,}/;
const WEBHOOK_VERIFY = /verify\w*Signature|verifyWebhook|verifyHmac|timingSafeEqual|constructEvent|createHmac|x-hub-signature|x-telegram-bot-api-secret-token|svix|webhooks\.verify/i;

function lines(text) {
  return text.split('\n');
}

/** Per-file counts of each sink in one source text. Pure, for tests. */
export function sinksIn(file, text) {
  const ls = lines(text);
  const count = (re, id, skip = () => false) => ls.filter((l, i) => re.test(l) && !MARK(id).test(l) && !MARK(id).test(ls[i - 1] ?? '') && !skip(l)).length;
  const found = {};
  const imports = (name) => new RegExp(`from\\s+['"]@inite/security(?:/(?:web|server))?['"]`).test(text) && new RegExp(`\\b${name}\\b`).test(text);

  found['inner-html'] = count(/dangerouslySetInnerHTML/, 'inner-html', (l) => /renderSafeMarkdown|jsonForScript|escapeHtml/.test(l));
  found['raw-sql'] = count(/\$(?:query|execute)RawUnsafe\s*\(|\.(?:query|raw)\(\s*`[^`]*\$\{|sequelize\.query\(\s*`[^`]*\$\{/, 'raw-sql');
  const serverish = /(?:^|\/)(?:app\/api|pages\/api|src\/app\/api|lib|src\/lib|server|src\/server|src\/modules|src\/services|services|actions|src\/actions)\//.test(file) || /['"]use server['"]/.test(text);
  if (serverish && !imports('safeFetch')) {
    // fetch( whose first argument is not a plain string literal
    found['raw-fetch'] = count(/(?<![.\w])fetch\(\s*(?!['"][^'"$]*['"]\s*[,)])(?!`[^`$]*`\s*[,)])[^)\s]/, 'raw-fetch');
  }
  const isRoute = /(?:^|\/)route\.[cm]?[jt]s$/.test(file) || /(?:^|\/)pages\/api\//.test(file) || /\.controller\.[jt]s$/.test(file);
  const mutates = /export\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|DELETE)\b|@(?:Post|Put|Patch|Delete)\(/.test(text);
  // A server-action module: the directive is the file's first statement (inline actions in a page are counted where they call into).
  const action = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use server['"]/.test(text);
  // A receiver: under a webhook(s) path, takes a POST, and is not a signed-in route (those manage webhooks; route-authz covers them).
  const receiver = /(?:^|\/)webhooks?(?:\/|$)|webhook\/route\.|webhook\.controller\./i.test(file) && mutates && !AUTHZ.test(text.replace(WEBHOOK_VERIFY, ''));
  if (receiver) found['webhook-unsigned'] = WEBHOOK_VERIFY.test(text) || MARK('webhook-unsigned').test(text) ? 0 : 1;
  else if ((isRoute && mutates) || action) found['route-authz'] = AUTHZ.test(text) || PUBLIC_MARK.test(text) || /@UseGuards\(/.test(text) || MARK('route-authz').test(text) ? 0 : 1;
  if (isRoute || action) {
    let n = 0;
    ls.forEach((l, i) => {
      if (!/\.(?:findUnique|findUniqueOrThrow|findFirst|update|delete)\(\s*\{\s*where:\s*\{\s*id\b/.test(l)) return;
      const where = [l, ls[i + 1] ?? '', ls[i + 2] ?? ''].join(' ').split(/\}\s*[,)]/)[0];
      if (OWNER_KEY.test(where)) return;
      if (ls.slice(Math.max(0, i - 8), i + 1).some((x) => ROW_CHECK.test(x))) return;
      if (MARK('tenant-unscoped').test(l) || MARK('tenant-unscoped').test(ls[i - 1] ?? '')) return;
      n++;
    });
    found['tenant-unscoped'] = n;
  }
  for (const k of Object.keys(found)) if (!found[k]) delete found[k];
  return found;
}

/** { sink: { file: count } } for the repo's tracked source. */
export function countSinks(repo) {
  const rec = {};
  for (const f of repo.files) {
    if (!SOURCE.test(f) || SKIP.test(f)) continue;
    const text = repo.read(f);
    if (text === null || text.length > 2_000_000) continue;
    for (const [k, n] of Object.entries(sinksIn(f, text))) (rec[k] ??= {})[f] = n;
  }
  return rec;
}

function readRecord(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Problems: a sink above its record (or new), and a record that rose against the ref. */
export function compareSinks(found, record, before = null) {
  const out = [];
  for (const [k, files] of Object.entries(found)) {
    for (const [f, n] of Object.entries(files)) {
      const held = record?.[k]?.[f] ?? 0;
      if (n > held) out.push(`${f}: ${k} ${n}${held ? ` (record ${held})` : ''}: ${HOW[k]}`);
    }
  }
  if (before) {
    for (const [k, files] of Object.entries(record ?? {})) {
      for (const [f, n] of Object.entries(files)) {
        if (n > (before[k]?.[f] ?? 0)) out.push(`${SECURITY}: ${k} for ${f} rose to ${n}; the record only goes down`);
      }
    }
  }
  return out;
}

export const HOW = {
  'inner-html': 'render through renderSafeMarkdown/jsonForScript from @inite/security/web, or mark `// security: inner-html <why the HTML is ours>`',
  'raw-sql': 'use Prisma.sql / tagged $queryRaw, never string-built SQL',
  'raw-fetch': 'fetch a URL someone else chose through safeFetch (@inite/security/server); our own service from env: `// security: raw-fetch <which service>`',
  'webhook-unsigned': 'verify the signature on the raw body (verifyWebhook / verifyHmac) before acting',
  'route-authz': 'call the auth/membership check, or `export const access = "public"` with the reason beside it',
  'tenant-unscoped': "a lookup by id goes through scoped() or checks the row's tenant against the session",
};

export function checkSinks(repo, { against = null, update = false } = {}) {
  const found = countSinks(repo);
  const file = path.join(repo.root, SECURITY);
  const record = readRecord(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const before = against ? readRecord(repo.readAt(against, SECURITY)) : null;
  const problems = compareSinks(found, record, before);
  if (update && record) {
    const lowered = {};
    for (const [k, files] of Object.entries(record)) {
      for (const [f, n] of Object.entries(files)) {
        const now = found[k]?.[f] ?? 0;
        if (now > 0) (lowered[k] ??= {})[f] = Math.min(n, now);
      }
    }
    fs.writeFileSync(file, JSON.stringify(lowered, null, 1) + '\n');
  }
  return { problems, found, held: Object.values(record ?? {}).reduce((a, fs_) => a + Object.values(fs_).reduce((x, y) => x + y, 0), 0) };
}

/** First record for a repo that has none: what is there today, named. */
export function seedSinks(repo) {
  return countSinks(repo);
}
