// Axis Direct reports: the "Portfolio Holding Statement" (holdings on a date, with ISIN and Axis's
// average cost) and the "PAN Level Transaction Report" (trades and dividends between two dates).
// Read in the browser with js/xlsx.js; nothing is uploaded.
import { readXlsx } from './xlsx.js';

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "31-Mar-2026", "01/APR/2026", "2026-09-15", "15/09/2026" or an Excel date number -> "YYYY-MM-DD"
export function axisDate(v) {
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9}|\d{1,2})[-/ ](\d{4})$/);
  if (!m) return null;
  const mm = /^\d+$/.test(m[2]) ? +m[2] : MON[m[2].slice(0, 3).toLowerCase()];
  return mm ? `${m[3]}-${String(mm).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
const toNum = (v) => (typeof v === 'number' ? v : +String(v ?? '').replace(/,/g, ''));
const cell = (row, i) => (i >= 0 ? row[i] : undefined);

// Label/value pairs above the table ("Client ID", "Client Name", "Date", "From Date", …).
function meta(rows) {
  const out = {};
  for (const r of rows.slice(0, 15)) {
    const vals = r.filter((v) => v !== undefined && v !== null && v !== '');
    if (vals.length === 2 && typeof vals[0] === 'string') out[vals[0].trim().toLowerCase()] = vals[1];
  }
  return out;
}
function table(rows, required) {
  const hi = rows.findIndex((r) => required.every((h) => r.some((v) => String(v ?? '').trim() === h)));
  if (hi < 0) return null;
  const head = rows[hi].map((v) => String(v ?? '').trim());
  return { col: (name) => head.indexOf(name), body: rows.slice(hi + 1) };
}

// Holding statement -> { kind: 'holdings', clientId, name, asOf, rows: [{ name, isin, qty, invested, avgCost, marketPrice }] }
// Trade report      -> { kind: 'trades', clientId, name, from, to, trades: [{ date, name, side, qty, price, cost }], dividends: [{ date, name, amount }], other: [{ date, name, what, qty, dir }] }
export function parseAxisWorkbook(sheets) {
  for (const { rows } of sheets) {
    const m = meta(rows);
    const clientId = String(m['client id'] ?? '').trim();
    const name = String(m['client name'] ?? '').trim();
    const h = table(rows, ['ISIN', 'Open Qty']);
    if (h) {
      const c = { name: h.col('Stock Name'), isin: h.col('ISIN'), qty: h.col('Open Qty'), inv: h.col('Investment Amount'), avg: h.col('Avg Cost'), price: h.col('Market Price') };
      const out = [];
      for (const r of h.body) {
        const isin = String(cell(r, c.isin) ?? '').trim();
        if (!/^IN[A-Z0-9]{9}\d$/.test(isin)) continue;
        const qty = toNum(cell(r, c.qty)), inv = toNum(cell(r, c.inv)), avg = toNum(cell(r, c.avg));
        out.push({ name: String(cell(r, c.name) ?? '').trim(), isin, qty, invested: isFinite(inv) && inv > 0 ? inv : isFinite(avg) ? avg * qty : null, avgCost: isFinite(avg) ? avg : null, marketPrice: toNum(cell(r, c.price)) || null });
      }
      return { kind: 'holdings', clientId, name, asOf: axisDate(m['to date'] ?? m.date ?? m['as on date'] ?? m['as on']), from: axisDate(m['from date']), rows: out };
    }
    const t = table(rows, ['Buy/Sell', 'Trade Qty']);
    if (t) {
      const c = { date: t.col('Date'), name: t.col('Stock Name'), side: t.col('Buy/Sell'), qty: t.col('Trade Qty'), price: t.col('Trade Price'), value: t.col('Trade value'),
        brk: t.col('Brokerage'), gst: t.col('GST'), other: t.col('Other Charges') };
      const trades = [], dividends = [], other = [];
      for (const r of t.body) {
        const date = axisDate(cell(r, c.date)), nm = String(cell(r, c.name) ?? '').trim(), side = String(cell(r, c.side) ?? '').trim().toUpperCase();
        const qty = toNum(cell(r, c.qty)), price = toNum(cell(r, c.price)), value = toNum(cell(r, c.value));
        if (!date || !nm || !side) continue;
        if (side === 'BUY' || side === 'SELL') {
          // Axis's average cost includes brokerage, GST and stamp duty but not STT; match it for buys.
          const charges = [c.brk, c.gst, c.other].reduce((a, i) => a + (toNum(cell(r, i)) || 0), 0);
          trades.push({ date, name: nm, side, qty, price, cost: side === 'BUY' ? (value + charges) / qty : price });
        } else if (/DIVIDEND/.test(side)) dividends.push({ date, name: nm, amount: value });
        else other.push({ date, name: nm, what: side, qty, dir: actionDir(side) });
      }
      return { kind: 'trades', clientId, name, from: axisDate(m['from date']), to: axisDate(m['to date']), trades, dividends, other };
    }
  }
  return null;
}

// Corporate actions in the trade report (MERGER BUY/SELL, BONUS, SPLIT BUY/SELL, DEMERGERIN,
// DEMERGERBUY/SELL, BUYBACK, …): +1 adds shares, -1 removes them, 0 = not understood.
// Axis dates each of these with the date of the lot it applies to, not the date of the event.
export function actionDir(what) {
  const w = String(what).toUpperCase().replace(/[^A-Z]/g, '');
  if (/BUYBACK|SELL|OUT$|EXTINGUISH|REDEEM/.test(w)) return -1;
  if (/BUY|BONUS|IN$|ALLOT|RIGHTS|CREDIT/.test(w)) return 1;
  return 0;
}

export async function readAxisFile(file, password) {
  const sheets = await readXlsx(new Uint8Array(await file.arrayBuffer()), password);
  const parsed = parseAxisWorkbook(sheets);
  if (!parsed) throw new Error(`“${file.name}” isn’t an Axis Direct holding statement or transaction report.`);
  return parsed;
}

// ---------- matching against the tracker ----------
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9& ]/g, ' ').replace(/\b(ltd|limited|the|co|company|corp|corporation|inc)\b/g, ' ').split(/\s+/).filter(Boolean).join(' ');
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const sameTxns = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortTx = (t) => [...t].sort((x, y) => (x.date || '').localeCompare(y.date || '') || y.qty - x.qty);
const txnQty = (txns) => txns.reduce((a, t) => a + t.qty, 0);

// Names in the trade report -> ISIN: the holding statement's names first, then the price list.
function isinLookup(holdings, state) {
  const exact = new Map(holdings.rows.map((r) => [normName(r.name), r.isin]));
  const byName = new Map();
  for (const [isin, v] of Object.entries(state.prices?.p || {})) {
    for (const n of [v[2], state.stockMeta?.m?.[isin]?.[2]]) {
      if (!n) continue;
      const k = normName(n);
      byName.set(k, byName.has(k) && byName.get(k) !== isin ? null : isin); // null = ambiguous
    }
  }
  return (name) => exact.get(normName(name)) || byName.get(normName(name)) || null;
}

// The holding statement is the starting point (quantity and Axis's average cost on its date);
// trades after that date are added on top, and dividends are merged in. Re-importing the same files
// gives the same entries, so nothing changes.
export function planAxisImport({ holdings, trades }, state) {
  if (!holdings) throw new Error('Choose the Portfolio Holding Statement (the trade report is optional).');
  if (trades && holdings.clientId && trades.clientId && holdings.clientId !== trades.clientId) {
    throw new Error(`The two files are for different accounts (client ${holdings.clientId} and ${trades.clientId}).`);
  }
  const asOf = holdings.asOf;
  const later = (d) => !!asOf && d > asOf;
  const isinOf = isinLookup(holdings, state);
  const unmatched = new Set(), lateActions = [];
  const tradesBy = new Map(), divsBy = new Map(), eventsBy = new Map(), mergedAway = [];
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const t of trades?.trades || []) {
    const isin = isinOf(t.name);
    // A name we can't place only matters if it traded after the holdings date (otherwise the
    // holding statement already has it, or it's no longer held).
    if (!isin) { if (later(t.date)) unmatched.add(t.name); continue; }
    push(tradesBy, isin, t);
    push(eventsBy, isin, { date: t.date, qty: t.side === 'BUY' ? t.qty : -t.qty, buy: t.side === 'BUY' });
  }
  for (const o of trades?.other || []) {
    const isin = isinOf(o.name);
    if (!isin) { if (/^MERGER/i.test(o.what) && o.dir < 0) mergedAway.push(o.date); continue; }
    if (later(o.date)) { lateActions.push(o); continue; }
    if (o.dir) push(eventsBy, isin, { date: o.date, qty: o.dir * o.qty, buy: o.dir > 0 && /^MERGER|^DEMERGER ?IN|ALLOT|RIGHTS/i.test(o.what), merger: /^MERGER/i.test(o.what) && o.dir > 0 });
  }
  for (const d of trades?.dividends || []) {
    const isin = isinOf(d.name);
    if (isin) push(divsBy, isin, { date: d.date, amount: r4(d.amount) });
  }
  // Shares received in a merger were first bought as the merged-away company; when there's only
  // one merger into a share we hold, its first-bought date is the old company's.
  const mergerTargets = [...eventsBy].filter(([, es]) => es.some((e) => e.merger)).map(([isin]) => isin);
  const mergedFrom = mergerTargets.length === 1 && mergedAway.length ? mergedAway.sort()[0] : null;

  // First-bought date of what's held on the statement date: the start of the current run of
  // holding (after the last time the balance was zero), but only when the report explains every
  // share held. Otherwise null, and the share shows XIRR "—" until a date is added.
  const firstBoughtOf = (isin, held) => {
    const es = (eventsBy.get(isin) || []).filter((e) => !later(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    let bal = 0, start = null;
    for (let i = 0; i < es.length;) {
      const d = es[i].date;
      let buyHere = false;
      for (; i < es.length && es[i].date === d; i++) { bal += es[i].qty; buyHere ||= es[i].buy; }
      if (bal < -1e-6) return null; // sold shares bought before the report starts
      if (bal < 1e-6) start = null;
      else if (!start && buyHere) start = d;
    }
    if (Math.abs(bal - held) > 1e-6 || !start) return null;
    return mergedFrom && mergerTargets[0] === isin && mergedFrom < start ? mergedFrom : start;
  };

  const demat = state.demats.find((d) => d.brokerClientId && d.brokerClientId === holdings.clientId) || null;
  const tracked = demat ? state.shares.filter((s) => s.dematId === demat.id) : [];
  const isins = [...new Set([...holdings.rows.map((r) => r.isin), ...tradesBy.keys()])];
  const rows = isins.flatMap((isin) => {
    const h = holdings.rows.find((r) => r.isin === isin);
    const ts = tradesBy.get(isin) || [];
    const after = ts.filter((t) => later(t.date));
    const firstBuy = h && h.qty > 0 ? firstBoughtOf(isin, h.qty) : null;
    const share = tracked.find((s) => s.isin === isin) || null;
    const oldOpening = share?.txns?.find((t) => t.kind === 'opening');
    const txns = [];
    if (h && h.qty > 0) {
      txns.push({ date: firstBuy || oldOpening?.date || null, qty: h.qty,
        price: h.invested != null ? r4(h.invested / h.qty) : null, kind: 'opening' });
    }
    for (const t of after) txns.push({ date: t.date, qty: t.side === 'BUY' ? t.qty : -t.qty, price: r4(t.cost), kind: t.side === 'BUY' ? 'buy' : 'sell' });
    const newTxns = sortTx(txns);
    const divs = [...(share?.dividends || []), ...(divsBy.get(isin) || [])];
    const dividends = [...new Map(divs.map((d) => [`${d.date}|${r4(d.amount)}`, { date: d.date, amount: r4(d.amount) }])).values()].sort((a, b) => a.date.localeCompare(b.date));
    const qty = txnQty(newTxns), oldQty = share ? txnQty(share.txns || []) : 0;
    const status = !share ? 'new' : sameTxns(sortTx(share.txns || []), newTxns) && sameTxns(share.dividends || [], dividends) ? 'same' : 'changed';
    if (!share && !newTxns.length) return []; // bought and sold before the statement date: nothing held to record
    const name = h?.name || ts[0]?.name || isin;
    return [{ isin, name, status, share, txns: newTxns, dividends, qty, oldQty, held: h?.qty || 0, avgCost: h?.avgCost ?? null,
      marketPrice: h?.marketPrice ?? null, newDividends: dividends.length - (share?.dividends || []).length, laterTrades: after.length, price: state.prices?.p?.[isin]?.[0] ?? null }];
  });
  // Tracked in this account but in neither file: offered as "sold all".
  for (const s of tracked) {
    if (!isins.includes(s.isin) && txnQty(s.txns || []) > 0) rows.push({ isin: s.isin, name: '', status: 'missing', share: s, qty: 0, oldQty: txnQty(s.txns), price: state.prices?.p?.[s.isin]?.[0] ?? null });
  }
  return { account: { clientId: holdings.clientId, name: holdings.name || trades?.name || '', asOf, tradesFrom: trades?.from, tradesTo: trades?.to }, demat, rows,
    unmatched: [...unmatched], lateActions };
}

// choices[i] = { include, portfolioId, sellAll }; memberId for a new account.
export function axisWrites(plan, choices, { memberId, today }) {
  const out = { demats: [], adds: [], appends: [], replaces: [] };
  const dematId = plan.demat?.id || null, ref = 'axis';
  plan.rows.forEach((r, i) => {
    const c = choices[i] || {};
    if (c.include === false || r.status === 'same') return;
    if (r.status === 'new') out.adds.push({ dematId, dematRef: dematId ? null : ref, isin: r.isin, name: r.name, portfolioId: c.portfolioId || null, txns: r.txns, dividends: r.dividends });
    else if (r.status === 'changed') out.replaces.push({ shareId: r.share.id, txns: r.txns, dividends: r.dividends });
    else if (r.status === 'missing' && c.sellAll) out.appends.push({ shareId: r.share.id, txns: [{ date: plan.account.asOf || today, qty: -r.oldQty, price: null, kind: 'sell' }] });
  });
  if (!dematId && out.adds.length) {
    out.demats.push({ ref, broker: 'Axis Direct', brokerClientId: plan.account.clientId, dpId: '', clientId: '', holderName: plan.account.name, memberId: memberId || null });
  }
  return out;
}
