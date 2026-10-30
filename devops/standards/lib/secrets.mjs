// No secret in the repo: no tracked env file, no key-shaped string in a
// tracked file. Reports the file and line, never the match itself.
import { execFileSync } from 'node:child_process';

const ENV_OK = /(?:^|\/)\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults)$/;
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w-]+)?$/;

// Shapes with a fixed, unmistakable prefix. Generic "password=" lines are
// left to the reviewer: they are mostly placeholders and env lookups.
export const PATTERNS = [
  ['private key', '-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----'],
  ['AWS access key', 'AKIA[0-9A-Z]{16}'],
  ['Anthropic key', 'sk-ant-[A-Za-z0-9_-]{20,}'],
  ['OpenAI key', 'sk-(?:proj-)?[A-Za-z0-9]{32,}'],
  ['GitHub token', '(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}'],
  ['Slack token', 'xox[abposr]-[A-Za-z0-9-]{10,}'],
  ['Stripe live key', '(?:sk|rk)_live_[A-Za-z0-9]{20,}'],
  ['Google API key', 'AIza[0-9A-Za-z_-]{35}'],
  ['Telegram bot token', '[0-9]{8,10}:AA[0-9A-Za-z_-]{33}'],
  // 29.10.2026 audit: an Airtable token in an n8n workflow, a Mailgun key in an env file.
  ['Airtable token', 'pat[A-Za-z0-9]{14}\\.[a-f0-9]{64}'],
  ['Mailgun key', 'key-[0-9a-f]{32}'],
  ['Stripe webhook secret', 'whsec_[A-Za-z0-9]{24,}'],
];

// Files that are credentials whatever they contain (a WhatsApp/Baileys
// session is a logged-in device; 808 of them were committed on 29.10.2026).
const CREDENTIAL_FILE = /(?:^|\/)(?:whatsapp-sessions?|baileys[_-]?auth[^/]*|auth_info[^/]*)\/|(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|[^/]*priv[^/]*\.pem|[^/]+\.p12|[^/]+\.pfx|service-account[^/]*\.json)$/;

export function credentialFileProblems(files, allow = []) {
  const hits = files.filter((f) => CREDENTIAL_FILE.test(f) && !/(?:^|\/)(?:test|tests|fixtures|__tests__)\//.test(f) && !allow.some((a) => new RegExp(a).test(f)));
  const dirs = [...new Set(hits.map((f) => (/(.*(?:whatsapp-sessions?|baileys[_-]?auth[^/]*|auth_info[^/]*))\//.exec(f) ?? [])[1] ?? f))];
  return dirs.map((d) => `${d}: credentials are tracked; untrack them, rotate (re-link the device / reissue the key), keep them out with .gitignore`);
}

// A key-shaped placeholder ("sk-ant-your_key_here", "AKIAXXXXXXXXXXXXXXXX")
// is documentation, not a secret.
const PLACEHOLDER = /your|example|here|placeholder|dummy|change.?me|redacted|fake|sample|test|x{6,}|0{8,}|(.)\1{7,}/i;

export function isPlaceholder(match) {
  return PLACEHOLDER.test(match);
}

export function envFileProblems(files) {
  return files.filter((f) => ENV_FILE.test(f) && !ENV_OK.test(f)).map((f) => `${f}: an env file is tracked; untrack it and keep it out with .gitignore`);
}

/** Lines in tracked files that look like a secret: "path:line (kind)". */
export function keyProblems(root, allow = []) {
  const out = [];
  for (const [kind, re] of PATTERNS) {
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-n', '-I', '-E', '-o', re, '--', '.', ':!*.lock', ':!*lock.json', ':!*lock.yaml', ':!**/vendor/**'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue; // git grep exits 1 when nothing matched
    }
    for (const line of hits.split('\n').filter(Boolean)) {
      const [file, n, ...rest] = line.split(':');
      if (isPlaceholder(rest.join(':'))) continue;
      if (allow.some((a) => new RegExp(a).test(file))) continue;
      out.push(`${file}:${n}: looks like a ${kind}; rotate it and remove it from history`);
    }
  }
  return [...new Set(out)];
}
