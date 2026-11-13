// NSDL / CDSL statement parsing and import matching. Run: node --test tests/*.test.mjs
// The statement text below is made up (no real statement is kept in the repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDematCas, planDematImport, dematWrites } from '../js/cas-demat.js';

const NSDL = [
  'NSDL Consolidated Account Statement',
  'Statement for the period from 01-Oct-2026 to 31-Oct-2026',
  'Summary of value of holdings',
  'NSDL Demat Account ACCOUNT HOLDER',
  'ZERODHA BROKING LIMITED RAGHAV KEDIA (PAN:ABCDE1234F)',
  'DP ID:IN303028 Client ID:12345678',
  'Equity Shares',
  'ISIN Stock Symbol Company Name Face Value No. of Shares Market Price in ₹ Value in ₹',
  'INE002A01018 RELIANCE.NSE RELIANCE INDUSTRIES LIMITED 10.00 60 1,324.40 79,464.00',
  'INE040A01034 HDFCBANK.NSE HDFC BANK LIMITED 1.00 200 798.15 1,59,630.00',
  'INE009A01021 INFY.NSE INFOSYS LIMITED',            // numbers on the next line (wrapped row)
  '5.00 40 1,154.10 46,164.00',
  'INF204KB14I2 NIPPON INDIA ETF NIFTY BEES 1.00 100 285.01 28,501.00', // ETF in the equity table
  'INE062A04019 SOME BANK PREFERENCE 10.00 5 100.00 500.00',            // preference share
  'Sub Total 3,13,759.00',
  'Mutual Funds (M)',
  'INF879O01027 PARAG PARIKH FLEXI CAP FUND 1,000.000 92.41 92,410.00',
  'CDSL Demat Account ACCOUNT HOLDERS',
  'GROWW INVEST TECH PRIVATE LIMITED RAGHAV KEDIA (PAN:ABCDE1234F)',
  'DP ID:12088700 Client ID:00527713 PRIYA KEDIA (PAN:FGHIJ5678K)',
  'Equities (E)',
  'ISIN Security Current Bal Frozen Bal Pledge Bal Pledge Setup Bal Free Bal Lock-in Bal Earmarked Bal Lent Bal Avl Bal Borrowed Bal Market Price Value',
  'INE006I01046 ASTRAL LIMITED 25.000 0.000 0.000 0.000 25.000 0.000 0.000 0.000 25.000 0.000 1,272.80 31,820.00',
];

const CDSL_EASI = [
  'CDSL CONSOLIDATED ACCOUNT STATEMENT',
  'Statement as on 31-10-2026',
  'DP Name : ZERODHA BROKING LTD BO ID : 1208160000140178',
  'Name : RAGHAV KEDIA (PAN:ABCDE1234F)',
  'Equity',
  'ISIN Security Current Bal Free Bal Pledge Bal Market Price Value',
  'INE081A01020 TATA STEEL LIMITED 300 300 0 184.85 55,455.00',
];

test('NSDL statement: accounts, holders, brokers, equities; MF and non-equity skipped', () => {
  const cas = parseDematCas(NSDL);
  assert.equal(cas.date, '2026-10-31');
  assert.equal(cas.accounts.length, 2);
  const [z, g] = cas.accounts;
  assert.deepEqual([z.dpId, z.clientId, z.brokerShort], ['IN303028', '12345678', 'Zerodha']);
  assert.deepEqual(z.holders, ['RAGHAV KEDIA']);
  assert.deepEqual(z.equities.map((e) => [e.isin, e.qty]), [['INE002A01018', 60], ['INE040A01034', 200], ['INE009A01021', 40]]);
  assert.equal(z.equities[0].name, 'RELIANCE INDUSTRIES LIMITED');
  assert.deepEqual([g.dpId, g.clientId, g.brokerShort], ['12088700', '00527713', 'Groww Invest Tech']);
  assert.deepEqual(g.holders, ['RAGHAV KEDIA', 'PRIYA KEDIA']);
  assert.deepEqual(g.equities.map((e) => [e.isin, e.qty, e.price]), [['INE006I01046', 25, 1272.8]]);
  assert.deepEqual(cas.skipped.map((s) => [s.isin, s.kind]), [
    ['INF204KB14I2', 'Mutual fund / ETF'], ['INE062A04019', 'Not an equity share'], ['INF879O01027', 'Mutual fund / ETF']]);
});

test('CDSL statement: BO ID split into DP ID + client ID, DP Name as broker', () => {
  const cas = parseDematCas(CDSL_EASI);
  assert.equal(cas.date, '2026-10-31');
  const [a] = cas.accounts;
  assert.deepEqual([a.dpId, a.clientId, a.brokerShort], ['12081600', '00140178', 'Zerodha']);
  assert.deepEqual(a.equities.map((e) => [e.isin, e.qty]), [['INE081A01020', 300]]);
});

// A tiny in-memory store to apply the writes, so re-importing can be checked.
function apply(state, w) {
  const ids = {};
  w.demats.forEach((d, i) => { ids[d.ref] = `d${state.demats.length + i + 1}`; });
  return {
    ...state,
    demats: [...state.demats, ...w.demats.map((d) => ({ id: ids[d.ref], ...d }))],
    shares: [
      ...state.shares.map((s) => ({ ...s, txns: [...s.txns, ...w.appends.filter((a) => a.shareId === s.id).flatMap((a) => a.txns)] })),
      ...w.adds.map((a, i) => ({ id: `s${state.shares.length + i + 1}`, isin: a.isin, dematId: a.dematId || ids[a.dematRef], portfolioId: a.portfolioId, txns: a.txns })),
    ],
  };
}

test('import: new, no change, increase, decrease, missing; re-import changes nothing', () => {
  const cas = parseDematCas(NSDL);
  let state = { demats: [], shares: [], prices: { p: { INE002A01018: [1324.4], INE040A01034: [798.15], INE006I01046: [1272.8] } } };

  // First import: everything is new; two new demat accounts.
  let plan = planDematImport(cas, state);
  assert.deepEqual(plan.flatMap((p) => p.rows.map((r) => r.status)), ['new', 'new', 'new', 'new']);
  assert.equal(plan[0].rows.find((r) => r.isin === 'INE009A01021').price, null); // no price → flagged in review
  const choices = { '0:0': { price: '1105', firstBought: '2020-03-16', portfolioId: 'p1' } };
  let w = dematWrites(plan, choices, { date: cas.date, memberFor: (i) => ['m1', 'm3'][i] });
  assert.equal(w.demats.length, 2);
  assert.deepEqual(w.adds[0].txns, [{ date: '2020-03-16', qty: 60, price: 1105, kind: 'opening' }]);
  assert.equal(w.adds[1].txns[0].price, null);
  state = apply(state, w);

  // Re-import the same statement: nothing to write.
  plan = planDematImport(cas, state);
  assert.ok(plan.every((p) => p.demat), 'demats matched by DP ID + client ID');
  assert.deepEqual(plan.flatMap((p) => p.rows.map((r) => r.status)), ['same', 'same', 'same', 'same']);
  w = dematWrites(plan, {}, { date: cas.date, memberFor: () => null });
  assert.deepEqual(w, { demats: [], dematUpdates: [], adds: [], appends: [] });

  // Next month: Reliance 60 → 75 (bonus), HDFC Bank 200 → 150, Infosys gone.
  const next = NSDL.map((l) => l
    .replace('to 31-Oct-2026', 'to 30-Nov-2026')
    .replace('10.00 60 1,324.40 79,464.00', '10.00 75 1,324.40 99,330.00')
    .replace('1.00 200 798.15 1,59,630.00', '1.00 150 798.15 1,19,722.50'))
    .filter((l, i, all) => !l.startsWith('INE009A01021') && all[i - 1]?.startsWith('INE009A01021') !== true);
  const cas2 = parseDematCas(next);
  plan = planDematImport(cas2, state);
  const z = plan[0].rows.map((r) => [r.isin, r.status, r.before, r.qty, r.diff]);
  assert.deepEqual(z, [
    ['INE002A01018', 'up', 60, 75, 15],
    ['INE040A01034', 'down', 200, 150, -50],
    ['INE009A01021', 'missing', 40, 0, -40],
  ]);
  w = dematWrites(plan, { '0:0': { increase: 'bonus' }, '0:2': { sellAll: true } }, { date: cas2.date, memberFor: () => null });
  assert.deepEqual(w.appends.map((a) => a.txns[0]), [
    { date: '2026-11-30', qty: 15, price: 0, kind: 'bonus' },
    { date: '2026-11-30', qty: -50, price: null, kind: 'sell' },
    { date: '2026-11-30', qty: -40, price: null, kind: 'sell' },
  ]);
  state = apply(state, w);
  // ...and importing that statement again changes nothing.
  plan = planDematImport(cas2, state);
  assert.deepEqual(plan[0].rows.map((r) => r.status), ['same', 'same']);
  assert.deepEqual(dematWrites(plan, {}, { date: cas2.date, memberFor: () => null }), { demats: [], dematUpdates: [], adds: [], appends: [] });
});

test('"Bought more" with a price records a buy at that price', () => {
  const state = { demats: [{ id: 'd1', dpId: 'IN303028', clientId: '12345678' }], shares: [{ id: 's1', isin: 'INE002A01018', dematId: 'd1', txns: [{ date: '2020-01-01', qty: 50, price: 1000, kind: 'opening' }] }], prices: { p: {} } };
  const plan = planDematImport(parseDematCas(NSDL.slice(0, 9)), state);
  assert.equal(plan[0].rows[0].status, 'up');
  const w = dematWrites(plan, { '0:0': { increase: 'buy', price: '1300' } }, { date: '2026-10-31', memberFor: () => null });
  assert.deepEqual(w.appends[0].txns, [{ date: '2026-10-31', qty: 10, price: 1300, kind: 'buy' }]);
});

test('a statement account can be linked to an account added from Axis reports', () => {
  const state = { demats: [{ id: 'ax', broker: 'Axis Direct', brokerClientId: '1234567', dpId: '', clientId: '' }],
    shares: [{ id: 's1', isin: 'INE002A01018', dematId: 'ax', txns: [{ date: null, qty: 60, price: 900, kind: 'opening' }] }], prices: { p: {} } };
  const cas = parseDematCas(NSDL.slice(0, 9));
  assert.equal(planDematImport(cas, state)[0].demat, null); // not linked: looks like a new account
  const plan = planDematImport(cas, state, { 0: 'ax' });
  assert.equal(plan[0].demat.id, 'ax');
  assert.deepEqual(plan[0].rows.map((r) => r.status), ['same']); // Reliance 60 is already there
  const w = dematWrites(plan, {}, { date: cas.date, memberFor: () => null });
  assert.deepEqual(w.dematUpdates, [{ dematId: 'ax', patch: { dpId: 'IN303028', clientId: '12345678' } }]);
  assert.deepEqual([w.demats, w.adds, w.appends], [[], [], []]);
});
