// The family's environment contract, as checks
// (initeai-landing .planning/family-unify-2026-11/auth-config.md §1, §2, §7, §9;
// the shared home is packages/env, `@inite/env`).
//
// - A secret never falls back to a constant: content-generator, events and
//   club signed tokens with a string in their source when the deploy did not
//   set the secret (01.11.2026).
// - Server code never reads NEXT_PUBLIC_*: `next build` inlines them into
//   server bundles, so the runtime value is ignored (estate's smoke container
//   sent production redirect URIs).
// - Every NEXT_PUBLIC_* the app reads is built in: an ARG in the Dockerfile
//   and a build-arg in every workflow that builds the image (solutions'
//   analytics was absent for its whole life).
// - .env.example names what the code reads, and nothing else.
// - Every value the app requires is set by each deploy.
//
// Scope is the repo's own source, as for the auth rules. Python repos get the
// three rules that are not about Next.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceFiles as allSource } from './auth-rules.mjs';
import { deployWorkflows } from './repo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The auth rules' source files, without archived, example and seed code. */
const ARCHIVE = /(?:^|\/)(?:archive|examples?|seeds?)\//;
const sourceFiles = (repo) => allSource(repo).filter(([f]) => !ARCHIVE.test(f));

/**
 * Legacy names per canonical name. The same table as packages/env/src/family.ts
 * `LEGACY_ALIASES` (a test holds the two together); repeated here because the
 * checker runs with no install.
 */
export const LEGACY_ALIASES = {
  INITE_AUTH_CLIENT_ID: ['OAUTH_CLIENT_ID', 'AUTH_CLIENT_ID'],
  INITE_AUTH_CLIENT_SECRET: ['OAUTH_CLIENT_SECRET', 'AUTH_CLIENT_SECRET'],
  INITE_AUTH_COOKIE_SECRET: ['AUTH_COOKIE_SECRET'],
  INITE_AUTH_ISSUER: ['AUTH_SERVICE_ISSUER', 'AUTH_ISSUER', 'OIDC_ISSUER', 'AUTH_ISSUER_URL', 'INITE_ISSUER'],
  APP_URL: ['APP_BASE_URL', 'PUBLIC_BASE_URL', 'SITE_URL', 'BASE_URL', 'FRONTEND_URL'],
  BILLING_SERVICE_URL: ['BILLING_URL', 'BILLING_API_URL'],
  BILLING_SERVICE_API_KEY: ['BILLING_API_KEY', 'BLOOM_BILLING_API_KEY', 'GATEWAY_BILLING_SERVICE_API_KEY', 'BRAIN_BILLING_API_KEY'],
};

const FAMILY_FRAGMENTS = {
  familyAuthEnv: ['INITE_AUTH_CLIENT_ID', 'INITE_AUTH_CLIENT_SECRET', 'INITE_AUTH_COOKIE_SECRET', 'INITE_AUTH_ISSUER', 'APP_URL'],
  familyBillingEnv: ['BILLING_SERVICE_URL', 'BILLING_SERVICE_API_KEY', 'BILLING_WEBHOOK_SECRET'],
};

// --- env-no-secret-fallback -------------------------------------------------

const SECRET_WORD = /(?:SECRET|PASSWORD|PASSWD|TOKEN|SALT|PRIVATE|(?:^|_)KEY|_PASS)(?:_|$)/;
const NOT_SECRET = /(?:^NEXT_PUBLIC_|^VITE_|^PUBLIC_|PUBLISHABLE|PUBLIC_KEY|_(?:TTL|EXPIRES?(?:_IN)?|EXPIRY|URL|URI|HOST|PORT|NAME|PATH|HEADER|ALG(?:ORITHM)?|LENGTH|SIZE|ID|TYPE|PREFIX|COOKIE|ADDRESS)$)/;

/** True for an env name that holds a secret. */
export const isSecretName = (name) => SECRET_WORD.test(name) && !NOT_SECRET.test(name);

const JS_FALLBACK = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])\s*(?:\|\||\?\?)\s*(?:(['"])((?:(?!\3)[^\\\n]|\\.)+)\3|`([^`$\n]+)`)/g;
const PY_FALLBACK = /os\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*,\s*(['"])([^'"\n]+)\2|os\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)\s*or\s*(['"])([^'"\n]+)\5/g;
const SCRIPTS = /(?:^|\/)scripts\//;

function secretFallbacks(repo) {
  const out = [];
  for (const [f, text] of sourceFiles(repo)) {
    if (SCRIPTS.test(f)) continue;
    const py = f.endsWith('.py');
    for (const m of text.matchAll(py ? PY_FALLBACK : JS_FALLBACK)) {
      const name = py ? m[1] ?? m[4] : m[1] ?? m[2];
      if (!isSecretName(name)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push(`${f}:${line}: ${name} falls back to a literal; use requireSecret('${name}') (@inite/env), which throws when it is unset`);
    }
  }
  return out;
}

// --- reading which env names a repo uses --------------------------------------

const JS_READ = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])|import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
const HELPER_READ = /\b(?:requireSecret|envText|envInt|envBool|envList|envKey|envValue|readWithAliases)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;
const PY_READ = /os\.environ(?:\.get\(\s*|\[\s*)['"]([A-Z_][A-Z0-9_]*)['"]|os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;
const SCHEMA_KEY = /^\s+([A-Z][A-Z0-9_]{2,})\s*:/gm;

/** Names the platform or the toolchain sets; a product does not document them. */
const PLATFORM = /^(?:NODE_ENV|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NEXT_RUNTIME|NEXT_PHASE|NEXT_TELEMETRY_DISABLED|NEXT_DEPLOYMENT_ID|NEXT_MANUAL_SIG_HANDLE|PORT|HOSTNAME|HOST|CI|PATH|HOME|PWD|TZ|TMPDIR|USER|LANG|SHELL|SKIP_ENV_VALIDATION|VERCEL(?:_[A-Z_]+)?|npm_[a-z_]+|GITHUB_ACTIONS|GITHUB_SHA|GITHUB_REF|GITHUB_RUN_ID|RUNNER_[A-Z_]+|JEST_WORKER_ID|VITEST(?:_[A-Z_]+)?|MODE|DEV|PROD|SSR|BASE_URL_VITE|PYTHONPATH|PYTHONUNBUFFERED|VIRTUAL_ENV)$/;

/** Test and lint tooling, and one-off scripts: what they read is not the app's configuration. */
const TOOLING = /(?:^|\/)(?:(?:playwright|vitest|jest|eslint|prettier|postcss|tailwind|lint-staged|commitlint)\.config[^/]*|scripts\/.*)$/;

/** Every env name in JS/TS source text (comments removed). */
export function jsNames(text) {
  const code = codeOnly(text);
  return [...[...code.matchAll(JS_READ)].map((m) => m[1] ?? m[2] ?? m[3]), ...[...code.matchAll(HELPER_READ)].map((m) => m[1])];
}

/** Every env name the repo's own source reads, with the first file that reads it. */
export function namesRead(repo) {
  const names = new Map();
  const add = (n, f) => {
    if (n && !PLATFORM.test(n) && !names.has(n)) names.set(n, f);
  };
  for (const [f, rawText] of sourceFiles(repo)) {
    if (TOOLING.test(f)) continue;
    const text = f.endsWith('.py') ? rawText : codeOnly(rawText);
    if (f.endsWith('.py')) {
      for (const m of text.matchAll(PY_READ)) add(m[1] ?? m[2], f);
      continue;
    }
    for (const n of jsNames(text)) add(n, f);
    if (/from\s+['"]@inite\/env['"]/.test(text) && /\b(?:defineEnv|envSpec)\s*\(/.test(text)) {
      for (const m of text.matchAll(SCHEMA_KEY)) add(m[1], f);
      for (const [fn, list] of Object.entries(FAMILY_FRAGMENTS)) if (text.includes(`${fn}(`)) list.forEach((n) => add(n, f));
    }
  }
  return names;
}

const EXAMPLE = /(?:^|\/)(?:\.env\.(?:example|sample|template|dist)|env\.example|example\.env)$/;
const SKIP_PATH = /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|docs?|\.planning)\//;

/** The example files and the names each documents (commented-out names count: optional). */
export function exampleNames(repo) {
  const files = repo.files.filter((f) => EXAMPLE.test(f) && !SKIP_PATH.test(f));
  const names = new Map();
  for (const f of files) {
    const text = repo.read(f) ?? '';
    const lines = text.split('\n');
    let tags = '';
    for (const line of lines) {
      const m = /^\s*(?:export\s+)?#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
      if (m) {
        if (!names.has(m[1])) names.set(m[1], { file: f, required: /@required\b/.test(tags), build: /@build\b/.test(tags) });
        tags = '';
      } else if (/^\s*#/.test(line)) tags += line;
      else tags = '';
    }
  }
  return { files, names };
}

/**
 * Env names the shared packages (inite-shared/packages/<name>/src) read: a product
 * documents them in its own .env.example although its own code never reads
 * them (SMTP_* for @inite/notifications, for instance). Generated by
 * `scanSharedReads` and held to it by test/env-rules.test.mjs.
 */
export const SHARED_ENV = JSON.parse(fs.readFileSync(path.join(here, 'shared-env.json'), 'utf8'));

/** The env names read by packages/<name>/src under `packagesRoot` (tests excluded), sorted. */
export function scanSharedReads(packagesRoot) {
  const names = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(e.name)) for (const n of jsNames(fs.readFileSync(p, 'utf8'))) names.add(n);
    }
  };
  for (const pkg of fs.readdirSync(packagesRoot)) {
    const src = path.join(packagesRoot, pkg, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  return [...names].filter((n) => !PLATFORM.test(n)).sort();
}

/** Text outside the source that may also read or set a name (dead-name check). */
function otherMentions(repo) {
  const parts = [];
  for (const f of repo.files) {
    if (/(?:^|\/)node_modules\//.test(f)) continue;
    const other =
      /(?:^|\/)(?:Dockerfile[^/]*|(?:docker-)?compose[^/]*\.ya?ml|[^/]*\.prisma|prisma\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|[^/]*\.sh|Procfile|fly\.toml|render\.yaml|vercel\.json)$|^\.github\/workflows\/|(?:^|\/)scripts\/.*\.[cm]?[jt]s$|(?:^|\/)(?:e2e|tests?)\/|(?:^|\/)(?:playwright|vitest|jest)\.config[^/]*$/;
    if (other.test(f)) parts.push(repo.read(f) ?? '');
  }
  return parts.join('\n');
}

const usesShared = (repo) => Object.keys({ ...repo.pkg?.dependencies, ...repo.pkg?.devDependencies }).some((d) => d.startsWith('@inite/')) || repo.files.includes('inite-shared');

function exampleSync(repo) {
  const read = namesRead(repo);
  if (!read.size) return [];
  const { files, names } = exampleNames(repo);
  if (!files.length) return [`no .env.example: the code reads ${read.size} name(s) nobody documents (generate it with @inite/env renderEnvExample)`];
  const out = [];
  // A legacy alias read beside its documented canonical name is the migration, not drift.
  const canonicalOf = (n) => Object.keys(LEGACY_ALIASES).find((c) => LEGACY_ALIASES[c].includes(n));
  const missing = [...read].filter(([n]) => !names.has(n) && !names.has(canonicalOf(n)));
  for (const [n, f] of missing.slice(0, 15)) out.push(`${n} is read (${f}) but not in ${files[0]}`);
  if (missing.length > 15) out.push(`... and ${missing.length - 15} more read but undocumented`);
  const elsewhere = otherMentions(repo);
  const shared = new Set(usesShared(repo) ? SHARED_ENV : []);
  const dead = [...names].filter(([n]) => !read.has(n) && !shared.has(n) && !PLATFORM.test(n) && !new RegExp(`\\b${n}\\b`).test(elsewhere));
  for (const [n, { file }] of dead.slice(0, 15)) out.push(`${n} is in ${file} but nothing reads it`);
  if (dead.length > 15) out.push(`... and ${dead.length - 15} more documented but unread`);
  return out;
}

// --- env-required-in-deploy -------------------------------------------------

const COMPOSE = /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/;

function requiredInDeploy(repo) {
  if (repo.config.deploy === false) return [];
  const required = new Map();
  for (const [f, text] of sourceFiles(repo)) {
    for (const m of text.matchAll(/\brequireSecret\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) if (!required.has(m[1])) required.set(m[1], f);
  }
  for (const [n, { file, required: req, build }] of exampleNames(repo).names) if (req && !build && !required.has(n)) required.set(n, `${file} @required`);
  if (!required.size) return [];
  const composeText = repo.files.filter((f) => COMPOSE.test(f) && !SKIP_PATH.test(f)).map((f) => repo.read(f) ?? '').join('\n');
  const sets = (text, n) => new RegExp(`(?:^|[\\s"'\\-])${n}\\s*[=:]|\\$\\{${n}:\\?`, 'm').test(text);
  const out = [];
  for (const wf of deployWorkflows(repo)) {
    const text = repo.read(`.github/workflows/${wf}`);
    if (text === null) continue;
    for (const [n, where] of required) {
      if (sets(text, n) || sets(composeText, n)) continue;
      const alias = (LEGACY_ALIASES[n] ?? []).find((a) => sets(text, a) || sets(composeText, a));
      out.push(alias ? `${wf} sets ${alias}, the legacy name of ${n} (required by ${where}); set ${n}` : `${wf} does not set ${n} (required by ${where})`);
    }
  }
  return out;
}

// --- env-public-not-server --------------------------------------------------

const SERVER_PATH =
  /(?:^|\/)(?:(?:proxy|middleware|instrumentation(?:-node)?)\.[cm]?[jt]s|next\.config\.[cm]?[jt]s)$|(?:^|\/)app\/(?:.*\/)?(?:route|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.[cm]?[jt]sx?$|(?:^|\/)app\/(?:.*\/)?(?:page|layout|default|template|not-found)\.[jt]sx$|(?:^|\/)pages\/api\//;
const SERVER_IMPORT =
  /from\s+['"](?:server-only|next\/headers|@prisma\/client|[^'"]*\/prisma|node:[a-z_/]+|fs|child_process|@inite\/auth\/(?:next|node|resource)|@inite\/billing(?:\/[^'"]*)?)['"]/;
const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use client['"]/;
const USE_SERVER = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*['"]use server['"]/;

/** True for a file that runs only on the server. */
export function isServerFile(f, text) {
  if (USE_CLIENT.test(text)) return false;
  return SERVER_PATH.test(f) || USE_SERVER.test(text) || SERVER_IMPORT.test(text);
}

const PUBLIC_READ = /process\.env(?:\.(NEXT_PUBLIC_[A-Z0-9_]+)|\[\s*['"](NEXT_PUBLIC_[A-Z0-9_]+)['"]\s*\])/g;

function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function publicOnServer(repo) {
  const out = [];
  for (const [f, text] of sourceFiles(repo)) {
    if (f.endsWith('.py') || TOOLING.test(f) || !isServerFile(f, text)) continue;
    const names = [...new Set([...codeOnly(text).matchAll(PUBLIC_READ)].map((m) => m[1] ?? m[2]))];
    if (names.length) out.push(`${f}: reads ${names.join(', ')} on the server; read APP_URL (appOrigin()) or a server name, and keep NEXT_PUBLIC_* in the browser (publicEnv)`);
  }
  return out;
}

// --- env-public-build-args --------------------------------------------------

const BUILDS = /docker\/build-push-action|docker-build-push|\bdocker\s+(?:buildx\s+)?build\b|^\s*build-args\s*:/m;

/** The names a workflow passes as build args (build-args blocks and --build-arg). */
export function buildArgs(text) {
  const out = new Set();
  for (const m of text.matchAll(/--build-arg[\s=]+["']?([A-Z_][A-Z0-9_]*)/g)) out.add(m[1]);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)build[-_]args\s*:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    for (const m of head[2].matchAll(/([A-Z_][A-Z0-9_]*)=/g)) out.add(m[1]);
    const indent = head[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j])) continue;
      if (/^(\s*)/.exec(lines[j])[1].length <= indent) break;
      const m = /^\s*(?:-\s*)?["']?([A-Z_][A-Z0-9_]*)\s*[=:]/.exec(lines[j]);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

function publicBuildArgs(repo) {
  const needed = new Map();
  for (const [f, text] of sourceFiles(repo)) {
    if (f.endsWith('.py')) continue;
    for (const line of codeOnly(text).split('\n')) {
      for (const m of line.matchAll(PUBLIC_READ)) {
        const n = m[1] ?? m[2];
        // A default on the same line makes a missing value harmless.
        if (new RegExp(`${n}['"\\]]*\\s*(?:\\|\\||\\?\\?)`).test(line)) continue;
        if (!needed.has(n)) needed.set(n, f);
      }
    }
  }
  if (!needed.size) return [];
  const out = [];
  const dockerfiles = repo.files.filter((f) => /(?:^|\/)Dockerfile[^/]*$/.test(f) && !SKIP_PATH.test(f));
  const docker = dockerfiles.map((f) => repo.read(f) ?? '').join('\n');
  const workflows = repo.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((f) => [f, repo.read(f) ?? '']).filter(([, t]) => BUILDS.test(t));
  for (const [n, f] of needed) {
    if (dockerfiles.length && !new RegExp(`^\\s*(?:ARG|ENV)\\s+${n}\\b`, 'm').test(docker)) out.push(`${n} (read in ${f}) is not an ARG in ${dockerfiles.join(', ')}`);
    for (const [wf, text] of workflows) if (!buildArgs(text).has(n)) out.push(`${wf} builds the image without ${n} (read in ${f})`);
  }
  if (!dockerfiles.length && !workflows.length) out.push(`the code reads ${[...needed.keys()].join(', ')} but no Dockerfile or workflow builds it in`);
  return out;
}

export const ENV_RULES = [
  {
    id: 'env-no-secret-fallback',
    profiles: ['next', 'node', 'python'],
    what: 'no secret falls back to a literal: requireSecret() throws when it is unset (@inite/env)',
    run: (repo) => secretFallbacks(repo),
  },
  {
    id: 'env-public-not-server',
    profiles: ['next'],
    what: 'server code reads no NEXT_PUBLIC_*: the build inlines them, so the runtime value is ignored',
    run: (repo) => publicOnServer(repo),
  },
  {
    id: 'env-public-build-args',
    profiles: ['next'],
    what: 'every NEXT_PUBLIC_* the app reads is an ARG in the Dockerfile and a build-arg in every workflow that builds the image',
    run: (repo) => publicBuildArgs(repo),
  },
  {
    id: 'env-example-sync',
    profiles: ['next', 'node', 'python'],
    what: '.env.example names every env value the code reads, and nothing it does not',
    run: (repo) => exampleSync(repo),
  },
  {
    id: 'env-required-in-deploy',
    profiles: ['next', 'node', 'python'],
    what: 'every required value (requireSecret, @required in .env.example) is set by each deploy workflow, under its canonical name',
    run: (repo) => requiredInDeploy(repo),
  },
];
