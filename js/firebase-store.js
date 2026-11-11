// Firestore-backed store. Same interface as the sample store in data.js.
import {
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { fetchScheme, searchSchemes, navOn, schemeCodeForIsin, needsNav } from './mf.js';
import { loadSharePrices } from './prices.js';

const COLS = ['members', 'portfolios', 'folios', 'holdings', 'schemes', 'demats', 'shares'];
// Share collections added later: until firestore.rules allows them, treat them as empty
// instead of locking everyone out.
const OPTIONAL = new Set(['demats', 'shares']);
const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name || a.folioNo || '').localeCompare(String(b.name || b.folioNo || ''));

export function createStore(db, { canEdit, isAdmin, onError, onDenied }) {
  const data = { members: [], portfolios: [], folios: [], holdings: [], schemes: [], demats: [], shares: [], users: [] };
  let prices = null, stockMeta = null;
  const blocked = new Set(); // share collections the current rules refuse
  const loaded = new Set();
  let state = null;
  const listeners = new Set();
  let navRefreshed = false;

  const rebuild = () => {
    if (loaded.size < COLS.length) return;
    const navDate = data.schemes.reduce((m, s) => (s.navDate > m ? s.navDate : m), '');
    state = {
      members: [...data.members].sort(byOrder),
      portfolios: [...data.portfolios].sort(byOrder),
      folios: [...data.folios].sort(byOrder),
      holdings: data.holdings,
      schemes: data.schemes,
      demats: [...data.demats].sort(byOrder),
      shares: [...data.shares].sort(byOrder),
      prices,
      stockMeta,
      sharesBlocked: blocked.size > 0,
      users: [...data.users].sort((a, b) => a.id.localeCompare(b.id)),
      navDate: navDate || new Date().toISOString().slice(0, 10),
    };
    listeners.forEach((fn) => fn(state));
    if (!navRefreshed) { navRefreshed = true; refreshNavs(); }
  };

  const listen = (name) =>
    onSnapshot(
      collection(db, name),
      (snap) => {
        data[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (name === 'schemes') data.schemes = data.schemes.map((s) => ({ code: s.id, ...s }));
        blocked.delete(name);
        loaded.add(name);
        rebuild();
      },
      (err) => {
        if (OPTIONAL.has(name) && err.code === 'permission-denied') {
          console.warn(`No access to "${name}" yet: publish the new firestore.rules.`);
          blocked.add(name);
          loaded.add(name);
          return rebuild();
        }
        return err.code === 'permission-denied' ? onDenied(err) : onError(err);
      },
    );
  COLS.forEach(listen);

  // Share prices and sector / market-cap data: files the daily GitHub job saves on this site.
  async function refreshPrices() {
    const got = await loadSharePrices();
    if (got.prices) prices = got.prices;
    if (got.meta) stockMeta = got.meta;
    if (state) rebuild();
  }
  refreshPrices();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshPrices(); });
  setInterval(refreshPrices, 60 * 60e3);
  if (isAdmin) {
    onSnapshot(collection(db, 'users'), (snap) => {
      data.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (state) rebuild();
    }, onError);
  }

  const save = (p) => p.catch(onError);
  const newId = (col) => doc(collection(db, col)).id;

  // Pull the latest NAV for every scheme that doesn't have today's yet (see needsNav). Runs on
  // load, when the tab comes back into view, and every hour while it's open.
  let refreshing = false;
  async function refreshNavs() {
    if (refreshing) return;
    refreshing = true;
    const now = Date.now();
    const stale = data.schemes.filter((s) => needsNav(s, now));
    await Promise.all(stale.map(async (s) => {
      try {
        const fresh = await fetchScheme(s.code);
        // Every signed-in family member may refresh NAVs (see firestore.rules).
        await updateDoc(doc(db, 'schemes', s.code), { nav: fresh.nav, navDate: fresh.navDate, checkedOn: new Date(now).toISOString() });
      } catch (e) { console.warn('NAV refresh failed for', s.code, e); }
    }));
    refreshing = false;
  }
  document.addEventListener('visibilitychange', () => { if (state && document.visibilityState === 'visible') refreshNavs(); });
  setInterval(() => { if (state) refreshNavs(); }, 60 * 60e3);

  async function ensureScheme(code) {
    const have = data.schemes.find((s) => s.code === code);
    if (have) return have;
    const s = await fetchScheme(code);
    await setDoc(doc(db, 'schemes', code), { ...s, checkedOn: new Date().toISOString() });
    return s;
  }

  return {
    get: () => state,
    subscribe(fn) { listeners.add(fn); if (state) fn(state); return () => listeners.delete(fn); },
    searchSchemes,
    ensureScheme,
    navOn,
    schemeCodeForIsin: async (isin, name) => data.schemes.find((s) => s.isin === isin)?.code || schemeCodeForIsin(isin, name),

    addMember(name) {
      const id = newId('members');
      save(setDoc(doc(db, 'members', id), { name, order: Date.now() }));
      return { id };
    },
    renameMember: (id, name) => save(updateDoc(doc(db, 'members', id), { name })),
    deleteMember: (id) => save(deleteDoc(doc(db, 'members', id))),

    addPortfolio(memberId, name) {
      const id = newId('portfolios');
      save(setDoc(doc(db, 'portfolios', id), { memberId, name, order: Date.now() }));
      return { id };
    },
    renamePortfolio: (id, name) => save(updateDoc(doc(db, 'portfolios', id), { name })),
    deletePortfolio(id) {
      const b = writeBatch(db);
      b.delete(doc(db, 'portfolios', id));
      data.folios.filter((f) => f.portfolioId === id).forEach((f) => b.update(doc(db, 'folios', f.id), { portfolioId: null }));
      data.shares.filter((s) => s.portfolioId === id).forEach((s) => b.update(doc(db, 'shares', s.id), { portfolioId: null }));
      save(b.commit());
    },

    moveFolio: (id, portfolioId, holder) => save(updateDoc(doc(db, 'folios', id), holder ? { portfolioId, holder } : { portfolioId })),
    async addFolio({ folioNo, amc, holder, portfolioId, schemeCode, date, amount, units }) {
      await ensureScheme(schemeCode);
      const fid = newId('folios');
      const b = writeBatch(db);
      b.set(doc(db, 'folios', fid), { folioNo, amc, holder, portfolioId, order: Date.now() });
      b.set(doc(db, 'holdings', newId('holdings')), { folioId: fid, schemeCode, txns: [{ date, amount, units }] });
      await b.commit();
      return { id: fid };
    },
    async addTransaction(folioId, schemeCode, txn) {
      await ensureScheme(schemeCode);
      const h = data.holdings.find((x) => x.folioId === folioId && x.schemeCode === schemeCode);
      if (h) await updateDoc(doc(db, 'holdings', h.id), { txns: arrayUnion(txn) });
      else await setDoc(doc(db, 'holdings', newId('holdings')), { folioId, schemeCode, txns: [txn] });
    },
    // CAS import. plan: [{ folioId (existing) | folioNo, holder, portfolioId, holdings: [{ schemeCode, txns }] }]
    async importFolios(plan) {
      const codes = [...new Set(plan.flatMap((f) => f.holdings.map((h) => h.schemeCode)))];
      const schemes = Object.fromEntries(await Promise.all(codes.map(async (c) => [c, await ensureScheme(c)])));
      const commits = [];
      let b = writeBatch(db), n = 0;
      const op = (fn) => { fn(b); if (++n >= 450) { commits.push(b.commit()); b = writeBatch(db); n = 0; } };
      plan.forEach((f, i) => {
        let fid = f.folioId;
        if (!fid) {
          fid = newId('folios');
          const amc = schemes[f.holdings[0].schemeCode].amc;
          op((w) => w.set(doc(db, 'folios', fid), { folioNo: f.folioNo, amc, holder: f.holder, portfolioId: f.portfolioId, order: Date.now() + i }));
        }
        for (const h of f.holdings) {
          const have = data.holdings.find((x) => x.folioId === fid && x.schemeCode === h.schemeCode);
          if (have) op((w) => w.update(doc(db, 'holdings', have.id), { txns: arrayUnion(...h.txns) }));
          else op((w) => w.set(doc(db, 'holdings', newId('holdings')), { folioId: fid, schemeCode: h.schemeCode, txns: h.txns }));
        }
      });
      commits.push(b.commit());
      await Promise.all(commits);
    },
    async deleteFolios(ids) {
      const set = new Set(ids);
      const refs = [
        ...ids.map((id) => doc(db, 'folios', id)),
        ...data.holdings.filter((h) => set.has(h.folioId)).map((h) => doc(db, 'holdings', h.id)),
      ];
      const commits = [];
      for (let i = 0; i < refs.length; i += 450) {
        const b = writeBatch(db);
        refs.slice(i, i + 450).forEach((r) => b.delete(r));
        commits.push(b.commit());
      }
      await Promise.all(commits);
    },
    deleteFolio(id) {
      const b = writeBatch(db);
      b.delete(doc(db, 'folios', id));
      data.holdings.filter((h) => h.folioId === id).forEach((h) => b.delete(doc(db, 'holdings', h.id)));
      save(b.commit());
    },

    // ---------- shares ----------
    async addDemat(d) {
      const id = newId('demats');
      await setDoc(doc(db, 'demats', id), { broker: d.broker || '', dpId: d.dpId || '', clientId: d.clientId || '', holderName: d.holderName || '', memberId: d.memberId || null, order: Date.now() });
      return { id };
    },
    async addShare({ isin, dematId, portfolioId, txns, dividends = [] }) {
      const id = newId('shares');
      await setDoc(doc(db, 'shares', id), { isin, dematId, portfolioId: portfolioId || null, order: Date.now(), txns, dividends, sectorOverride: null });
      return { id };
    },
    updateShare: (id, patch) => updateDoc(doc(db, 'shares', id), patch),
    moveShare: (id, portfolioId) => save(updateDoc(doc(db, 'shares', id), { portfolioId })),
    deleteShare: (id) => deleteDoc(doc(db, 'shares', id)),
    // Demat CAS import. plan: { demats: [{ ref, broker, dpId, clientId, holderName, memberId }],
    //   adds: [{ dematRef | dematId, isin, portfolioId, txns }], appends: [{ shareId, txns }] }
    async importDemat(plan) {
      const ids = {};
      const commits = [];
      let b = writeBatch(db), n = 0;
      const op = (fn) => { fn(b); if (++n >= 450) { commits.push(b.commit()); b = writeBatch(db); n = 0; } };
      plan.demats.forEach((d, i) => {
        ids[d.ref] = newId('demats');
        op((w) => w.set(doc(db, 'demats', ids[d.ref]), { broker: d.broker || '', dpId: d.dpId, clientId: d.clientId, holderName: d.holderName || '', memberId: d.memberId || null, order: Date.now() + i }));
      });
      plan.adds.forEach((a, i) => op((w) => w.set(doc(db, 'shares', newId('shares')), {
        isin: a.isin, dematId: a.dematId || ids[a.dematRef], portfolioId: a.portfolioId || null, order: Date.now() + i, txns: a.txns, dividends: [], sectorOverride: null,
      })));
      plan.appends.forEach((a) => {
        const sh = data.shares.find((s) => s.id === a.shareId);
        op((w) => w.update(doc(db, 'shares', a.shareId), { txns: [...(sh?.txns || []), ...a.txns] }));
      });
      commits.push(b.commit());
      await Promise.all(commits);
    },

    setUser: (email, role) => setDoc(doc(db, 'users', email.toLowerCase()), { role, updatedAt: Date.now() }, { merge: true }),
    removeUser: (email) => deleteDoc(doc(db, 'users', email.toLowerCase())),
  };
}
