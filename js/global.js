// GIFT City (IFSC) funds: priced in US dollars and not in AMFI's NAV data. The daily GitHub job
// (scripts/global_funds.py) saves their NAV history and the dollar-to-rupee rate in
// data/global-funds.json; this turns those into rupee NAVs so the funds work like any other scheme.
// Their scheme codes start with "gift:" (e.g. "gift:DGEQ-A").
export const isGlobal = (code) => String(code || '').startsWith('gift:');

// Last [date, value] row on or before day (rows sorted by date).
function onOrBefore(rows, day) {
  let lo = 0, hi = (rows?.length || 0) - 1, hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= day) { hit = rows[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return hit;
}

export const globalFund = (g, code) => g?.funds?.find((f) => f.code === code) || null;
// The dollar rate of the same day as the NAV. The ECB publishes no rate on its holidays; then the
// last rate before that day is used (and its date shown).
export const usdInrOn = (g, day) => onOrBefore(g?.usdInr, day)?.[1] ?? null;
const usdInrRowOn = (g, day) => onOrBefore(g?.usdInr, day);
// NAV in the fund's currency on (or the last NAV day before) a date: { nav, date }.
export function navUsdOn(g, code, day) {
  const r = onOrBefore(globalFund(g, code)?.navs, day);
  return r ? { nav: r[1], date: r[0] } : null;
}
// NAV in rupees on a date: that day's dollar NAV at that day's exchange rate.
export function navOnGlobal(g, code, day) {
  const n = navUsdOn(g, code, day);
  const fx = n && usdInrRowOn(g, n.date);
  return n && fx ? { nav: n.nav * fx[1], date: n.date, navUsd: n.nav, usdInr: fx[1], usdInrDate: fx[0] } : null;
}

// Scheme record for a GIFT City fund (what's stored in Firestore; NAVs come from the file).
export function globalScheme(g, code) {
  const f = globalFund(g, code);
  return f ? { code, name: f.name, amc: f.amc, assetClass: f.assetClass, category: f.category, currency: f.currency } : null;
}

// Latest and previous rupee NAVs, for valuation and the day's change. Each dollar NAV is converted
// at the rate of its own date, not today's: a NAV of 17 Nov uses the 17 Nov rate.
export function globalQuote(g, code) {
  const navs = globalFund(g, code)?.navs;
  if (!navs?.length) return null;
  const at = (r) => { const fx = r && usdInrRowOn(g, r[0]); return fx ? { nav: r[1] * fx[1], navUsd: r[1], usdInr: fx[1], usdInrDate: fx[0], date: r[0] } : null; };
  const last = at(navs[navs.length - 1]), prev = at(navs[navs.length - 2]);
  if (!last) return null;
  return { nav: last.nav, navDate: last.date, navUsd: last.navUsd, usdInr: last.usdInr, usdInrDate: last.usdInrDate, prevNav: prev?.nav ?? null, prevNavDate: prev?.date ?? null };
}

// Schemes with GIFT City funds' rupee NAVs filled in from the file.
export function withGlobal(schemes, g) {
  return schemes.map((s) => {
    if (!isGlobal(s.code)) return s;
    const q = globalQuote(g, s.code);
    return q ? { ...s, ...q } : { ...s, nav: s.nav ?? 0 };
  });
}

// Search the GIFT City funds by name: every word typed must start a word of the name, ignoring
// punctuation, so "DSP Global Equity Fund- Class A" (as on DSP's statement) finds Class A only.
const nameWords = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export function searchGlobal(g, q) {
  const typed = nameWords(q);
  if (!typed.length) return [];
  return (g?.funds || []).filter((f) => {
    const name = nameWords(`${f.name} gift city ifsc`);
    return typed.every((w) => name.some((n) => n.startsWith(w)));
  }).map((f) => ({ code: f.code, name: f.name }));
}
