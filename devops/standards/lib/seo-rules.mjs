// What a family site shows search engines and assistants
// (.planning/family-growth-2026-11/metrics.md, 31.10.2026): inite.estate's
// robots.txt shut out GoogleOther and Google-CloudVertexBot, inite.training
// and inite.health shut out AhrefsBot and SemrushBot (the tools the family
// measures itself with), inite.services had no llms.txt and no JSON-LD, and
// bloom.inite.ai and break3.inite.health had neither a sitemap nor a parent.
//
// A site is a directory with a Next root layout (`app/layout.tsx`), a
// single-page app's `public/index.html`, or a robots, sitemap or llms.txt
// source (app router, Astro `src/pages/`, or `public/`). A Next app mounted under another site's path (`basePath`)
// has no robots.txt of its own: crawlers read it at the host's root. A site whose
// robots.txt shuts out every agent (`User-agent: *` + `Disallow: /`) is a
// private app (a dashboard behind sign-in): it is held only to letting the
// search agents through by name, not to a sitemap, llms.txt or a parent.
//
//   seo-robots-allows-search  no `Disallow: /` for Googlebot, GoogleOther,
//                             Bingbot, the AI search and answer agents, or
//                             AhrefsBot/SemrushBot; a Sitemap line is present.
//   seo-llms-txt              a public site serves /llms.txt.
//   seo-org-schema-parent     a public site's Organization names
//                             https://inite.ai/#organization as its
//                             parentOrganization (inite.ai, the parent,
//                             declares subOrganization instead).
//
// A block that is right says why where it is written, on its line or the one
// above: `robots-block: <reason of 8+ characters>`. A gap the repo cannot
// close yet goes in .inite/standards.json "debt" with its reason.

const SKIP = /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|out|coverage|__tests__|__mocks__|tests?|e2e|fixtures|examples?|templates?|docs?|\.planning)\//;
// Next's app router (app/robots.ts, app/llms.txt/route.ts), Astro's pages
// (src/pages/llms.txt.ts), or a static file in public/.
const ROUTES = '(?:src\\/)?(?:app|pages)\\/';
const ROBOTS = new RegExp(`^(.*?)(?:${ROUTES}robots(?:\\.txt(?:\\/route)?)?\\.[cm]?[jt]sx?|public\\/robots\\.txt)$`);
const SITEMAP = new RegExp(`^(.*?)(?:${ROUTES}sitemap(?:\\.xml(?:\\/route)?)?\\.[cm]?[jt]sx?|public\\/sitemap\\.xml)$`);
const LLMS = new RegExp(`^(.*?)(?:${ROUTES}llms\\.txt(?:\\/route)?\\.[cm]?[jt]sx?|public\\/llms\\.txt)$`);
// A page tree with nothing for crawlers yet is a site too: Next's root
// layout, or a single-page app's public/index.html.
const PAGES = /^(.*?)(?:(?:src\/)?app\/layout\.[cm]?[jt]sx?|public\/index\.html)$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|html|astro|json|vue|svelte)$/;
const MARK = /robots-block:\s*\S.{7,}/;

/**
 * The agents a site may not shut out. Search and answer agents (they fetch
 * to index or to cite), Google's other fetchers (Vertex grounding uses
 * Google-CloudVertexBot; GoogleOther feeds Google's products), and the two
 * SEO crawlers the family reads its own links and rankings through.
 * Training-only agents (GPTBot, ClaudeBot, Google-Extended, CCBot) are the
 * site's choice and are not listed.
 */
export const SEARCH_AGENTS = [
  'Googlebot', 'Googlebot-Image', 'Googlebot-News', 'Googlebot-Video', 'Storebot-Google', 'Google-InspectionTool',
  'GoogleOther', 'GoogleOther-Image', 'GoogleOther-Video', 'Google-CloudVertexBot',
  'Bingbot', 'BingPreview', 'msnbot', 'DuckDuckBot', 'DuckAssistBot', 'Applebot', 'Yandex', 'YandexBot',
  'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User', 'MistralAI-User',
  'AhrefsBot', 'SemrushBot',
];
const PROTECTED = new Map(SEARCH_AGENTS.map((a) => [a.toLowerCase(), a]));

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
function marked(text, index) {
  const lines = text.split('\n');
  const n = lineAt(text, index) - 1;
  return MARK.test(lines[n] ?? '') || MARK.test(lines[n - 1] ?? '');
}

/** Groups of a robots.txt body: agents, and whether the group shuts out the whole site. */
export function robotsTxtGroups(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const at = offset;
    offset += raw.length + 1;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], allowAll: false, disallowAll: false, index: at }));
      cur.agents.push({ name: value, index: at });
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'disallow' && value === '/') cur.disallowAll = true;
    if (key === 'allow' && value === '/') cur.allowAll = true;
  }
  return groups;
}

const FULL_DISALLOW = /\bdisallow\s*:\s*(?:(['"`])\/\1|\[\s*(['"`])\/\2\s*\])/i;
const FULL_ALLOW = /\ballow\s*:\s*(?:(['"`])\/\1|\[\s*(['"`])\/\2)/i;
const strings = (s) => [...s.matchAll(/(['"`])([^'"`\n]+)\1/g)].map((m) => m[2]);

/**
 * Agents a robots source shuts out of the whole site, with where: a robots.txt
 * text (public/robots.txt, or a route that returns one) or a Next robots
 * object (`{ userAgent: 'X', disallow: '/' }`, `NAMES.map((userAgent) => ({
 * userAgent, disallow: '/' }))` over `const NAMES = [...]`).
 */
export function blockedAgents(text, { isText = false } = {}) {
  const out = [];
  if (isText || /^\s*User-agent\s*:/im.test(text)) {
    for (const g of robotsTxtGroups(text)) {
      if (!g.disallowAll || g.allowAll) continue;
      for (const a of g.agents) out.push({ agent: a.name, index: a.index });
    }
    if (isText) return out;
  }
  // Object literals with no nested braces: { userAgent: 'X' | ['X', 'Y'], ..., disallow: '/' }.
  for (const m of text.matchAll(/\{[^{}]*?\buserAgent\s*:\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)[^{}]*\}/g)) {
    if (!FULL_DISALLOW.test(m[0]) || FULL_ALLOW.test(m[0])) continue;
    for (const agent of strings(m[1])) out.push({ agent, index: m.index });
  }
  // NAMES.map((ua) => ({ userAgent: ua, disallow: '/' })) over a const array of names.
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\.map\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\(\s*\{([^{}]*)\}\s*\)/g)) {
    const [, list, param, body] = m;
    if (!new RegExp(`\\buserAgent\\b(?:\\s*:\\s*${param}\\b)?`).test(body) || !FULL_DISALLOW.test(body) || FULL_ALLOW.test(body)) continue;
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${list}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!decl) continue;
    for (const s of decl[1].matchAll(/(['"`])([^'"`\n]+)\1/g)) out.push({ agent: s[2], index: decl.index + decl[0].indexOf(s[0]) });
  }
  return out;
}

/** True when a robots source names a sitemap: a Sitemap line, a `sitemap:` key, or the shared builder (which always adds one). */
export function namesSitemap(text) {
  return /^\s*Sitemap\s*:\s*\S/im.test(text) || /\bsitemap\s*:/.test(text) || /\bbuildRobots\s*\(/.test(text);
}

/** The repo's sites: root directory → its robots, sitemap and llms sources. */
export function sites(files) {
  const by = new Map();
  const site = (root) => {
    if (!by.has(root)) by.set(root, { root, robots: [], sitemap: [], llms: [] });
    return by.get(root);
  };
  // The root sits outside any route tree: `app/x/app/layout.tsx` is a page of `./`, not a site.
  const inTree = (m) => /(?:^|\/)(?:app|pages)\//.test(m[1]);
  for (const f of files) {
    if (SKIP.test(f)) continue;
    let m;
    if ((m = ROBOTS.exec(f)) && !inTree(m)) site(m[1]).robots.push(f);
    else if ((m = SITEMAP.exec(f)) && !inTree(m)) site(m[1]).sitemap.push(f);
    else if ((m = LLMS.exec(f)) && !inTree(m)) site(m[1]).llms.push(f);
    else if ((m = PAGES.exec(f)) && !inTree(m)) site(m[1]);
  }
  return [...by.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/** Reads a site's robots sources once: problems for the robots rule, and whether the site is public. */
function readSite(repo, s) {
  const problems = [];
  let isPrivate = false;
  for (const f of s.robots) {
    const text = repo.read(f) ?? '';
    const isText = f.endsWith('.txt');
    for (const { agent, index } of blockedAgents(text, { isText })) {
      if (agent === '*') {
        isPrivate = true;
        continue;
      }
      const name = PROTECTED.get(agent.toLowerCase());
      if (!name || marked(text, index)) continue;
      problems.push(`${f}:${lineAt(text, index)}: Disallow: / for ${name}; let it read the site, or say why beside it (robots-block: <reason>)`);
    }
  }
  return { problems, isPrivate };
}

const where = (s) => s.root || './';

/** A Next app served under a path of another site (`basePath: '/tv'`): its robots.txt is the host's. */
function mounted(repo, s) {
  return ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'].some((f) => /\bbasePath\s*:\s*(['"`])\/[^'"`]+\1/.test(repo.read(`${s.root}${f}`) ?? ''));
}

/** Source files of one site (its directory, without what SKIP leaves out). */
function siteFiles(repo, s) {
  const inSite = (f) => (s.root ? f.startsWith(s.root) : true);
  // A nested site in the same repo is its own (apps/landing vs apps/dashboard).
  const others = sites(repo.files).map((x) => x.root).filter((r) => r && r !== s.root && r.startsWith(s.root));
  return repo.files.filter((f) => inSite(f) && !others.some((r) => f.startsWith(r)) && SOURCE.test(f) && !SKIP.test(f) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f));
}

export const SEO_RULES = [
  {
    id: 'seo-robots-allows-search',
    profiles: ['next', 'node', 'python'],
    what: 'robots.txt lets Googlebot, GoogleOther, Bingbot, the AI search agents and Ahrefs/Semrush read the site, and names the sitemap',
    run(repo) {
      const out = [];
      for (const s of sites(repo.files)) {
        if (!s.robots.length) {
          if (mounted(repo, s)) continue;
          out.push(`${where(s)}: no robots.txt (app/robots.ts or public/robots.txt)`);
          continue;
        }
        const { problems, isPrivate } = readSite(repo, s);
        out.push(...problems);
        if (!isPrivate && !s.robots.some((f) => namesSitemap(repo.read(f) ?? ''))) out.push(`${s.robots.join(', ')}: no Sitemap line`);
      }
      return out;
    },
  },
  {
    id: 'seo-llms-txt',
    profiles: ['next', 'node', 'python'],
    what: 'a public site serves /llms.txt (public/llms.txt or app/llms.txt/route)',
    run(repo) {
      return sites(repo.files)
        .filter((s) => !readSite(repo, s).isPrivate && !s.llms.length)
        .map((s) => `${where(s)}: no llms.txt (public/llms.txt or app/llms.txt/route.ts)`);
    },
  },
  {
    id: 'seo-org-schema-parent',
    profiles: ['next', 'node', 'python'],
    what: "a public site's Organization JSON-LD names https://inite.ai/#organization as parentOrganization",
    run(repo) {
      const out = [];
      for (const s of sites(repo.files)) {
        if (readSite(repo, s).isPrivate) continue;
        let parent = false;
        for (const f of siteFiles(repo, s)) {
          const text = repo.read(f) ?? '';
          // inite.ai itself is the parent: it declares its brands as subOrganization.
          if (/\bsubOrganization\b/.test(text) || (/\bparentOrganization(?:Id)?\b/.test(text) && /inite\.ai\/#organization/.test(text))) {
            parent = true;
            break;
          }
        }
        if (!parent) out.push(`${where(s)}: no Organization with parentOrganization → https://inite.ai/#organization`);
      }
      return out;
    },
  },
];
