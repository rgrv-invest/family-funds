// Firestore-backed store. Same interface as the sample store in data.js.
import {
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { fetchScheme, searchSchemes, navOn } from './mf.js';

const COLS = ['members', 'portfolios', 'folios', 'holdings', 'schemes'];
const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name || a.folioNo || '').localeCompare(String(b.name || b.folioNo || ''));

export function createStore(db, { canEdit, isAdmin, onError, onDenied }) {
  const data = { members: [], portfolios: [], folios: [], holdings: [], schemes: [], users: [] };
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
        loaded.add(name);
        rebuild();
      },
      (err) => (err.code === 'permission-denied' ? onDenied(err) : onError(err)),
    );
  COLS.forEach(listen);
  if (isAdmin) {
    onSnapshot(collection(db, 'users'), (snap) => {
      data.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (state) rebuild();
    }, onError);
  }

  const save = (p) => p.catch(onError);
  const newId = (col) => doc(collection(db, col)).id;

  // Pull fresh NAVs for every scheme we hold (once per visit).
  async function refreshNavs() {
    const today = new Date().toISOString().slice(0, 10);
    const stale = data.schemes.filter((s) => !s.checkedOn || s.checkedOn < today);
    await Promise.all(stale.map(async (s) => {
      try {
        const fresh = await fetchScheme(s.code);
        // Every signed-in family member may refresh NAVs (see firestore.rules).
        await updateDoc(doc(db, 'schemes', s.code), { nav: fresh.nav, navDate: fresh.navDate, checkedOn: today });
      } catch (e) { console.warn('NAV refresh failed for', s.code, e); }
    }));
  }

  async function ensureScheme(code) {
    const have = data.schemes.find((s) => s.code === code);
    if (have) return have;
    const s = await fetchScheme(code);
    await setDoc(doc(db, 'schemes', code), { ...s, checkedOn: new Date().toISOString().slice(0, 10) });
    return s;
  }

  return {
    get: () => state,
    subscribe(fn) { listeners.add(fn); if (state) fn(state); return () => listeners.delete(fn); },
    searchSchemes,
    ensureScheme,
    navOn,

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
      save(b.commit());
    },

    moveFolio: (id, portfolioId) => save(updateDoc(doc(db, 'folios', id), { portfolioId })),
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
    deleteFolio(id) {
      const b = writeBatch(db);
      b.delete(doc(db, 'folios', id));
      data.holdings.filter((h) => h.folioId === id).forEach((h) => b.delete(doc(db, 'holdings', h.id)));
      save(b.commit());
    },

    setUser: (email, role) => setDoc(doc(db, 'users', email.toLowerCase()), { role, updatedAt: Date.now() }, { merge: true }),
    removeUser: (email) => deleteDoc(doc(db, 'users', email.toLowerCase())),
  };
}
