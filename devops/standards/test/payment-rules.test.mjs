// node --test devops/standards/test
// The family payment rules on throwaway repos.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { check, mayStillAddDebt } from '../lib/checks.mjs';
import { PAYMENT_RULES } from '../lib/payment-rules.mjs';
import { loadRepo } from '../lib/repo.mjs';

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inite-pay-'));
  made.push(dir);
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  g('add', '-A');
  return loadRepo(dir);
}

const PKG = (deps = {}) => JSON.stringify({ name: 'x', dependencies: { next: '16.4.3', '@inite/billing': 'workspace:*', ...deps } });
const run = (id, repo) => PAYMENT_RULES.find((r) => r.id === id).run(repo);

const GOOD = {
  'package.json': PKG(),
  'app/[lang]/pricing/page.tsx': `import { PlanPicker } from '@inite/billing/react';\nexport default async function P() { return <PlanPicker plans={await billing.plans()} locale="en" labels={t} />; }\n`,
  'app/api/billing/checkout/route.ts': `export const POST = billingCheckoutRoute({ billing });\nconst re = s.replace(/(a)/, '$1');\nconst t = \`\${total}\`;\n`,
  'locales/en/pricing.json': JSON.stringify({ free: 'R$ 0', perMonth: '/mo', saving: 'save {{percent}}%' }),
  'tests/pay.test.ts': `const fake = mockPayment({ price: 29, label: '$29/mo' });\n`,
};

describe('payment rules', () => {
  it('a product that renders billing\'s catalogue passes all three', () => {
    const repo = repoWith(GOOD);
    for (const r of PAYMENT_RULES) assert.deepEqual(r.run(repo), [], r.id);
  });

  it('refuses a provider SDK in package.json, an import and a direct API call', () => {
    const repo = repoWith({
      'package.json': PKG({ stripe: '^20.4.1', '@paypal/react-paypal-js': '8' }),
      'lib/pay.ts': `import Stripe from 'stripe';\nfetch('https://gate.lava.top/api/v2/invoice');\n`,
      'requirements.txt': 'fastapi\nstripe==9.0\n',
    });
    const p = run('payments-through-billing', repo).join('\n');
    assert.match(p, /dependencies: stripe/);
    assert.match(p, /@paypal\/react-paypal-js/);
    assert.match(p, /lib\/pay\.ts: imports stripe/);
    assert.match(p, /gate\.lava\.top directly/);
    assert.match(p, /requirements\.txt: stripe/);
  });

  it('refuses prices typed into components and locale files, but not a free tier', () => {
    const repo = repoWith({
      'package.json': PKG(),
      'components/Pricing.tsx': `const PLANS = [{ id: 'pro', price: 49 }, { id: 'free', price: 0 }];\nconst addon = '$39';\n`,
      'src/messages/pt.json': JSON.stringify({ pricing: { starter: 'R$ 145 por mês', ru: '4490 руб', eu: '€79' }, hero: { claim: 'saves $2,000 a month' } }),
      'src/lib/llm/cost.ts': `const note = 'about $0.05 a call';\n`,
    });
    const p = run('payments-no-price-literals', repo).join('\n');
    assert.match(p, /components\/Pricing\.tsx: .*price: 49/);
    assert.match(p, /\$39/);
    assert.doesNotMatch(p, /price: 0/);
    assert.match(p, /R\$ 145/);
    assert.match(p, /4490 руб/);
    assert.match(p, /€79/);
    assert.doesNotMatch(p, /\$2,000/, 'copy outside a pricing key is not a price');
    assert.doesNotMatch(p, /cost\.ts/, 'a cost note in a file that sells nothing is not a price');
  });

  it('refuses a mock payment path outside tests', () => {
    const repo = repoWith({
      'package.json': PKG(),
      'src/payment/payment.service.ts': `async completeMockPayment(id) { return { paid: true }; }\n`,
      'src/lib/payments/mock.js': `export default {};\n`,
      'src/lib/payments/index.js': `if (process.env.PAYMENT_PROVIDER === 'mock') {}\n`,
    });
    const p = run('payments-no-mock', repo).join('\n');
    assert.match(p, /payment\.service\.ts: MockPayment/);
    assert.match(p, /payments\/mock\.js: a mock payment provider/);
    assert.match(p, /index\.js: PAYMENT_PROVIDER === 'mock'/);
  });

  it('leaves billing itself alone: "payments": "rails"', () => {
    const repo = repoWith({
      '.inite/standards.json': JSON.stringify({ profile: 'node', payments: 'rails' }),
      'package.json': JSON.stringify({ name: 'billing', dependencies: { stripe: '1' } }),
      'src/adapters/stripe.ts': `fetch('https://api.stripe.com/v1/checkout/sessions');\n`,
    });
    for (const r of PAYMENT_RULES) assert.deepEqual(r.run(repo), [], r.id);
  });

  it('runs in check() and a repo may record it as debt until its adoption date', () => {
    const repo = repoWith({
      '.inite/standards.json': JSON.stringify({ profile: 'next', debt: { 'payments-through-billing': 'stripe in dead code, removed in #12' } }),
      'package.json': PKG({ stripe: '1' }),
    });
    const r = check(repo, { offline: true, only: ['payments-through-billing'] }).results[0];
    assert.equal(r.status, 'debt');
    assert.equal(mayStillAddDebt('payments-no-mock', '2026-11-01'), true);
    assert.equal(mayStillAddDebt('payments-no-mock', '2027-01-01'), false);
  });
});
