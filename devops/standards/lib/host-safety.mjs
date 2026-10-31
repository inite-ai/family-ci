// The family's repos deploy onto one shared host. A deploy may remove only
// what it created itself: its own images, containers, volumes and networks.
//
// 25.10.2026 and again 30.10.2026: the shared `postgres` container (five
// databases) had stopped on a full disk, and `docker system prune -f` in
// another repo's deploy deleted it. Every host-wide cleanup is one stopped
// container away from that.
//
// Refused in workflows, composite actions and shell scripts:
//   - `docker system|container|volume|network prune` (host-wide, always);
//   - `docker image prune` without a `label=` filter (every repo's images);
//   - `docker builder prune` without a filter;
//   - `compose down` with `-v`, `--volumes` or `--remove-orphans` (a project
//     name that collides with another repo's removes that repo's containers;
//     -v drops volumes, which is data);
//   - `docker rm`, `docker container rm`, `docker volume rm`, `docker rmi`
//     of a name this repo does not own, of a list nobody scoped, or of the
//     host's dangling volumes.
//
// What a repo owns: its name, the values of its PROJECT/CONTAINER/IMAGE/VOLUME/
// COMPOSE/SERVICE variables, its `container_name:`, `--name`, `-p` names,
// and `host.owns` in .inite/standards.json. The host's shared services
// (postgres, redis, traefik, temporal) are never owned by a name guess.
//
// A line that is right as it stands says so on the line or the one above:
//   # deploy-owns: <reason of 8+ characters>
// e.g. `# deploy-owns: OLD_IDS is this project's containers, filtered by label above`.
import path from 'node:path';

const SHARED = /^(?:postgres|postgresql|redis|traefik|traefik-global|temporal|inite-temporal|portainer|watchtower|nginx-proxy)(?:$|[-_:./])/i;
const MARK = /#\s*deploy-owns:\s*\S.{7,}/;
const SKIP = /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|coverage|__tests__|tests?|e2e|fixtures)\//;

/** The files a deploy runs: workflows, composite actions, shell scripts. */
export function deployFiles(files) {
  return files.filter(
    (f) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) ||
      /^\.github\/actions\/.+\/action\.ya?ml$/.test(f) ||
      (/\.sh$/.test(f) && !SKIP.test(f) && !/(?:^|\/)[^/]*test[^/]*\.sh$/.test(f)),
  );
}

const strip = (s) => s.replace(/^["']|["']$/g, '');

/** Variables a file sets: `KEY: value` (YAML env) and `KEY=value` (shell). */
export function variables(text) {
  const vars = {};
  // YAML env keys are upper case (a step's `id: build` is not a variable); shell ones are any case.
  for (const m of text.matchAll(/^\s*(?:export\s+|local\s+)?(?:([A-Z_][A-Z0-9_]*):\s+|([A-Za-z_][A-Za-z0-9_]*)=)(["']?)((?:\$\{\{[^}]*\}\}|[^\s"'#])+)\3\s*(?:#.*)?$/gm)) {
    const k = m[1] ?? m[2];
    if (!(k in vars)) vars[k] = m[4];
  }
  return vars;
}

/** Names this file and repo own (lowercase prefixes). */
export function ownedNames(text, { repoName = '', owns = [], alsoOwned = [] } = {}) {
  const vars = variables(text);
  const names = new Set();
  // A name built at run time (`hcprobe-$RUN`) is owned by its literal prefix
  // (`hcprobe-`); an image by its name without registry user or tag.
  const add = (v) => {
    let n = strip(resolve(String(v ?? ''), vars)).toLowerCase();
    n = n.slice(n.lastIndexOf('/') + 1).replace(/:.*$/, '');
    const at = n.search(/[${}?]/);
    if (at >= 0) n = /[-_.]$/.test(n.slice(0, at)) ? n.slice(0, at) : '';
    if (n && n.length >= 3 && !SHARED.test(n)) names.add(n);
  };
  add(repoName);
  for (const [k, v] of Object.entries(vars)) if (/PROJECT|CONTAINER|IMAGE|COMPOSE|SERVICE|APP_NAME|STACK|VOLUME|NETWORK/.test(k)) add(v);
  for (const m of text.matchAll(/container_name:\s*(["']?[\w.${}:-]+["']?)/g)) add(m[1]);
  // Created or deployed here: `docker run --name X`, `docker volume create X`,
  // `compose -p X`, the images it pulls and writes into its compose file.
  for (const m of text.matchAll(/(?:--name[=\s]+|docker\s+volume\s+create\s+)(["']?[\w.${}:-]+["']?)/g)) add(m[1]);
  for (const m of text.matchAll(/compose\b[^\n|;&]*?(?:\s-p|--project-name)[=\s]+(["']?[\w.${}:-]+["']?)/g)) add(m[1]);
  for (const m of text.matchAll(/(?:^[\s-]*image:\s*|docker\s+pull\s+)(["']?(?:\$\{\{[^}]*\}\}|[^\s"'#])+)/gm)) add(m[1]);
  for (const o of alsoOwned) names.add(o); // owned in another deploy file or compose file of the same repo
  for (const o of owns) names.add(String(o).toLowerCase()); // stated by the repo: may name a shared service it really owns
  return names;
}

/** `$X`, `${X}`, `${X:-d}`, `${{ env.X }}` replaced from vars; unknowns stay as `$?`. */
function resolve(token, vars, depth = 0) {
  const v = (k, d) => (k in vars && depth < 4 ? resolve(vars[k], vars, depth + 1) : d ?? '$?');
  return token
    .replace(/\$\$/g, 'pid') // the shell's own pid: a name this run made
    .replace(/\$\{\{\s*(?:env|vars)\.(\w+)\s*\}\}/g, (_, k) => v(k))
    .replace(/\$\{\{[^}]*\}\}/g, '$?') // secrets.*, needs.*: a registry user, an output
    .replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (_, k, d) => v(k, d))
    .replace(/\$(\w+)/g, (_, k) => v(k));
}

/** The short name of a target: `user/initeai:tag` -> `initeai`, `"initeai-worker"` -> `initeai-worker`. */
function shortName(target) {
  let t = strip(target).toLowerCase();
  t = t.replace(/@sha256:.*$/, '');
  const slash = t.lastIndexOf('/');
  if (slash >= 0) t = t.slice(slash + 1);
  return t;
}

function ownedTarget(target, owned) {
  let n = shortName(target);
  const at = n.indexOf('$?');
  if (at >= 0) n = n.slice(0, at); // a run-time name: its literal prefix must be owned
  if (!n) return false;
  if (SHARED.test(n) && !owned.has(n)) return false;
  for (const o of owned) {
    if (at >= 0 ? n.startsWith(o) && (/[-_.]$/.test(o) || /[-_.]/.test(n[o.length] ?? '')) : n === o || (n.startsWith(o) && (/[-_:./]$/.test(o) || /[-_:./]/.test(n[o.length] ?? '')))) return true;
  }
  return false;
}

/** A list fed to rm (`... | xargs docker rm`, `$(docker ps ...)`) is scoped when it filters on an owned name. */
function scopedList(raw, owned, vars) {
  const source = resolve(raw, vars);
  if (/dangling=true/.test(source) && /\bvolume\b/.test(source)) return false;
  for (const o of owned) {
    const e = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:name=\\^?|label=[\\w.-]+=|reference=["']?[\\w./*$?-]*?)${e}|grep\\s+(?:-\\w+\\s+)*["']?\\^?${e}|docker\\s+(?:images|image\\s+ls)\\s+(?:-\\w+\\s+)*["']?[\\w./$?-]*${e}`).test(source)) return true;
  }
  return false;
}

const RM = /\bdocker\s+(?:container\s+rm|volume\s+rm|image\s+rm|rmi|rm)\b/;

/**
 * Problems in one file's text: [{ line, problem }].
 * `context` = { repoName, owns } (see ownedNames).
 */
export function destroyProblems(text, context = {}) {
  const vars = variables(text);
  const owned = ownedNames(text, context);
  const lines = text.split('\n');
  const out = [];
  // A command continued with `\` is read as one line, reported at its first.
  for (let i = 0; i < lines.length; i++) {
    let cmd = lines[i];
    const start = i;
    while (/\\\s*$/.test(cmd) && i + 1 < lines.length) cmd = cmd.replace(/\\\s*$/, ' ') + lines[++i].trim();
    if (/^\s*#/.test(cmd)) continue;
    if (MARK.test(cmd) || (start > 0 && MARK.test(lines[start - 1]))) continue;
    const code = cmd.replace(/\s#\s.*$/, '');
    const say = (problem) => out.push({ line: start + 1, problem });

    const prune = /\bdocker\s+(system|container|volume|network|image|builder)\s+prune\b([^|;&\n]*)/.exec(code);
    if (prune) {
      const [, what, rest] = prune;
      if (['system', 'container', 'volume', 'network'].includes(what)) say(`docker ${what} prune removes every stopped container, unused volume or network on the shared host, not only this repo's`);
      else if (what === 'image' && !/--filter[=\s]+["']?label=/.test(rest)) say("docker image prune without a label= filter removes every repo's unused images; remove this repo's own images by name (keep the last few)");
      else if (what === 'builder' && !/--filter[=\s]/.test(rest)) say('docker builder prune without a filter empties the whole build cache; add --filter until=<hours>h');
    }
    if (/\bdocker[- ]compose\b[^|;&\n]*\bdown\b[^|;&\n]*?(?:\s-[a-zA-Z]*v[a-zA-Z]*\b|--volumes\b|--remove-orphans\b)/.test(code)) {
      say('compose down with -v/--volumes/--remove-orphans removes volumes or containers this file did not define; use plain `down`');
    }
    const rm = RM.exec(code);
    if (rm) {
      const before = code.slice(0, rm.index);
      const after = code.slice(rm.index + rm[0].length);
      const sub = /\$\(([^)]*)\)/.exec(after);
      if (/\|\s*(?:xargs\b[^|]*)?$/.test(before)) {
        if (!scopedList(before, owned, vars)) say(`${rm[0]} of a list not filtered to this repo's own names`);
      } else if (sub) {
        if (!scopedList(sub[1], owned, vars)) say(`${rm[0]} of a list not filtered to this repo's own names`);
      } else {
        const targets = resolve(after, vars)
          .split(/[|;&]|\s(?:\|\||&&)\s|\s[12]?>/)[0]
          .trim()
          .split(/\s+/)
          .filter((t) => t && !t.startsWith('-'));
        const bad = targets.filter((t) => !ownedTarget(t, owned));
        if (!targets.length) say(`${rm[0]} with no name`);
        else if (bad.length) say(`${rm[0]} ${bad.map(strip).join(' ')}: not a name this repo owns (${[...owned].join(', ') || 'none found'})`);
      }
    }
  }
  return out;
}

export const HOST_RULE = {
  id: 'deploy-no-host-wide-destroy',
  profiles: ['next', 'node', 'python'],
  debtable: false,
  what: 'a deploy removes only what it created: no system/container/volume prune, no unfiltered image prune, no compose down -v/--remove-orphans, no rm of names it does not own',
  run(repo) {
    const repoName = path.basename(repo.root);
    const owns = repo.config.host?.owns ?? [];
    const files = deployFiles(repo.files);
    // What one deploy file or compose file of the repo names is the repo's:
    // deploy.sh removes the image the workflow builds.
    const composes = repo.files.filter((f) => /(?:^|\/)(?:docker-)?compose[^/]*\.ya?ml$/.test(f) && !/(?:^|\/)(?:node_modules|vendor|inite-shared)\//.test(f));
    const alsoOwned = [...new Set([...files, ...composes].flatMap((f) => [...ownedNames(repo.read(f) ?? '', { repoName })]))];
    const out = [];
    for (const f of files) {
      for (const p of destroyProblems(repo.read(f) ?? '', { repoName, owns, alsoOwned })) out.push(`${f}:${p.line}: ${p.problem}`);
    }
    return out;
  },
};
