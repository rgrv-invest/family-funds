// Mutual fund data from mfapi.in (free mirror of AMFI's NAV data, works from the browser).
const API = 'https://api.mfapi.in/mf';

// "03-10-2026" -> "2026-10-03"
export const isoDate = (dmy) => dmy.split('-').reverse().join('-');

// Turn AMFI's category string into our asset class + short category.
export function classify(name, schemeCategory = '') {
  const cat = schemeCategory.replace(/\s+/g, ' ').trim();
  const i = cat.indexOf('-');
  const group = (i >= 0 ? cat.slice(0, i) : cat).trim();
  const sub = i >= 0 ? cat.slice(i + 1).trim() : '';
  const short = (sub || group || 'Other').replace(/\s*Fund$/i, '').replace(/\s*Scheme$/i, '').trim();
  const n = name.toLowerCase();
  let asset = 'Other';
  if (/gold|silver/.test(n)) asset = 'Gold';
  else if (/^equity/i.test(group)) asset = 'Equity';
  else if (/^debt|income/i.test(group)) asset = 'Debt';
  else if (/^hybrid/i.test(group)) asset = 'Hybrid';
  else if (/solution/i.test(group)) asset = /pure equity|equity plan/.test(n) ? 'Equity' : /debt|conservative/.test(n) ? 'Debt' : 'Hybrid';
  else if (/gilt|bond|debt|liquid|money market|sdl|g-sec|psu|crisil|treasury|overnight/.test(n)) asset = 'Debt';
  else if (/index|etf|nifty|sensex|fof|overseas|global|international|nasdaq|s&p/.test(n + ' ' + cat.toLowerCase())) asset = 'Equity';
  let category = short.replace(/^Dynamic Asset Allocation or /i, '');
  if (asset === 'Gold') category = /silver/.test(n) ? 'Silver' : 'Gold';
  return { assetClass: asset, category };
}

const json = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fund data service returned ${r.status}`);
  return r.json();
};

export async function searchSchemes(q) {
  if (!q || q.trim().length < 3) return [];
  const rows = await json(`${API}/search?q=${encodeURIComponent(q.trim())}`);
  return rows.slice(0, 40).map((r) => ({ code: String(r.schemeCode), name: r.schemeName }));
}

export async function fetchScheme(code) {
  const d = await json(`${API}/${code}/latest`);
  if (!d?.meta || !d.data?.length) throw new Error(`No data found for scheme ${code}`);
  const { assetClass, category } = classify(d.meta.scheme_name, d.meta.scheme_category);
  return {
    code: String(code),
    name: d.meta.scheme_name,
    amc: d.meta.fund_house.replace(/\s*Mutual Fund$/i, ''),
    assetClass,
    category,
    amfiCategory: d.meta.scheme_category,
    isin: d.meta.isin_growth || d.meta.isin_div_reinvestment || null,
    nav: +d.data[0].nav,
    navDate: isoDate(d.data[0].date),
  };
}

// NAV on (or the last trading day before) a given date, for estimating units.
const historyCache = new Map();
export async function navOn(code, isoDay) {
  if (!historyCache.has(code)) historyCache.set(code, json(`${API}/${code}`));
  const d = await historyCache.get(code);
  for (const row of d.data) {           // newest first
    const day = isoDate(row.date);
    if (day <= isoDay) return { nav: +row.nav, date: day };
  }
  return null;
}

// Find the mfapi.in scheme code for an ISIN (from a CAS). The full scheme list carries ISINs;
// if it doesn't have this one, search by name and check each candidate's ISINs.
let allSchemes = null;
const metaCache = new Map();
const isinsOf = (code) => {
  if (!metaCache.has(code)) metaCache.set(code, json(`${API}/${code}/latest`).then((d) => [d.meta?.isin_growth, d.meta?.isin_div_reinvestment]).catch(() => []));
  return metaCache.get(code);
};
export async function schemeCodeForIsin(isin, name = '') {
  try {
    allSchemes ||= json(API);
    const hit = (await allSchemes).find((r) => r.isinGrowth === isin || r.isinDivReinvestment === isin);
    if (hit) return String(hit.schemeCode);
  } catch { allSchemes = null; }
  const words = name.replace(/\(.*?\)/g, ' ').replace(/[^A-Za-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
  for (const n of [6, 4, 3]) {
    if (words.length < 2) break;
    const rows = await searchSchemes(words.slice(0, n).join(' ')).catch(() => []);
    const top = rows.slice(0, 15);
    const isins = await Promise.all(top.map((r) => isinsOf(r.code)));
    const i = isins.findIndex((x) => x.includes(isin));
    if (i >= 0) return top[i].code;
  }
  return null;
}
