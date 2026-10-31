// Every payment goes through inite-billing-service
// (.planning/family-subscriptions-2026-10.md). A product asks billing for a
// checkout session and reads entitlements back; it holds no provider SDK,
// calls no provider's API, keeps no price of its own and has no pretend
// payment that marks an order paid.
//
// `.inite/standards.json` "payments": "rails" marks billing itself, the one
// repo that talks to the providers. Scope is the repo's own source, as for
// the auth rules: tests, fixtures, docs, planning notes, migrations and the
// vendored inite-shared are not read.

import path from 'node:path';

const CODE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte|py)$/;
const COPY = /(?:^|\/)(?:locales?|messages|i18n|lang)\/.*\.json$/;
const SKIP =
  /(?:^|\/)(?:node_modules|inite-shared|vendor|dist|build|\.next|coverage|docs?|\.planning|e2e|tests?|__tests__|__mocks__|fixtures|migrations|seeds?|archive|examples?|\.github)(?:\/|$)|\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$/;

function files(repo, re) {
  const out = [];
  for (const f of repo.files) {
    if (!re.test(f) || SKIP.test(f)) continue;
    const text = repo.read(f);
    if (text !== null) out.push([f, text]);
  }
  return out;
}

const isRails = (repo) => repo.config.payments === 'rails';

/** npm packages that take money themselves. */
const NPM_SDK =
  /^(?:stripe|@stripe\/.+|mercadopago|@mercadopago\/.+|@paypal\/.+|paypal-rest-sdk|braintree|square|razorpay|@lemonsqueezy\/.+|@paddle\/.+|@mollie\/.+|yookassa|@a2seven\/yoo-checkout|cloudpayments|@adyen\/.+|@coinbase\/commerce-node|@coinbase\/x402|x402-(?:next|express|hono))$/;
const PY_SDK = /^\s*(?:stripe|mercadopago|paypalrestsdk|yookassa|braintree|adyen)\b/im;
const IMPORT =
  /(?:from\s+|require\(\s*|import\(\s*)['"](stripe|@stripe\/[^'"]+|mercadopago|@paypal\/[^'"]+|braintree|razorpay|@lemonsqueezy\/[^'"]+|@paddle\/[^'"]+|yookassa|@coinbase\/x402|x402-(?:next|express|hono))['"]/;
const PY_IMPORT = /^\s*(?:import|from)\s+(?:stripe|mercadopago|paypalrestsdk|yookassa|braintree)\b/m;
const HOSTS =
  /\b(?:api\.stripe\.com|checkout\.stripe\.com|js\.stripe\.com|api\.mercadopago\.com|api(?:-m)?\.(?:sandbox\.)?paypal\.com|gate\.lava\.top|api\.lava\.top|api\.yookassa\.ru|api\.cloudpayments\.ru|api\.lemonsqueezy\.com|api\.paddle\.com|x402\.org\/facilitator)\b/;

function sdkProblems(repo) {
  const out = [];
  const pkg = repo.pkg ?? {};
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) if (NPM_SDK.test(name)) out.push(`package.json ${field}: ${name}`);
  }
  for (const f of repo.files) {
    if (!/(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml)$/.test(f) || SKIP.test(f)) continue;
    const m = PY_SDK.exec(repo.read(f) ?? '');
    if (m) out.push(`${f}: ${m[0].trim()}`);
  }
  for (const [f, text] of files(repo, CODE)) {
    const py = f.endsWith('.py');
    const imp = py ? PY_IMPORT.exec(text) : IMPORT.exec(text);
    if (imp) out.push(`${f}: imports ${py ? imp[0].trim() : imp[1]}`);
    const host = HOSTS.exec(text);
    if (host) out.push(`${f}: calls ${host[0]} directly`);
  }
  return out;
}

// A price written down: "$29", "US$ 49", "R$ 145", "€79", "79 €", "690 ₽",
// "4490 руб", or a `price: 29` field. Zero is not a price (a free tier).
const MONEY = [
  /(?<![\w$])(?:US)?\$\s?(\d{2,}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d[.,]\d{2})(?![\d{])/g,
  /R\$\s?(\d[\d.,]*)/g,
  /€\s?(\d[\d.,]*)/g,
  /(?<![\w.])(\d[\d.,]*)\s?(?:€|₽|руб\.?(?![а-я]))/g,
  /\bprice(?:Monthly|Yearly|Annual|Usd|Brl|_monthly|_yearly)?\s*[:=]\s*(\d+(?:\.\d+)?)\b/g,
];

// Where a plan's price is shown or sold: a file named for it, or a locale
// key under pricing/plans/tiers/billing. A cost in an LLM prompt, a sample
// figure in a demo or a market number in research is not the product's price
// and is not read.
const SELLS = /(?:pric|plan|tier|billing|subscri|checkout|upgrade|paywall)/i;
const SELLS_KEY = /^(?:pricing|prices?|plans?|tiers?|billing|subscriptions?|checkout|upgrade|paywall)$/i;

function amounts(text) {
  const found = new Set();
  for (const re of MONEY) {
    for (const m of text.matchAll(re)) {
      if (Number(String(m[1]).replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')) === 0) continue;
      found.add(m[0].trim());
    }
  }
  return found;
}

/** The strings of a locale file that sit under a pricing-like key. */
function sellingStrings(node, selling = false, out = []) {
  if (typeof node === 'string') {
    if (selling) out.push(node);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) sellingStrings(v, selling || SELLS_KEY.test(k), out);
  }
  return out;
}

function priceProblems(repo) {
  const out = [];
  const report = (f, found) => {
    if (found.size) out.push(`${f}: ${[...found].slice(0, 4).join(', ')}${found.size > 4 ? ` (+${found.size - 4})` : ''}`);
  };
  for (const [f, text] of files(repo, CODE)) {
    if (SELLS.test(path.basename(f)) || /(?:^|\/)(?:pricing|plans|billing|checkout)\//i.test(f)) report(f, amounts(text));
  }
  for (const [f, text] of files(repo, COPY)) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    report(f, amounts(sellingStrings(parsed).join('\n')));
  }
  return out;
}

const MOCK = [
  /(?:mock|fake|dummy|simulat(?:e|ed))[-_ ]?(?:payment|checkout|charge)s?/i,
  /\b(?:MOCK_PAYMENTS?|PAYMENTS?_MOCK)\b/,
  /PAYMENT_PROVIDER['"]?\s*(?:===?|:|=)\s*['"]mock['"]/,
  /\/dev\/mock-pay\b/,
];

function mockProblems(repo) {
  const out = [];
  for (const f of repo.files) {
    if (!SKIP.test(f) && /(?:^|\/)payments?\/[^/]*mock[^/]*\.[cm]?[jt]sx?$/i.test(f)) out.push(`${f}: a mock payment provider`);
  }
  for (const [f, text] of files(repo, CODE)) {
    for (const re of MOCK) {
      const m = re.exec(text);
      if (m) {
        out.push(`${f}: ${m[0]}`);
        break;
      }
    }
  }
  return [...new Set(out)];
}

export const PAYMENT_RULES = [
  {
    id: 'payments-through-billing',
    profiles: ['next', 'node', 'python'],
    what: 'no payment provider SDK and no provider API called directly: billing (inite-billing-service) takes every payment',
    run: (repo) => (isRails(repo) ? [] : sdkProblems(repo)),
  },
  {
    id: 'payments-no-price-literals',
    profiles: ['next', 'node', 'python'],
    what: "no price written into source or locale files: a pricing page renders billing's catalogue (@inite/billing/plans)",
    run: (repo) => (isRails(repo) ? [] : priceProblems(repo)),
  },
  {
    id: 'payments-no-mock',
    profiles: ['next', 'node', 'python'],
    what: 'no mock or simulated payment path that can mark an order paid; a test double lives in tests',
    run: (repo) => (isRails(repo) ? [] : mockProblems(repo)),
  },
];
