// How a family API answers an error (06.11.2026). The family's routes
// answered errors in four shapes: `{ error: "text" }`, `{ ok: false, error }`,
// api-kit v1's `{ error: { code, message, fields } }` and NestJS's defaults.
// Nothing answered `application/problem+json` (RFC 9457), so a client, an
// agent or a monitor had to know each repo's shape. `problem()` from
// @inite/api-kit is the one shape; it keeps `error` as a string for the front
// ends that read it.
//
//   api-errors-problem-json   a Next route handler (`app/api/**/route.{ts,js}`)
//                             answers a 4xx or 5xx with `problem()`, not
//                             `NextResponse.json(` / `Response.json(`.
//
// Detection is deliberately simple: for each `NextResponse.json(` or
// `Response.json(` call in a route file, the call's arguments (to its closing
// parenthesis) are searched for a literal `status: 4xx|5xx`. A status held in
// a variable, a `new Response(JSON.stringify(…))`, or a helper that wraps
// `NextResponse.json` elsewhere is not seen. A call whose arguments already
// name `application/problem+json` passes.
//
// An error whose shape is fixed by another standard (OAuth's
// `{ error: "invalid_grant" }`, RFC 6749; a provider's webhook contract)
// says so on the line or the one above:
//   // problem-json: <reason of 8+ characters>
// The rule warns until family.json "enforce" names its day; a repo records
// its gap once as debt (family.json "introduced") and pays it down.

const ROUTE = /(?:^|\/)app\/api\/(?:.+\/)?route\.[cm]?[jt]sx?$/;
const SKIP = /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|out|coverage|__tests__|__mocks__|tests?|e2e|fixtures|examples?|templates?)\//;
const CALL = /\b(?:NextResponse|Response)\.json\s*\(/g;
const STATUS = /\bstatus\s*:\s*([45]\d\d)\b/;
const MARK = /problem-json:\s*\S.{7,}/;
const MAX_SPAN = 4000;

/** Route handler files of a Next app router, outside vendored and test trees. */
export function routeFiles(files) {
  return files.filter((f) => ROUTE.test(f) && !SKIP.test(f) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f));
}

/** The text between an opening parenthesis at `open` and its match (strings skipped; template `${}` treated as text). */
export function argsSpan(text, open) {
  let depth = 0;
  let quote = null;
  const end = Math.min(text.length, open + MAX_SPAN);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, end);
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** JSON error answers in one route file: [{ line, status, call }]. */
export function jsonErrors(text) {
  const lines = text.split('\n');
  const out = [];
  for (const m of text.matchAll(CALL)) {
    const args = argsSpan(text, m.index + m[0].length - 1);
    const s = STATUS.exec(args);
    if (!s || /application\/problem\+json/.test(args)) continue;
    const line = lineAt(text, m.index);
    if (MARK.test(lines[line - 1] ?? '') || MARK.test(lines[line - 2] ?? '')) continue;
    out.push({ line, status: Number(s[1]), call: m[0].replace(/\s*\($/, '') });
  }
  return out;
}

export const API_RULES = [
  {
    id: 'api-errors-problem-json',
    profiles: ['next'],
    what: "route handlers answer 4xx/5xx as application/problem+json (RFC 9457) with @inite/api-kit's problem(), not NextResponse.json/Response.json",
    run(repo) {
      const out = [];
      for (const f of routeFiles(repo.files)) {
        for (const e of jsonErrors(repo.read(f) ?? '')) {
          out.push(`${f}:${e.line}: ${e.status} answered with ${e.call}(); answer problem(${e.status}, "<code>", detail) from @inite/api-kit, or say why beside it (problem-json: <reason>)`);
        }
      }
      return out;
    },
  },
];
