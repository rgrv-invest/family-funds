// Axis Direct holding statement + trade report: parsing and import matching.
// Run: node --test tests/*.test.mjs. The rows below are made up; no real report is kept in the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAxisWorkbook, planAxisImport, axisWrites, axisDate } from '../js/axis.js';
import { shareStats } from '../js/calc.js';

const _ = undefined;
const holdingSheet = (date, rows) => [{ name: 'Portfolio Holding Statement', rows: [
  [], [], [], [_, 'Portfolio Holding Statement'], [],
  [_, 'Client ID', '1234567'], [_, 'Client Name', 'Test Holder'], [_, 'Date', date], [_, 'Pan', 'ABCDE1234F'], [], [], [],
  [_, 'Asset Type', 'Current Value ', 'Total Amount Invested', 'Profit/Loss Till Date'], [_, 'Equity', '1', '1', '0'], [], [], [],
  [_, 'Stock Name', 'ISIN', 'Open Qty', 'Market Price', 'Market Value', 'Investment Amount', 'Avg Cost', 'Unrealized Profit and Loss', 'Asset Type'],
  ...rows.map(([n, isin, qty, inv]) => [_, n, isin, String(qty), '100', '0', String(inv), (inv / qty).toFixed(2), '0', 'Equity']),
  [], [_, 'Disclaimer…'],
] }];
const tradeSheet = (from, to, rows) => [{ name: 'Equity', rows: [
  [], [], [], [_, 'Pan Level Transaction Report - Equity'], [],
  [_, 'Client ID', 1234567], [_, 'Client Name', 'TEST HOLDER'], [_, 'From Date', from], [_, 'To Date', to], [_, 'Pan', 'ABCDE1234F'], [], [_, 'Equity'], [],
  [_, 'Date', 'Stock Name', 'Exchange', 'Buy/Sell', 'Trade Qty', 'Trade Price', 'Trade value', 'Brokerage', 'GST', 'STT', 'Other Charges', 'Source'],
  ...rows.map(([date, n, side, qty, price, charges = 0]) => [_, date, n, side.includes('DIVIDEND') ? _ : 'NSE', side, qty, price, qty * price, charges, 0, 5, 0, 'Axisdirect']),
  [], [_, 'Disclaimer…'],
] }];
const prices = { date: '2026-11-13', p: {
  INE002A01018: [1300, 'RELIANCE', 'RELIANCE INDUSTRIES LTD'], INE040A01034: [800, 'HDFCBANK', 'HDFC BANK LTD'],
  INE336H01023: [25, 'GAYAPROJ', 'GAYATRI PROJECTS LTD'], INE009A01021: [1200, 'INFY', 'INFOSYS LIMITED'] } };
const H = holdingSheet('31-Mar-2026', [['Reliance Industries Ltd', 'INE002A01018', 100, 91641.47], ['HDFC Bank Ltd', 'INE040A01034', 1200, 822779.4], ['Embassy Developments Ltd', 'INE069I01010', 1000, 108342.6]]);
const T = tradeSheet('01/APR/2026', '13/NOV/2026', [
  ['2026-09-15', 'Embassy Developments Ltd', 'SELL', 1000, 54.65], ['2026-09-08', 'Gayatri Projects Ltd', 'BUY', 5000, 23.43, 523.8],
  ['2026-06-19', 'HDFC Bank Ltd', 'FINAL DIVIDEND', 1200, 13], ['2026-06-05', 'Reliance Industries Ltd', 'FINAL DIVIDEND', 100, 6],
  ['2026-10-01', 'Unknown Widgets Ltd', 'BUY', 10, 5]]);

test('dates in every format the reports use', () => {
  assert.deepEqual(['31-Mar-2026', '01/APR/2026', '2026-09-15', '15/09/2026', 46112].map(axisDate), ['2026-03-31', '2026-04-01', '2026-09-15', '2026-09-15', '2026-03-31']);
});

test('reads the holding statement and the trade report', () => {
  const h = parseAxisWorkbook(H), t = parseAxisWorkbook(T);
  assert.equal(h.kind, 'holdings'); assert.equal(h.clientId, '1234567'); assert.equal(h.asOf, '2026-03-31');
  assert.deepEqual(h.rows.map((r) => [r.isin, r.qty, r.invested]), [['INE002A01018', 100, 91641.47], ['INE040A01034', 1200, 822779.4], ['INE069I01010', 1000, 108342.6]]);
  assert.equal(t.kind, 'trades'); assert.equal(t.clientId, '1234567'); assert.deepEqual([t.from, t.to], ['2026-04-01', '2026-11-13']);
  assert.equal(t.trades.length, 3); assert.equal(t.dividends.length, 2);
  assert.equal(t.trades.find((x) => x.side === 'BUY' && x.name.startsWith('Gayatri')).cost, (5000 * 23.43 + 523.8) / 5000); // brokerage in, STT out
});

test('first import: holdings at Axis average cost, later trades on top, dividends, names matched', () => {
  const state = { demats: [], shares: [], prices };
  const plan = planAxisImport({ holdings: parseAxisWorkbook(H), trades: parseAxisWorkbook(T) }, state);
  assert.deepEqual(plan.unmatched, ['Unknown Widgets Ltd']);
  const by = Object.fromEntries(plan.rows.map((r) => [r.isin, r]));
  assert.deepEqual(by.INE002A01018.txns, [{ date: null, qty: 100, price: 916.4147, kind: 'opening' }]);
  assert.deepEqual(by.INE002A01018.dividends, [{ date: '2026-06-05', amount: 600 }]);
  assert.equal(by.INE069I01010.qty, 0); // sold since the statement date
  assert.deepEqual(by.INE336H01023.txns, [{ date: '2026-09-08', qty: 5000, price: 23.5348, kind: 'buy' }]); // bought after it, matched by name
  const st = shareStats({ txns: by.INE040A01034.txns }, 800, '2026-11-13');
  assert.equal(st.invested, 822779.4); // exactly Axis's investment amount
  const w = axisWrites(plan, {}, { memberId: 'm1', today: '2026-11-13' });
  assert.equal(w.demats.length, 1); assert.equal(w.demats[0].brokerClientId, '1234567'); assert.equal(w.adds.length, 4);
});

// Apply writes the way the stores do.
function apply(state, w) {
  const ids = Object.fromEntries(w.demats.map((d, i) => [d.ref, `d${state.demats.length + i + 1}`]));
  return {
    ...state,
    demats: [...state.demats, ...w.demats.map((d) => ({ id: ids[d.ref], ...d }))],
    shares: [
      ...state.shares.map((s) => {
        const rep = w.replaces.find((x) => x.shareId === s.id);
        const add = w.appends.filter((x) => x.shareId === s.id).flatMap((x) => x.txns);
        return { ...s, ...(rep ? { txns: rep.txns, dividends: rep.dividends } : {}), txns: [...(rep ? rep.txns : s.txns), ...add] };
      }),
      ...w.adds.map((a, i) => ({ id: `s${state.shares.length + i + 1}`, isin: a.isin, dematId: a.dematId || ids[a.dematRef], portfolioId: a.portfolioId, txns: a.txns, dividends: a.dividends })),
    ],
  };
}

test('re-importing the same files changes nothing; a newer statement updates; missing → sold all', () => {
  let state = { demats: [], shares: [], prices };
  const files = { holdings: parseAxisWorkbook(H), trades: parseAxisWorkbook(T) };
  state = apply(state, axisWrites(planAxisImport(files, state), {}, { memberId: 'm1', today: '2026-11-13' }));
  let plan = planAxisImport(files, state);
  assert.ok(plan.rows.every((r) => r.status === 'same'));
  assert.deepEqual(axisWrites(plan, {}, { today: '2026-11-13' }), { demats: [], adds: [], appends: [], replaces: [] });

  // A user-entered first-bought date survives a later import.
  const rel = state.shares.find((s) => s.isin === 'INE002A01018');
  rel.txns = [{ ...rel.txns[0], date: '2019-05-01' }];
  // Newer statement (today): Reliance 100 → 150 at a new average, HDFC Bank gone from both files.
  const H2 = holdingSheet('13-Nov-2026', [['Reliance Industries Ltd', 'INE002A01018', 150, 151641.47], ['Gayatri Projects Ltd', 'INE336H01023', 5000, 117674]]);
  plan = planAxisImport({ holdings: parseAxisWorkbook(H2) }, state);
  const by = Object.fromEntries(plan.rows.map((r) => [r.isin, r]));
  assert.equal(by.INE002A01018.status, 'changed');
  assert.deepEqual(by.INE002A01018.txns, [{ date: '2019-05-01', qty: 150, price: 1010.9431, kind: 'opening' }]);
  assert.equal(by.INE002A01018.dividends.length, 1); // kept
  assert.equal(by.INE040A01034.status, 'missing');
  const idx = plan.rows.indexOf(by.INE040A01034);
  const w = axisWrites(plan, { [idx]: { sellAll: true } }, { today: '2026-11-13' });
  assert.deepEqual(w.appends, [{ shareId: by.INE040A01034.share.id, txns: [{ date: '2026-11-13', qty: -1200, price: null, kind: 'sell' }] }]);
  state = apply(state, w);
  assert.ok(planAxisImport({ holdings: parseAxisWorkbook(H2) }, state).rows.every((r) => r.status === 'same'));
});

test('a trade report covering the whole holding gives the first-bought date', () => {
  const h = parseAxisWorkbook(holdingSheet('13-Nov-2026', [['Reliance Industries Ltd', 'INE002A01018', 100, 100000]]));
  const t = parseAxisWorkbook(tradeSheet('01/APR/2015', '13/NOV/2026', [['2018-02-01', 'Reliance Industries Ltd', 'BUY', 60, 900], ['2021-07-01', 'Reliance Industries Ltd', 'BUY', 40, 1100]]));
  const [row] = planAxisImport({ holdings: h, trades: t }, { demats: [], shares: [], prices }).rows;
  assert.deepEqual(row.txns, [{ date: '2018-02-01', qty: 100, price: 1000, kind: 'opening' }]);
});

test('files from two different accounts are refused', () => {
  const t = parseAxisWorkbook(T); t.clientId = '999';
  assert.throws(() => planAxisImport({ holdings: parseAxisWorkbook(H), trades: t }, { demats: [], shares: [], prices }), /different accounts/);
});
