// How a family app reaches the shared host, as checks
// (.github/workflows/deploy-compose.yml is the shape they describe).
//
// deploy-pinned-image: what is deployed is the commit, not a moving tag.
//   `:latest` was retagged in the registry after the build and pulled by the
//   host; anything else that wrote `:latest` in between (a manual deploy, a
//   parallel run) shipped instead, the container recorded no commit, and a
//   rollback rebuilt the old commit. A family image in a deploy file names
//   its tag (the sha); a third-party image names a version.
//
// canonical-host: www and https are the edge's job, done once.
//   - every Traefik router that serves www.X routes through the family's
//     `www-to-apex@file` middleware (devops/host/traefik/family-edge.yml);
//   - `redirect-to-https` is referenced as `@file`, never declared on a
//     container: two containers that declare it differently make Traefik
//     drop it for every router (07.2026);
//   - the app does not rewrite the request URL's host in middleware/proxy:
//     www.inite.education and www.inite.club sent people to :3000 on
//     31.10.2026 that way (`nextUrl.clone()` keeps the container's port).
//
// A line that is right as it stands says so on the line or the one above:
//   # deploy-pinned: <reason of 8+ characters>     (or // for source)
//   # canonical-host: <reason of 8+ characters>
import { deployFiles } from './host-safety.mjs';

const SKIP = /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|coverage|__tests__|__mocks__|tests?|e2e|fixtures)\//;
const mark = (id) => new RegExp(`(?:#|//)\\s*${id}:\\s*\\S.{7,}`);
const PINNED_MARK = mark('deploy-pinned');
const CANON_MARK = mark('canonical-host');

/** Compose files a deploy may use (not a developer's local docker-compose.yml). */
export function deployComposeFiles(files) {
  return files.filter(
    (f) => !SKIP.test(f) && (/(?:^|\/)(?:deploy|ops|infra)\/(?:[^/]+\/)*[^/]*compose[^/]*\.ya?ml$/.test(f) || /(?:^|\/)docker-compose\.(?:prod|production)[^/]*\.ya?ml$/.test(f)),
  );
}

/** Lines with `\` continuations joined, each with the 1-based line it starts on. */
function logicalLines(text) {
  const raw = text.split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    const start = i;
    while (/\\\s*$/.test(line) && i + 1 < raw.length) line = line.replace(/\\\s*$/, ' ') + raw[++i].trim();
    out.push({ line, n: start + 1, prev: start > 0 ? raw[start - 1] : '' });
  }
  return out;
}

const FAMILY_REF = /(?:\$\{\{\s*secrets\.DOCKERHUB_USERNAME\s*\}\}|\$\{?DOCKERHUB_USERNAME\}?|\bmikefluff|ghcr\.io\/inite-ai)\/[\w.-]+(?::[^\s"'`)]+|@sha256:[0-9a-f]+)?/g;
const FAMILY_ONE = new RegExp(FAMILY_REF.source);
const TOKEN = String.raw`(?!-)(?:\$\{\{[^}]*\}\}|[^\s;|&)])+`; // a shell word, with GitHub's ${{ }} kept whole
const MOVING =/:(?:latest|main-latest|main|master|stable|production|prod|staging)$/;

/** What is wrong with one image reference as a deploy names it, or null. */
export function imageProblem(ref) {
  const r = ref.replace(/^["']|["']$/g, '').trim();
  if (!r || /^\$\{\{[^}]*\}\}$|^\$\{?\w+(?::[-?][^}]*)?\}?$/.test(r)) return null; // a whole variable: its value is checked where it is set
  if (/@sha256:/.test(r)) return null;
  const last = r.slice(r.lastIndexOf('/') + 1);
  const tag = /:([^:]+)$/.exec(last)?.[1];
  if (tag === undefined) return /\$/.test(last) ? null : `${r} has no tag: name the commit (family) or a version (third-party)`;
  if (MOVING.test(`:${tag}`)) return `${r} is a moving tag: deploy the commit (\${{ github.sha }}) or a pinned version`;
  return null;
}

/** The YAML key an indented line sits under (`with:` for an action's inputs). */
function parentKey(lines, idx) {
  const indent = /^(\s*)/.exec(lines[idx])[1].length;
  for (let j = idx - 1; j >= 0; j--) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = /^(\s*)/.exec(l)[1].length;
    if (ind < indent) return /^\s*-?\s*([\w.${}\s-]+?):\s*(?:#.*)?$/.exec(l)?.[1]?.trim() ?? '';
  }
  return '';
}

/** Problems with pinned images in one deploy file's text: [{ line, problem }]. */
export function pinnedImageProblems(text) {
  const out = [];
  const raw = text.split('\n');
  for (const { line, n, prev } of logicalLines(text)) {
    if (/^\s*#/.test(line) || PINNED_MARK.test(line) || PINNED_MARK.test(prev)) continue;
    const code = line.replace(/\s#\s.*$/, '');
    const say = (p) => p && out.push({ line: n, problem: p });
    const img = /^\s*-?\s*image:\s*(\S.*?)\s*$/.exec(code);
    if (img) {
      // `image:` under `with:` is an action's input (docker-build-push takes the repository), not a deploy.
      if (parentKey(raw, n - 1) !== 'with') say(imageProblem(img[1]));
      continue;
    }
    const pull = new RegExp(`\\bdocker\\s+pull\\s+(?:-\\S+\\s+)*(${TOKEN})`).exec(code);
    if (pull) {
      say(imageProblem(pull[1]));
      continue;
    }
    if (/\bdocker\s+(?:run|create)\b/.test(code)) {
      // The image is one token among options; a family image is found by its
      // registry, any other by a moving tag. One problem per image.
      const seen = new Set();
      const add = (ref) => {
        const p = imageProblem(ref);
        if (p && !seen.has(ref)) {
          seen.add(ref);
          say(p);
        }
      };
      for (const m of code.matchAll(new RegExp(`\\s(${TOKEN})`, 'g'))) if (FAMILY_ONE.test(m[1]) || /:(?:latest|main-latest)$/.test(m[1])) add(m[1]);
    }
  }
  return out;
}

const ROUTER = /traefik\.http\.routers\.((?:\$\{\{[^}]*\}\}|[^.=\s"'])+)\.(rule|middlewares)=([^"'\n]*)/g;

/** Problems with the edge in one deploy or compose file: [{ line, problem }]. */
export function edgeProblems(text) {
  const out = [];
  const lines = logicalLines(text);
  const middlewares = new Map();
  for (const { line } of lines) for (const m of line.matchAll(ROUTER)) if (m[2] === 'middlewares') middlewares.set(m[1], `${middlewares.get(m[1]) ?? ''},${m[3]}`);
  for (const { line, n, prev } of lines) {
    if (/^\s*#/.test(line) || CANON_MARK.test(line) || CANON_MARK.test(prev)) continue;
    const say = (p) => out.push({ line: n, problem: p });
    if (/traefik\.http\.middlewares\.redirect-to-https\./.test(line)) {
      say('declares redirect-to-https on a container; reference the family one as redirect-to-https@file (devops/host/traefik/family-edge.yml)');
    }
    for (const m of line.matchAll(ROUTER)) {
      const [, router, kind, value] = m;
      if (kind === 'middlewares') {
        for (const mw of value.split(',').map((s) => s.trim())) {
          if (/^redirect-to-https(?:@docker)?$/.test(mw)) say(`router ${router} uses ${mw}; use redirect-to-https@file`);
        }
      } else if (/Host\(\\?`www\./.test(value) && !/www-to-apex@file/.test(middlewares.get(router) ?? '')) {
        say(`router ${router} serves www itself; send www.X to https://X at the edge (middlewares=www-to-apex@file)`);
      }
    }
  }
  return out;
}

/** An app that moves the request to another host itself (middleware/proxy). */
export function hostRewriteProblems(text) {
  const out = [];
  text.split('\n').forEach((line, i, all) => {
    if (/^\s*\/\//.test(line) || CANON_MARK.test(line) || (i > 0 && CANON_MARK.test(all[i - 1]))) return;
    if (/\.(?:host|hostname|port)\s*=(?!=)/.test(line)) {
      out.push({ line: i + 1, problem: "rewrites the URL's host or port in the app; www→apex is the edge's (www-to-apex@file), and a cloned nextUrl carries the container's port" });
    }
  });
  return out;
}

const SOURCE_PROXY = /^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/;

export const DEPLOY_RULES = [
  {
    id: 'deploy-pinned-image',
    profiles: ['next', 'node', 'python'],
    what: 'a deploy names the image by commit (family) or version (third-party), never :latest or no tag',
    run(repo) {
      const out = [];
      for (const f of [...deployFiles(repo.files), ...deployComposeFiles(repo.files)]) {
        for (const p of pinnedImageProblems(repo.read(f) ?? '')) out.push(`${f}:${p.line}: ${p.problem}`);
      }
      return out;
    },
  },
  {
    id: 'canonical-host',
    profiles: ['next', 'node', 'python'],
    what: 'www→apex and http→https happen at the edge through the family @file middlewares; the app never rewrites the host',
    run(repo) {
      const out = [];
      for (const f of [...deployFiles(repo.files), ...deployComposeFiles(repo.files)]) {
        for (const p of edgeProblems(repo.read(f) ?? '')) out.push(`${f}:${p.line}: ${p.problem}`);
      }
      for (const f of repo.files.filter((x) => SOURCE_PROXY.test(x))) {
        for (const p of hostRewriteProblems(repo.read(f) ?? '')) out.push(`${f}:${p.line}: ${p.problem}`);
      }
      return out;
    },
  },
];
