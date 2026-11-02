// The two files a family deploy writes on the host, rendered from the inputs
// of .github/workflows/deploy-compose.yml (called by deploy.sh beside it):
//
//   node render.mjs env <file>   the app's environment, mode 600, from ENV_TEMPLATE
//                                with ${secrets.NAME} filled from SECRETS_JSON
//   node render.mjs compose      the compose file, on stdout
//
// The compose file holds no secret: the environment reaches the container
// through `env_file`. The Traefik labels are rendered here and nowhere else:
// https and www→apex are the family's two middlewares in Traefik's file
// provider (devops/host/traefik/family-edge.yml), referenced as @file, never
// declared again on a container. 07.2026: a container that declared
// `redirect-to-https` differently made Traefik drop it for every site.
//
// Node only, no dependencies: it runs on the self-hosted runner.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EDGE_MIDDLEWARES = { https: 'redirect-to-https@file', www: 'www-to-apex@file' };

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_REF = /\$\{secrets\.([A-Za-z_][A-Za-z0-9_]*)(\?)?\}/g;

/**
 * KEY=value lines; `${secrets.NAME}` is the secret's value, `${secrets.NAME?}`
 * the same but blank when the secret is not set. A required secret that is
 * missing or blank fails the deploy before anything on the host changes.
 * Returns { lines: [[key, value]], problems: [] }.
 */
export function parseEnv(template, secrets = {}) {
  const lines = [];
  const problems = [];
  const seen = new Set();
  for (const [i, raw] of String(template ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!KEY.test(key)) {
      problems.push(`env line ${i + 1}: "${line.slice(0, 40)}" is not KEY=value`);
      continue;
    }
    if (seen.has(key)) problems.push(`env line ${i + 1}: ${key} is set twice`);
    seen.add(key);
    const value = line.slice(eq + 1).replace(SECRET_REF, (_, name, optional) => {
      const v = secrets[name];
      if ((v === undefined || v === null || v === '') && !optional) problems.push(`env ${key}: the secret ${name} is not set (write \${secrets.${name}?} if blank is meant)`);
      return v === undefined || v === null ? '' : String(v);
    });
    if (/[\r\n]/.test(value)) problems.push(`env ${key}: a value with a line break cannot go in an env file`);
    if (value.includes("'")) problems.push(`env ${key}: a value with a single quote cannot go in the env file literally`);
    lines.push([key, value]);
  }
  return { lines, problems };
}

/** The env file: single-quoted values, which compose reads literally (no $ interpolation, no # comments). */
export function envFile(lines) {
  return `# Written by the family deploy (inite-shared deploy-compose). Mode 600.\n${lines.map(([k, v]) => `${k}='${v}'`).join('\n')}\n`;
}

/** Writes the env file with mode 600 from the first byte (no window where it is readable). */
export function writeEnvFile(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The domains input: the first non-www host is canonical and served; other
 * non-www hosts are served too; every www.X redirects to https://X (the
 * edge's www-to-apex). A www twin of a host that is not served is refused.
 */
export function parseDomains(input) {
  const hosts = String(input ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const problems = [];
  for (const h of hosts) if (!HOST.test(h)) problems.push(`domain "${h}" is not a host name`);
  const served = hosts.filter((h) => !h.startsWith('www.'));
  const www = hosts.filter((h) => h.startsWith('www.'));
  if (!served.length) problems.push('domains: no apex host (the first non-www host is the canonical one)');
  for (const w of www) if (!served.includes(w.slice(4))) problems.push(`domains: ${w} redirects to ${w.slice(4)}, which is not in the list`);
  return { canonical: served[0] ?? '', served, www, problems };
}

/** Volume lines `name:/path` (a named volume of this app) or `/host:/path` (a bind mount). */
export function parseVolumes(input, app) {
  const out = [];
  const problems = [];
  for (const raw of String(input ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([^:\s]+):(\/[^:\s]*)(?::(ro|rw))?$/.exec(line);
    if (!m) {
      problems.push(`volume "${line}" is not name:/path or /host/path:/path`);
      continue;
    }
    const [, source, target, mode] = m;
    if (source.startsWith('/')) out.push({ bind: source, target, mode });
    else if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source)) out.push({ key: source, name: `${app}_${source}`, target, mode });
    else problems.push(`volume name "${source}" is not a docker volume name`);
  }
  return { volumes: out, problems };
}

const q = (s) => JSON.stringify(String(s).replaceAll('$', '$$$$')); // a YAML string compose will not interpolate
const hostRule = (hosts) => hosts.map((h) => `Host(\`${h}\`)`).join(' || ');

/**
 * The Traefik labels for one deploy. `edge` names this deploy's routers and
 * service (unique per deploy, so the old container's routers never collide
 * with the new one's while both run); `priority` makes the newer deploy's
 * routers win while both are up.
 */
export function traefikLabels({ edge, served, www, port, priority }) {
  const r = (name, rule, entry, extra = []) => [
    `traefik.http.routers.${name}.rule=${rule}`,
    `traefik.http.routers.${name}.entrypoints=${entry}`,
    `traefik.http.routers.${name}.priority=${priority}`,
    `traefik.http.routers.${name}.service=${edge}`,
    ...(entry === 'websecure' ? [`traefik.http.routers.${name}.tls=true`, `traefik.http.routers.${name}.tls.certresolver=letsencrypt`] : []),
    ...extra,
  ];
  const labels = [
    'traefik.enable=true',
    'traefik.docker.network=traefik-global',
    `traefik.http.services.${edge}.loadbalancer.server.port=${port}`,
    ...r(edge, hostRule(served), 'websecure'),
    ...r(`${edge}-http`, hostRule(served), 'web', [`traefik.http.routers.${edge}-http.middlewares=${EDGE_MIDDLEWARES.https}`]),
  ];
  if (www.length) {
    // One hop from http://www.X or https://www.X to https://X: the edge
    // answers, the app never sees it, no container port can leak into Location.
    labels.push(
      ...r(`${edge}-www`, hostRule(www), 'websecure', [`traefik.http.routers.${edge}-www.middlewares=${EDGE_MIDDLEWARES.www}`]),
      ...r(`${edge}-www-http`, hostRule(www), 'web', [`traefik.http.routers.${edge}-www-http.middlewares=${EDGE_MIDDLEWARES.www}`]),
    );
  }
  return labels;
}

/**
 * The compose file of one deploy: one service named after the app, the
 * container named after the app (the name other containers and the host
 * scripts reach it by), the image pinned by commit.
 */
export function renderCompose(o) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.app ?? '')) problems.push(`app "${o.app}" must be a lowercase docker name`);
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(o.edge ?? '')) problems.push(`edge "${o.edge}" must be a lowercase name`);
  const image = String(o.image ?? '');
  const last = image.slice(image.lastIndexOf('/') + 1);
  if (!/^[\w.:@/-]+$/.test(image) || !(/@sha256:[0-9a-f]{64}$/.test(image) || /^[\w.-]+:[\w.-]+$/.test(last))) problems.push(`image "${image}" has no tag`);
  else if (/:(?:latest|main-latest)$/.test(image) && !o.allowMovingTag) problems.push(`image "${image}" is a moving tag; deploy the commit (image:<sha>)`);
  if (!/^\d+$/.test(String(o.port ?? ''))) problems.push(`port "${o.port}" is not a number`);
  if (!/^\/\S*$/.test(o.healthPath ?? '')) problems.push(`health path "${o.healthPath}" must start with /`);
  const d = parseDomains(o.domains);
  const v = parseVolumes(o.volumes, o.app);
  problems.push(...d.problems, ...v.problems);
  if (problems.length) return { text: '', problems };

  const health = o.healthCommand?.trim() || `wget -q -T 5 -O /dev/null http://127.0.0.1:${o.port}${o.healthPath} || exit 1`;
  const labels = [
    ...traefikLabels({ edge: o.edge, served: d.served, www: d.www, port: o.port, priority: o.priority ?? 0 }),
    `inite.deploy.app=${o.app}`,
    `inite.deploy.edge=${o.edge}`,
  ];
  const y = [];
  y.push(`# ${o.app}: rendered by the family deploy (inite-shared deploy-compose) for ${image}.`);
  y.push('# No secrets here: they are in the env file beside it (mode 600). Do not edit; the next deploy rewrites it.');
  y.push('services:');
  y.push(`  ${o.app}:`);
  y.push(`    image: ${q(image)}`);
  y.push(`    container_name: ${q(o.app)}`);
  y.push('    restart: unless-stopped');
  y.push('    expose:');
  y.push(`      - ${q(o.port)}`);
  y.push('    env_file:');
  y.push(`      - ${q(o.envFile ?? '.env')}`);
  y.push('    healthcheck:');
  y.push(`      test: ["CMD-SHELL", ${q(health)}]`);
  y.push(`      interval: ${o.healthInterval ?? '5s'}`);
  y.push('      timeout: 6s');
  y.push(`      retries: ${o.healthRetries ?? 24}`);
  y.push(`      start_period: ${o.startPeriod ?? '60s'}`);
  y.push('    labels:');
  for (const l of labels) y.push(`      - ${q(l)}`);
  if (v.volumes.length) {
    y.push('    volumes:');
    for (const x of v.volumes) y.push(`      - ${q(`${x.bind ?? x.key}:${x.target}${x.mode ? `:${x.mode}` : ''}`)}`);
  }
  y.push('    networks:');
  y.push('      - traefik-global');
  y.push('networks:');
  y.push('  traefik-global:');
  y.push('    external: true');
  const named = v.volumes.filter((x) => x.key);
  if (named.length) {
    // Named by the app, not by this deploy's compose project, and made by the
    // deploy before the first `up`: every deploy reaches the same data.
    y.push('volumes:');
    for (const x of named) {
      y.push(`  ${x.key}:`);
      y.push(`    name: ${q(x.name)}`);
      y.push('    external: true');
    }
  }
  return { text: `${y.join('\n')}\n`, problems: [], volumes: named.map((x) => x.name), canonical: d.canonical };
}

function fromEnv() {
  const e = process.env;
  return {
    app: e.APP,
    edge: e.EDGE,
    image: e.IMAGE_REF,
    allowMovingTag: e.ALLOW_MOVING_TAG === '1',
    domains: e.DOMAINS,
    port: e.PORT,
    healthPath: e.HEALTH_PATH,
    healthCommand: e.HEALTH_COMMAND,
    volumes: e.VOLUMES,
    envFile: e.ENV_FILE,
    priority: Number(e.PRIORITY || 0),
  };
}

function main(argv) {
  const [cmd, out] = argv;
  if (cmd === 'env') {
    let secrets = {};
    try {
      secrets = JSON.parse(process.env.SECRETS_JSON || '{}');
    } catch {
      console.error('render: SECRETS_JSON is not JSON');
      return 1;
    }
    const { lines, problems } = parseEnv(process.env.ENV_TEMPLATE, secrets);
    if (problems.length) {
      for (const p of problems) console.error(`::error::${p}`);
      return 1;
    }
    writeEnvFile(out, envFile(lines));
    console.log(`render: ${lines.length} variables into ${out} (600)`);
    return 0;
  }
  if (cmd === 'github-env') {
    // The e2e job's environment: appended to $GITHUB_ENV, one heredoc per variable.
    let secrets = {};
    try {
      secrets = JSON.parse(process.env.SECRETS_JSON || '{}');
    } catch {
      console.error('render: SECRETS_JSON is not JSON');
      return 1;
    }
    const { lines, problems } = parseEnv(process.env.ENV_TEMPLATE, secrets);
    if (problems.length) {
      for (const p of problems) console.error(`::error::${p}`);
      return 1;
    }
    const mark = `INITE_EOF_${Date.now().toString(36)}`;
    fs.appendFileSync(out, lines.map(([k, v]) => `${k}<<${mark}\n${v}\n${mark}\n`).join(''));
    console.log(`render: ${lines.length} variables for the e2e job`);
    return 0;
  }
  if (cmd === 'compose') {
    const r = renderCompose(fromEnv());
    if (r.problems.length) {
      for (const p of r.problems) console.error(`::error::${p}`);
      return 1;
    }
    process.stdout.write(r.text);
    return 0;
  }
  if (cmd === 'volumes') {
    const { volumes } = parseVolumes(process.env.VOLUMES, process.env.APP);
    for (const x of volumes) if (x.name) console.log(x.name);
    return 0;
  }
  if (cmd === 'canonical') {
    console.log(parseDomains(process.env.DOMAINS).canonical);
    return 0;
  }
  if (cmd === 'www') {
    console.log(parseDomains(process.env.DOMAINS).www.length ? 'yes' : 'no');
    return 0;
  }
  console.error('usage: render.mjs env <file> | github-env <file> | compose | volumes | canonical | www');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
