// node --test devops/standards/test
// seo-robots-allows-search, seo-llms-txt, seo-org-schema-parent
// (lib/seo-rules.mjs): what a family site shows search engines and
// assistants. Pure functions, plus throwaway repos under the OS temp dir for
// the rules as `check` runs them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { check } from '../lib/checks.mjs';
import { loadRepo } from '../lib/repo.mjs';
import { blockedAgents, namesSitemap, sites } from '../lib/seo-rules.mjs';

const agents = (text, o) => blockedAgents(text, o).map((b) => b.agent);

describe('blockedAgents', () => {
  it('a robots.txt group with Disallow: /', () => {
    const txt = 'User-agent: *\nAllow: /\n\nUser-agent: GoogleOther\nUser-agent: Google-CloudVertexBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /api/\n';
    assert.deepEqual(agents(txt, { isText: true }), ['GoogleOther', 'Google-CloudVertexBot']);
  });
  it('Allow: / in the same group wins', () => {
    assert.deepEqual(agents('User-agent: Googlebot\nAllow: /\nDisallow: /\n', { isText: true }), []);
  });
  it('a Next robots object, single agent or a list', () => {
    assert.deepEqual(agents("rules: [{ userAgent: 'AhrefsBot', disallow: '/' }, { userAgent: ['SemrushBot', 'MJ12bot'], disallow: ['/'] }]"), ['AhrefsBot', 'SemrushBot', 'MJ12bot']);
  });
  it('a crawl delay or a path is not a block', () => {
    assert.deepEqual(agents("{ userAgent: 'AhrefsBot', crawlDelay: 10 }, { userAgent: 'Googlebot', allow: '/', disallow: ['/api/'] }"), []);
  });
  it('a const list mapped to disallow /', () => {
    const ts = "const SEO_ABUSE_BOTS = ['MJ12bot', 'AhrefsBot', 'SemrushBot'];\nextraRules: SEO_ABUSE_BOTS.map((userAgent) => ({\n  userAgent,\n  disallow: '/',\n})),";
    assert.deepEqual(agents(ts), ['MJ12bot', 'AhrefsBot', 'SemrushBot']);
    const ok = "const AI = ['GPTBot'];\nAI.map((userAgent) => ({ userAgent, allow: '/', disallow: ['/api/'] }))";
    assert.deepEqual(agents(ok), []);
  });
  it('a robots.txt written out in a route handler', () => {
    assert.deepEqual(agents('const body = `User-agent: *\nAllow: /\n\nUser-agent: Bingbot\nDisallow: /\n`'), ['Bingbot']);
  });
});

describe('namesSitemap', () => {
  it('a Sitemap line, a sitemap key, or the shared builder', () => {
    assert.ok(namesSitemap('User-agent: *\nAllow: /\nSitemap: https://x.y/sitemap.xml\n'));
    assert.ok(namesSitemap('return { rules, sitemap: `${SITE}/sitemap.xml` }'));
    assert.ok(namesSitemap('return buildRobots({ disallow: [] })'));
    assert.ok(!namesSitemap("return { rules: [{ userAgent: '*', allow: '/' }] }"));
  });
});

describe('sites', () => {
  it('finds each site root, not routes inside a page tree', () => {
    const found = sites([
      'src/app/layout.tsx',
      'src/app/robots.ts',
      'src/app/app/[slug]/layout.tsx',
      'apps/landing/public/llms.txt',
      'apps/landing/src/app/robots.ts',
      'marketing/src/pages/llms.txt.ts',
      'marketing/public/robots.txt',
      'inite-shared/packages/content/src/app/robots.ts',
      'lib/site-facts/files/robots.ts',
    ]).map((s) => s.root);
    assert.deepEqual(found, ['', 'apps/landing/', 'marketing/']);
  });
});

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function repoWith(files) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inite-seo-')), 'site');
  made.push(path.dirname(dir));
  fs.mkdirSync(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  for (const [p, body] of Object.entries({ '.inite/standards.json': JSON.stringify({ profile: 'next' }), ...files })) {
    if (body === undefined) continue;
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  g('add', '-A');
  return dir;
}

const IDS = ['seo-robots-allows-search', 'seo-llms-txt', 'seo-org-schema-parent'];
// On the enforce day: before it the rules only warn (family.json "enforce").
const ENFORCED = '2026-12-31';
const run = (dir, today = ENFORCED) => Object.fromEntries(check(loadRepo(dir), { only: IDS, today }).results.map((r) => [r.id, r]));

const GOOD = {
  'app/layout.tsx': "const org = { '@type': 'Organization', parentOrganization: { '@id': 'https://inite.ai/#organization' } }\n",
  'app/robots.ts': "export default () => ({ rules: [{ userAgent: '*', allow: '/' }, { userAgent: 'MJ12bot', disallow: '/' }], sitemap: 'https://x.y/sitemap.xml' })\n",
  'public/llms.txt': '# X\n',
};

describe('the rules in check', () => {
  it('a site with robots, sitemap, llms.txt and a parent passes', () => {
    for (const r of Object.values(run(repoWith(GOOD)))) assert.equal(r.status, 'ok', `${r.id}: ${r.problems}`);
  });

  it('fails a blocked search agent with file:line, a missing llms.txt and a missing parent', () => {
    const r = run(
      repoWith({
        'app/layout.tsx': 'export default function L() {}\n',
        'app/robots.ts': "const SEO = ['AhrefsBot', 'SemrushBot'];\nexport default () => ({ rules: [{ userAgent: '*', allow: '/' }, ...SEO.map((userAgent) => ({ userAgent, disallow: '/' }))] })\n",
      }),
    );
    assert.equal(r['seo-robots-allows-search'].status, 'fail');
    const robots = r['seo-robots-allows-search'].problems.join('\n');
    assert.match(robots, /app\/robots\.ts:1: Disallow: \/ for AhrefsBot/);
    assert.match(robots, /SemrushBot/);
    assert.match(robots, /no Sitemap line/);
    assert.equal(r['seo-llms-txt'].status, 'fail');
    assert.equal(r['seo-org-schema-parent'].status, 'fail');
  });

  it('before the enforce day the same site only warns', () => {
    const r = run(repoWith({ 'app/layout.tsx': 'export default function L() {}\n' }), '2026-11-02');
    for (const id of IDS) assert.equal(r[id].status, 'warn', id);
  });

  it('a block that says why is allowed', () => {
    const r = run(
      repoWith({
        ...GOOD,
        'public/robots.txt': '# robots-block: GoogleOther fetched 40k URLs a day in 10/2026 and took the site down\nUser-agent: GoogleOther\nDisallow: /\n\nSitemap: https://x.y/sitemap.xml\n',
        'app/robots.ts': undefined,
      }),
    );
    assert.equal(r['seo-robots-allows-search'].status, 'ok', r['seo-robots-allows-search'].problems.join('\n'));
  });

  it('a private app (User-agent: * Disallow: /) needs no sitemap, llms.txt or parent', () => {
    const r = run(repoWith({ 'app/layout.tsx': '', 'app/robots.ts': "export default () => ({ rules: { userAgent: '*', disallow: '/' } })\n" }));
    for (const x of Object.values(r)) assert.equal(x.status, 'ok', `${x.id}: ${x.problems}`);
  });

  it('an app mounted under another site (basePath) has no robots.txt of its own', () => {
    const r = run(repoWith({ ...GOOD, 'apps/tv/next.config.ts': "export default { basePath: '/tv' }\n", 'apps/tv/src/app/layout.tsx': 'parentOrganization https://inite.ai/#organization', 'apps/tv/public/llms.txt': '# tv\n' }));
    assert.equal(r['seo-robots-allows-search'].status, 'ok', r['seo-robots-allows-search'].problems.join('\n'));
  });

  it('inite.ai, the parent, declares subOrganization', () => {
    const r = run(repoWith({ ...GOOD, 'app/layout.tsx': "const org = { '@type': 'Organization', subOrganization: [] }\n" }));
    assert.equal(r['seo-org-schema-parent'].status, 'ok');
  });

  it('a gap can be carried as debt with its reason', () => {
    const r = run(
      repoWith({
        ...GOOD,
        'public/llms.txt': undefined,
        '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { 'seo-llms-txt': 'the site is being replaced by inite.ai/x in November' } }),
      }),
    );
    assert.equal(r['seo-llms-txt'].status, 'debt');
  });
});
