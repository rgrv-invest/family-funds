// Reads an NSDL or CDSL consolidated account statement (CAS, PDF) in the browser: demat accounts and
// the shares held in each. Nothing is uploaded. Mutual fund sections and other securities (bonds,
// ETFs, preference shares, …) are listed as skipped.
import { pdfLines } from './cas.js';

const MONTH_NO = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ISIN_ANY = /\b(IN[A-Z0-9]{9}\d)\b/;
const EQUITY_ISIN = /^INE[A-Z0-9]{4}01[A-Z0-9]{3}$/; // company equity shares
const NUMBER_RE = /^\(?-?(?:[\d,]*\.\d+|[\d,]+)\)?$/;
const DATE = String.raw`(\d{1,2})[-/ ]([A-Za-z]{3,9}|\d{1,2})[-/ ](\d{4})`;
const STMT_PERIOD_RE = new RegExp(String.raw`period\s+(?:from\s+)?${DATE}\s+(?:to|-)\s+${DATE}`, 'i');
const AS_ON_RE = new RegExp(String.raw`(?:as\s+on|statement\s+date\s*:?)\s+${DATE}`, 'i');
const DP_CLIENT_RE = /DP\s*ID\s*:?\s*([A-Z0-9]+)\s*,?\s*Client\s*ID\s*:?\s*(\d+)/i;
const BO_ID_RE = /BO\s*ID\s*:?\s*(\d{16})\b/i;
const DP_NAME_RE = /DP\s*Name\s*:?\s*(.+?)(?:\s{2,}|\s+BO\s*ID|\s+DP\s*ID|$)/i;
const PAN_RE = /([A-Z][A-Za-z .&'-]+?)\s*\(\s*PAN\s*:?\s*[A-Z]{5}\d{4}[A-Z]\s*\)/g;
const BROKER_SPLIT = /^(.*\b(?:LIMITED|LTD\.?|PVT\.?\s+LTD\.?|PRIVATE\s+LIMITED|SECURITIES|BROKING|BANK))\s+(.+)$/i;

// Section headings: which kind of securities the next table holds.
const SECTIONS = [
  [/^\s*(equity shares|equities\s*\(e\)|equity)\s*$/i, 'equity'],
  [/^\s*(mutual funds?\s*\(m\)|mutual fund units|mutual fund folios|mutual funds? units held)/i, 'mf'],
  [/^\s*(corporate bonds|preference shares|government securities|money market|securitised|alternate investment|postal saving|national pension|zero coupon|debentures|bonds)\b/i, 'other'],
];

const ACRONYMS = new Set(['icici', 'hdfc', 'sbi', 'iifl', 'idbi', 'idfc', 'jm', 'nsdl', 'cdsl', 'smc', 'ifl', 'bnp', 'hsbc', 'kfin', 'cams']);
const isoDate = (d, m, y) => {
  const mm = /^\d+$/.test(m) ? +m : MONTH_NO[m.slice(0, 3).toLowerCase()];
  return mm ? `${y}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
const num = (s) => (s.startsWith('(') ? -1 : 1) * +s.replace(/[(),]/g, '');
const shortBroker = (b) => (b || '').replace(/\b(BROKING|SECURITIES|STOCK|BROKERS?|CAPITAL|SERVICES|INVESTMENTS?|PVT\.?|PRIVATE|LIMITED|LTD\.?|INDIA)\b\.?/gi, '').replace(/\s+/g, ' ').trim()
  .toLowerCase().replace(/\b\w+/g, (w) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));

// The share count is the number that closes count × price ≈ value (the last two numbers in a row).
// NSDL rows print face value, shares, price, value; CDSL rows print the current balance and
// several other balances before price and value.
function holdingFromNumbers(nums) {
  if (nums.length < 3) return null;
  const price = nums[nums.length - 2], value = nums[nums.length - 1];
  const candidates = nums.slice(0, -2);
  const qty = candidates.find((q) => q > 0 && Number.isInteger(q) && Math.abs(q * price - value) <= Math.max(1, value * 0.01))
    ?? (candidates.length >= 6 ? candidates[0] : candidates[candidates.length - 1]);
  if (!(qty > 0)) return null;
  return { qty, price, value };
}

export function parseDematCas(lines) {
  let date = null;
  const accounts = new Map();
  const skipped = [];
  let acct = null, section = null, pendingBroker = '';

  const account = (dpId, clientId) => {
    const key = `${dpId}|${clientId}`;
    if (!accounts.has(key)) accounts.set(key, { dpId, clientId, broker: '', holders: [], equities: [] });
    return accounts.get(key);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!date) {
      const pm = line.match(STMT_PERIOD_RE);
      if (pm) date = isoDate(pm[4], pm[5], pm[6]);
      else {
        const am = line.match(AS_ON_RE);
        if (am) date = isoDate(am[1], am[2], am[3]);
      }
    }

    // Demat account headers: "DP ID:IN300xxx Client ID:12345678" (NSDL), "BO ID : 1208…" (CDSL).
    const dn = line.match(DP_NAME_RE);
    if (dn && !ISIN_ANY.test(line)) pendingBroker = dn[1].trim();
    const dc = line.match(DP_CLIENT_RE);
    const bo = !dc && line.match(BO_ID_RE);
    if (dc || bo) {
      acct = dc ? account(dc[1].toUpperCase(), dc[2]) : account(bo[1].slice(0, 8), bo[1].slice(8));
      section = null;
      // Broker: a "DP Name" line, or the line just above the DP ID ("ZERODHA BROKING LIMITED  NAME (PAN:…)").
      if (!acct.broker) {
        const noPan = (t) => t.replace(/\(\s*PAN[^)]*\)/gi, '').trim();
        const before = noPan(line.slice(0, dc ? dc.index : bo.index));
        const prev = noPan(lines[i - 1] || '');
        const guess = pendingBroker || (before.length > 3 ? before : '') || (/demat account|account holder/i.test(prev) ? '' : prev);
        const split = guess.match(BROKER_SPLIT);
        acct.broker = (split ? split[1] : guess).replace(/\b(NSDL|CDSL)\s+Demat\s+Account\b/i, '').trim();
      }
      pendingBroker = '';
      // Holder names "NAME (PAN:XXXXX1234X)" on this line and the two either side.
      for (const l of [lines[i - 1], line, lines[i + 1]]) {
        for (const m of (l || '').matchAll(PAN_RE)) {
          let name = m[1].trim();
          const split = name.match(BROKER_SPLIT);
          if (split) name = split[2];
          if (name && !acct.holders.includes(name)) acct.holders.push(name);
        }
      }
      continue;
    }

    const sec = SECTIONS.find(([re]) => re.test(line));
    if (sec && !ISIN_ANY.test(line)) { section = sec[1]; continue; }

    const im = line.match(ISIN_ANY);
    if (!im || !acct) continue;
    const isin = im[1];
    // A row's numbers can sit on the line below its ISIN when the name wraps; gather up to 3 lines.
    let text = line.slice(im.index + isin.length);
    let tokens = text.split(/\s+/).filter((t) => NUMBER_RE.test(t));
    for (let j = 1; tokens.length < 3 && j <= 3 && lines[i + j] && !ISIN_ANY.test(lines[i + j]); j++) {
      text += ' ' + lines[i + j];
      tokens = text.split(/\s+/).filter((t) => NUMBER_RE.test(t));
    }
    const name = text.split(/\s+/).filter((t) => t && !NUMBER_RE.test(t) && !/^[-–]+$/.test(t)).join(' ')
      .replace(/^[A-Z0-9&-]+\.(?:NSE|BSE)\s+/, '').trim();
    const h = holdingFromNumbers(tokens.map(num));
    if (section === 'mf' || isin.startsWith('INF')) { skipped.push({ isin, name, kind: 'Mutual fund / ETF' }); continue; }
    if (section === 'other' || !EQUITY_ISIN.test(isin)) { skipped.push({ isin, name, kind: 'Not an equity share' }); continue; }
    if (!h) { skipped.push({ isin, name, kind: 'Couldn’t read the quantity' }); continue; }
    if (!acct.equities.some((e) => e.isin === isin)) acct.equities.push({ isin, name, ...h });
  }
  const list = [...accounts.values()].map((a) => ({ ...a, brokerShort: shortBroker(a.broker) }));
  return { date, accounts: list.filter((a) => a.equities.length || list.length === 1), allAccounts: list, skipped };
}

export async function readDematCas(file, password) {
  const lines = await pdfLines(new Uint8Array(await file.arrayBuffer()), password,
    'usually your PAN in capital letters (e.g. ABCDE1234F)');
  const cas = parseDematCas(lines);
  if (!cas.allAccounts.length) {
    throw new Error(lines.some((l) => /folio no/i.test(l))
      ? 'This looks like a mutual fund statement (CAMS / KFintech). Choose “Mutual funds” instead.'
      : 'Couldn’t find any demat account in this file. Use the NSDL or CDSL consolidated account statement (CAS).');
  }
  return cas;
}

// ---------- matching against the tracker ----------
const qtyOf = (sh) => (sh.txns || []).reduce((a, t) => a + t.qty, 0);

// For each demat account in the statement: the tracked demat (by DP ID + client ID) and one row per
// share: 'new', 'same', 'up' / 'down' (quantity change) or 'missing' (tracked but not in the statement).
export function planDematImport(cas, state) {
  const priceOf = (isin) => state.prices?.p?.[isin]?.[0] ?? null;
  return cas.accounts.map((a) => {
    const demat = state.demats.find((d) => d.dpId === a.dpId && d.clientId === a.clientId) || null;
    const tracked = demat ? state.shares.filter((s) => s.dematId === demat.id) : [];
    const rows = a.equities.map((e) => {
      const share = tracked.find((s) => s.isin === e.isin) || null;
      const before = share ? qtyOf(share) : 0;
      const diff = Math.round((e.qty - before) * 1e6) / 1e6;
      const status = !share || before <= 0 ? (share ? 'up' : 'new') : diff === 0 ? 'same' : diff > 0 ? 'up' : 'down';
      return { isin: e.isin, name: e.name, qty: e.qty, before, diff, status, share, stmtPrice: e.price, stmtValue: e.value, price: priceOf(e.isin) };
    });
    const seen = new Set(a.equities.map((e) => e.isin));
    for (const s of tracked) {
      const before = qtyOf(s);
      if (!seen.has(s.isin) && before > 0) rows.push({ isin: s.isin, name: '', qty: 0, before, diff: -before, status: 'missing', share: s, price: priceOf(s.isin) });
    }
    return { account: a, demat, rows };
  });
}

// Turn the reviewed plan into store writes. choices[rowKey] carries the reviewer's answers:
// { include, price, firstBought, portfolioId, increase: 'buy' | 'bonus', sellAll }.
export function dematWrites(plan, choices, { date, memberFor }) {
  const out = { demats: [], adds: [], appends: [] };
  plan.forEach((p, ai) => {
    const ref = `new${ai}`;
    const dematId = p.demat?.id || null;
    let used = false;
    p.rows.forEach((r, ri) => {
      const c = choices[`${ai}:${ri}`] || {};
      if (c.include === false) return;
      const price = c.price === '' || c.price == null ? null : +c.price;
      if (r.status === 'new') {
        out.adds.push({ dematId, dematRef: dematId ? null : ref, isin: r.isin, portfolioId: c.portfolioId || null,
          txns: [{ date: c.firstBought || null, qty: r.qty, price, kind: 'opening' }] });
        used = true;
      } else if (r.status === 'up') {
        const bonus = c.increase === 'bonus';
        out.appends.push({ shareId: r.share.id, txns: [{ date, qty: r.diff, price: bonus ? 0 : price, kind: bonus ? 'bonus' : 'buy' }] });
      } else if (r.status === 'down') {
        out.appends.push({ shareId: r.share.id, txns: [{ date, qty: r.diff, price: null, kind: 'sell' }] });
      } else if (r.status === 'missing' && c.sellAll) {
        out.appends.push({ shareId: r.share.id, txns: [{ date, qty: -r.before, price: null, kind: 'sell' }] });
      }
    });
    if (!dematId && used) {
      out.demats.push({ ref, broker: p.account.brokerShort || p.account.broker, dpId: p.account.dpId, clientId: p.account.clientId,
        holderName: p.account.holders.join(', '), memberId: memberFor(ai) || null });
    }
  });
  return out;
}
