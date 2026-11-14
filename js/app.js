import {
  summarize, schemeSummary, holdingsOfFolios, foliosOfPortfolio, portfoliosOfMember, foliosOfMember, holdingStats,
  folioClosed, xirr, shareStats, summarizeShares, summarizeAll, shareInfo, priceOf, sharesOfPortfolio, sharesOfMember, shareHeld,
} from './calc.js';
import {
  rupees, compact, pct, signedPct, signedRupees, tone, date, esc, fmtNav, fmtUnits,
} from './format.js';
import { readCas, normFolio, txnKey } from './cas.js';
import { readDematCas, planDematImport, dematWrites } from './cas-demat.js';
import { readAxisFile, planAxisImport, axisWrites } from './axis.js';

const $ = (sel, root = document) => root.querySelector(sel);
const sidebar = $('#sidebar');
const main = $('#main');
const tooltip = $('#tooltip');
const dialog = $('#dialog');
const toastEl = $('#toast');

const ASSET_COLOR = { Equity: 'var(--s1)', Debt: 'var(--s2)', Hybrid: 'var(--s3)', Gold: 'var(--s4)', Shares: 'var(--s5)' };
const assetColor = (name) => ASSET_COLOR[name] || 'var(--s0)';
const CAP_COLOR = { Large: 'var(--s1)', Mid: 'var(--s2)', Small: 'var(--s3)' };
const capColor = (name) => CAP_COLOR[name] || 'var(--s0)';

// ---------- routing ----------
function route() {
  const [type, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (type === 'member' || type === 'portfolio') return { type, id };
  if (type === 'unassigned' || type === 'access' || type === 'closed') return { type };
  return { type: 'family' };
}
const go = (hash) => { location.hash = hash; };

// ---------- session ----------
let store = null;
let session = { role: 'admin', email: '' };
const canEdit = () => session.role !== 'viewer';
const isAdmin = () => session.role === 'admin';
const ifEdit = (html) => (canEdit() ? html : '');
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const ROLE_LABEL = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };

export function start(s, sess) {
  store = s;
  session = sess;
  window.addEventListener('hashchange', render);
  store.subscribe(render);
  if (store.get()) render();
  else main.innerHTML = '<div class="loading">Loading your family’s portfolios…</div>';
}

// ---------- helpers ----------
const memberById = (s, id) => s.members.find((m) => m.id === id);
const portfolioById = (s, id) => s.portfolios.find((p) => p.id === id);
// Closed folios (every unit sold) are listed on their own page, not with the folios still held.
// They keep their portfolio, so a new purchase puts them back where they were. Like any sold
// units, they count nowhere else: not in Invested, Current value, Gain / loss or XIRR.
const closedCache = new WeakMap();
const closedIds = (s) => {
  if (!closedCache.has(s)) closedCache.set(s, new Set(s.folios.filter((f) => folioClosed(s, f.id)).map((f) => f.id)));
  return closedCache.get(s);
};
const openFolios = (s, fs) => fs.filter((f) => !closedIds(s).has(f.id));
const unassignedAll = (s) => s.folios.filter((f) => !f.portfolioId || !portfolioById(s, f.portfolioId));
const unassigned = (s) => openFolios(s, unassignedAll(s));

// ---------- shares: helpers and the All · Mutual funds · Shares switch ----------
const dematById = (s, id) => s.demats.find((d) => d.id === id);
const dematLabel = (d) => (d ? `${d.broker || 'Demat'} ··${String(d.clientId || d.brokerClientId || d.dpId || '').slice(-4)}` : 'Demat');
const heldShares = (sh) => sh.filter(shareHeld);
const unassignedShares = (s) => s.shares.filter((x) => !x.portfolioId || !portfolioById(s, x.portfolioId));
const soldShares = (s) => s.shares.filter((x) => !shareHeld(x) && (x.txns || []).length);
const xirrText = (x, note) => (note === 'young' ? '< 1 yr' : x == null ? '—' : signedPct(x));
// Remembered on this device, like column sorting. Without shares there's nothing to switch: funds only.
let viewPref = 'all';
try { viewPref = localStorage.getItem('view') || 'all'; } catch {}
const hasShares = (s) => s.shares.some(shareHeld);
const viewOf = (s) => (hasShares(s) ? viewPref : 'mf');
function summaryFor(s, folios, shares, v = viewOf(s)) {
  const hs = holdingsOfFolios(s, folios.map((f) => f.id));
  if (v === 'mf') return summarize(hs, s);
  if (v === 'shares') return summarizeShares(heldShares(shares), s);
  return summarizeAll(hs, heldShares(shares), s);
}
function viewSwitch(s) {
  if (!hasShares(s)) return '';
  const v = viewOf(s);
  const b = (key, label) => `<button type="button" role="radio" aria-checked="${v === key}" class="${v === key ? 'on' : ''}" data-view="${key}">${label}</button>`;
  return `<div class="seg" role="radiogroup" aria-label="Show">${b('all', 'All')}${b('mf', 'Mutual funds')}${b('shares', 'Shares')}</div>`;
}

export function toast(msg, undo) {
  toastEl.innerHTML = esc(msg) + (undo ? '<button class="undo">Undo</button>' : '');
  toastEl.classList.add('show');
  if (undo) toastEl.querySelector('button').onclick = () => { undo(); toastEl.classList.remove('show'); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 4500);
  toastEl.style.pointerEvents = undo ? 'auto' : 'none';
}

// The holder is the member whose portfolio the folio sits in; an unassigned folio keeps the
// holder it was last given (at import, when added, or by its last portfolio).
const holderOf = (s, f) => {
  const p = portfolioById(s, f.portfolioId);
  return (p && memberById(s, p.memberId)?.name) || f.holder;
};

function moveFolio(folioId, portfolioId) {
  const s = store.get();
  const f = s.folios.find((x) => x.id === folioId);
  if (!f || f.portfolioId === portfolioId) return;
  const from = f.portfolioId, fromHolder = f.holder;
  const p = portfolioById(s, portfolioId);
  const holder = p ? memberById(s, p.memberId)?.name : undefined; // moving to Unassigned keeps the holder
  store.moveFolio(folioId, portfolioId, holder);
  const label = p ? `${memberById(s, p.memberId)?.name} · ${p.name}` : 'Unassigned';
  toast(`Moved folio ${f.folioNo} to ${label}`, () => store.moveFolio(folioId, from, fromHolder));
}

// ---------- sidebar ----------
function renderSidebar(s, r) {
  const active = (t, id) => (r.type === t && (id == null || r.id === id) ? ' active' : '');
  let html = `
    <div class="brand"><div class="brand-mark">₹</div>Family Funds</div>
    <button class="nav-item${active('family')}" data-go="#/">Family overview</button>
    <div class="nav-section"><div class="nav-label">Members</div>`;
  for (const m of s.members) {
    const ps = portfoliosOfMember(s, m.id);
    html += `<button class="nav-item nav-member${active('member', m.id)}" data-go="#/member/${m.id}">${esc(m.name)}</button>`;
    for (const p of ps) {
      const n = openFolios(s, foliosOfPortfolio(s, p.id)).length + heldShares(sharesOfPortfolio(s, p.id)).length;
      html += `<button class="nav-item nav-portfolio${active('portfolio', p.id)}" data-go="#/portfolio/${p.id}" data-drop="${p.id}">
        <span>${esc(p.name)}</span><span class="count">${n}</span></button>`;
    }
    html += ifEdit(`<button class="nav-item nav-add" data-add-portfolio="${m.id}">+ Add portfolio</button>`);
  }
  const un = unassigned(s).length + heldShares(unassignedShares(s)).length;
  const closedN = closedIds(s).size + soldShares(s).length;
  html += `</div>
    <div class="nav-section">
      <button class="nav-item${active('unassigned')}" data-go="#/unassigned" data-drop="">
        <span>Unassigned</span><span class="count">${un}</span></button>
      ${closedN ? `<button class="nav-item${active('closed')}" data-go="#/closed"><span>Closed</span><span class="count">${closedN}</span></button>` : ''}
      ${ifEdit('<button class="nav-item nav-add" style="padding-left:10px" data-add-member>+ Add member</button>')}
      ${isAdmin() ? `<button class="nav-item${active('access')}" data-go="#/access">Access</button>` : ''}
    </div>
    <div class="side-foot">
      <div>${s.schemes.length ? `NAVs as of ${date(s.navDate)}` : 'No funds added yet'}</div>
      ${s.prices?.date ? `<div>Share prices as of ${date(s.prices.date)}</div>` : ''}
      ${session.note ? `<div>${esc(session.note)}</div>` : ''}
      ${session.email ? `<div class="me"><span title="${esc(session.email)}">${esc(session.email)}</span><span class="chip">${ROLE_LABEL[session.role]}</span></div>` : ''}
      ${session.signOut ? '<button class="link-btn" data-signout>Sign out</button>' : ''}
    </div>`;
  sidebar.innerHTML = html;
}

// ---------- shared view pieces ----------
function kpis(sum, v = 'mf') {
  const missing = sum.missingCost ? `excludes ${plural(sum.missingCost, 'share')} without a buy price` : '';
  const investedSub = missing || (v === 'shares' ? 'cost of shares held' : v === 'all' ? 'cost of units and shares held' : 'cost of units held');
  return `
  <section class="card kpis" aria-label="Summary">
    <div class="kpi"><div class="kpi-label">Invested</div><div class="kpi-value">${rupees(sum.invested)}</div>
      <div class="kpi-sub ${missing ? 'warn-text' : 'muted'}">${investedSub}</div></div>
    <div class="kpi"><div class="kpi-label">Current value</div><div class="kpi-value">${rupees(sum.current)}</div>
      <div class="kpi-sub muted">${sum.count} holding${sum.count === 1 ? '' : 's'}</div></div>
    <div class="kpi"><div class="kpi-label">XIRR</div><div class="kpi-value ${sum.xirrNote ? '' : tone(sum.xirr)}">${xirrText(sum.xirr, sum.xirrNote)}</div>
      <div class="kpi-sub muted">${sum.xirrNote === 'young' ? 'held under a year' : 'annualised'}${sum.hasDividends ? ' · incl. dividends' : ''}</div></div>
    <div class="kpi"><div class="kpi-label">Gain / loss</div><div class="kpi-value ${tone(sum.gain)}">${signedRupees(sum.gain)}</div>
      <div class="kpi-sub ${tone(sum.gain)}">${sum.gain >= 0 ? '▲' : '▼'} ${signedPct(sum.gainPct)} absolute</div></div>
  </section>`;
}

// Pie chart (SVG). Slices separated by a 2px surface-coloured gap.
function pie(items, tip, color = assetColor, what = 'Asset class') {
  const R = 80, C = 84;
  const total = items.reduce((a, x) => a + x.value, 0);
  let a0 = -Math.PI / 2;
  const slices = items.map((x) => {
    const fill = color(x.name);
    if (x.value / total > 0.9999) return `<circle cx="${C}" cy="${C}" r="${R}" fill="${fill}" ${tip(x)}/>`;
    const a1 = a0 + (x.value / total) * Math.PI * 2;
    const p = (a) => `${(C + R * Math.cos(a)).toFixed(2)} ${(C + R * Math.sin(a)).toFixed(2)}`;
    const d = `M${C} ${C} L${p(a0)} A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${fill}" ${tip(x)}/>`;
  });
  const label = items.map((x) => `${x.name} ${pct(x.pct)}`).join(', ');
  return `<svg class="pie" viewBox="0 0 ${C * 2} ${C * 2}" role="img" aria-label="${what} split: ${esc(label)}">${slices.join('')}</svg>`;
}

function breakups(sum, v = 'mf') {
  if (!sum.current) {
    const what = v === 'shares' ? 'shares' : v === 'all' ? 'folios or shares' : 'folios';
    return `<div class="grid-2"><section class="card"><div class="card-b empty">No holdings yet — move or add ${what} to see the breakup.</div></section></div>`;
  }
  const tip = (x) => `data-tip="<b>${esc(x.name)}</b><br>${compact(x.value)} · ${pct(x.pct)}"`;
  const pieCard = (title, items, color) => `
    <section class="card">
      <div class="card-h"><h2>${title}</h2><span class="muted" style="font-size:12px">share of ${v === 'shares' ? 'share' : 'current'} value</span></div>
      <div class="card-b pie-wrap">
        ${pie(items, tip, color, title)}
        <div class="pie-legend">
        ${items.map((x) => `
          <div class="legend-row" ${tip(x)}><i class="swatch" style="background:${color(x.name)}"></i>
            <span>${esc(x.name)}</span><span class="v num">${compact(x.value)}</span><span class="p num">${pct(x.pct)}</span></div>`).join('')}
        </div>
      </div>
    </section>`;
  const barCard = (title, items, caption) => {
    const max = Math.max(...items.map((x) => x.pct), 1e-9);
    return `
    <section class="card">
      <div class="card-h"><h2>${title}</h2><span class="muted" style="font-size:12px">${caption}</span></div>
      <div class="card-b">${items.length ? `<div class="bars">
        ${items.map((x) => `
          <div class="bar-row" ${tip(x)}>
            <span class="name" title="${esc(x.name)}">${esc(x.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="display:block;width:${(x.pct / max) * 100}%"></span></span>
            <span class="p num">${pct(x.pct)}</span>
          </div>`).join('')}
      </div>` : '<div class="empty">No funds here.</div>'}</div>
    </section>`;
  };
  if (v === 'shares') return `<div class="grid-2">${pieCard('Market cap', sum.byCap, capColor)}${barCard('Sector', sum.bySector, 'share of share value')}</div>`;
  return `<div class="grid-2">${pieCard('Asset class', sum.byAsset, assetColor)}${barCard('Fund category', sum.byCategory, v === 'all' ? 'share of fund value' : 'share of current value')}</div>`;
}

function summaryTable(rows, total, firstCol) {
  if (!rows.length) return `<div class="card"><div class="card-b empty">Nothing here yet.</div></div>`;
  return `
  <div class="card table-wrap"><table>
    <thead><tr><th>${firstCol}</th><th>Invested</th><th>Current value</th><th>XIRR</th><th>Gain</th><th>Share</th></tr></thead>
    <tbody>
      ${rows.map((r) => `
        <tr class="clickable" data-go="${r.href}">
          <td><div class="row-title">${esc(r.name)}</div><div class="row-sub">${esc(r.sub)}</div></td>
          <td class="num">${rupees(r.sum.invested)}</td>
          <td class="num">${rupees(r.sum.current)}</td>
          <td class="num ${r.sum.xirrNote ? '' : tone(r.sum.xirr)}">${xirrText(r.sum.xirr, r.sum.xirrNote)}</td>
          <td class="num ${tone(r.sum.gain)}">${signedRupees(r.sum.gain)}<div class="row-sub">${signedPct(r.sum.gainPct)}</div></td>
          <td class="num"><span class="alloc">${pct(total ? r.sum.current / total : 0, 0)}
            <span class="alloc-bar"><i style="width:${total ? (r.sum.current / total) * 100 : 0}%"></i></span></span></td>
        </tr>`).join('')}
    </tbody></table></div>`;
}

function moveSelect(s, f) {
  let opts = `<option value="" ${!f.portfolioId ? 'selected' : ''}>Unassigned</option>`;
  for (const m of s.members) {
    const ps = portfoliosOfMember(s, m.id);
    if (!ps.length) continue;
    opts += `<optgroup label="${esc(m.name)}">${ps
      .map((p) => `<option value="${p.id}" ${p.id === f.portfolioId ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('')}</optgroup>`;
  }
  return `<select data-move="${f.id}" aria-label="Move folio ${esc(f.folioNo)} to portfolio">${opts}</select>`;
}

// ---------- sorting ----------
// Holdings table and folio list sort by column. Clicking a header sorts (largest first, or A–Z for
// names), clicking again reverses, and a third click goes back to the default order.
// The choice is remembered on this device only.
const sorts = { holdings: null, folios: null, shares: null }; // { key, dir: 1 | -1 }
try { Object.assign(sorts, JSON.parse(localStorage.getItem('sort')) || {}); } catch {}
function setSort(list, sort) {
  sorts[list] = sort;
  try { localStorage.setItem('sort', JSON.stringify(sorts)); } catch {}
}
function cycleSort(list, key) {
  const cur = sorts[list];
  const first = key === 'name' ? 1 : -1;
  setSort(list, cur?.key !== key ? { key, dir: first } : cur.dir === first ? { key, dir: -first } : null);
}
// Sort by a value getter; missing values (no XIRR yet, say) always go last.
function sortBy(items, sort, get) {
  if (!sort) return items;
  return items.map((x) => [x, get(x, sort.key)]).sort(([, a], [, b]) => {
    if (a == null || Number.isNaN(a)) return b == null || Number.isNaN(b) ? 0 : 1;
    if (b == null || Number.isNaN(b)) return -1;
    return (typeof a === 'string' ? a.localeCompare(b) : a - b) * sort.dir;
  }).map(([x]) => x);
}
function sortHead(list, key, label) {
  const s = sorts[list];
  const on = s?.key === key;
  const state = on ? (s.dir > 0 ? 'ascending' : 'descending') : 'not sorted';
  return `<button class="sort${on ? ' on' : ''}" data-sort="${list}:${key}" title="Sort by ${label}" aria-label="${label}, ${state}">${label}<i aria-hidden="true">${on ? (s.dir > 0 ? '▲' : '▼') : ''}</i></button>`;
}
const HOLDING_SORT = {
  name: (r) => r.scheme.name, units: (r) => r.units, nav: (r) => r.scheme.nav, invested: (r) => r.sum.invested,
  current: (r) => r.sum.current, xirr: (r) => r.sum.xirr, gain: (r) => r.sum.gain, share: (r) => r.sum.current,
};

function holdingsTable(s, holdings, total, title = 'Holdings') {
  const rows = sortBy(schemeSummary(holdings, s), sorts.holdings, (r, k) => HOLDING_SORT[k]?.(r));
  if (!rows.length) return '';
  return `
  <div class="section-title"><h2>${title}</h2><span class="muted" style="font-size:12.5px">${rows.length} scheme${rows.length === 1 ? '' : 's'}, combined across folios</span></div>
  <div class="card table-wrap"><table class="holdings">
    <thead><tr>${[['name', 'Scheme'], ['units', 'Units'], ['nav', 'NAV'], ['invested', 'Invested'], ['current', 'Current value'], ['xirr', 'XIRR'], ['gain', 'Gain'], ['share', 'Share']]
      .map(([k, l]) => `<th${sorts.holdings?.key === k ? ` aria-sort="${sorts.holdings.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${sortHead('holdings', k, l)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td><div class="row-title">${esc(r.scheme.name)}</div>
            <div class="row-sub"><i class="swatch-sm" style="background:${assetColor(r.scheme.assetClass)}"></i>${esc(r.scheme.assetClass)} · ${esc(r.scheme.category)}${r.folios > 1 ? ` · ${r.folios} folios` : ''}</div></td>
          <td class="num">${fmtUnits(r.units)}</td>
          <td class="num">${fmtNav(r.scheme.nav)}</td>
          <td class="num">${rupees(r.sum.invested)}</td>
          <td class="num">${rupees(r.sum.current)}</td>
          <td class="num ${tone(r.sum.xirr)}">${r.sum.xirr == null ? '—' : signedPct(r.sum.xirr)}</td>
          <td class="num ${tone(r.sum.gain)}">${signedRupees(r.sum.gain)}<div class="row-sub">${signedPct(r.sum.gainPct)}</div></td>
          <td class="num"><span class="alloc">${pct(total ? r.sum.current / total : 0, 0)}
            <span class="alloc-bar"><i style="width:${total ? (r.sum.current / total) * 100 : 0}%"></i></span></span></td>
        </tr>`).join('')}
    </tbody></table></div>`;
}

// ---------- shares table ----------
const SHARE_SORT = {
  name: (r) => r.info.name, qty: (r) => r.st.qty, price: (r) => r.price, invested: (r) => r.st.invested,
  current: (r) => r.st.current, xirr: (r) => r.st.xirr, gain: (r) => r.st.gain, share: (r) => r.st.current,
};
function shareMoveSelect(s, sh) {
  return moveSelect(s, { id: sh.id, portfolioId: sh.portfolioId, folioNo: '' }).replace('data-move=', 'data-move-share=').replace(/aria-label="[^"]*"/, 'aria-label="Move share to portfolio"');
}
// movable: drag rows onto a sidebar portfolio, or pick one under "Move to" (editors only).
function sharesTable(s, shares, total, { movable = false, title = 'Shares' } = {}) {
  const held = heldShares(shares);
  if (!held.length) return '';
  const valueDate = s.prices?.date || s.navDate;
  const rows = sortBy(held.map((sh) => {
    const price = priceOf(s, sh.isin);
    return { sh, price, info: shareInfo(s, sh), st: shareStats(sh, price, valueDate), demat: dematById(s, sh.dematId) };
  }), sorts.shares, (r, k) => SHARE_SORT[k]?.(r));
  const needPrice = rows.filter((r) => r.st.invested == null).length;
  const noPrice = rows.filter((r) => r.price == null).length;
  const edit = canEdit();
  const head = [['name', 'Share'], ['qty', 'Qty'], ['price', 'Avg buy / Last'], ['invested', 'Invested'], ['current', 'Current value'], ['xirr', 'XIRR'], ['gain', 'Gain'], ['share', 'Share']];
  return `
  <div class="section-title"><h2>${title}</h2><span class="muted" style="font-size:12.5px">${plural(rows.length, 'share')}${s.prices ? ` · prices as of ${date(s.prices.date)}` : ''}</span></div>
  ${needPrice ? `<div class="notice">${plural(needPrice, 'share')} ${needPrice === 1 ? 'needs' : 'need'} a buy price. Until then ${needPrice === 1 ? 'it counts' : 'they count'} in current value only, not in invested, gain or XIRR.${edit ? ' Use “Add buy price” on the row.' : ''}</div>` : ''}
  ${noPrice ? `<div class="notice">${plural(noPrice, 'share')} ${noPrice === 1 ? 'has' : 'have'} no price in today’s price file, so ${noPrice === 1 ? 'it isn’t' : 'they aren’t'} counted anywhere.</div>` : ''}
  <div class="card table-wrap"><table class="holdings shares-table">
    <thead><tr>${head.map(([k, l]) => `<th${sorts.shares?.key === k ? ` aria-sort="${sorts.shares.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${sortHead('shares', k, l)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map(({ sh, price, info, st, demat }) => `
        <tr data-share="${sh.id}" ${edit && movable ? 'draggable="true"' : ''}>
          <td><div class="row-title">${esc(info.name)}${info.symbol ? ` <span class="sym">${esc(info.symbol)}</span>` : ''}</div>
            <div class="row-sub"><i class="swatch-sm" style="background:${capColor(info.cap)}"></i>${info.cap === 'Unclassified' ? 'Unclassified' : `${info.cap} cap`} · ${esc(info.sector)} · ${esc(dematLabel(demat))}</div>
            ${edit ? `<div class="row-acts">${movable ? `<label class="move-label">Move to ${shareMoveSelect(s, sh)}</label>` : ''}<button class="btn small" data-edit-share="${sh.id}">Edit</button></div>` : ''}</td>
          <td class="num" data-l="Qty">${fmtUnits(st.qty)}</td>
          <td class="num" data-l="Avg buy / Last">${st.avgPrice != null ? fmtNav(st.avgPrice) : edit ? `<button class="btn small" data-buy-price="${sh.id}">Add buy price</button>` : '<span class="muted">—</span>'}
            <div class="row-sub">${price != null ? fmtNav(price) : 'No price'}</div></td>
          <td class="num" data-l="Invested">${st.invested != null ? rupees(st.invested) : '<span class="muted">—</span>'}</td>
          <td class="num" data-l="Current">${st.current != null ? rupees(st.current) : '<span class="muted">—</span>'}</td>
          <td class="num ${st.xirrNote ? '' : tone(st.xirr)}" data-l="XIRR">${xirrText(st.xirr, st.xirrNote)}${st.hasDividends && st.xirr != null ? '<div class="row-sub">incl. dividends</div>' : ''}</td>
          <td class="num ${tone(st.gain)}" data-l="Gain">${st.gain != null ? `${signedRupees(st.gain)}<div class="row-sub">${signedPct(st.gainPct)}</div>` : '<span class="muted">—</span>'}</td>
          <td class="num" data-l="Share"><span class="alloc">${pct(total && st.current ? st.current / total : 0, 0)}
            <span class="alloc-bar"><i style="width:${total && st.current ? (st.current / total) * 100 : 0}%"></i></span></span></td>
        </tr>`).join('')}
    </tbody></table></div>`;
}

// Sold shares (quantity 0): listed on the Closed page only.
function soldSharesTable(s) {
  const rows = soldShares(s).map((sh) => ({ sh, info: shareInfo(s, sh), st: shareStats(sh, null, s.prices?.date), demat: dematById(s, sh.dematId), p: portfolioById(s, sh.portfolioId) }))
    .sort((a, b) => (b.st.lastSale || '').localeCompare(a.st.lastSale || ''));
  if (!rows.length) return '<div class="card"><div class="card-b empty">No sold shares.</div></div>';
  return `<div class="card table-wrap"><table class="holdings">
    <thead><tr><th>Share</th><th>Sold</th><th>Portfolio</th>${canEdit() ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map(({ sh, info, st, demat, p }) => `
      <tr><td><div class="row-title">${esc(info.name)}${info.symbol ? ` <span class="sym">${esc(info.symbol)}</span>` : ''}</div><div class="row-sub">${esc(dematLabel(demat))}</div></td>
        <td class="num">${st.lastSale ? date(st.lastSale) : '—'}</td>
        <td class="num">${p ? `${esc(memberById(s, p.memberId)?.name || '')} · ${esc(p.name)}` : 'Unassigned'}</td>
        ${canEdit() ? `<td class="row-actions"><button class="btn small" data-edit-share="${sh.id}">Edit</button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
}

function folioCards(s, folios, { showPortfolio = false, closed = 0 } = {}) {
  const closedNote = closed ? ` <a href="#/closed">${plural(closed, 'closed folio')}</a> ${closed === 1 ? 'is' : 'are'} under Closed folios.` : '';
  if (!folios.length) return `<div class="card"><div class="card-b empty">${closed ? 'No folios with units left here.' : canEdit() ? 'No folios here yet. Add one, drag one onto this portfolio in the sidebar, or use “Move to” on any folio.' : 'No folios here yet.'}${closedNote}</div></div>`;
  const schemeBy = Object.fromEntries(s.schemes.map((x) => [x.code, x]));
  const sort = sorts.folios;
  // Each column sorts the folios by their totals, and the schemes inside each folio by their own values.
  const gainPct = (inv, cur) => (inv ? (cur - inv) / inv : null);
  const SCHEME_SORT = { name: (x) => x.sc?.name, lastBuy: (x) => x.lastBuy, units: (x) => x.st?.units, invested: (x) => x.st?.invested, current: (x) => x.st?.current, gain: (x) => x.st && gainPct(x.st.invested, x.st.current) };
  const cards = folios.map((f) => {
    const hs = s.holdings.filter((h) => h.folioId === f.id);
    const items = hs.map((h) => {
      const sc = schemeBy[h.schemeCode];
      const st = sc ? holdingStats(h, sc, s.navDate) : null;
      return { h, sc, st, lastBuy: (st || holdingStats(h, { nav: 0 }, s.navDate)).lastBuy };
    });
    const sum = summarize(hs, s);
    return { f, hs, sum, items: sortBy(items, sort, (x, k) => SCHEME_SORT[k]?.(x)) };
  });
  const FOLIO_SORT = {
    name: (c) => c.items.map((x) => x.sc?.name || '').sort()[0],
    lastBuy: (c) => c.items.reduce((m, x) => (x.lastBuy > m ? x.lastBuy : m), '') || null,
    units: (c) => c.items.reduce((a, x) => a + (x.st?.units || 0), 0),
    invested: (c) => c.sum.invested, current: (c) => c.sum.current, gain: (c) => gainPct(c.sum.invested, c.sum.current),
  };
  const sortOpts = [['', 'Default order'], ['name:1', 'Scheme, A–Z'], ['name:-1', 'Scheme, Z–A'],
    ['lastBuy:-1', 'Last purchase, newest first'], ['lastBuy:1', 'Last purchase, oldest first'],
    ...[['invested', 'Invested'], ['current', 'Current value'], ['gain', 'Gain']].flatMap(([k, l]) => [[`${k}:-1`, `${l}, high to low`], [`${k}:1`, `${l}, low to high`]])];
  const sel = sort ? `${sort.key}:${sort.dir}` : '';
  return `<label class="sort-select">Sort folios<select data-sort-select="folios">${sortOpts.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <div class="folio-list">${sortBy(cards, sort, (c, k) => FOLIO_SORT[k]?.(c)).map(({ f, sum, items }) => {
    const p = portfolioById(s, f.portfolioId);
    return `
    <article class="folio" draggable="${canEdit()}" data-folio="${f.id}">
      ${canEdit() ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : '<span></span>'}
      <div>
        <div class="folio-head">
          <span class="folio-no">Folio ${esc(f.folioNo)}</span>
          <span class="chip">${esc(f.amc)}</span>
          <span class="chip">Holder: ${esc(holderOf(s, f))}</span>
          ${showPortfolio ? `<span class="chip">${p ? esc(p.name) : 'Unassigned'}</span>` : ''}
          <span class="muted" style="font-size:12.5px">${rupees(sum.current)} · <span class="${tone(sum.xirr)}">XIRR ${sum.xirr == null ? '—' : signedPct(sum.xirr)}</span></span>
        </div>
        <div class="schemes with-date">
          <div class="scheme scheme-head"><span class="sn">${sortHead('folios', 'name', 'Scheme')}</span><span>${sortHead('folios', 'lastBuy', 'Last purchase')}</span><span>${sortHead('folios', 'units', 'Units')}</span><span>${sortHead('folios', 'invested', 'Invested')}</span><span>${sortHead('folios', 'current', 'Current')}</span><span>${sortHead('folios', 'gain', 'Gain')}</span></div>
          ${items.map(({ h, sc, st, lastBuy }) => {
            if (!sc) return `<div class="scheme"><span class="sn muted">Loading scheme ${esc(h.schemeCode)}…</span></div>`;
            const bought = `<span class="num" data-l="Last purchase">${lastBuy ? date(lastBuy) : '—'}</span>`;
            if (st.units <= 1e-6) return `<div class="scheme sold"><span class="sn">${esc(sc.name)}<small>Fully redeemed${st.lastSale ? ` on ${date(st.lastSale)}` : ''}</small></span>${bought}<span class="num">—</span><span class="num">—</span><span class="num">—</span><span class="num">—</span></div>`;
            const g = st.current - st.invested;
            return `<div class="scheme">
              <span class="sn">${esc(sc.name)}<small>${esc(sc.category)} · <span class="nowrap">NAV ${fmtNav(sc.nav)}${sc.navDate ? ` on ${date(sc.navDate)}` : ''}</span></small></span>
              ${bought}
              <span class="num" data-l="Units">${fmtUnits(st.units)}</span>
              <span class="num" data-l="Invested">${rupees(st.invested)}</span>
              <span class="num" data-l="Current">${rupees(st.current)}</span>
              <span class="num ${tone(g)}" data-l="Gain">${signedPct(st.invested ? g / st.invested : 0)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      ${ifEdit(`<div class="folio-actions"><label class="muted" style="font-size:11.5px;display:block;margin-bottom:3px">Move to</label>${moveSelect(s, f)}
        <div class="folio-btns"><button class="btn small" data-add-txn="${f.id}">+ Transaction</button><button class="btn small danger" data-delete-folio="${f.id}">Delete</button></div></div>`)}
    </article>`;
  }).join('')}</div>${closedNote ? `<p class="hint closed-note">${closedNote.trim()}</p>` : ''}`;
}

// Closed folios: what went in, what came back, and the return, per folio and per scheme.
function closedCards(s, folios) {
  if (!folios.length) return '<div class="card"><div class="card-b empty">No closed folios.</div></div>';
  const schemeBy = Object.fromEntries(s.schemes.map((x) => [x.code, x]));
  const cards = folios.map((f) => {
    const items = s.holdings.filter((h) => h.folioId === f.id).map((h) => ({ h, sc: schemeBy[h.schemeCode], st: holdingStats(h, { nav: 0 }, s.navDate) }));
    const bought = items.reduce((a, x) => a + x.st.bought, 0);
    const sold = items.reduce((a, x) => a + x.st.sold, 0);
    const closedOn = items.reduce((m, x) => (x.st.lastSale > m ? x.st.lastSale : m), '');
    return { f, items, bought, sold, closedOn, rate: xirr(items.flatMap((x) => x.st.flows)) };
  }).sort((a, b) => b.closedOn.localeCompare(a.closedOn));
  const gain = (x) => `<span class="${tone(x.sold - x.bought)}">${signedRupees(x.sold - x.bought)}</span>`;
  return `<div class="folio-list">${cards.map((c) => {
    const p = portfolioById(s, c.f.portfolioId);
    return `
    <article class="folio closed" data-folio="${c.f.id}">
      <span></span>
      <div>
        <div class="folio-head">
          <span class="folio-no">Folio ${esc(c.f.folioNo)}</span>
          <span class="chip">${esc(c.f.amc)}</span>
          <span class="chip">Holder: ${esc(holderOf(s, c.f))}</span>
          <span class="chip">${p ? `${esc(memberById(s, p.memberId)?.name || '')} · ${esc(p.name)}` : 'Unassigned'}</span>
          ${c.closedOn ? `<span class="chip">Closed ${date(c.closedOn)}</span>` : ''}
          <span class="muted" style="font-size:12.5px">Realised ${gain(c)} · <span class="${tone(c.rate)}">XIRR ${c.rate == null ? '—' : signedPct(c.rate)}</span></span>
        </div>
        <div class="schemes">
          <div class="scheme scheme-head"><span class="sn">Scheme</span><span>Bought</span><span>Sold</span><span>Gain</span><span>XIRR</span></div>
          ${c.items.map(({ sc, st }) => {
            const r = xirr(st.flows);
            return `<div class="scheme">
              <span class="sn">${esc(sc?.name || 'Scheme')}<small>${st.lastSale ? `Last sold ${date(st.lastSale)}` : 'All purchases reversed'}</small></span>
              <span class="num" data-l="Bought">${rupees(st.bought)}</span>
              <span class="num" data-l="Sold">${rupees(st.sold)}</span>
              <span class="num" data-l="Gain">${gain(st)}</span>
              <span class="num ${tone(r)}" data-l="XIRR">${r == null ? '—' : signedPct(r)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      ${ifEdit(`<div class="folio-actions"><div class="folio-btns"><button class="btn small" data-add-txn="${c.f.id}">+ Transaction</button><button class="btn small danger" data-delete-folio="${c.f.id}">Delete</button></div></div>`)}
    </article>`;
  }).join('')}</div>`;
}

function header({ crumbs = [], title, subtitle, actions = '' }) {
  return `
  <div class="topbar">
    <div class="topbar-left">
      <button class="icon-btn menu-btn" data-menu aria-label="Open menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
      <div>
        ${crumbs.length ? `<div class="crumbs">${crumbs.map((c) => `<button data-go="${c.href}">${esc(c.label)}</button>`).join(' / ')}</div>` : ''}
        <h1>${esc(title)}</h1>
        ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
      </div>
    </div>
    <div class="actions">${actions}
      <button class="icon-btn" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
    </div>
  </div>`;
}

// ---------- views ----------
// "By member" / "Portfolios" rows follow the switch; in the funds-only and shares-only views, rows
// with nothing of that kind are left out.
const keepRow = (s, v) => (r) => !hasShares(s) || v === 'all' || r.sum.count > 0 || r.sum.current > 0;
const subOf = (s, folios, shares) => [plural(openFolios(s, folios).length, 'folio'), ...(heldShares(shares).length ? [plural(heldShares(shares).length, 'share')] : [])].join(' · ');

// Funds, shares or both, as the switch says. Fund tables stay exactly as they were in the funds view.
function holdingsSections(s, folios, shares, total, v, opts = {}) {
  const hs = holdingsOfFolios(s, folios.map((f) => f.id));
  if (v === 'mf') return holdingsTable(s, hs, total);
  if (v === 'shares') return sharesTable(s, shares, total, opts);
  return holdingsTable(s, hs, total, 'Funds') + sharesTable(s, shares, total, opts);
}

function viewFamily(s) {
  const v = viewOf(s);
  const all = summaryFor(s, s.folios, s.shares, v);
  const rows = s.members.map((m) => {
    const ps = portfoliosOfMember(s, m.id);
    return {
      name: m.name,
      sub: `${ps.length} portfolio${ps.length === 1 ? '' : 's'}`,
      href: `#/member/${m.id}`,
      sum: summaryFor(s, foliosOfMember(s, m.id), sharesOfMember(s, m.id), v),
    };
  });
  const un = unassigned(s), unSh = heldShares(unassignedShares(s));
  if (un.length || unSh.length) rows.push({ name: 'Unassigned', sub: subOf(s, un, unSh), href: '#/unassigned', sum: summaryFor(s, unassignedAll(s), unassignedShares(s), v) });
  const counts = [plural(s.members.length, 'member'), plural(s.portfolios.length, 'portfolio'), plural(openFolios(s, s.folios).length, 'folio'),
    ...(hasShares(s) ? [plural(heldShares(s.shares).length, 'share')] : []), ...(closedIds(s).size ? [`${closedIds(s).size} closed`] : [])];
  return (
    header({ title: 'Family overview', subtitle: counts.join(' · '), actions: ifEdit(`<button class="btn" data-add-member>+ Add member</button><button class="btn" data-import-cas>Import CAS</button><button class="btn" data-add-share>+ Add share</button><button class="btn primary" data-add-folio>+ Add folio</button>`) }) +
    (session.banner ? `<div class="banner">${session.banner}</div>` : '') +
    (s.sharesBlocked && canEdit() ? '<div class="banner warn">Share holdings can’t be saved or shown yet: the Firestore rules need updating. See “Publish the new Firestore rules” in the README.</div>' : '') +
    (!s.members.length && !s.folios.length && !s.shares.length ? welcome() : familyBody(s, all, rows.filter(keepRow(s, v)), v))
  );
}

function familyBody(s, all, rows, v) {
  return (
    viewSwitch(s) + kpis(all, v) +
    `<div class="section-title" style="margin-top:20px"><h2>By member</h2></div>` + summaryTable(rows, all.current, 'Member') +
    `<div style="margin-top:16px">${breakups(all, v)}</div>` +
    holdingsSections(s, s.folios, s.shares, all.current, v)
  );
}

function viewMember(s, id) {
  const m = memberById(s, id);
  if (!m) return viewFamily(s);
  const v = viewOf(s);
  const folios = foliosOfMember(s, id);
  const shares = sharesOfMember(s, id);
  const sum = summaryFor(s, folios, shares, v);
  const rows = portfoliosOfMember(s, id).map((p) => {
    const fs = foliosOfPortfolio(s, p.id), sh = sharesOfPortfolio(s, p.id);
    return { name: p.name, sub: subOf(s, fs, sh), href: `#/portfolio/${p.id}`, sum: summaryFor(s, fs, sh, v) };
  });
  return (
    header({
      crumbs: [{ label: 'Family', href: '#/' }],
      title: m.name,
      subtitle: `${plural(rows.length, 'portfolio')} · ${subOf(s, folios, shares)}`,
      actions: ifEdit(`<button class="btn" data-rename-member="${m.id}">Rename</button>${rows.length ? '' : `<button class="btn danger" data-delete-member="${m.id}">Remove</button>`}<button class="btn primary" data-add-portfolio="${m.id}">+ Add portfolio</button>`),
    }) +
    viewSwitch(s) + kpis(sum, v) +
    `<div class="section-title" style="margin-top:20px"><h2>Portfolios</h2></div>` + summaryTable(rows.filter(keepRow(s, v)), sum.current, 'Portfolio') +
    `<div style="margin-top:16px">${breakups(sum, v)}</div>` +
    holdingsSections(s, folios, shares, sum.current, v, { movable: true }) +
    (v === 'shares' ? '' : `<div class="section-title"><h2>All folios</h2></div>${ifEdit('<p class="hint">Drag a folio onto any portfolio in the sidebar, or pick one under “Move to”.</p>')}` +
      folioCards(s, openFolios(s, folios), { showPortfolio: true, closed: folios.length - openFolios(s, folios).length }))
  );
}

function viewPortfolio(s, id) {
  const p = portfolioById(s, id);
  if (!p) return viewFamily(s);
  const m = memberById(s, p.memberId);
  const v = viewOf(s);
  const folios = foliosOfPortfolio(s, id);
  const shares = sharesOfPortfolio(s, id);
  const sum = summaryFor(s, folios, shares, v);
  return (
    header({
      crumbs: [{ label: 'Family', href: '#/' }, { label: m?.name || '', href: `#/member/${p.memberId}` }],
      title: p.name,
      subtitle: subOf(s, folios, shares),
      actions: ifEdit(`<button class="btn" data-rename-portfolio="${p.id}">Rename</button><button class="btn danger" data-delete-portfolio="${p.id}">Delete</button>${openFolios(s, folios).length ? `<button class="btn danger" data-delete-all-folios="${p.id}">Delete all folios</button>` : ''}<button class="btn" data-import-cas="${p.id}">Import CAS</button><button class="btn" data-add-share="${p.id}">+ Add share</button><button class="btn primary" data-add-folio="${p.id}">+ Add folio</button>`),
    }) +
    viewSwitch(s) + kpis(sum, v) + breakups(sum, v) +
    holdingsSections(s, folios, shares, sum.current, v, { movable: true }) +
    (v === 'shares' ? '' : `<div class="section-title"><h2>Folios</h2></div>${ifEdit('<p class="hint">Drag a folio onto another portfolio in the sidebar, or pick one under “Move to”.</p>')}` +
      folioCards(s, openFolios(s, folios), { closed: folios.length - openFolios(s, folios).length }))
  );
}

function viewUnassigned(s) {
  const folios = unassigned(s);
  const shares = unassignedShares(s);
  const total = summarizeAll(holdingsOfFolios(s, unassignedAll(s).map((f) => f.id)), heldShares(shares), s).current;
  return (
    header({ crumbs: [{ label: 'Family', href: '#/' }], title: 'Unassigned', subtitle: 'Shares and folios not in any portfolio. They still count in the family total.', actions: ifEdit(`<button class="btn" data-import-cas>Import CAS</button><button class="btn" data-add-share>+ Add share</button><button class="btn primary" data-add-folio>+ Add folio</button>`) }) +
    (heldShares(shares).length ? `${sharesTable(s, shares, total, { movable: true })}${ifEdit('<p class="hint">Drag a share onto a portfolio in the sidebar, or pick one under “Move to”.</p>')}` : '') +
    `<div class="section-title"><h2>Folios</h2></div>` +
    folioCards(s, folios, { closed: unassignedAll(s).length - folios.length })
  );
}

function viewClosed(s) {
  const folios = s.folios.filter((f) => closedIds(s).has(f.id));
  return (
    header({ crumbs: [{ label: 'Family', href: '#/' }], title: 'Closed', subtitle: 'Folios and shares with nothing left. They don’t count in any totals, gains or XIRR elsewhere.' }) +
    `<div class="section-title"><h2>Closed folios</h2><span class="muted" style="font-size:12.5px">realised gain and XIRR shown here only</span></div>` +
    closedCards(s, folios) +
    `<div class="section-title"><h2>Sold shares</h2></div>` + soldSharesTable(s)
  );
}

function welcome() {
  return `<section class="card welcome"><div class="card-b">
    <h2>Welcome to Family Funds</h2>
    <p>Start by adding each family member, then give them one or more portfolios (for example “Retirement” or “Tax saving”).
    Then add folios with their purchases, or import them all from a CAS statement. Totals, XIRR and breakups appear as soon as there’s a holding.</p>
    ${ifEdit('<div class="actions"><button class="btn primary" data-add-member>+ Add first member</button></div>')}
  </div></section>`;
}

function viewAccess(s) {
  if (!isAdmin()) return viewFamily(s);
  const roleSel = (email, role) => `<select data-set-role="${esc(email)}" aria-label="Role for ${esc(email)}">
    ${['viewer', 'editor', 'admin'].map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
  const rows = [
    `<tr><td><div class="row-title">${esc(session.owner || session.email)}</div><div class="row-sub">Owner · can’t be removed</div></td><td>Admin</td><td></td></tr>`,
    ...s.users.filter((u) => u.id !== session.owner).map((u) => `
      <tr><td><div class="row-title">${esc(u.id)}</div></td><td>${roleSel(u.id, u.role)}</td>
        <td><button class="btn small danger" data-remove-user="${esc(u.id)}">Remove</button></td></tr>`),
  ];
  return header({ crumbs: [{ label: 'Family', href: '#/' }], title: 'Access', subtitle: 'Only people listed here can open the tracker.', actions: '<button class="btn primary" data-add-user>+ Add person</button>' }) +
    `<div class="card table-wrap"><table class="access">
      <thead><tr><th>Google account</th><th>Role</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div class="roles-help">
      <p><b>Viewer</b> sees everything but can’t change anything.</p>
      <p><b>Editor</b> can add and move folios, portfolios and members.</p>
      <p><b>Admin</b> can also manage this list.</p>
    </div>`;
}

// ---------- render ----------
function render() {
  const s = store?.get();
  if (!s) return;
  const r = route();
  renderSidebar(s, r);
  const y = window.scrollY;
  const same = render.lastHash === location.hash;
  const resorted = render.resorted;
  render.resorted = false;
  // Folio cards from the first one on screen down, with where that first one sits.
  const cards = same && !resorted ? [...main.querySelectorAll('[data-folio]')] : [];
  const first = cards.findIndex((el) => el.getBoundingClientRect().bottom > 0);
  const anchorTop = first >= 0 ? cards[first].getBoundingClientRect().top : Infinity;
  const anchorIds = anchorTop < innerHeight ? cards.slice(first).map((el) => el.dataset.folio) : [];
  main.innerHTML =
    r.type === 'member' ? viewMember(s, r.id)
    : r.type === 'portfolio' ? viewPortfolio(s, r.id)
    : r.type === 'unassigned' ? viewUnassigned(s)
    : r.type === 'closed' ? viewClosed(s)
    : r.type === 'access' ? viewAccess(s)
    : viewFamily(s);
  if (same) {
    window.scrollTo(0, y);
    // Keep the folio list still when content above it changes (e.g. moving a folio out shrinks
    // the summary and holdings table): the first card on screen stays put, or if it was moved
    // away, the next one takes its place.
    const anchor = anchorIds.map((id) => main.querySelector(`[data-folio="${id}"]`)).find(Boolean);
    if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - anchorTop);
  } else window.scrollTo(0, 0);
  render.lastHash = location.hash;
  closeMenu();
}

// ---------- dialogs ----------
// onSubmit returns an error message to show, or a function to run after closing (e.g. open the next dialog).
function openDialog({ title, body, submit = 'Save', onSubmit, onOpen, wide = false }) {
  dialog.classList.toggle('wide', wide);
  dialog.innerHTML = `<form method="dialog" novalidate>
    <div class="dlg-h">${esc(title)}</div>
    <div class="dlg-b">${body}</div>
    <p class="dlg-err" hidden></p>
    <div class="dlg-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" value="ok">${esc(submit)}</button></div>
  </form>`;
  const form = dialog.querySelector('form');
  const errEl = form.querySelector('.dlg-err');
  const okBtn = form.querySelector('[value=ok]');
  form.querySelector('[data-close]').onclick = () => dialog.close();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    errEl.hidden = true;
    okBtn.disabled = true;
    try {
      const res = await onSubmit(Object.fromEntries(new FormData(form)), form);
      if (typeof res === 'string') { errEl.textContent = res; errEl.hidden = false; } else { dialog.close(); if (typeof res === 'function') res(); }
    } catch (ex) {
      errEl.textContent = ex.message || String(ex);
      errEl.hidden = false;
    } finally { okBtn.disabled = false; }
  });
  dialog.showModal();
  onOpen?.(form);
  form.querySelector('input:not([type=hidden]), select')?.focus();
}

function nameDialog(title, current, onSave) {
  openDialog({
    title,
    body: `<label class="field">Name<input name="name" required maxlength="40" value="${esc(current || '')}"></label>`,
    onSubmit: ({ name }) => { if (!name.trim()) return 'Please enter a name'; onSave(name.trim()); },
  });
}

// Search box that looks up schemes (mfapi.in) and writes the chosen code into a hidden input.
const schemePickerHtml = (label = 'Scheme') => `
  <div class="field">${label}
    <input type="search" class="scheme-q" placeholder="Type 3+ letters, e.g. parag parikh flexi direct" autocomplete="off" required>
    <input type="hidden" name="schemeCode">
    <div class="picker" role="listbox" hidden></div>
  </div>`;
function wireSchemePicker(form, onPick) {
  const q = form.querySelector('.scheme-q');
  const hidden = form.querySelector('[name=schemeCode]');
  const list = form.querySelector('.picker');
  let t, seq = 0;
  q.addEventListener('input', () => {
    hidden.value = '';
    q.setCustomValidity('Pick a scheme from the list');
    clearTimeout(t);
    t = setTimeout(async () => {
      const my = ++seq;
      if (q.value.trim().length < 3) { list.hidden = true; return; }
      list.hidden = false;
      list.innerHTML = '<div class="picker-msg">Searching…</div>';
      try {
        const rows = await store.searchSchemes(q.value);
        if (my !== seq) return;
        list.innerHTML = rows.length
          ? rows.map((r) => `<button type="button" role="option" data-pick="${esc(r.code)}">${esc(r.name)}</button>`).join('')
          : '<div class="picker-msg">No schemes found. Try fewer words.</div>';
      } catch (e) {
        list.innerHTML = `<div class="picker-msg">Couldn’t search right now (${esc(e.message)}).</div>`;
      }
    }, 300);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    hidden.value = b.dataset.pick;
    q.value = b.textContent;
    q.setCustomValidity('');
    list.hidden = true;
    onPick?.(b.dataset.pick);
  });
}

// Fields for one transaction. Units can be left blank and estimated from that day's NAV.
const txnFieldsHtml = (s, withType = false) => `
  ${withType ? `<label class="field">Type<select name="type"><option value="buy">Purchase / SIP instalment</option><option value="sell">Redemption</option></select></label>` : ''}
  <div class="row-2">
    <label class="field">Date<input type="date" name="date" required max="${new Date().toISOString().slice(0, 10)}"></label>
    <label class="field">Amount (₹)<input type="number" name="amount" required min="1" step="any"></label>
  </div>
  <label class="field">Units<input type="number" name="units" min="0.001" step="any" placeholder="Leave blank to estimate from that day’s NAV"></label>`;

async function resolveUnits(d) {
  if (d.units) return +d.units;
  const hit = await (store.navOn ? store.navOn(d.schemeCode, d.date) : null);
  if (!hit) throw new Error('Couldn’t find a NAV for that date. Please enter the units from your statement.');
  return +(+d.amount / hit.nav).toFixed(3);
}

function portfolioOptions(s, selected) {
  return `<option value="">Unassigned</option>` + s.members.map((m) => {
    const ps = portfoliosOfMember(s, m.id);
    return ps.length ? `<optgroup label="${esc(m.name)}">${ps.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
}

function addFolioDialog(portfolioId) {
  const s = store.get();
  const p = portfolioById(s, portfolioId);
  const holderDefault = p ? memberById(s, p.memberId)?.name : '';
  openDialog({
    title: 'Add folio',
    submit: 'Add folio',
    body: `
      <div class="row-2">
        <label class="field">Folio number<input name="folioNo" required maxlength="30"></label>
        <label class="field">Holder<select name="holder">${s.members.map((m) => `<option ${m.name === holderDefault ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}<option value="Other">Other</option></select></label>
      </div>
      ${schemePickerHtml()}
      <label class="field">Portfolio<select name="portfolioId">${portfolioOptions(s, portfolioId)}</select></label>
      <div class="field-note">First purchase</div>
      ${txnFieldsHtml(s)}
      <p class="hint" style="margin:0">Add more purchases later with “+ Transaction” on the folio.</p>`,
    onOpen: (form) => wireSchemePicker(form),
    onSubmit: async (d) => {
      if (!d.folioNo.trim()) return 'Enter a folio number.';
      if (!d.schemeCode) return 'Pick a scheme from the search results.';
      const units = await resolveUnits(d);
      const sc = await store.ensureScheme(d.schemeCode);
      await store.addFolio({ folioNo: d.folioNo.trim(), amc: sc.amc, holder: d.holder, portfolioId: d.portfolioId || null, schemeCode: d.schemeCode, date: d.date, amount: +d.amount, units });
      toast(`Added folio ${d.folioNo.trim()}`);
    },
  });
}

function addTxnDialog(folioId) {
  const s = store.get();
  const f = s.folios.find((x) => x.id === folioId);
  const held = s.holdings.filter((h) => h.folioId === folioId).map((h) => s.schemes.find((x) => x.code === h.schemeCode)).filter(Boolean);
  openDialog({
    title: `Add transaction · Folio ${f.folioNo}`,
    submit: 'Add',
    body: `
      <label class="field">Scheme<select name="existing">${held.map((x) => `<option value="${x.code}">${esc(x.name)}</option>`).join('')}<option value="">Another scheme in this folio…</option></select></label>
      <div class="other-scheme" ${held.length ? 'hidden' : ''}>${schemePickerHtml('Find scheme')}</div>
      ${txnFieldsHtml(s, true)}`,
    onOpen: (form) => {
      wireSchemePicker(form);
      const sel = form.querySelector('[name=existing]');
      const other = form.querySelector('.other-scheme');
      const q = form.querySelector('.scheme-q');
      const sync = () => { other.hidden = !!sel.value; q.required = !sel.value; if (sel.value) q.setCustomValidity(''); };
      sel.addEventListener('change', sync);
      sync();
    },
    onSubmit: async (d) => {
      d.schemeCode = d.existing || d.schemeCode;
      if (!d.schemeCode) return 'Pick a scheme.';
      const units = await resolveUnits(d);
      const sign = d.type === 'sell' ? -1 : 1;
      await store.addTransaction(folioId, d.schemeCode, { date: d.date, amount: sign * +d.amount, units: sign * units });
      toast(d.type === 'sell' ? 'Redemption added' : 'Purchase added');
    },
  });
}

// ---------- shares: add / edit ----------
const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const dematOptions = (s, selected) => s.demats.map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(dematLabel(d))}${d.holderName ? ` · ${esc(d.holderName)}` : ''}</option>`).join('');
const memberOptions = (s, selected) => `<option value="">—</option>` + s.members.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

// Search the price file by name or symbol (it lists every share with a price).
function shareSearch(s, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || !s.prices?.p) return [];
  const out = [];
  for (const [isin, [, sym, name]] of Object.entries(s.prices.p)) {
    const nice = s.stockMeta?.m?.[isin]?.[2] || name;
    const hay = `${sym} ${nice} ${name} ${isin}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push({ isin, sym, name: nice, exact: sym.toLowerCase() === words.join('') });
  }
  return out.sort((a, b) => b.exact - a.exact || a.sym.localeCompare(b.sym)).slice(0, 30);
}

function addShareDialog(portfolioId) {
  const s = store.get();
  const p = portfolioById(s, portfolioId);
  openDialog({
    title: 'Add share',
    submit: 'Add share',
    body: `
      <label class="field">Demat account<select name="dematId">${dematOptions(s)}<option value="new" ${s.demats.length ? '' : 'selected'}>+ Add a demat account…</option></select></label>
      <div class="new-demat" ${s.demats.length ? 'hidden' : ''}>
        <div class="row-2">
          <label class="field">Broker<input name="broker" maxlength="40" placeholder="e.g. Zerodha"></label>
          <label class="field">Belongs to<select name="memberId">${memberOptions(s, p?.memberId)}</select></label>
        </div>
        <div class="row-2">
          <label class="field">DP ID<input name="dpId" maxlength="20" placeholder="e.g. 12081600 or IN303028"></label>
          <label class="field">Client ID<input name="clientId" maxlength="20" placeholder="8 digits"></label>
        </div>
        <p class="hint" style="margin:0">Find these in your broker app’s profile, or on your NSDL / CDSL statement. They let a statement import find this account later.</p>
      </div>
      <div class="field">Share
        <input type="search" class="share-q" placeholder="Name or symbol, e.g. reliance or INFY" autocomplete="off" required>
        <input type="hidden" name="isin">
        <div class="picker" role="listbox" hidden></div>
      </div>
      <div class="row-2">
        <label class="field">Quantity<input type="number" name="qty" required min="1" step="1"></label>
        <label class="field">Average buy price (₹, optional)<input type="number" name="price" min="0" step="any" placeholder="From your broker app"></label>
      </div>
      <label class="field">First bought (optional)<input type="date" name="date" max="${todayIso()}"></label>
      <label class="field">Portfolio<select name="portfolioId">${portfolioOptions(s, portfolioId)}</select></label>
      <p class="hint" style="margin:0">Without a buy price the share still shows its value, but isn’t counted in invested, gain or XIRR. Without a first-bought date, XIRR can’t be worked out.</p>`,
    onOpen: (form) => {
      const sel = form.querySelector('[name=dematId]');
      const box = form.querySelector('.new-demat');
      sel.addEventListener('change', () => { box.hidden = sel.value !== 'new'; });
      const q = form.querySelector('.share-q'), hidden = form.querySelector('[name=isin]'), list = form.querySelector('.picker');
      q.addEventListener('input', () => {
        hidden.value = '';
        q.setCustomValidity('Pick a share from the list');
        const rows = q.value.trim().length >= 2 ? shareSearch(s, q.value) : [];
        list.hidden = q.value.trim().length < 2;
        list.innerHTML = rows.length
          ? rows.map((r) => `<button type="button" role="option" data-pick="${r.isin}">${esc(r.name)} <span class="muted">${esc(r.sym)} · ${r.isin}</span></button>`).join('')
          : `<div class="picker-msg">${s.prices ? 'No match. Try the NSE symbol.' : 'Share prices haven’t loaded yet.'}</div>`;
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        hidden.value = b.dataset.pick;
        q.value = b.textContent.replace(/\s+/g, ' ').trim();
        q.setCustomValidity('');
        list.hidden = true;
      });
    },
    onSubmit: async (d) => {
      if (!d.isin) return 'Pick a share from the search results.';
      let dematId = d.dematId;
      if (dematId === 'new') {
        if (!d.broker.trim() && !d.clientId.trim()) return 'Enter the broker or the client ID for the new demat account.';
        const dup = s.demats.find((x) => d.dpId.trim() && x.dpId === d.dpId.trim().toUpperCase() && x.clientId === d.clientId.trim());
        dematId = dup ? dup.id : (await store.addDemat({ broker: d.broker.trim(), dpId: d.dpId.trim().toUpperCase(), clientId: d.clientId.trim(), holderName: memberById(s, d.memberId)?.name || '', memberId: d.memberId || null })).id;
      }
      const have = s.shares.find((x) => x.dematId === dematId && x.isin === d.isin);
      if (have) return 'This share is already in that demat account. Use “Edit” on it to add a transaction.';
      await store.addShare({ isin: d.isin, name: shareInfo(s, { isin: d.isin }).name, dematId, portfolioId: d.portfolioId || null,
        txns: [{ date: d.date || null, qty: +d.qty, price: d.price === '' ? null : +d.price, kind: 'opening' }] });
      toast(`Added ${shareInfo(s, { isin: d.isin }).name}`);
    },
  });
}

const KIND_LABEL = { opening: 'Holding', buy: 'Bought', sell: 'Sold', bonus: 'Bonus / split', split: 'Bonus / split' };
function shareDialog(shareId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  if (!sh) return;
  const info = shareInfo(s, sh);
  const st = shareStats(sh, priceOf(s, sh.isin), s.prices?.date);
  const txns = [...(sh.txns || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  openDialog({
    title: `${info.name}${info.symbol ? ` (${info.symbol})` : ''}`,
    submit: 'Close',
    wide: true,
    body: `
      <p class="hint" style="margin:0">${esc(dematLabel(dematById(s, sh.dematId)))} · ISIN ${esc(sh.isin)} · ${esc(info.cap === 'Unclassified' ? 'Unclassified' : `${info.cap} cap`)} · ${esc(info.sector)}${sh.sectorOverride ? ' (set by you)' : ''}</p>
      <p style="margin:0"><b>${fmtUnits(st.qty)}</b> shares${st.avgPrice != null ? ` · average buy ${fmtNav(st.avgPrice)}` : ' · <span class="warn-text">no buy price</span>'}${st.firstBought ? ` · first bought ${date(st.firstBought)}` : ''}</p>
      <div class="table-wrap"><table class="mini">
        <thead><tr><th>Date</th><th>What</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>${txns.map((t) => `<tr><td>${t.date ? date(t.date) : '—'}</td><td>${KIND_LABEL[t.kind] || t.kind}</td><td class="num">${t.qty > 0 ? '+' : '−'}${fmtUnits(Math.abs(t.qty))}</td><td class="num">${t.price ? fmtNav(t.price) : t.kind === 'sell' ? 'at average cost' : FREE_KINDS.has(t.kind) ? 'free' : '—'}</td></tr>`).join('')}</tbody>
      </table></div>
      ${(sh.dividends || []).length ? `<p class="hint" style="margin:0">Dividends: ${sh.dividends.map((d) => `${date(d.date)} ${rupees(d.amount)}`).join(' · ')}</p>` : ''}
      ${ifEdit(`<div class="dlg-actions">
        <button type="button" class="btn small" data-act="price">${st.avgPrice != null ? 'Edit buy price / first bought' : 'Add buy price'}</button>
        <button type="button" class="btn small" data-act="txn">+ Transaction</button>
        <button type="button" class="btn small" data-act="dividend">+ Dividend</button>
        <button type="button" class="btn small" data-act="sector">Edit sector</button>
        <button type="button" class="btn small danger" data-act="delete">Delete</button>
      </div>`)}`,
    onOpen: (form) => {
      form.querySelector('[data-close]').hidden = true;
      form.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        dialog.close();
        ({ price: buyPriceDialog, txn: shareTxnDialog, dividend: dividendDialog, sector: sectorDialog, delete: deleteShareDialog })[act](shareId);
      });
    },
    onSubmit: () => {},
  });
}
const FREE_KINDS = new Set(['bonus', 'split']);

// The broker's average price is the cost of everything held now, so it replaces the purchase
// history with one entry: the current quantity at that price.
function buyPriceDialog(shareId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  const st = shareStats(sh, priceOf(s, sh.isin), s.prices?.date);
  const info = shareInfo(s, sh);
  openDialog({
    title: `Buy price · ${info.name}`,
    submit: 'Save',
    body: `
      <div class="row-2">
        <label class="field">Average buy price (₹)<input type="number" name="price" required min="0.01" step="any" value="${st.avgPrice != null ? +st.avgPrice.toFixed(2) : ''}"></label>
        <label class="field">First bought (optional)<input type="date" name="date" max="${todayIso()}" value="${st.firstBought || ''}"></label>
      </div>
      <details class="help"><summary>Where do I find my average price?</summary>
        <ul>
          <li><b>Zerodha Kite:</b> Portfolio → Holdings → tap the share: “Avg. cost”. <b>Console</b> (console.zerodha.com): Portfolio → Holdings, “Avg. cost” column.</li>
          <li><b>Groww:</b> Stocks → Holdings → tap the share: “Avg. price”.</li>
          <li><b>Upstox:</b> Portfolio → Holdings → tap the share: “Avg. price”.</li>
          <li><b>Other brokers:</b> look for “average price”, “avg. cost” or “buy average” on the holdings screen.</li>
        </ul>
        <p>For the first-bought date, your broker’s tradebook or contract notes show when you first bought it. A rough date is fine: it only affects XIRR.</p>
      </details>
      <p class="hint" style="margin:0">This records ${fmtUnits(st.qty)} shares at this average price${(sh.txns || []).length > 1 ? `, replacing the ${(sh.txns || []).length} entries recorded so far` : ''}.</p>`,
    onSubmit: async (d) => {
      await store.updateShare(shareId, { txns: [{ date: d.date || null, qty: st.qty, price: +d.price, kind: 'opening' }] });
      toast(`Saved the buy price for ${info.name}`);
    },
  });
}

function shareTxnDialog(shareId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  const info = shareInfo(s, sh);
  openDialog({
    title: `Add transaction · ${info.name}`,
    submit: 'Add',
    body: `
      <label class="field">Type<select name="kind"><option value="buy">Bought</option><option value="sell">Sold</option><option value="bonus">Bonus / split (free shares)</option></select></label>
      <div class="row-2">
        <label class="field">Date<input type="date" name="date" required max="${todayIso()}"></label>
        <label class="field">Quantity<input type="number" name="qty" required min="1" step="1"></label>
      </div>
      <label class="field price-field">Price per share (₹)<input type="number" name="price" min="0" step="any" placeholder="Leave blank if you don’t know it"></label>
      <p class="hint" style="margin:0">A sale reduces the holding at its average cost. A bonus or split adds shares at no cost.</p>`,
    onOpen: (form) => {
      const kind = form.querySelector('[name=kind]'), pf = form.querySelector('.price-field');
      kind.addEventListener('change', () => { pf.hidden = kind.value === 'bonus'; });
    },
    onSubmit: async (d) => {
      const qty = +d.qty;
      const held = shareStats(sh, null, null).qty;
      if (d.kind === 'sell' && qty > held + 1e-9) return `You hold ${fmtUnits(held)} shares.`;
      const txn = d.kind === 'sell' ? { date: d.date, qty: -qty, price: d.price === '' ? null : +d.price, kind: 'sell' }
        : d.kind === 'bonus' ? { date: d.date, qty, price: 0, kind: 'bonus' }
        : { date: d.date, qty, price: d.price === '' ? null : +d.price, kind: 'buy' };
      await store.updateShare(shareId, { txns: [...(sh.txns || []), txn] });
      toast(`${KIND_LABEL[txn.kind]} ${fmtUnits(qty)} ${info.name}`);
    },
  });
}

function dividendDialog(shareId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  openDialog({
    title: `Add dividend · ${shareInfo(s, sh).name}`,
    submit: 'Add',
    body: `<div class="row-2">
        <label class="field">Date paid<input type="date" name="date" required max="${todayIso()}"></label>
        <label class="field">Amount received (₹)<input type="number" name="amount" required min="0.01" step="any"></label>
      </div>
      <p class="hint" style="margin:0">Dividends count in this share’s XIRR, not in gain.</p>`,
    onSubmit: async (d) => {
      await store.updateShare(shareId, { dividends: [...(sh.dividends || []), { date: d.date, amount: +d.amount }] });
      toast('Dividend added');
    },
  });
}

function sectorDialog(shareId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  const info = shareInfo(s, sh);
  const known = [...new Set(Object.values(s.stockMeta?.m || {}).map((m) => m[1]).filter(Boolean))].sort();
  openDialog({
    title: `Sector · ${info.name}`,
    submit: 'Save',
    body: `<label class="field">Sector<input name="sector" list="sector-list" maxlength="60" value="${esc(sh.sectorOverride || '')}" placeholder="${esc(info.sector)}"></label>
      <datalist id="sector-list">${known.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <p class="hint" style="margin:0">Leave blank to use the standard sector${s.stockMeta?.m?.[sh.isin]?.[1] ? ` (${esc(s.stockMeta.m[sh.isin][1])})` : ', or “Other” if there isn’t one'}.</p>`,
    onSubmit: async (d) => {
      await store.updateShare(shareId, { sectorOverride: d.sector.trim() || null });
      toast('Sector saved');
    },
  });
}

function deleteShareDialog(shareId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  const info = shareInfo(s, sh);
  openDialog({
    title: `Delete ${info.name}?`, submit: 'Delete',
    body: '<p style="margin:0;color:var(--ink-2)">This removes the share and its transactions and dividends for everyone. To record that you sold it, use “+ Transaction → Sold” instead.</p>',
    onSubmit: async () => { await store.deleteShare(shareId); toast(`Deleted ${info.name}`); },
  });
}

function moveShare(shareId, portfolioId) {
  const s = store.get();
  const sh = s.shares.find((x) => x.id === shareId);
  if (!sh || (sh.portfolioId || null) === portfolioId) return;
  const from = sh.portfolioId || null;
  store.moveShare(shareId, portfolioId);
  const p = portfolioById(s, portfolioId);
  toast(`Moved ${shareInfo(s, sh).name} to ${p ? `${memberById(s, p.memberId)?.name} · ${p.name}` : 'Unassigned'}`, () => store.moveShare(shareId, from));
}

// ---------- CAS import ----------
function importCasDialog(portfolioId) {
  const help = {
    mf: { text: 'Upload a <b>detailed</b> Consolidated Account Statement (PDF) from CAMS or KFintech. Get one from camsonline.com, kfintech.com or mfcentral.com: choose “Detailed” and, the first time, “Since inception”.',
      pw: 'The one you set when requesting it', saved: 'Only folios and transactions are saved.' },
    shares: { text: 'Upload the Consolidated Account Statement (PDF) from <b>NSDL</b> (nsdl.co.in) or <b>CDSL</b> (cdslindia.com). It lists the shares in each of your demat accounts.',
      pw: 'Usually your PAN in capitals, e.g. ABCDE1234F', saved: 'Only demat accounts and share quantities are saved.' },
    axis: { text: 'From Axis Direct, download the <b>Portfolio Holding Statement</b> and, for purchase dates, sales and dividends, the <b>PAN Level Transaction Report</b>. Run both from the day the account was opened up to today.',
      pw: 'Usually the PAN in capitals, e.g. ABCDE1234F', saved: 'Only shares, quantities, average costs, trades and dividends are saved.' },
  };
  const LABEL = { mf: 'Statement (PDF)', shares: 'Statement (PDF)', axis: 'Portfolio Holding Statement (.xlsx)' };
  const ACCEPT = { mf: 'application/pdf,.pdf', shares: 'application/pdf,.pdf', axis: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel' };
  openDialog({
    title: 'Import from CAS',
    submit: 'Read statement',
    body: `
      <div class="field">What’s in the statement?
        <div class="seg seg-wide" role="radiogroup">
          <label><input type="radio" name="kind" value="mf" checked> Mutual funds <small>CAMS / KFintech</small></label>
          <label><input type="radio" name="kind" value="axis"> Shares <small>Axis Direct</small></label>
          <label><input type="radio" name="kind" value="shares"> Shares <small>NSDL / CDSL</small></label>
        </div>
      </div>
      <p class="hint kind-help" style="margin:0">${help.mf.text}</p>
      <label class="field"><span class="file-label">${LABEL.mf}</span><input type="file" name="file" accept="${ACCEPT.mf}" required></label>
      <label class="field file2" hidden>PAN Level Transaction Report (.xlsx, optional)<input type="file" name="file2" accept="${ACCEPT.axis}"></label>
      <label class="field">Password<input type="password" name="password" autocomplete="off" placeholder="${help.mf.pw}"></label>
      <p class="hint" style="margin:0">Files are read in your browser and aren’t uploaded. <span class="kind-saved">${help.mf.saved}</span></p>
      <p class="cas-status" aria-live="polite" hidden></p>`,
    onOpen: (form) => {
      form.addEventListener('change', (e) => {
        if (e.target.name !== 'kind') return;
        const k = e.target.value, h = help[k];
        form.querySelector('.kind-help').innerHTML = h.text;
        form.querySelector('[name=password]').placeholder = h.pw;
        form.querySelector('.kind-saved').textContent = h.saved;
        form.querySelector('.file-label').textContent = LABEL[k];
        form.querySelector('[name=file]').accept = ACCEPT[k];
        form.querySelector('.file2').hidden = k !== 'axis';
      });
    },
    onSubmit: async (d, form) => {
      const status = form.querySelector('.cas-status');
      const say = (msg) => { status.hidden = false; status.textContent = msg; };
      if (!d.file?.size) return d.kind === 'axis' ? 'Choose the Portfolio Holding Statement.' : 'Choose the statement PDF.';
      try {
        say('Reading the statement…');
        if (d.kind === 'axis') {
          const files = [await readAxisFile(d.file, d.password.trim())];
          if (d.file2?.size) files.push(await readAxisFile(d.file2, d.password.trim()));
          const holdings = files.find((f) => f.kind === 'holdings'), trades = files.find((f) => f.kind === 'trades');
          if (!holdings) return 'One of the files needs to be the Portfolio Holding Statement (the transaction report alone isn’t enough).';
          const plan = planAxisImport({ holdings, trades }, store.get());
          return () => reviewAxisDialog(plan, portfolioId);
        }
        if (d.kind === 'shares') {
          const cas = await readDematCas(d.file, d.password.trim());
          return () => reviewDematDialog(cas, portfolioId);
        }
        const cas = await readCas(d.file, d.password);
        const rows = await matchCas(cas, say);
        return () => reviewCasDialog(cas, rows, portfolioId);
      } catch (e) {
        status.hidden = true;
        return e.message || String(e);
      }
    },
  });
}

// Match CAS schemes to scheme codes and folios to ones we already track; work out which transactions are new.
async function matchCas(cas, say) {
  const isins = new Map(cas.folios.flatMap((f) => f.schemes.map((x) => [x.isin, x.name])));
  let done = 0;
  say(`Matching ${plural(isins.size, 'scheme')}…`);
  const codes = new Map(await Promise.all([...isins].map(async ([isin, name]) => {
    const code = await store.schemeCodeForIsin(isin, name).catch(() => null);
    say(`Matching schemes… ${++done} of ${isins.size}`);
    return [isin, code];
  })));
  const s = store.get();
  const byNo = new Map(s.folios.map((f) => [normFolio(f.folioNo), f]));
  return cas.folios.map((f) => {
    const existing = byNo.get(f.folioNo) || null;
    const holdings = f.schemes.map((x) => {
      const code = codes.get(x.isin);
      const held = existing && code ? s.holdings.find((h) => h.folioId === existing.id && h.schemeCode === code) : null;
      const have = new Set((held?.txns || []).map(txnKey));
      const fresh = x.txns.filter((t) => !have.has(txnKey(t)));
      // Statement check: what the tracker will hold after this import vs the statement's closing
      // units and Total Cost Value (cost of the units held, stamp duty included).
      let check = null;
      if (code && x.closingUnits != null) {
        const after = [...(held?.txns || []), ...fresh];
        const st = after.length ? holdingStats({ txns: after }, { nav: 0 }, s.navDate) : { units: 0, invested: 0 };
        check = {
          units: st.units, invested: st.invested, afterImport: fresh.length > 0,
          unitsOk: Math.abs(st.units - x.closingUnits) < 0.002,
          costOk: x.costValue == null || Math.abs(st.invested - x.costValue) <= Math.max(2, x.costValue * 0.001),
        };
      }
      return { ...x, code, isNew: !held, fresh, check };
    });
    const ready = holdings.filter((h) => h.code && h.fresh.length);
    // A new holding from a statement that starts part-way through has no cost for its opening units.
    const gap = ready.some((h) => h.isNew && h.openingUnits > 0.001);
    return { ...f, existing, holdings, ready, gap };
  });
}

function reviewCasDialog(cas, rows, portfolioId) {
  const s = store.get();
  const anyNew = rows.some((r) => !r.existing && r.ready.length);
  const casHolder = rows.find((r) => r.holder)?.holder || '';
  const words = new Set(casHolder.toLowerCase().split(/\s+/));
  const p = portfolioById(s, portfolioId);
  const guess = s.members.find((m) => m.name.toLowerCase().split(/\s+/).some((w) => words.has(w)))?.name
    || (p && memberById(s, p.memberId)?.name);
  const txnCount = (r) => r.ready.reduce((a, h) => a + h.fresh.length, 0);
  const schemeLine = (h) => {
    const name = esc(h.name || h.isin);
    if (!h.code) return `<li class="warn">${name}<small>Couldn’t match ISIN ${esc(h.isin)} to a scheme — skipped. Add it by hand with “+ Transaction”.</small></li>`;
    const notes = [];
    if (h.isNew && h.openingUnits > 0.001) notes.push(`${fmtUnits(h.openingUnits)} units held before ${cas.period?.from || h.txns[0] ? date(cas.period?.from || h.txns[0].date) : 'this statement'} aren’t in this statement, so invested and XIRR would be wrong. Use a “Since inception” statement.`);
    if (!h.balanced) notes.push('Some rows couldn’t be read: the units don’t add up to the closing balance. Check this scheme after importing.');
    const c = h.check;
    const ours = c && `${fmtUnits(c.units)} units · ${rupees(c.invested)}`;
    const theirs = c && `${fmtUnits(h.closingUnits)} units${h.costValue != null ? ` · ${rupees(h.costValue)}` : ''}`;
    if (c && !(c.unitsOk && c.costOk)) {
      notes.push(`Doesn’t match the statement${c.unitsOk ? ' (units match, cost differs)' : ''}. ${c.afterImport ? 'After this import the tracker would show' : 'The tracker shows'} ${ours}; the statement says ${theirs}.`);
    }
    const ok = c && c.unitsOk && c.costOk ? `<small class="ok">✓ Matches the statement: ${esc(theirs)}</small>` : '';
    const what = h.fresh.length ? `${plural(h.fresh.length, 'new transaction')}` : h.txns.length ? 'up to date' : 'no transactions in this statement';
    return `<li class="${notes.length ? 'warn' : ''}">${name} <span class="muted">· ${what}</span>${ok}${notes.map((n) => `<small>${esc(n)}</small>`).join('')}</li>`;
  };
  const folioRow = (r, i) => {
    const n = txnCount(r);
    const tag = !n ? (r.existing ? 'Up to date' : 'Not in tracker') : r.existing ? 'Already tracked' : 'New folio';
    return `
      <label class="cas-folio${n ? '' : ' off'}">
        <input type="checkbox" name="f${i}" ${n && !r.gap ? 'checked' : ''} ${n ? '' : 'disabled'}>
        <div>
          <div class="cas-folio-h"><b>Folio ${esc(r.folioNo)}</b><span class="chip">${tag}</span>${r.holder ? `<span class="muted">${esc(r.holder)}</span>` : ''}</div>
          <ul>${r.holdings.map(schemeLine).join('')}</ul>
        </div>
      </label>`;
  };
  const total = rows.reduce((a, r) => a + txnCount(r), 0);
  const checked = rows.flatMap((r) => r.holdings.filter((h) => h.check));
  const off = checked.filter((h) => !(h.check.unitsOk && h.check.costOk)).length;
  const checkLine = !checked.length ? ''
    : off ? `<p class="cas-check warn"><b>Statement check:</b> ${off} of ${plural(checked.length, 'scheme')} won’t match the statement’s units and cost — marked below.</p>`
    : `<p class="cas-check ok"><b>Statement check:</b> all ${plural(checked.length, 'scheme')} will match the statement’s units and cost.</p>`;
  openDialog({
    title: 'Review import',
    submit: total ? 'Import' : 'Done',
    wide: true,
    body: `
      <p class="hint" style="margin:0">${cas.period ? `Statement ${date(cas.period.from)} – ${date(cas.period.to)} · ` : ''}${plural(rows.length, 'folio')} · ${plural(total, 'new transaction')}.
        ${total ? 'Transactions already in the tracker are skipped, so it’s safe to import a newer statement later.' : 'Everything in this statement is already in the tracker.'}</p>
      ${anyNew ? `<div class="row-2">
        <label class="field">Holder for new folios<select name="holder">${s.members.map((m) => `<option ${m.name === guess ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}<option value="Other" ${guess ? '' : 'selected'}>Other</option></select></label>
        <label class="field">Put new folios in<select name="portfolioId">${portfolioOptions(s, portfolioId)}</select></label>
      </div>` : ''}
      ${checkLine}
      <div class="cas-list">${rows.map(folioRow).join('')}</div>`,
    onSubmit: async (d) => {
      if (!total) return;
      const plan = rows.filter((r, i) => d[`f${i}`]).map((r) => ({
        folioId: r.existing?.id || null,
        folioNo: r.folioNo,
        holder: d.holder || 'Other',
        portfolioId: d.portfolioId || null,
        holdings: r.ready.map((h) => ({ schemeCode: h.code, txns: h.fresh })),
      }));
      if (!plan.length) return 'Tick at least one folio to import.';
      await store.importFolios(plan);
      const added = plan.filter((f) => !f.folioId).length;
      const txns = plan.reduce((a, f) => a + f.holdings.reduce((b, h) => b + h.txns.length, 0), 0);
      toast(`Imported ${plural(txns, 'transaction')}${added ? ` · ${plural(added, 'new folio')}` : ''}`);
    },
  });
}

// ---------- NSDL / CDSL statement review ----------
function reviewDematDialog(cas, portfolioId, links = {}) {
  const s = store.get();
  const plan = planDematImport(cas, s, links);
  // Tracked accounts without a DP ID (added from Axis Direct reports) that a statement account could be.
  const linkable = s.demats.filter((d) => !d.dpId);
  const STATUS = { new: 'New', same: 'No change', missing: 'Not in this statement' };
  const change = (r) => `${fmtUnits(r.before)} → ${fmtUnits(r.qty)} (${r.diff > 0 ? '+' : '−'}${fmtUnits(Math.abs(r.diff))})`;
  const nActions = plan.reduce((a, p) => a + p.rows.filter((r) => r.status !== 'same').length, 0);
  const guessMember = (a) => {
    const words = new Set(a.holders.join(' ').toLowerCase().split(/\s+/));
    return s.members.find((m) => m.name.toLowerCase().split(/\s+/).some((w) => words.has(w)))?.id
      || (portfolioId && portfolioById(s, portfolioId)?.memberId) || '';
  };
  const rowHtml = (ai, r, ri) => {
    const k = `${ai}-${ri}`;
    const name = esc(shareInfo(s, { isin: r.isin }).name !== r.isin ? shareInfo(s, { isin: r.isin }).name : r.name || r.isin);
    const flags = [];
    if (r.price == null && r.status !== 'missing') flags.push('No price in the price file yet, so it won’t be valued.');
    if (r.price != null && r.stmtPrice && Math.abs(r.stmtPrice - r.price) / r.price > 0.1) flags.push(`Statement price ${fmtNav(r.stmtPrice)} differs from the latest close ${fmtNav(r.price)}.`);
    let controls = '';
    if (r.status === 'new') {
      controls = `<div class="dm-ctrl">
        <label>Avg buy price (₹)<input type="number" name="price-${k}" min="0" step="any" placeholder="optional"></label>
        <label>First bought<input type="date" name="date-${k}" max="${todayIso()}"></label>
        <label>Portfolio<select name="pf-${k}">${portfolioOptions(s, portfolioId)}</select></label></div>`;
    } else if (r.status === 'up') {
      controls = `<div class="dm-ctrl">
        <label class="inline"><input type="radio" name="inc-${k}" value="buy" checked> Bought more</label>
        <label class="inline"><input type="radio" name="inc-${k}" value="bonus"> Bonus / split (no cost)</label>
        <label>Price for the new shares (₹)<input type="number" name="price-${k}" min="0" step="any" placeholder="optional"></label></div>`;
    } else if (r.status === 'down') {
      controls = '<div class="dm-note">Recorded as a sale at average cost.</div>';
    } else if (r.status === 'missing') {
      controls = `<div class="dm-ctrl"><label class="inline"><input type="checkbox" name="sold-${k}"> Sold all ${fmtUnits(r.before)} (record a sale)</label></div>`;
    }
    const tag = STATUS[r.status] || change(r);
    return `<div class="dm-row ${r.status}">
      <div class="dm-main">${r.status !== 'same' && r.status !== 'missing' ? `<input type="checkbox" name="inc-row-${k}" checked aria-label="Import ${name}">` : '<span></span>'}
        <div><b>${name}</b> <span class="muted">${esc(r.isin)}</span> <span class="chip ${r.status}">${tag}</span>
          ${r.status === 'new' || r.status === 'same' ? `<span class="muted">· ${fmtUnits(r.qty)} shares${r.stmtValue ? ` · ${rupees(r.stmtValue)} on the statement` : ''}</span>` : ''}
          ${flags.map((f) => `<small class="warn-text">${esc(f)}</small>`).join('')}
          ${controls}</div></div>
    </div>`;
  };
  const acctHtml = (p, ai) => {
    const a = p.account;
    return `<section class="dm-acct">
      <div class="dm-acct-h"><b>${esc(a.brokerShort || a.broker || 'Demat account')}</b> <span class="muted">DP ${esc(a.dpId)} · Client ${esc(a.clientId)}${a.holders.length ? ` · ${esc(a.holders.join(', '))}` : ''}</span>
        <span class="chip">${p.linked ? `Linked to ${esc(dematLabel(p.demat))}` : p.demat ? 'Already tracked' : 'New demat account'}</span></div>
      ${(!p.demat || p.linked) && linkable.length ? `<label class="field">Already in the tracker as<select name="link-${ai}"><option value="">— no, it’s a new account —</option>${linkable.map((d) => `<option value="${d.id}" ${links[ai] === d.id ? 'selected' : ''}>${esc(dematLabel(d))}${d.holderName ? ` · ${esc(d.holderName)}` : ''}</option>`).join('')}</select></label>` : ''}
      ${p.demat ? '' : `<label class="field">Whose demat account is this?<select name="member-${ai}">${memberOptions(s, guessMember(a))}</select></label>`}
      ${p.rows.length ? p.rows.map((r, ri) => rowHtml(ai, r, ri)).join('') : '<p class="hint" style="margin:0">No shares in this account.</p>'}
    </section>`;
  };
  const skipped = cas.skipped.length ? `<details class="help"><summary>Skipped ${plural(cas.skipped.length, 'item')} (mutual funds and other securities)</summary>
      <ul>${cas.skipped.map((x) => `<li>${esc(x.name || x.isin)} <span class="muted">${esc(x.isin)} · ${esc(x.kind)}</span></li>`).join('')}</ul>
      <p>Mutual funds come in through the CAMS / KFintech statement instead.</p></details>` : '';
  openDialog({
    title: 'Review share import',
    submit: nActions || plan.some((p) => p.linked) ? 'Import' : 'Done',
    wide: true,
    body: `
      <p class="hint" style="margin:0">${cas.date ? `Statement as on ${date(cas.date)} · ` : ''}${plural(plan.length, 'demat account')} · ${plural(plan.reduce((a, p) => a + p.rows.filter((r) => r.status !== 'missing').length, 0), 'share')}.
        ${nActions ? 'Quantities are compared with the tracker; re-importing the same statement changes nothing.' : 'Everything in this statement already matches the tracker.'}</p>
      ${skipped}
      <div class="cas-list">${plan.map(acctHtml).join('')}</div>`,
    onOpen: (form) => form.addEventListener('change', (e) => {
      const m = e.target.name?.match(/^link-(\d+)$/);
      if (!m) return;
      dialog.close(); // redo the matching against the chosen account
      reviewDematDialog(cas, portfolioId, { ...links, [m[1]]: e.target.value || undefined });
    }),
    onSubmit: async (d) => {
      if (!nActions && !plan.some((p) => p.linked)) return;
      const choices = {};
      plan.forEach((p, ai) => p.rows.forEach((r, ri) => {
        const k = `${ai}-${ri}`;
        choices[`${ai}:${ri}`] = {
          include: r.status === 'same' || r.status === 'missing' ? true : !!d[`inc-row-${k}`],
          price: d[`price-${k}`] ?? '', firstBought: d[`date-${k}`] || null, portfolioId: d[`pf-${k}`] || null,
          increase: d[`inc-${k}`] || 'buy', sellAll: !!d[`sold-${k}`],
        };
      }));
      const missingMember = plan.findIndex((p, ai) => !p.demat && p.rows.some((r, ri) => choices[`${ai}:${ri}`].include && r.status === 'new') && !d[`member-${ai}`]);
      if (missingMember >= 0) return `Choose whose demat account ${plan[missingMember].account.clientId} is.`;
      const w = dematWrites(plan, choices, { date: cas.date || todayIso(), memberFor: (ai) => d[`member-${ai}`] });
      if (!w.demats.length && !w.dematUpdates.length && !w.adds.length && !w.appends.length) return 'Nothing selected to import.';
      await store.importDemat(w);
      toast(`Imported ${plural(w.adds.length, 'new share')}${w.appends.length ? ` · ${plural(w.appends.length, 'change')}` : ''}${w.demats.length ? ` · ${plural(w.demats.length, 'demat account')}` : ''}`);
    },
  });
}

// ---------- Axis Direct review ----------
function reviewAxisDialog(plan, portfolioId) {
  const s = store.get();
  const a = plan.account;
  const avg = (txns) => shareStats({ txns }, null, null).avgPrice;
  const nActions = plan.rows.filter((r) => r.status !== 'same').length;
  const noDate = plan.rows.filter((r) => r.status !== 'missing' && r.qty > 0 && r.txns.some((t) => t.kind === 'opening' && !t.date));
  const firstBought = (txns) => txns?.find((t) => t.kind === 'opening')?.date || null;
  const words = new Set(a.name.toLowerCase().split(/\s+/));
  const guess = s.members.find((m) => m.name.toLowerCase().split(/\s+/).some((w) => words.has(w)))?.id || (portfolioId && portfolioById(s, portfolioId)?.memberId) || '';
  const rowHtml = (r, i) => {
    const name = esc(r.name || shareInfo(s, { isin: r.isin }).name);
    const notes = [];
    if (r.price == null && r.qty > 0) notes.push('No price in the price file yet, so it won’t be valued.');
    let tag = '', what = '', controls = '';
    if (r.status === 'new') {
      tag = r.qty > 0 ? 'New' : 'New · sold';
      what = r.qty > 0 ? `${fmtUnits(r.qty)} shares · avg ${avg(r.txns) != null ? fmtNav(avg(r.txns)) : '—'}${firstBought(r.txns) ? ` · since ${date(firstBought(r.txns))}` : ''}` : `held ${fmtUnits(r.held)} on ${date(a.asOf)}, sold since`;
      controls = `<div class="dm-ctrl"><label>Portfolio<select name="pf-${i}">${portfolioOptions(s, portfolioId)}</select></label></div>`;
    } else if (r.status === 'changed') {
      const o = avg(r.share.txns || []), n = avg(r.txns);
      tag = r.oldQty !== r.qty ? `${fmtUnits(r.oldQty)} → ${fmtUnits(r.qty)}` : 'Updated';
      const fb = firstBought(r.txns);
      what = [o != null && n != null && Math.abs(o - n) > 0.005 ? `avg ${fmtNav(o)} → ${fmtNav(n)}` : '',
        fb && fb !== firstBought(r.share.txns) ? `first bought ${date(fb)}` : '',
        r.newDividends > 0 ? `${plural(r.newDividends, 'new dividend')}` : ''].filter(Boolean).join(' · ');
    } else if (r.status === 'same') { tag = 'No change'; what = `${fmtUnits(r.qty)} shares`; }
    else if (r.status === 'missing') {
      tag = 'Not in these files';
      controls = `<div class="dm-ctrl"><label class="inline"><input type="checkbox" name="sold-${i}"> Sold all ${fmtUnits(r.oldQty)} (record a sale)</label></div>`;
    }
    const dividends = r.status === 'new' && r.dividends?.length ? ` · ${plural(r.dividends.length, 'dividend')}` : '';
    return `<div class="dm-row ${r.status === 'changed' ? 'up' : r.status}">
      <div class="dm-main">${r.status === 'new' || r.status === 'changed' ? `<input type="checkbox" name="inc-${i}" checked aria-label="Import ${name}">` : '<span></span>'}
        <div><b>${name}</b> <span class="muted">${esc(r.isin)}</span> <span class="chip ${r.status === 'changed' ? 'up' : r.status}">${tag}</span>
          ${what || dividends ? `<span class="muted">· ${what}${dividends}</span>` : ''}
          ${notes.map((n) => `<small class="warn-text">${esc(n)}</small>`).join('')}
          ${controls}</div></div></div>`;
  };
  // Only things that actually need attention; everything the app handled itself stays quiet.
  const names = (list) => list.map((x) => `<b>${esc(x)}</b>`).join(', ');
  const late = [...new Set(plan.lateActions.map((o) => o.name))];
  const extra = [
    plan.unmatched.length ? `Trades in ${names(plan.unmatched)} after ${date(a.asOf)} couldn’t be matched to a share, so they weren’t added. If you still hold ${plan.unmatched.length === 1 ? 'it, add it' : 'them, add them'} with “+ Add share”.` : '',
    late.length ? `${names(late)} had a bonus, split or merger after ${date(a.asOf)}, which this holding statement doesn’t include yet. Download a holding statement dated today and import both files again.` : '',
    noDate.length ? `The transaction report doesn’t cover every share of ${names(noDate.map((r) => r.name || shareInfo(s, { isin: r.isin }).name))} (for example, shares moved in from another broker, or bought before ${a.tradesFrom ? date(a.tradesFrom) : 'the report starts'}), so ${noDate.length === 1 ? 'its' : 'their'} first-bought date isn’t known and XIRR shows “—”. ${a.tradesFrom ? 'Run the transaction report from an earlier date, or add' : 'Add the transaction report, or add'} the date later with Edit → Edit buy price / first bought.` : '',
  ].filter(Boolean);
  openDialog({
    title: 'Review Axis Direct import',
    submit: nActions ? 'Import' : 'Done',
    wide: true,
    body: `
      <section class="dm-acct">
        <div class="dm-acct-h"><b>Axis Direct</b> <span class="muted">client ${esc(a.clientId)}${a.name ? ` · ${esc(a.name)}` : ''}</span>
          <span class="chip">${plan.demat ? 'Already tracked' : 'New account'}</span></div>
        <p class="hint" style="margin:0">Holdings as on ${a.asOf ? date(a.asOf) : '—'}${a.tradesFrom ? ` · trades ${date(a.tradesFrom)} – ${date(a.tradesTo)}` : ' · no trade report'}.
          ${nActions ? 'Average costs come from Axis; trades after the holdings date are added on top. Importing the same files again changes nothing.' : 'Everything in these files already matches the tracker.'}</p>
        ${plan.demat ? '' : `<label class="field">Whose account is this?<select name="member">${memberOptions(s, guess)}</select></label>`}
        ${plan.rows.filter((r) => r.status === 'new').length > 1 ? `<label class="field">Put all new shares in<select class="pf-all">${portfolioOptions(s, portfolioId)}</select></label>` : ''}
        ${extra.map((x) => `<p class="notice" style="margin:0">${x}</p>`).join('')}
        ${plan.rows.map(rowHtml).join('')}
      </section>`,
    onOpen: (form) => form.querySelector('.pf-all')?.addEventListener('change', (e) => {
      form.querySelectorAll('select[name^="pf-"]').forEach((sel) => { sel.value = e.target.value; });
    }),
    onSubmit: async (d) => {
      if (!nActions) return;
      const choices = plan.rows.map((r, i) => ({ include: r.status === 'new' || r.status === 'changed' ? !!d[`inc-${i}`] : true, portfolioId: d[`pf-${i}`] || null, sellAll: !!d[`sold-${i}`] }));
      if (!plan.demat && plan.rows.some((r, i) => r.status === 'new' && choices[i].include) && !d.member) return 'Choose whose account this is.';
      const w = axisWrites(plan, choices, { memberId: d.member, today: todayIso() });
      if (!w.adds.length && !w.replaces.length && !w.appends.length) return 'Nothing selected to import.';
      await store.importDemat(w);
      toast(`Imported ${plural(w.adds.length, 'new share')}${w.replaces.length ? ` · ${plural(w.replaces.length, 'update')}` : ''}${w.appends.length ? ` · ${plural(w.appends.length, 'sale')}` : ''}`);
    },
  });
}

function addUserDialog() {
  openDialog({
    title: 'Add person',
    submit: 'Give access',
    body: `
      <label class="field">Their Google account (Gmail address)<input type="email" name="email" required placeholder="name@gmail.com"></label>
      <label class="field">Role<select name="role"><option value="viewer">Viewer — can only look</option><option value="editor" selected>Editor — can make changes</option><option value="admin">Admin — can also manage access</option></select></label>
      <p class="hint" style="margin:0">Then send them the app’s link. They sign in with this Google account.</p>`,
    onSubmit: async ({ email, role }) => {
      const e = email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'Enter a valid email address.';
      await store.setUser(e, role);
      toast(`${e} can now open the tracker`);
    },
  });
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, tr[data-go]');
  if (!t || !store || t.closest('dialog')) return;
  const s = store.get();
  if (t.dataset.go != null) return go(t.dataset.go);
  if (t.hasAttribute('data-menu')) return openMenu();
  if (t.hasAttribute('data-theme-toggle')) return toggleTheme();
  if (t.dataset.sort) {
    const [list, key] = t.dataset.sort.split(':');
    cycleSort(list, key);
    render.resorted = true;
    return render();
  }
  if (t.dataset.view) {
    viewPref = t.dataset.view;
    try { localStorage.setItem('view', viewPref); } catch {}
    render.resorted = true; // the lists below change, so don't try to keep a folio card in place
    return render();
  }
  if (t.hasAttribute('data-add-share')) return addShareDialog(t.dataset.addShare || null);
  if (t.dataset.buyPrice) return buyPriceDialog(t.dataset.buyPrice);
  if (t.dataset.editShare) return shareDialog(t.dataset.editShare);
  if (t.hasAttribute('data-add-member')) return nameDialog('Add member', '', (n) => { const m = store.addMember(n); go(`#/member/${m.id}`); });
  if (t.dataset.addPortfolio) return nameDialog(`New portfolio for ${memberById(s, t.dataset.addPortfolio)?.name}`, '', (n) => { const p = store.addPortfolio(t.dataset.addPortfolio, n); go(`#/portfolio/${p.id}`); });
  if (t.dataset.renameMember) return nameDialog('Rename member', memberById(s, t.dataset.renameMember)?.name, (n) => store.renameMember(t.dataset.renameMember, n));
  if (t.dataset.renamePortfolio) return nameDialog('Rename portfolio', portfolioById(s, t.dataset.renamePortfolio)?.name, (n) => store.renamePortfolio(t.dataset.renamePortfolio, n));
  if (t.dataset.deletePortfolio) {
    const p = portfolioById(s, t.dataset.deletePortfolio);
    const n = foliosOfPortfolio(s, p.id).length, ns = sharesOfPortfolio(s, p.id).length;
    const what = [n ? plural(n, 'folio') : '', ns ? plural(ns, 'share') : ''].filter(Boolean).join(' and ');
    return openDialog({
      title: `Delete “${p.name}”?`, submit: 'Delete',
      body: `<p style="margin:0;color:var(--ink-2)">${what ? `Its ${what} will move to Unassigned — nothing is lost.` : 'This portfolio is empty.'}</p>`,
      onSubmit: () => { store.deletePortfolio(p.id); go(`#/member/${p.memberId}`); toast(`Deleted ${p.name}`); },
    });
  }
  if (t.hasAttribute('data-add-folio')) return addFolioDialog(t.dataset.addFolio || null);
  if (t.hasAttribute('data-import-cas')) return importCasDialog(t.dataset.importCas || null);
  if (t.dataset.addTxn) return addTxnDialog(t.dataset.addTxn);
  if (t.dataset.deleteAllFolios) {
    const p = portfolioById(s, t.dataset.deleteAllFolios);
    const fs = openFolios(s, foliosOfPortfolio(s, p.id));
    return openDialog({
      title: `Delete all ${plural(fs.length, 'folio')} in “${p.name}”?`, submit: `Delete ${plural(fs.length, 'folio')}`,
      body: `<p style="margin:0;color:var(--ink-2)">This permanently removes ${fs.length === 1 ? 'this folio' : `these ${fs.length} folios`} and all their transactions for everyone. The portfolio itself stays. To keep folios but take them out of this portfolio, use “Delete” on the portfolio instead — its folios move to Unassigned.</p>
        <p class="hint" style="margin:0">${fs.map((f) => `${esc(f.folioNo)} · ${esc(f.amc)}`).join('<br>')}</p>`,
      onSubmit: async () => { await store.deleteFolios(fs.map((f) => f.id)); toast(`Deleted ${plural(fs.length, 'folio')} from ${p.name}`); },
    });
  }
  if (t.dataset.deleteFolio) {
    const f = s.folios.find((x) => x.id === t.dataset.deleteFolio);
    return openDialog({
      title: `Delete folio ${f.folioNo}?`, submit: 'Delete folio',
      body: '<p style="margin:0;color:var(--ink-2)">This removes the folio and all its transactions for everyone. To keep it but take it out of a portfolio, use “Move to → Unassigned” instead.</p>',
      onSubmit: () => { store.deleteFolio(f.id); toast(`Deleted folio ${f.folioNo}`); },
    });
  }
  if (t.dataset.deleteMember) {
    const m = memberById(s, t.dataset.deleteMember);
    return openDialog({
      title: `Remove ${m.name}?`, submit: 'Remove',
      body: '<p style="margin:0;color:var(--ink-2)">They have no portfolios, so nothing else is affected.</p>',
      onSubmit: () => { store.deleteMember(m.id); go('#/'); },
    });
  }
  if (t.hasAttribute('data-add-user')) return addUserDialog();
  if (t.dataset.removeUser) {
    const e = t.dataset.removeUser;
    return openDialog({
      title: `Remove ${e}?`, submit: 'Remove access',
      body: '<p style="margin:0;color:var(--ink-2)">They’ll lose access immediately, even if the app is open. Your data isn’t affected.</p>',
      onSubmit: async () => { await store.removeUser(e); toast(`Removed ${e}`); },
    });
  }
  if (t.hasAttribute('data-signout')) return session.signOut?.();
});

document.addEventListener('change', (e) => {
  const sortSel = e.target.closest('select[data-sort-select]');
  if (sortSel) {
    const [key, dir] = sortSel.value.split(':');
    setSort(sortSel.dataset.sortSelect, key ? { key, dir: +dir } : null);
    render.resorted = true;
    render();
  }
  const sel = e.target.closest('select[data-move]');
  if (sel) moveFolio(sel.dataset.move, sel.value || null);
  const shareSel = e.target.closest('select[data-move-share]');
  if (shareSel) moveShare(shareSel.dataset.moveShare, shareSel.value || null);
  const roleSel = e.target.closest('select[data-set-role]');
  if (roleSel) store.setUser(roleSel.dataset.setRole, roleSel.value)
    .then(() => toast(`${roleSel.dataset.setRole} is now ${ROLE_LABEL[roleSel.value]}`))
    .catch((err) => toast(`Couldn’t change role: ${err.message}`));
});

// drag & drop folios (cards) and shares (table rows) onto sidebar portfolios
let dragId = null, dragKind = 'folio';
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('[data-folio], tr[data-share][draggable="true"]');
  if (!card || !canEdit()) return;
  dragKind = card.dataset.share ? 'share' : 'folio';
  dragId = card.dataset.share || card.dataset.folio;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  sidebar.querySelectorAll('[data-drop]').forEach((el) => el.classList.add('drop-ok'));
});
document.addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  sidebar.querySelectorAll('.drop-ok, .drop-hover').forEach((el) => el.classList.remove('drop-ok', 'drop-hover'));
});
sidebar.addEventListener('dragover', (e) => {
  const t = e.target.closest('[data-drop]');
  if (!t || !dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  sidebar.querySelectorAll('.drop-hover').forEach((el) => el !== t && el.classList.remove('drop-hover'));
  t.classList.add('drop-hover');
});
sidebar.addEventListener('dragleave', (e) => {
  const t = e.target.closest('[data-drop]');
  if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-hover');
});
sidebar.addEventListener('drop', (e) => {
  const t = e.target.closest('[data-drop]');
  if (!t || !dragId) return;
  e.preventDefault();
  (dragKind === 'share' ? moveShare : moveFolio)(dragId, t.dataset.drop || null);
});

// tooltips
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tooltip.hidden = true; return; }
  tooltip.innerHTML = t.dataset.tip;
  tooltip.hidden = false;
});
document.addEventListener('mousemove', (e) => {
  if (tooltip.hidden) return;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY - h - 10;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y < 8) y = e.clientY + 18;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
});

// mobile menu
const scrim = $('#scrim');
function openMenu() { sidebar.classList.add('open'); scrim.classList.add('open'); }
function closeMenu() { sidebar.classList.remove('open'); scrim.classList.remove('open'); }
scrim.addEventListener('click', closeMenu);

// theme
function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
}
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
