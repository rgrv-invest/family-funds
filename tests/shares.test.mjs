// Share calculations. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareStats, summarizeShares, summarizeAll, summarize, xirr } from '../js/calc.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const yrs = (a, b) => (Date.parse(b) - Date.parse(a)) / (365 * 864e5);
const D = '2026-11-09'; // price date

test('opening lot (manual average price): qty, invested, gain, XIRR', () => {
  const st = shareStats({ txns: [{ date: '2023-11-09', qty: 60, price: 100, kind: 'opening' }] }, 150, D);
  assert.equal(st.qty, 60);
  assert.equal(st.invested, 6000);
  assert.equal(st.current, 9000);
  assert.equal(st.gain, 3000);
  close(st.gainPct, 0.5);
  close(st.xirr, Math.pow(9000 / 6000, 1 / yrs('2023-11-09', D)) - 1);
});

test('a sale reduces quantity at average cost', () => {
  const st = shareStats({ txns: [
    { date: '2023-01-01', qty: 10, price: 100, kind: 'buy' },
    { date: '2024-01-01', qty: 10, price: 200, kind: 'buy' },
    { date: '2025-01-01', qty: -5, price: 250, kind: 'sell' },
  ] }, 300, D);
  assert.equal(st.qty, 15);
  close(st.invested, 2250); // 15 × average 150
  close(st.avgPrice, 150);
  assert.equal(st.lastSale, '2025-01-01');
});

test('bonus / split adds quantity at zero cost', () => {
  const st = shareStats({ txns: [
    { date: '2023-01-01', qty: 50, price: 200, kind: 'opening' },
    { date: '2024-06-01', qty: 50, price: 0, kind: 'bonus' },
  ] }, 120, D);
  assert.equal(st.qty, 100);
  assert.equal(st.invested, 10000);
  close(st.avgPrice, 100);
  close(st.xirr, Math.pow(12000 / 10000, 1 / yrs('2023-01-01', D)) - 1); // the bonus lot adds no cash flow
});

test('missing buy price: current value only', () => {
  const sh = { isin: 'X', txns: [{ date: null, qty: 40, price: null, kind: 'opening' }] };
  const st = shareStats(sh, 50, D);
  assert.equal(st.current, 2000);
  assert.equal(st.invested, null);
  assert.equal(st.gain, null);
  assert.equal(st.xirrNote, 'nocost');
  const priced = { isin: 'Y', txns: [{ date: '2020-01-01', qty: 10, price: 100, kind: 'opening' }] };
  const sum = summarizeShares([sh, priced], { prices: { date: D, p: { X: [50], Y: [150] } }, navDate: D });
  assert.equal(sum.current, 3500);
  assert.equal(sum.invested, 1000);
  assert.equal(sum.gain, 500);
  assert.equal(sum.missingCost, 1);
});

test('price but no purchase date: XIRR shows nothing', () => {
  const st = shareStats({ txns: [{ date: null, qty: 10, price: 100, kind: 'opening' }] }, 150, D);
  assert.equal(st.invested, 1000);
  assert.equal(st.xirr, null);
  assert.equal(st.xirrNote, 'nodate');
});

test('held under a year: "< 1 yr" instead of an annualised figure', () => {
  const st = shareStats({ txns: [{ date: '2026-10-26', qty: 10, price: 100, kind: 'buy' }] }, 107, D);
  assert.equal(st.xirr, null);
  assert.equal(st.xirrNote, 'young');
  assert.equal(st.gain, 70);
});

test('dividends count in XIRR (not in gain)', () => {
  const base = { txns: [{ date: '2022-11-09', qty: 100, price: 100, kind: 'opening' }] };
  const without = shareStats(base, 120, D);
  const withDiv = shareStats({ ...base, dividends: [{ date: '2023-08-01', amount: 500 }, { date: '2024-08-01', amount: 500 }] }, 120, D);
  assert.equal(withDiv.gain, without.gain);
  assert.ok(withDiv.xirr > without.xirr);
  assert.equal(withDiv.hasDividends, true);
  close(withDiv.xirr, xirr([{ date: '2022-11-09', amount: -10000 }, { date: '2023-08-01', amount: 500 }, { date: '2024-08-01', amount: 500 }, { date: D, amount: 12000 }]));
});

test('fully sold shares count nowhere', () => {
  const sold = { isin: 'X', txns: [{ date: '2022-01-01', qty: 10, price: 100, kind: 'buy' }, { date: '2024-01-01', qty: -10, price: null, kind: 'sell' }] };
  const st = shareStats(sold, 200, D);
  assert.equal(st.held, false);
  assert.equal(st.qty, 0);
  const sum = summarizeShares([sold], { prices: { date: D, p: { X: [200] } }, navDate: D });
  assert.equal(sum.current, 0);
  assert.equal(sum.count, 0);
});

test('no price: excluded and counted as missing a price', () => {
  const sum = summarizeShares([{ isin: 'Z', txns: [{ date: '2020-01-01', qty: 5, price: 10, kind: 'buy' }] }], { prices: { date: D, p: {} }, navDate: D });
  assert.equal(sum.current, 0);
  assert.equal(sum.noPrice, 1);
});

test('All view: totals add up, XIRR merges funds and shares, Shares slice', () => {
  const state = {
    navDate: '2026-11-06', // fund NAV date earlier than the price date
    schemes: [{ code: 'f', nav: 30, assetClass: 'Equity', category: 'Flexi Cap' }],
    prices: { date: D, p: { S1: [200] } },
  };
  const holdings = [{ schemeCode: 'f', txns: [{ date: '2021-01-01', amount: 10000, units: 500 }] }];
  const shares = [{ isin: 'S1', txns: [{ date: '2022-01-01', qty: 50, price: 100, kind: 'opening' }] }];
  const all = summarizeAll(holdings, shares, state);
  const f = summarize(holdings, state);
  assert.equal(all.invested, 10000 + 5000);
  assert.equal(all.current, 15000 + 10000);
  assert.equal(all.gain, 5000 + 5000);
  close(all.xirr, xirr([{ date: '2021-01-01', amount: -10000 }, { date: '2022-01-01', amount: -5000 }, { date: D, amount: 25000 }]));
  assert.deepEqual(all.byAsset.map((a) => a.name).sort(), ['Equity', 'Shares']);
  close(all.byAsset.find((a) => a.name === 'Shares').pct, 10000 / 25000);
  close(all.byCategory[0].pct, 1); // categories stay a share of fund value
  // With no shares, the All view is exactly the funds view.
  const noShares = summarizeAll(holdings, [], state);
  assert.equal(noShares.xirr, f.xirr);
  assert.equal(noShares.invested, f.invested);
});

test('share names: NSE current name, then the broker name (ETFs), then the price file; ETFs get an ETF sector', async () => {
  const { shareInfo } = await import('../js/calc.js');
  const state = { prices: { p: { INE758E01017: [227.5, 'JIOFIN', 'JIO FIN SERVICES LTD'], INF109KB15Y7: [115.77, 'ICICIB22', 'ICICIPRAMC - BHARATIWIN'] } },
    stockMeta: { m: { INE758E01017: ['L', 'Financial Services', 'Jio Financial Services Ltd'] } } };
  assert.deepEqual(shareInfo(state, { isin: 'INE758E01017', name: 'Reliance Strategic Investments' }), { name: 'Jio Financial Services Ltd', symbol: 'JIOFIN', cap: 'Large', sector: 'Financial Services' });
  assert.deepEqual(shareInfo(state, { isin: 'INF109KB15Y7', name: 'Bharat 22 ETF' }), { name: 'Bharat 22 ETF', symbol: 'ICICIB22', cap: 'Unclassified', sector: 'ETF' });
  assert.equal(shareInfo(state, { isin: 'INF109KB15Y7' }).name, 'ICICIPRAMC - BHARATIWIN');
  assert.equal(shareInfo(state, { isin: 'INF109KB15Y7', sectorOverride: 'Diversified' }).sector, 'Diversified');
});
