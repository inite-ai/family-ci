// The family auth contract, as checks (.planning/family-auth-unification-2026-10.md).
// One sign-in for every product: auth.inite.ai through @inite/auth (or the
// Python kit for the python profile). A product carries no sign-in of its
// own: no password hashing, no JWT signing or verifying, no OAuth client, no
// HS256, no tokens in the browser, and the back-channel route only where the
// kit mounts it.
//
// Scope: the repo's own source. Tests, fixtures, docs, planning notes, the
// vendored inite-shared and generated code are not read. The customer lane
// (a tenant's own customers: rent's booking portal, shop and food
// storefronts, training members, Telegram mini-apps) is still open with the
// owner; a repo that has one names it as debt with that reason, and the
// entry goes when the owner decides.
//
// `.inite/standards.json` "auth": "idp" marks auth.inite.ai itself, and
// "none" a repo that signs nobody in (it must then have no auth code at all).

export const BACKCHANNEL_LOGOUT_PATH = '/api/auth/backchannel-logout';

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const SKIP =
  /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|coverage|docs?|\.planning|e2e|tests?|__tests__|__mocks__|fixtures|migrations|prisma\/migrations|scripts\/dev-idp[^/]*|\.github)(?:\/|$)|\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$/;

/** The repo's own source files, as [path, text]. */
export function sourceFiles(repo) {
  const out = [];
  for (const f of repo.files) {
    if (!SOURCE.test(f) || SKIP.test(f)) continue;
    const text = repo.read(f);
    if (text !== null) out.push([f, text]);
  }
  return out;
}

const HASHERS = [
  [/from\s+['"](?:bcrypt|bcryptjs|argon2|@node-rs\/argon2|@node-rs\/bcrypt)['"]|require\(\s*['"](?:bcrypt|bcryptjs|argon2)['"]\s*\)/, 'a password hasher (bcrypt/argon2)'],
  [/\bcrypto\.scrypt(?:Sync)?\s*\(|\bscrypt(?:Sync)?\s*\(\s*password|\bpbkdf2(?:Sync)?\s*\(/, 'password hashing (scrypt/pbkdf2)'],
  [/^\s*(?:from\s+(?:passlib|argon2|bcrypt)\b|import\s+(?:passlib|argon2|bcrypt)\s*$)/m, 'a password hasher (passlib/argon2/bcrypt)', 'py'],
];
const JWT = [
  [/from\s+['"]jsonwebtoken['"]|require\(\s*['"]jsonwebtoken['"]\s*\)/, 'jsonwebtoken'],
  [/\bnew\s+SignJWT\b|\bjwtVerify\s*\(|\bcreateRemoteJWKSet\s*\(|\bjwtDecrypt\s*\(/, 'its own JWT signing or verifying (jose)'],
  [/^\s*(?:import\s+jwt\s*$|from\s+jwt\s+import|import\s+jose\s*$|from\s+jose\s+import)/m, 'its own JWT (PyJWT/python-jose)', 'py'],
];
const OAUTH = [
  [/\/v1\/oauth\/(?:token|authorize)\b|\bcode_verifier\b|['"]grant_type['"]\s*[:,]\s*['"]authorization_code['"]/, 'its own OAuth client (token/authorize calls, PKCE)'],
];
const BROWSER_TOKENS = /(?:localStorage|sessionStorage)\.setItem\(\s*[^,]*(?:access|refresh|id)_?token/i;

function scan(repo, patterns) {
  const out = [];
  for (const [f, text] of sourceFiles(repo)) {
    const py = f.endsWith('.py');
    for (const [re, what, lang] of patterns) if ((lang === 'py') === py && re.test(text)) out.push(`${f}: ${what}`);
  }
  return out;
}

const mode = (repo) => repo.config.auth ?? 'product';
const isIdp = (repo) => mode(repo) === 'idp';
const usesKitImport = /from\s+['"]@inite\/auth\/(?:next|node|resource|client)['"]|require\(\s*['"]@inite\/auth\/(?:next|node|resource)['"]\s*\)/;
const usesPyKit = /^\s*(?:from\s+inite_auth\b|import\s+inite_auth\b)/m;

export const AUTH_RULES = [
  {
    id: 'auth-kit',
    profiles: ['next', 'node', 'python'],
    what: 'signs in through the family kit (@inite/auth, or inite_auth for Python), mounted on the family paths',
    run(repo) {
      if (isIdp(repo) || mode(repo) === 'none') return [];
      const files = sourceFiles(repo);
      const kit = repo.profile === 'python' ? usesPyKit : usesKitImport;
      return files.some(([, t]) => kit.test(t)) ? [] : [repo.profile === 'python' ? 'no `inite_auth` import' : 'nothing imports @inite/auth/next, /node, /resource or /client'];
    },
  },
  {
    id: 'auth-no-local-credentials',
    profiles: ['next', 'node', 'python'],
    what: 'no password hashing: nobody signs in with a password a product stores',
    run: (repo) => (isIdp(repo) ? [] : scan(repo, HASHERS)),
  },
  {
    id: 'auth-no-own-jwt',
    profiles: ['next', 'node', 'python'],
    what: 'no JWT signing or verifying of its own, and no OAuth client of its own: the kit does both',
    run: (repo) => (isIdp(repo) ? [] : scan(repo, [...JWT, ...OAUTH])),
  },
  {
    id: 'auth-no-hs256',
    profiles: ['next', 'node', 'python'],
    what: 'no HS256 anywhere: a family token is RS256, and a shared secret never mints a session',
    run(repo) {
      if (isIdp(repo)) return [];
      return sourceFiles(repo)
        .filter(([, t]) => /['"]HS256['"]/.test(t))
        .map(([f]) => `${f}: HS256`);
    },
  },
  {
    id: 'auth-no-browser-tokens',
    profiles: ['next', 'node'],
    what: 'no token in localStorage or sessionStorage: the browser holds only httpOnly cookies',
    run: (repo) => scan(repo, [[BROWSER_TOKENS, 'a token written to browser storage']]),
  },
  {
    id: 'auth-backchannel-path',
    profiles: ['next', 'node', 'python'],
    debtable: false,
    what: `back-channel logout is served at ${BACKCHANNEL_LOGOUT_PATH} and nowhere else`,
    run(repo) {
      if (isIdp(repo)) return [];
      const out = [];
      for (const f of repo.files) {
        if (SKIP.test(f)) continue;
        const m = /(?:^|\/)app\/(.*?)\/route\.[cm]?[jt]sx?$/.exec(f);
        if (!m) continue;
        const route = '/' + m[1].split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
        if (/backchannel|back-channel/i.test(route) && route !== BACKCHANNEL_LOGOUT_PATH) out.push(`${f} serves ${route}; the family path is ${BACKCHANNEL_LOGOUT_PATH}`);
      }
      for (const [f, text] of sourceFiles(repo)) {
        for (const mm of text.matchAll(/['"`](\/[^'"`\s]*back-?channel[^'"`\s]*)['"`]/gi)) {
          const p = mm[1].replace(/\/$/, '');
          if (p !== BACKCHANNEL_LOGOUT_PATH && !/^https?:/.test(p)) out.push(`${f}: "${p}"; the family path is ${BACKCHANNEL_LOGOUT_PATH}`);
        }
      }
      return [...new Set(out)];
    },
  },
];
