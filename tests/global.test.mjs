// GIFT City (dollar) funds: rupee NAVs from data/global-funds.json. Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGlobal, navUsdOn, usdInrOn, navOnGlobal, globalQuote, withGlobal, searchGlobal, globalScheme } from '../js/global.js';
import { summarize } from '../js/calc.js';

const G = {
  funds: [{ code: 'gift:DGEQ-A', name: 'DSP Global Equity Fund – Class A (Regular)', amc: 'DSP (GIFT City)', currency: 'USD', assetClass: 'Equity', category: 'Global',
    navs: [['2025-09-22', 10.001], ['2026-11-13', 9.246], ['2026-11-16', 9.163], ['2026-11-17', 9.04]] }],
  usdInr: [['2025-09-19', 88.2], ['2025-09-22', 88.3], ['2026-11-13', 94.25], ['2026-11-16', 93.93], ['2026-11-17', 93.48]],
};

test('codes, lookups on or before a date, rupee NAV = dollar NAV × that day’s rate', () => {
  assert.ok(isGlobal('gift:DGEQ-A'));
  assert.ok(!isGlobal('122639'));
  assert.deepEqual(navUsdOn(G, 'gift:DGEQ-A', '2026-11-15'), { nav: 9.246, date: '2026-11-13' }); // weekend: Friday's NAV
  assert.equal(navUsdOn(G, 'gift:DGEQ-A', '2025-01-01'), null); // before launch
  assert.equal(usdInrOn(G, '2025-09-21'), 88.2);
  assert.equal(navOnGlobal(G, 'gift:DGEQ-A', '2026-11-16').nav, 9.163 * 93.93);
  assert.deepEqual(globalScheme(G, 'gift:DGEQ-A'), { code: 'gift:DGEQ-A', name: 'DSP Global Equity Fund – Class A (Regular)', amc: 'DSP (GIFT City)', assetClass: 'Equity', category: 'Global', currency: 'USD' });
  assert.deepEqual(searchGlobal(G, 'dsp global equity').map((x) => x.code), ['gift:DGEQ-A']);
  assert.deepEqual(searchGlobal(G, 'gift city'), [{ code: 'gift:DGEQ-A', name: G.funds[0].name }]);
  assert.deepEqual(searchGlobal(G, 'parag'), []);
  // Typed as on DSP's statement, with its punctuation; the class letter picks the class.
  const two = { ...G, funds: [...G.funds, { ...G.funds[0], code: 'gift:DGEQ-B', name: 'DSP Global Equity Fund – Class B (Direct)' }] };
  for (const q of ['DSP Global Equity Fund- Class A', 'DSP Global Equity Fund - Class A', 'dsp global equity class-a', 'Global Equity Fund Class A Regular']) {
    assert.deepEqual(searchGlobal(two, q).map((x) => x.code), ['gift:DGEQ-A'], q);
  }
  assert.deepEqual(searchGlobal(two, 'dsp glo').map((x) => x.code), ['gift:DGEQ-A', 'gift:DGEQ-B']);
});

test('latest and previous rupee NAVs feed valuation and the day’s change (currency moves included)', () => {
  const q = globalQuote(G, 'gift:DGEQ-A');
  // The NAV of 17 Nov is converted at the rate of 17 Nov (not the latest rate), and 16 Nov at 16 Nov's.
  assert.deepEqual(q, { nav: 9.04 * 93.48, navDate: '2026-11-17', navUsd: 9.04, usdInr: 93.48, usdInrDate: '2026-11-17', prevNav: 9.163 * 93.93, prevNavDate: '2026-11-16' });
  const later = { ...G, usdInr: [...G.usdInr, ['2026-11-18', 93.44], ['2026-11-19', 93.3]] };
  assert.equal(globalQuote(later, 'gift:DGEQ-A').usdInr, 93.48);
  // No ECB rate on the NAV's day (a holiday): the last rate before it, with its date.
  const holiday = { ...G, usdInr: G.usdInr.filter(([d]) => d !== '2026-11-17') };
  assert.deepEqual([globalQuote(holiday, 'gift:DGEQ-A').usdInr, globalQuote(holiday, 'gift:DGEQ-A').usdInrDate], [93.93, '2026-11-16']);
  const [stored, other] = withGlobal([{ code: 'gift:DGEQ-A', name: 'x' }, { code: '122639', nav: 92.41 }], G);
  assert.equal(stored.nav, q.nav);
  assert.equal(other.nav, 92.41);
  assert.equal(withGlobal([{ code: 'gift:XX-A' }], G)[0].nav, 0); // not in the file: valued at 0, not NaN

  // $6,000 bought at launch; rupee cost estimated at that day's rate.
  const h = { folioId: 'f', schemeCode: 'gift:DGEQ-A', txns: [{ date: '2025-09-22', units: 599.94, amount: Math.round(6000 * 88.3), usd: 6000, inrEstimated: true }] };
  const sum = summarize([h], { schemes: [stored], navDate: '2026-11-17' });
  assert.equal(sum.invested, 529800);
  assert.ok(Math.abs(sum.current - 599.94 * 9.04 * 93.48) < 1e-6);
  assert.ok(Math.abs(sum.dayChange - 599.94 * (9.04 * 93.48 - 9.163 * 93.93)) < 1e-6);
});
