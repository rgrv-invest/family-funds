import {
  summarize, schemeSummary, holdingsOfFolios, foliosOfPortfolio, portfoliosOfMember, foliosOfMember, holdingStats,
} from './calc.js';
import {
  rupees, compact, pct, signedPct, signedRupees, tone, date, esc, fmtNav, fmtUnits,
} from './format.js';
import { readCas, normFolio, txnKey } from './cas.js';

const $ = (sel, root = document) => root.querySelector(sel);
const sidebar = $('#sidebar');
const main = $('#main');
const tooltip = $('#tooltip');
const dialog = $('#dialog');
const toastEl = $('#toast');

const ASSET_COLOR = { Equity: 'var(--s1)', Debt: 'var(--s2)', Hybrid: 'var(--s3)', Gold: 'var(--s4)' };
const assetColor = (name) => ASSET_COLOR[name] || 'var(--s0)';

// ---------- routing ----------
function route() {
  const [type, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (type === 'member' || type === 'portfolio') return { type, id };
  if (type === 'unassigned' || type === 'access') return { type };
  return { type: 'family' };
}
const go = (hash) => { location.hash = hash; };

// ---------- session ----------
let store = null;
let session = { role: 'admin', email: '' };
const canEdit = () => session.role !== 'viewer';
const isAdmin = () => session.role === 'admin';
const ifEdit = (html) => (canEdit() ? html : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
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
const unassigned = (s) => s.folios.filter((f) => !f.portfolioId || !portfolioById(s, f.portfolioId));

export function toast(msg, undo) {
  toastEl.innerHTML = esc(msg) + (undo ? '<button class="undo">Undo</button>' : '');
  toastEl.classList.add('show');
  if (undo) toastEl.querySelector('button').onclick = () => { undo(); toastEl.classList.remove('show'); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 4500);
  toastEl.style.pointerEvents = undo ? 'auto' : 'none';
}

function moveFolio(folioId, portfolioId) {
  const s = store.get();
  const f = s.folios.find((x) => x.id === folioId);
  if (!f || f.portfolioId === portfolioId) return;
  const from = f.portfolioId;
  store.moveFolio(folioId, portfolioId);
  const p = portfolioById(s, portfolioId);
  const label = p ? `${memberById(s, p.memberId)?.name} · ${p.name}` : 'Unassigned';
  toast(`Moved folio ${f.folioNo} to ${label}`, () => store.moveFolio(folioId, from));
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
      const n = foliosOfPortfolio(s, p.id).length;
      html += `<button class="nav-item nav-portfolio${active('portfolio', p.id)}" data-go="#/portfolio/${p.id}" data-drop="${p.id}">
        <span>${esc(p.name)}</span><span class="count">${n}</span></button>`;
    }
    html += ifEdit(`<button class="nav-item nav-add" data-add-portfolio="${m.id}">+ Add portfolio</button>`);
  }
  const un = unassigned(s).length;
  html += `</div>
    <div class="nav-section">
      <button class="nav-item${active('unassigned')}" data-go="#/unassigned" data-drop="">
        <span>Unassigned folios</span><span class="count">${un}</span></button>
      ${ifEdit('<button class="nav-item nav-add" style="padding-left:10px" data-add-member>+ Add member</button>')}
      ${isAdmin() ? `<button class="nav-item${active('access')}" data-go="#/access">Access</button>` : ''}
    </div>
    <div class="side-foot">
      <div>${s.schemes.length ? `NAVs as of ${date(s.navDate)}` : 'No funds added yet'}</div>
      ${session.note ? `<div>${esc(session.note)}</div>` : ''}
      ${session.email ? `<div class="me"><span title="${esc(session.email)}">${esc(session.email)}</span><span class="chip">${ROLE_LABEL[session.role]}</span></div>` : ''}
      ${session.signOut ? '<button class="link-btn" data-signout>Sign out</button>' : ''}
    </div>`;
  sidebar.innerHTML = html;
}

// ---------- shared view pieces ----------
function kpis(sum) {
  return `
  <section class="card kpis" aria-label="Summary">
    <div class="kpi"><div class="kpi-label">Invested</div><div class="kpi-value">${rupees(sum.invested)}</div>
      <div class="kpi-sub muted">cost of units held</div></div>
    <div class="kpi"><div class="kpi-label">Current value</div><div class="kpi-value">${rupees(sum.current)}</div>
      <div class="kpi-sub muted">${sum.count} holding${sum.count === 1 ? '' : 's'}</div></div>
    <div class="kpi"><div class="kpi-label">XIRR</div><div class="kpi-value ${tone(sum.xirr)}">${sum.xirr == null ? '—' : signedPct(sum.xirr)}</div>
      <div class="kpi-sub muted">annualised</div></div>
    <div class="kpi"><div class="kpi-label">Gain / loss</div><div class="kpi-value ${tone(sum.gain)}">${signedRupees(sum.gain)}</div>
      <div class="kpi-sub ${tone(sum.gain)}">${sum.gain >= 0 ? '▲' : '▼'} ${signedPct(sum.gainPct)} absolute</div></div>
  </section>`;
}

// Pie chart (SVG). Slices separated by a 2px surface-coloured gap.
function pie(items, tip) {
  const R = 80, C = 84;
  const total = items.reduce((a, x) => a + x.value, 0);
  let a0 = -Math.PI / 2;
  const slices = items.map((x) => {
    const color = assetColor(x.name);
    if (x.value / total > 0.9999) return `<circle cx="${C}" cy="${C}" r="${R}" fill="${color}" ${tip(x)}/>`;
    const a1 = a0 + (x.value / total) * Math.PI * 2;
    const p = (a) => `${(C + R * Math.cos(a)).toFixed(2)} ${(C + R * Math.sin(a)).toFixed(2)}`;
    const d = `M${C} ${C} L${p(a0)} A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${color}" ${tip(x)}/>`;
  });
  const label = items.map((x) => `${x.name} ${pct(x.pct)}`).join(', ');
  return `<svg class="pie" viewBox="0 0 ${C * 2} ${C * 2}" role="img" aria-label="Asset class split: ${esc(label)}">${slices.join('')}</svg>`;
}

function breakups(sum) {
  if (!sum.current) {
    return `<div class="grid-2"><section class="card"><div class="card-b empty">No holdings yet — move or add folios to see the breakup.</div></section></div>`;
  }
  const tip = (x) => `data-tip="<b>${esc(x.name)}</b><br>${compact(x.value)} · ${pct(x.pct)}"`;
  const asset = `
    <section class="card">
      <div class="card-h"><h2>Asset class</h2><span class="muted" style="font-size:12px">share of current value</span></div>
      <div class="card-b pie-wrap">
        ${pie(sum.byAsset, tip)}
        <div class="pie-legend">
        ${sum.byAsset.map((x) => `
          <div class="legend-row" ${tip(x)}><i class="swatch" style="background:${assetColor(x.name)}"></i>
            <span>${esc(x.name)}</span><span class="v num">${compact(x.value)}</span><span class="p num">${pct(x.pct)}</span></div>`).join('')}
        </div>
      </div>
    </section>`;
  const max = Math.max(...sum.byCategory.map((x) => x.pct));
  const cat = `
    <section class="card">
      <div class="card-h"><h2>Fund category</h2><span class="muted" style="font-size:12px">share of current value</span></div>
      <div class="card-b"><div class="bars">
        ${sum.byCategory.map((x) => `
          <div class="bar-row" ${tip(x)}>
            <span class="name" title="${esc(x.name)}">${esc(x.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="display:block;width:${(x.pct / max) * 100}%"></span></span>
            <span class="p num">${pct(x.pct)}</span>
          </div>`).join('')}
      </div></div>
    </section>`;
  return `<div class="grid-2">${asset}${cat}</div>`;
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
          <td class="num ${tone(r.sum.xirr)}">${r.sum.xirr == null ? '—' : signedPct(r.sum.xirr)}</td>
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

function holdingsTable(s, holdings, total) {
  const rows = schemeSummary(holdings, s);
  if (!rows.length) return '';
  return `
  <div class="section-title"><h2>Holdings</h2><span class="muted" style="font-size:12.5px">${rows.length} scheme${rows.length === 1 ? '' : 's'}, combined across folios</span></div>
  <div class="card table-wrap"><table class="holdings">
    <thead><tr><th>Scheme</th><th>Units</th><th>NAV</th><th>Invested</th><th>Current value</th><th>XIRR</th><th>Gain</th><th>Share</th></tr></thead>
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

function folioCards(s, folios, { showPortfolio = false } = {}) {
  if (!folios.length) return `<div class="card"><div class="card-b empty">${canEdit() ? 'No folios here yet. Add one, drag one onto this portfolio in the sidebar, or use “Move to” on any folio.' : 'No folios here yet.'}</div></div>`;
  const schemeBy = Object.fromEntries(s.schemes.map((x) => [x.code, x]));
  return `<div class="folio-list">${folios.map((f) => {
    const hs = s.holdings.filter((h) => h.folioId === f.id);
    const sum = summarize(hs, s);
    const p = portfolioById(s, f.portfolioId);
    return `
    <article class="folio" draggable="${canEdit()}" data-folio="${f.id}">
      ${canEdit() ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : '<span></span>'}
      <div>
        <div class="folio-head">
          <span class="folio-no">Folio ${esc(f.folioNo)}</span>
          <span class="chip">${esc(f.amc)}</span>
          <span class="chip">Holder: ${esc(f.holder)}</span>
          ${showPortfolio ? `<span class="chip">${p ? esc(p.name) : 'Unassigned'}</span>` : ''}
          <span class="muted" style="font-size:12.5px">${rupees(sum.current)} · <span class="${tone(sum.xirr)}">XIRR ${sum.xirr == null ? '—' : signedPct(sum.xirr)}</span></span>
        </div>
        <div class="schemes">
          <div class="scheme scheme-head"><span class="sn">Scheme</span><span>Units</span><span>Invested</span><span>Current</span><span>Gain</span></div>
          ${hs.map((h) => {
            const sc = schemeBy[h.schemeCode];
            if (!sc) return `<div class="scheme"><span class="sn muted">Loading scheme ${esc(h.schemeCode)}…</span></div>`;
            const st = holdingStats(h, sc, s.navDate);
            const g = st.current - st.invested;
            return `<div class="scheme">
              <span class="sn">${esc(sc.name)}<small>${esc(sc.category)} · NAV ${fmtNav(sc.nav)}</small></span>
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
function viewFamily(s) {
  const all = summarize(s.holdings, s);
  const rows = s.members.map((m) => {
    const ps = portfoliosOfMember(s, m.id);
    return {
      name: m.name,
      sub: `${ps.length} portfolio${ps.length === 1 ? '' : 's'}`,
      href: `#/member/${m.id}`,
      sum: summarize(holdingsOfFolios(s, foliosOfMember(s, m.id).map((f) => f.id)), s),
    };
  });
  const un = unassigned(s);
  if (un.length) rows.push({ name: 'Unassigned folios', sub: `${un.length} folio${un.length === 1 ? '' : 's'}`, href: '#/unassigned', sum: summarize(holdingsOfFolios(s, un.map((f) => f.id)), s) });
  return (
    header({ title: 'Family overview', subtitle: `${plural(s.members.length, 'member')} · ${plural(s.portfolios.length, 'portfolio')} · ${plural(s.folios.length, 'folio')}`, actions: ifEdit(`<button class="btn" data-add-member>+ Add member</button><button class="btn" data-import-cas>Import CAS</button><button class="btn primary" data-add-folio>+ Add folio</button>`) }) +
    (session.banner ? `<div class="banner">${session.banner}</div>` : '') +
    (!s.members.length && !s.folios.length ? welcome() : familyBody(s, all, rows))
  );
}

function familyBody(s, all, rows) {
  return (
    kpis(all) +
    `<div class="section-title" style="margin-top:20px"><h2>By member</h2></div>` + summaryTable(rows, all.current, 'Member') +
    `<div style="margin-top:16px">${breakups(all)}</div>` +
    holdingsTable(s, s.holdings, all.current)
  );
}

function viewMember(s, id) {
  const m = memberById(s, id);
  if (!m) return viewFamily(s);
  const folios = foliosOfMember(s, id);
  const sum = summarize(holdingsOfFolios(s, folios.map((f) => f.id)), s);
  const rows = portfoliosOfMember(s, id).map((p) => {
    const fs = foliosOfPortfolio(s, p.id);
    return { name: p.name, sub: `${fs.length} folio${fs.length === 1 ? '' : 's'}`, href: `#/portfolio/${p.id}`, sum: summarize(holdingsOfFolios(s, fs.map((f) => f.id)), s) };
  });
  return (
    header({
      crumbs: [{ label: 'Family', href: '#/' }],
      title: m.name,
      subtitle: `${rows.length} portfolio${rows.length === 1 ? '' : 's'} · ${folios.length} folios`,
      actions: ifEdit(`<button class="btn" data-rename-member="${m.id}">Rename</button>${rows.length ? '' : `<button class="btn danger" data-delete-member="${m.id}">Remove</button>`}<button class="btn primary" data-add-portfolio="${m.id}">+ Add portfolio</button>`),
    }) +
    kpis(sum) +
    `<div class="section-title" style="margin-top:20px"><h2>Portfolios</h2></div>` + summaryTable(rows, sum.current, 'Portfolio') +
    `<div style="margin-top:16px">${breakups(sum)}</div>` +
    holdingsTable(s, holdingsOfFolios(s, folios.map((f) => f.id)), sum.current) +
    `<div class="section-title"><h2>All folios</h2></div>${ifEdit('<p class="hint">Drag a folio onto any portfolio in the sidebar, or pick one under “Move to”.</p>')}` +
    folioCards(s, folios, { showPortfolio: true })
  );
}

function viewPortfolio(s, id) {
  const p = portfolioById(s, id);
  if (!p) return viewFamily(s);
  const m = memberById(s, p.memberId);
  const folios = foliosOfPortfolio(s, id);
  const sum = summarize(holdingsOfFolios(s, folios.map((f) => f.id)), s);
  return (
    header({
      crumbs: [{ label: 'Family', href: '#/' }, { label: m?.name || '', href: `#/member/${p.memberId}` }],
      title: p.name,
      subtitle: `${folios.length} folio${folios.length === 1 ? '' : 's'}`,
      actions: ifEdit(`<button class="btn" data-rename-portfolio="${p.id}">Rename</button><button class="btn danger" data-delete-portfolio="${p.id}">Delete</button>${folios.length ? `<button class="btn danger" data-delete-all-folios="${p.id}">Delete all folios</button>` : ''}<button class="btn" data-import-cas="${p.id}">Import CAS</button><button class="btn primary" data-add-folio="${p.id}">+ Add folio</button>`),
    }) +
    kpis(sum) + breakups(sum) +
    holdingsTable(s, holdingsOfFolios(s, folios.map((f) => f.id)), sum.current) +
    `<div class="section-title"><h2>Folios</h2></div>${ifEdit('<p class="hint">Drag a folio onto another portfolio in the sidebar, or pick one under “Move to”.</p>')}` +
    folioCards(s, folios)
  );
}

function viewUnassigned(s) {
  const folios = unassigned(s);
  return (
    header({ crumbs: [{ label: 'Family', href: '#/' }], title: 'Unassigned folios', subtitle: 'Folios not in any portfolio. They still count in the family total.', actions: ifEdit(`<button class="btn" data-import-cas>Import CAS</button><button class="btn primary" data-add-folio>+ Add folio</button>`) }) +
    folioCards(s, folios)
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
  main.innerHTML =
    r.type === 'member' ? viewMember(s, r.id)
    : r.type === 'portfolio' ? viewPortfolio(s, r.id)
    : r.type === 'unassigned' ? viewUnassigned(s)
    : r.type === 'access' ? viewAccess(s)
    : viewFamily(s);
  if (render.lastHash === location.hash) window.scrollTo(0, y); else window.scrollTo(0, 0);
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

// ---------- CAS import ----------
function importCasDialog(portfolioId) {
  openDialog({
    title: 'Import from CAS',
    submit: 'Read statement',
    body: `
      <p class="hint" style="margin:0">Upload a <b>detailed</b> Consolidated Account Statement (PDF) from CAMS or KFintech.
        Get one from camsonline.com, kfintech.com or mfcentral.com: choose “Detailed” and, the first time, “Since inception”.</p>
      <label class="field">Statement (PDF)<input type="file" name="file" accept="application/pdf,.pdf" required></label>
      <label class="field">PDF password<input type="password" name="password" autocomplete="off" placeholder="The one you set when requesting it"></label>
      <p class="hint" style="margin:0">The PDF is read in your browser and isn’t uploaded. Only folios and transactions are saved.</p>
      <p class="cas-status" aria-live="polite" hidden></p>`,
    onSubmit: async (d, form) => {
      const status = form.querySelector('.cas-status');
      const say = (msg) => { status.hidden = false; status.textContent = msg; };
      if (!d.file?.size) return 'Choose the statement PDF.';
      try {
        say('Reading the statement…');
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
      return { ...x, code, isNew: !held, fresh: x.txns.filter((t) => !have.has(txnKey(t))) };
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
    if (h.isNew && h.openingUnits > 0.001) notes.push(`${fmtUnits(h.openingUnits)} units held before ${date(cas.period?.from || h.txns[0].date)} aren’t in this statement, so invested and XIRR would be wrong. Use a “Since inception” statement.`);
    if (!h.balanced) notes.push('Some rows couldn’t be read: the units don’t add up to the closing balance. Check this scheme after importing.');
    const what = h.fresh.length ? `${plural(h.fresh.length, 'new transaction')}` : 'up to date';
    return `<li class="${notes.length ? 'warn' : ''}">${name} <span class="muted">· ${what}</span>${notes.map((n) => `<small>${esc(n)}</small>`).join('')}</li>`;
  };
  const folioRow = (r, i) => {
    const n = txnCount(r);
    const tag = !n ? 'Up to date' : r.existing ? 'Already tracked' : 'New folio';
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
  if (t.hasAttribute('data-add-member')) return nameDialog('Add member', '', (n) => { const m = store.addMember(n); go(`#/member/${m.id}`); });
  if (t.dataset.addPortfolio) return nameDialog(`New portfolio for ${memberById(s, t.dataset.addPortfolio)?.name}`, '', (n) => { const p = store.addPortfolio(t.dataset.addPortfolio, n); go(`#/portfolio/${p.id}`); });
  if (t.dataset.renameMember) return nameDialog('Rename member', memberById(s, t.dataset.renameMember)?.name, (n) => store.renameMember(t.dataset.renameMember, n));
  if (t.dataset.renamePortfolio) return nameDialog('Rename portfolio', portfolioById(s, t.dataset.renamePortfolio)?.name, (n) => store.renamePortfolio(t.dataset.renamePortfolio, n));
  if (t.dataset.deletePortfolio) {
    const p = portfolioById(s, t.dataset.deletePortfolio);
    const n = foliosOfPortfolio(s, p.id).length;
    return openDialog({
      title: `Delete “${p.name}”?`, submit: 'Delete',
      body: `<p style="margin:0;color:var(--ink-2)">${n ? `Its ${n} folio${n === 1 ? '' : 's'} will move to Unassigned — nothing is lost.` : 'This portfolio is empty.'}</p>`,
      onSubmit: () => { store.deletePortfolio(p.id); go(`#/member/${p.memberId}`); toast(`Deleted ${p.name}`); },
    });
  }
  if (t.hasAttribute('data-add-folio')) return addFolioDialog(t.dataset.addFolio || null);
  if (t.hasAttribute('data-import-cas')) return importCasDialog(t.dataset.importCas || null);
  if (t.dataset.addTxn) return addTxnDialog(t.dataset.addTxn);
  if (t.dataset.deleteAllFolios) {
    const p = portfolioById(s, t.dataset.deleteAllFolios);
    const fs = foliosOfPortfolio(s, p.id);
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
  const sel = e.target.closest('select[data-move]');
  if (sel) moveFolio(sel.dataset.move, sel.value || null);
  const roleSel = e.target.closest('select[data-set-role]');
  if (roleSel) store.setUser(roleSel.dataset.setRole, roleSel.value)
    .then(() => toast(`${roleSel.dataset.setRole} is now ${ROLE_LABEL[roleSel.value]}`))
    .catch((err) => toast(`Couldn’t change role: ${err.message}`));
});

// drag & drop folios onto sidebar portfolios
let dragId = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('[data-folio]');
  if (!card || !canEdit()) return;
  dragId = card.dataset.folio;
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
  moveFolio(dragId, t.dataset.drop || null);
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
