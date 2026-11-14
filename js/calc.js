// Portfolio maths: FIFO cost basis, XIRR, aggregation and breakups.

const DAY = 864e5;

// XIRR via Newton-Raphson with bisection fallback. flows: [{ date: 'YYYY-MM-DD', amount }]
// Sign convention: money going in to the investment is negative, money coming out positive.
export function xirr(flows) {
  // Net same-day flows: a purchase and its same-day reversal cancel out instead of skewing the result.
  const byDate = new Map();
  for (const f of flows) byDate.set(f.date, (byDate.get(f.date) || 0) + f.amount);
  flows = [...byDate].map(([date, amount]) => ({ date, amount })).filter((f) => Math.abs(f.amount) > 0.005);
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

// Stats for one holding: units held, FIFO cost of units held, current value, all cash flows,
// the cash flows of the units still held (each remaining lot's cost on its purchase date),
// the date of the last purchase that wasn't reversed, and (for closed holdings) what was bought,
// what came back from sales and payouts, and the date of the last sale.
export function holdingStats(h, scheme, navDate) {
  const lots = [];
  const buys = [];
  const flows = [];
  let bought = 0, sold = 0, lastSale = null;
  // Same day: purchases before sales, so a reversal printed above its purchase can still cancel it.
  for (const t of [...h.txns].sort((a, b) => a.date.localeCompare(b.date) || b.units - a.units)) {
    flows.push({ date: t.date, amount: -t.amount });
    if (t.units > 0) {
      const lot = { units: t.units, cost: t.amount, date: t.date };
      lots.push(lot);
      buys.push(lot);
      bought += t.amount;
    } else if (t.units === 0) {
      sold -= t.amount; // IDCW payout: money back, no units
    } else {
      // A reversal (bounced cheque, rejected purchase) cancels the purchase it reverses: same units,
      // same money back. Remove that lot instead of selling the oldest units first.
      const r = lots.findLastIndex((l) => Math.abs(l.units + t.units) < 5e-4 && Math.abs(l.cost + t.amount) <= Math.max(1, l.cost * 1e-3));
      if (r >= 0) { lots[r].reversed = true; bought -= lots[r].cost; lots.splice(r, 1); continue; }
      sold -= t.amount;
      lastSale = t.date;
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
  const lastBuy = buys.reduce((m, b) => (!b.reversed && b.date > m ? b.date : m), '') || null;
  const heldFlows = lots.filter((l) => l.units > 1e-9).map((l) => ({ date: l.date, amount: -l.cost }));
  return { units, invested, current, flows, heldFlows, navDate, lastBuy, bought, sold, lastSale };
}

// Aggregate a list of holdings into totals, XIRR and breakups.
export function summarize(holdings, state) {
  const schemeBy = Object.fromEntries(state.schemes.map((s) => [s.code, s]));
  let invested = 0, current = 0, held = 0;
  const flows = [];
  const byAsset = {}, byCategory = {};
  for (const h of holdings) {
    const s = schemeBy[h.schemeCode];
    if (!s) continue;
    const st = holdingStats(h, s, state.navDate);
    invested += st.invested;
    current += st.current;
    if (st.units > 1e-6) held++;
    // XIRR covers only the units still held, like Gain / loss: sold units and their sales are left out.
    flows.push(...st.heldFlows);
    byAsset[s.assetClass] = (byAsset[s.assetClass] || 0) + st.current;
    byCategory[s.category] = (byCategory[s.category] || 0) + st.current;
  }
  // Value on the NAV date, or on the latest purchase if that's newer: NAVs are published a day
  // or so late, and a purchase dated after the valuation would read a loss as a huge gain.
  const valueDate = flows.reduce((m, f) => (f.date > m ? f.date : m), state.navDate);
  const r = current > 0 ? xirr([...flows, { date: valueDate, amount: current }]) : null;
  const toList = (o) =>
    Object.entries(o)
      .filter(([, value]) => value > 1e-6) // sold-out funds have nothing left to show
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
    count: held,
    flows, // held units' cash flows, for the combined funds + shares XIRR
    valueDate,
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

// A folio is closed once every unit in it has been sold (or every purchase reversed).
export function folioClosed(state, folioId) {
  const hs = state.holdings.filter((h) => h.folioId === folioId);
  return hs.length > 0 && hs.every((h) => holdingStats(h, { nav: 0 }, state.navDate).units <= 1e-6);
}

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

// ---------- shares ----------
// A share's txns: [{ date|null, qty, price|null, kind }], kind 'buy' | 'sell' | 'bonus' | 'split' | 'opening'.
// Quantity is the sum of qty. Cost is average cost: a sale removes the same fraction of every lot
// held, so each remaining lot keeps its date for XIRR. A bonus or split adds quantity at zero cost.
// A lot bought with price null has an unknown cost, which makes the holding's cost unknown.
const YEAR = 365 * DAY;
const FREE = new Set(['bonus', 'split']);
export const CAP_NAMES = { L: 'Large', M: 'Mid', S: 'Small' };

export const priceOf = (state, isin) => state.prices?.p?.[isin]?.[0] ?? null;
export function shareInfo(state, sh) {
  const p = state.prices?.p?.[sh.isin];
  const m = state.stockMeta?.m?.[sh.isin];
  return {
    // Current name from NSE's company list (follows renames, mergers and demergers); then the name the
    // broker gave at import (ETFs aren't in that list, and the exchange's ETF names are codes); then
    // the price file's abbreviated name.
    name: m?.[2] || sh.name || p?.[2] || sh.isin,
    symbol: p?.[1] || '',
    cap: CAP_NAMES[m?.[0]] || 'Unclassified',
    sector: sh.sectorOverride || m?.[1] || (/^INF/.test(sh.isin || '') ? 'ETF' : 'Other'),
  };
}

// Stats for one share. valueDate: the price date.
export function shareStats(sh, price, valueDate) {
  const txns = [...(sh.txns || [])].sort((a, b) => (a.date || '').localeCompare(b.date || '') || b.qty - a.qty);
  let lots = [];
  let lastSale = null, firstBought = null;
  for (const t of txns) {
    if (t.qty > 0) {
      const cost = FREE.has(t.kind) ? 0 : t.price == null ? null : t.qty * t.price;
      lots.push({ qty: t.qty, cost, date: t.date || null });
      if (t.date && !FREE.has(t.kind) && (!firstBought || t.date < firstBought)) firstBought = t.date;
    } else if (t.qty < 0) {
      const held = lots.reduce((a, l) => a + l.qty, 0);
      if (held <= 1e-9) continue;
      const keep = Math.max(0, 1 + t.qty / held);
      lots = lots.map((l) => ({ ...l, qty: l.qty * keep, cost: l.cost == null ? null : l.cost * keep })).filter((l) => l.qty > 1e-9);
      if (t.date) lastSale = t.date;
    }
  }
  const qty = Math.max(0, (sh.txns || []).reduce((a, t) => a + t.qty, 0));
  const held = qty > 1e-9;
  const known = held && lots.every((l) => l.cost != null);
  const invested = known ? lots.reduce((a, l) => a + l.cost, 0) : null;
  const current = held && price != null ? qty * price : null;
  const gain = invested != null && current != null ? current - invested : null;

  // XIRR: each held lot's cost on its date, dividends since the first held lot, today's value.
  const costed = lots.filter((l) => l.cost > 0);
  const start = costed.reduce((m, l) => (l.date && (!m || l.date < m) ? l.date : m), null);
  const divs = (sh.dividends || []).filter((d) => d.date && d.amount > 0 && (!start || d.date >= start));
  let flows = null, xirrNote = null, rate = null;
  if (!held) xirrNote = 'sold';
  else if (price == null) xirrNote = 'noprice';
  else if (!known) xirrNote = 'nocost';
  else if (costed.some((l) => !l.date) || !start) xirrNote = 'nodate';
  else {
    flows = [...costed.map((l) => ({ date: l.date, amount: -l.cost })), ...divs.map((d) => ({ date: d.date, amount: d.amount }))];
    const end = flows.reduce((m, f) => (f.date > m ? f.date : m), valueDate || '');
    if (Date.parse(end) - Date.parse(start) < YEAR) xirrNote = 'young';
    else rate = xirr([...flows, { date: end, amount: current }]);
  }
  return {
    qty, held, invested, current, gain,
    gainPct: gain != null && invested ? gain / invested : null,
    avgPrice: invested != null && held ? invested / qty : null,
    xirr: rate, xirrNote, flows, start,
    hasDividends: divs.length > 0,
    firstBought, lastSale,
  };
}

// Totals for a list of shares. Shares without a buy price count in current value only; shares
// without a price count nowhere. XIRR covers shares with a known cost and dated purchases.
export function summarizeShares(shares, state) {
  const valueDate = state.prices?.date || state.navDate;
  let invested = 0, current = 0, gain = 0, held = 0, missingCost = 0, noPrice = 0, divs = false;
  const flows = [];
  let xirrValue = 0;
  const byCap = {}, bySector = {};
  for (const sh of shares) {
    const st = shareStats(sh, priceOf(state, sh.isin), valueDate);
    if (!st.held) continue;
    held++;
    if (st.current == null) { noPrice++; continue; }
    current += st.current;
    const info = shareInfo(state, sh);
    byCap[info.cap] = (byCap[info.cap] || 0) + st.current;
    bySector[info.sector] = (bySector[info.sector] || 0) + st.current;
    if (st.invested == null) { missingCost++; continue; }
    invested += st.invested;
    gain += st.gain;
    if (st.flows) { flows.push(...st.flows); xirrValue += st.current; divs ||= st.hasDividends; }
  }
  const x = combinedXirr(flows, xirrValue, valueDate, true);
  const toList = (o) => Object.entries(o).filter(([, v]) => v > 1e-6)
    .map(([name, value]) => ({ name, value, pct: current ? value / current : 0 })).sort((a, b) => b.value - a.value);
  return {
    invested, current, gain, gainPct: invested ? gain / invested : 0,
    xirr: x.xirr, xirrNote: x.note, hasDividends: divs,
    count: held, missingCost, noPrice,
    byCap: toList(byCap), bySector: toList(bySector),
    flows, xirrValue, valueDate,
  };
}

// XIRR of cash flows against a value on the later of valueDate and the last flow. With shares in
// the mix, a span under a year shows "< 1 yr" rather than an annualised figure.
function combinedXirr(flows, value, valueDate, young) {
  if (!flows.length || value <= 0) return { xirr: null, note: null };
  const start = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0].date);
  const end = flows.reduce((m, f) => (f.date > m ? f.date : m), valueDate || '');
  if (young && Date.parse(end) - Date.parse(start) < YEAR) return { xirr: null, note: 'young' };
  return { xirr: xirr([...flows, { date: end, amount: value }]), note: null };
}

// Funds + shares for the "All" view: totals add up, XIRR merges both sets of cash flows with one
// value on the later of the NAV date and the price date. Asset classes gain a "Shares" slice;
// fund categories stay as a share of fund value.
export function summarizeAll(holdings, shares, state) {
  const f = summarize(holdings, state);
  const s = summarizeShares(shares, state);
  const current = f.current + s.current;
  const invested = f.invested + s.invested;
  const gain = f.gain + s.gain;
  const valueDate = [f.valueDate, s.valueDate].filter(Boolean).sort().pop();
  const x = combinedXirr([...f.flows, ...s.flows], f.current + s.xirrValue, valueDate, s.flows.length > 0);
  const byAsset = [...f.byAsset.map((a) => ({ ...a })), ...(s.current > 0 ? [{ name: 'Shares', value: s.current }] : [])]
    .map((a) => ({ ...a, pct: current ? a.value / current : 0 })).sort((a, b) => b.value - a.value);
  return {
    invested, current, gain, gainPct: invested ? gain / invested : 0,
    xirr: s.flows.length ? x.xirr : f.xirr, xirrNote: s.flows.length ? x.note : null,
    hasDividends: s.hasDividends,
    byAsset, byCategory: f.byCategory, // fund categories: share of fund value
    count: f.count + s.count, missingCost: s.missingCost, noPrice: s.noPrice,
    funds: f, shares: s,
  };
}

// Selectors for shares (a share sits in a portfolio, like a folio).
export const sharesOfPortfolio = (state, pid) => state.shares.filter((s) => s.portfolioId === pid);
export const sharesOfMember = (state, mid) => {
  const pids = new Set(portfoliosOfMember(state, mid).map((p) => p.id));
  return state.shares.filter((s) => pids.has(s.portfolioId));
};
export const shareHeld = (sh) => (sh.txns || []).reduce((a, t) => a + t.qty, 0) > 1e-9;
