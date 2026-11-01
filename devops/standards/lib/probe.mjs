// What a deployed family site shows the world, read from outside: the
// security headers on its HTML, the flags on its cookies, paths that
// must never answer (/.env, /.git), and where its www twin sends people. Used after a release (verify-deploy)
// and weekly across every family domain (security-scan.yml), reported as
// one issue.
//
// 29.10.2026 audit: 9 of 36 hosts sent no CSP, 8 an 'unsafe-inline' one;
// auth.inite.ai had no HSTS and no frame-ancestors on its sign-in page.

export const EXPOSED = [
  ['/.env', (b) => /^[A-Z][A-Z0-9_]{2,}=/m.test(b)],
  ['/.git/HEAD', (b) => /^ref: refs\//.test(b)],
  ['/.git/config', (b) => /\[core\]/.test(b)],
  ['/.DS_Store', (b) => b.startsWith('\u0000\u0000\u0000\u0001Bud1')],
  ['/server.js.map', (b) => /"mappings"\s*:/.test(b)],
  ['/.npmrc', (b) => /_authToken|registry=/.test(b)],
  ['/docker-compose.yml', (b) => /^services:/m.test(b)],
];

/** Problems with one response's headers (a Headers-like with get / getSetCookie). Pure, for tests. */
export function headerProblems(h, { html = true } = {}) {
  const out = [];
  const get = (k) => h.get(k);
  const hsts = get('strict-transport-security');
  if (!hsts) out.push('no Strict-Transport-Security');
  else if (Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0) < 15552000) out.push('HSTS max-age under 180 days');
  if (get('x-content-type-options') !== 'nosniff') out.push('no X-Content-Type-Options: nosniff');
  if (!get('referrer-policy')) out.push('no Referrer-Policy');
  if (html) {
    if (!get('permissions-policy')) out.push('no Permissions-Policy');
    const csp = get('content-security-policy');
    if (!csp) out.push('no Content-Security-Policy');
    else {
      const script = (/(?:^|;)\s*script-src\s+([^;]*)/.exec(csp) ?? /(?:^|;)\s*default-src\s+([^;]*)/.exec(csp))?.[1] ?? '';
      if (/'unsafe-inline'/.test(script) && !/'nonce-|'sha(256|384|512)-/.test(script)) out.push("CSP lets inline scripts run ('unsafe-inline' with no nonce)");
      if (!/frame-ancestors/.test(csp) && !get('x-frame-options')) out.push('can be framed (no frame-ancestors, no X-Frame-Options)');
      if (!/object-src\s+'none'/.test(csp) && !/default-src\s+'none'/.test(csp)) out.push("CSP has no object-src 'none'");
    }
  }
  if (get('x-powered-by')) out.push(`X-Powered-By: ${get('x-powered-by')} names the stack`);
  const cookies = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  for (const c of cookies) {
    const [pair, ...attrs] = c.split(';').map((s) => s.trim());
    const name = pair.split('=')[0];
    const a = attrs.map((x) => x.toLowerCase());
    if (!a.includes('secure')) out.push(`cookie ${name}: no Secure`);
    if (!a.some((x) => x.startsWith('samesite='))) out.push(`cookie ${name}: no SameSite`);
    if (/sess|auth|token|sid|jwt/i.test(name) && !a.includes('httponly')) out.push(`cookie ${name}: looks like a session and is readable by script`);
  }
  return out;
}

/**
 * The www twin of an apex site: it must send the visitor to the apex over
 * https, with no port, keeping the path; or answer itself. Pure, for tests.
 *
 * 31.10.2026: www.inite.education and www.inite.club sent people to
 * https://inite.education:3000/ (the middleware cloned nextUrl, which carries
 * the container's port, and changed only the host); www.inite.fund was a 404.
 */
export function wwwProblems(apexOrigin, status, location) {
  const apex = new URL(apexOrigin);
  const www = `www.${apex.hostname}`;
  if (status >= 200 && status < 300) return [];
  if (status >= 300 && status < 400) {
    if (!location) return [`${www} redirects (${status}) with no Location`];
    let to;
    try {
      to = new URL(location, `https://${www}/x?q=1`);
    } catch {
      return [`${www} redirects to an unreadable Location: ${location}`];
    }
    const out = [];
    if (to.port) out.push(`${www} redirects to port ${to.port} (${to.origin}): the app built the address from the container's own host`);
    if (to.protocol !== 'https:') out.push(`${www} redirects to ${to.protocol}// rather than https`);
    if (to.hostname !== apex.hostname && to.hostname !== www) out.push(`${www} redirects to another host, ${to.hostname}`);
    return out;
  }
  return [`${www} answers ${status}: send it to https://${apex.hostname}/ (or serve it)`];
}

/** Only a registrable apex (inite.ai, mikefluff.com) has a www twin to check. */
export const hasWwwTwin = (origin) => new URL(origin).hostname.split('.').length === 2;

async function fetchText(url, ms = 15000) {
  const ctl = AbortSignal.timeout(ms);
  const res = await fetch(url, { redirect: 'follow', signal: ctl, headers: { 'user-agent': 'inite-security-probe/1 (+https://inite.ai)' } });
  const body = (await res.text()).slice(0, 4096);
  return { res, body };
}

/** One site: headers on the page (after redirects) and the exposed paths. */
export async function probeSite(origin) {
  const base = origin.replace(/\/+$/, '');
  const problems = [];
  try {
    const { res } = await fetchText(base + '/');
    const html = /text\/html/.test(res.headers.get('content-type') ?? '');
    problems.push(...headerProblems(res.headers, { html }));
  } catch (e) {
    return { origin: base, problems: [`no answer: ${String(e.message ?? e).split('\n')[0]}`] };
  }
  if (hasWwwTwin(base)) {
    const www = base.replace('://', '://www.');
    try {
      const res = await fetch(`${www}/x?q=1`, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'inite-security-probe/1 (+https://inite.ai)' } });
      problems.push(...wwwProblems(base, res.status, res.headers.get('location')));
    } catch (e) {
      problems.push(`${new URL(www).hostname} gives no answer: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
  for (const [p, isReal] of EXPOSED) {
    try {
      const { res, body } = await fetchText(base + p, 10000);
      // A single-page app answers every path with its index: only the file's own shape counts.
      if (res.status === 200 && isReal(body)) problems.push(`${p} is served`);
    } catch {
      /* an error is not an exposure */
    }
  }
  return { origin: base, problems };
}

/** Markdown for the weekly issue. */
export function report(results, when = new Date()) {
  const bad = results.filter((r) => r.problems.length);
  const lines = [`Family security scan, ${when.toISOString().slice(0, 10)}: ${bad.length} of ${results.length} sites with problems.`, ''];
  for (const r of results) {
    lines.push(`### ${r.problems.length ? '✗' : '✓'} ${r.origin}`);
    for (const p of r.problems) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push('Fix with `securityHeaders()` from `@inite/security/web` (see the baseline, `.planning/family-security-baseline-2026-10.md`).');
  return lines.join('\n');
}
