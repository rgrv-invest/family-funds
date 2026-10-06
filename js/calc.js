// Portfolio maths: FIFO cost basis, XIRR, aggregation and breakups.

const DAY = 864e5;

// XIRR via Newton-Raphson with bisection fallback. flows: [{ date: 'YYYY-MM-DD', amount }]
// Sign convention: money going in to the investment is negative, money coming out positive.
export function xirr(flows) {
  if (flows.length < 2) return null;
  const hasNeg = flows.some((f) => f.amount < 0);
  const hasPos = flows.some((f) => f.amount > 0);
  if (!hasNeg || !hasPos) return null;
  const t0 = Math.min(...flows.map((f) => Date.parse(f.date)));
  const cf = flows.map((f) => ({ a: f.amount, y: (Date.parse(f.date) - t0) / (365 * DAY) }));
  const npv = (r) => cf.reduce((s, c) => s + c.a / Math.pow(1 + r, c.y), 0);
  const dnpv = (r) => cf.reduce((s, c) => s - (c.y * c.a) / Math.pow(1 + r, c.y + 1), 0);

  // The rate's sign must match the overall gain: npv(0) is the plain sum of the flows. A root on
  // the other side (or a runaway one) is an artefact, e.g. of flows dated out of order.
  const gain = npv(0);
  if (gain === 0) return 0;
  const plausible = (x) => isFinite(x) && x > -1 && Math.sign(x) === Math.sign(gain);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const v = npv(r);
    const d = dnpv(r);
    if (!isFinite(v) || !isFinite(d) || d === 0) break;
    const next = r - v / d;
    if (next <= -0.9999 || !isFinite(next)) break;
    if (Math.abs(next - r) < 1e-8) { if (plausible(next)) return next; break; }
    r = next;
  }
  // Bisection on the side the gain points to: (-1, 0) for a loss, (0, hi) for a gain.
  let lo, hi;
  if (gain < 0) { lo = -0.999999; hi = 0; } else {
    lo = 0; hi = 1;
    while (npv(hi) > 0 && hi < 1e12) hi *= 10;
  }
  let flo = npv(lo);
  if (!isFinite(flo) || flo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-6) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// Stats for one holding: units held, FIFO cost of units held, current value, cash flows.
export function holdingStats(h, scheme, navDate) {
  const lots = [];
  const flows = [];
  for (const t of [...h.txns].sort((a, b) => a.date.localeCompare(b.date))) {
    flows.push({ date: t.date, amount: -t.amount });
    if (t.units > 0) {
      lots.push({ units: t.units, cost: t.amount });
    } else {
      // A reversal (bounced cheque, rejected purchase) cancels the purchase it reverses: same units,
      // same money back. Remove that lot instead of selling the oldest units first.
      const r = lots.findLastIndex((l) => Math.abs(l.units + t.units) < 5e-4 && Math.abs(l.cost + t.amount) <= Math.max(1, l.cost * 1e-3));
      if (r >= 0) { lots.splice(r, 1); continue; }
      let toSell = -t.units;
      while (toSell > 1e-9 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.units, toSell);
        const perUnit = lot.cost / lot.units;
        lot.units -= take;
        lot.cost -= take * perUnit;
        toSell -= take;
        if (lot.units <= 1e-9) lots.shift();
      }
    }
  }
  const units = lots.reduce((s, l) => s + l.units, 0);
  const invested = lots.reduce((s, l) => s + l.cost, 0);
  const current = units * scheme.nav;
  return { units, invested, current, flows, navDate };
}

// Aggregate a list of holdings into totals, XIRR and breakups.
export function summarize(holdings, state) {
  const schemeBy = Object.fromEntries(state.schemes.map((s) => [s.code, s]));
  let invested = 0, current = 0;
  const flows = [];
  const byAsset = {}, byCategory = {};
  for (const h of holdings) {
    const s = schemeBy[h.schemeCode];
    if (!s) continue;
    const st = holdingStats(h, s, state.navDate);
    invested += st.invested;
    current += st.current;
    flows.push(...st.flows);
    byAsset[s.assetClass] = (byAsset[s.assetClass] || 0) + st.current;
    byCategory[s.category] = (byCategory[s.category] || 0) + st.current;
  }
  // Value on the NAV date, or on the latest transaction if that's newer: NAVs are published a day
  // or so late, and a purchase dated after the valuation would read a loss as a huge gain.
  const valueDate = flows.reduce((m, f) => (f.date > m ? f.date : m), state.navDate);
  const r = current > 0 ? xirr([...flows, { date: valueDate, amount: current }]) : null;
  const toList = (o) =>
    Object.entries(o)
      .map(([name, value]) => ({ name, value, pct: current ? value / current : 0 }))
      .sort((a, b) => b.value - a.value);
  return {
    invested,
    current,
    gain: current - invested,
    gainPct: invested ? (current - invested) / invested : 0,
    xirr: r,
    byAsset: toList(byAsset),
    byCategory: toList(byCategory),
    count: holdings.length,
  };
}

// Selectors
export const holdingsOfFolios = (state, folioIds) => {
  const set = new Set(folioIds);
  return state.holdings.filter((h) => set.has(h.folioId));
};
export const foliosOfPortfolio = (state, pid) => state.folios.filter((f) => f.portfolioId === pid);
export const portfoliosOfMember = (state, mid) => state.portfolios.filter((p) => p.memberId === mid);
export const foliosOfMember = (state, mid) => {
  const pids = new Set(portfoliosOfMember(state, mid).map((p) => p.id));
  return state.folios.filter((f) => pids.has(f.portfolioId));
};

// Holdings grouped by scheme across all the given folios.
export function schemeSummary(holdings, state) {
  const schemeBy = Object.fromEntries(state.schemes.map((s) => [s.code, s]));
  const groups = {};
  for (const h of holdings) (groups[h.schemeCode] ||= []).push(h);
  const rows = Object.entries(groups).map(([code, hs]) => {
    const scheme = schemeBy[code];
    const sum = summarize(hs, state);
    const units = hs.reduce((a, h) => a + holdingStats(h, scheme, state.navDate).units, 0);
    return { scheme, sum, units, folios: new Set(hs.map((h) => h.folioId)).size };
  });
  return rows.filter((r) => r.units > 1e-6).sort((a, b) => b.sum.current - a.sum.current);
}
