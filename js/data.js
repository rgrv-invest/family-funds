// Data layer. Today: in-memory sample data. Later: swapped for Firestore with the same API.
//
// Model
//   members:    { id, name }
//   portfolios: { id, memberId, name }
//   folios:     { id, folioNo, amc, holder, portfolioId }   (portfolioId null = unassigned)
//   holdings:   { id, folioId, schemeCode, txns: [{ date, amount, units }] }  (amount < 0 = redemption)
//   schemes:    { code, name, amc, assetClass, category, nav, navDate }

const NAV_DATE = '2026-10-01';

export const SCHEMES = [
  { code: '122639', name: 'Parag Parikh Flexi Cap Fund', amc: 'PPFAS', assetClass: 'Equity', category: 'Flexi Cap', nav: 92.41, cagr: 0.19 },
  { code: '120716', name: 'UTI Nifty 50 Index Fund', amc: 'UTI', assetClass: 'Equity', category: 'Large Cap / Index', nav: 178.32, cagr: 0.13 },
  { code: '118989', name: 'HDFC Mid-Cap Opportunities Fund', amc: 'HDFC', assetClass: 'Equity', category: 'Mid Cap', nav: 214.87, cagr: 0.22 },
  { code: '125497', name: 'SBI Small Cap Fund', amc: 'SBI', assetClass: 'Equity', category: 'Small Cap', nav: 196.05, cagr: 0.2 },
  { code: '120586', name: 'ICICI Pru Bluechip Fund', amc: 'ICICI Prudential', assetClass: 'Equity', category: 'Large Cap / Index', nav: 118.6, cagr: 0.14 },
  { code: '119551', name: 'Axis ELSS Tax Saver Fund', amc: 'Axis', assetClass: 'Equity', category: 'ELSS', nav: 104.22, cagr: 0.1 },
  { code: '118825', name: 'ICICI Pru Equity & Debt Fund', amc: 'ICICI Prudential', assetClass: 'Hybrid', category: 'Aggressive Hybrid', nav: 412.9, cagr: 0.16 },
  { code: '119062', name: 'HDFC Balanced Advantage Fund', amc: 'HDFC', assetClass: 'Hybrid', category: 'Balanced Advantage', nav: 538.14, cagr: 0.15 },
  { code: '119800', name: 'SBI Liquid Fund', amc: 'SBI', assetClass: 'Debt', category: 'Liquid', nav: 4211.37, cagr: 0.068 },
  { code: '118560', name: 'HDFC Corporate Bond Fund', amc: 'HDFC', assetClass: 'Debt', category: 'Corporate Bond', nav: 33.18, cagr: 0.075 },
  { code: '120505', name: 'Axis Short Duration Fund', amc: 'Axis', assetClass: 'Debt', category: 'Short Duration', nav: 32.04, cagr: 0.071 },
  { code: '119132', name: 'Nippon India Gold Savings Fund', amc: 'Nippon India', assetClass: 'Gold', category: 'Gold FoF', nav: 41.76, cagr: 0.17 },
].map((s) => ({ ...s, navDate: NAV_DATE }));

// ---------- sample data generation (deterministic) ----------
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function navOn(scheme, dateStr) {
  const years = (Date.parse(NAV_DATE) - Date.parse(dateStr)) / (365.25 * 864e5);
  const wiggle = 1 + (rnd() - 0.5) * 0.08;
  return +(scheme.nav / Math.pow(1 + scheme.cagr, years) * wiggle).toFixed(4);
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function sip(code, start, months, amount) {
  const s = SCHEMES.find((x) => x.code === code);
  const txns = [];
  for (let i = 0; i < months; i++) {
    const date = addMonths(start, i);
    if (date > NAV_DATE) break;
    txns.push({ date, amount, units: +(amount / navOn(s, date)).toFixed(3) });
  }
  return txns;
}
function lump(code, date, amount) {
  const s = SCHEMES.find((x) => x.code === code);
  return [{ date, amount, units: +(amount / navOn(s, date)).toFixed(3) }];
}

let uid = 0;
const id = (p) => `${p}${++uid}`;

function sampleState() {
  const members = [
    { id: 'm1', name: 'Dad' },
    { id: 'm2', name: 'Mom' },
    { id: 'm3', name: 'Me' },
    { id: 'm4', name: 'Sister' },
  ];
  const portfolios = [
    { id: 'p1', memberId: 'm1', name: 'Retirement' },
    { id: 'p2', memberId: 'm1', name: 'Emergency fund' },
    { id: 'p3', memberId: 'm2', name: 'Long-term wealth' },
    { id: 'p4', memberId: 'm3', name: 'Core equity' },
    { id: 'p5', memberId: 'm3', name: 'House down payment' },
    { id: 'p6', memberId: 'm3', name: 'Tax saving' },
    { id: 'p7', memberId: 'm4', name: 'Higher studies' },
  ];
  const folios = [];
  const holdings = [];
  const add = (holder, portfolioId, amc, folioNo, items) => {
    const f = { id: id('f'), folioNo, amc, holder, portfolioId };
    folios.push(f);
    items.forEach(([code, txns]) => holdings.push({ id: id('h'), folioId: f.id, schemeCode: code, txns }));
  };

  add('Dad', 'p1', 'HDFC', '1047823/62', [
    ['118989', sip('118989', '2019-04-05', 90, 10000)],
    ['119062', lump('119062', '2018-11-12', 500000)],
  ]);
  add('Dad', 'p1', 'ICICI Prudential', '8812934/11', [['118825', sip('118825', '2020-01-10', 80, 7500)]]);
  add('Dad', 'p2', 'SBI', '20983451', [['119800', lump('119800', '2024-03-15', 300000)]]);
  add('Dad', 'p2', 'HDFC', '1047823/71', [['118560', lump('118560', '2023-07-20', 250000)]]);
  add('Mom', 'p3', 'PPFAS', '5521093', [['122639', sip('122639', '2020-06-01', 76, 5000)]]);
  add('Mom', 'p3', 'Nippon India', '477120934', [['119132', lump('119132', '2022-02-14', 150000)]]);
  add('Mom', 'p3', 'UTI', '60912234', [['120716', sip('120716', '2021-09-07', 61, 4000)]]);
  add('Me', 'p4', 'PPFAS', '5530112', [['122639', sip('122639', '2021-01-05', 70, 15000)]]);
  add('Me', 'p4', 'SBI', '21093384', [['125497', sip('125497', '2022-04-05', 54, 5000)]]);
  add('Me', 'p4', 'ICICI Prudential', '9021345/40', [['120586', sip('120586', '2023-01-10', 45, 5000)]]);
  add('Me', 'p5', 'Axis', '910203948', [['120505', lump('120505', '2025-02-01', 400000)]]);
  add('Me', 'p5', 'SBI', '21093384/2', [['119800', lump('119800', '2025-08-18', 150000)]]);
  add('Me', 'p6', 'Axis', '910112233', [['119551', lump('119551', '2023-03-20', 150000), ], ]);
  add('Sister', 'p7', 'UTI', '61002931', [['120716', sip('120716', '2023-06-07', 40, 3000)]]);
  add('Sister', 'p7', 'HDFC', '1088231/05', [['119062', lump('119062', '2024-05-02', 100000)]]);
  add('Sister', null, 'Axis', '910445566', [['119551', lump('119551', '2024-01-15', 46000)]]);

  // one partial redemption so the sample isn't all buys
  const h = holdings.find((x) => x.schemeCode === '119062' && x.txns.length === 1 && x.txns[0].amount === 500000);
  if (h) {
    const s = SCHEMES.find((x) => x.code === '119062');
    const nav = navOn(s, '2024-12-10');
    h.txns.push({ date: '2024-12-10', amount: -150000, units: -(+(150000 / nav).toFixed(3)) });
  }
  return { members, portfolios, folios, holdings, schemes: SCHEMES, navDate: NAV_DATE, users: [{ id: 'mom@example.com', role: 'editor' }, { id: 'sister@example.com', role: 'viewer' }] };
}

// ---------- store ----------
let state = sampleState();
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(state));
const commit = (patch) => {
  state = { ...state, ...patch };
  emit();
};

export const sampleStore = {
  get: () => state,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  addMember(name) {
    const m = { id: id('m'), name };
    commit({ members: [...state.members, m] });
    return m;
  },
  renameMember(memberId, name) {
    commit({ members: state.members.map((m) => (m.id === memberId ? { ...m, name } : m)) });
  },
  addPortfolio(memberId, name) {
    const p = { id: id('p'), memberId, name };
    commit({ portfolios: [...state.portfolios, p] });
    return p;
  },
  renamePortfolio(portfolioId, name) {
    commit({ portfolios: state.portfolios.map((p) => (p.id === portfolioId ? { ...p, name } : p)) });
  },
  deletePortfolio(portfolioId) {
    commit({
      portfolios: state.portfolios.filter((p) => p.id !== portfolioId),
      folios: state.folios.map((f) => (f.portfolioId === portfolioId ? { ...f, portfolioId: null } : f)),
    });
  },
  moveFolio(folioId, portfolioId) {
    commit({ folios: state.folios.map((f) => (f.id === folioId ? { ...f, portfolioId } : f)) });
  },
  // Scheme search/lookup against the sample list (the live app uses mfapi.in).
  searchSchemes: async (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return SCHEMES.filter((s) => words.every((w) => s.name.toLowerCase().includes(w))).map((s) => ({ code: s.code, name: s.name }));
  },
  ensureScheme: async (code) => SCHEMES.find((s) => s.code === code),
  navOn: async (code, day) => ({ nav: navOn(SCHEMES.find((s) => s.code === code), day), date: day }),
  deleteMember(memberId) {
    commit({ members: state.members.filter((m) => m.id !== memberId) });
  },
  addTransaction(folioId, schemeCode, txn) {
    const h = state.holdings.find((x) => x.folioId === folioId && x.schemeCode === schemeCode);
    commit({
      holdings: h
        ? state.holdings.map((x) => (x === h ? { ...x, txns: [...x.txns, txn] } : x))
        : [...state.holdings, { id: id('h'), folioId, schemeCode, txns: [txn] }],
    });
  },
  deleteFolio(folioId) {
    commit({ folios: state.folios.filter((f) => f.id !== folioId), holdings: state.holdings.filter((h) => h.folioId !== folioId) });
  },
  async setUser(email, role) {
    const rest = state.users.filter((u) => u.id !== email);
    commit({ users: [...rest, { id: email, role }] });
  },
  async removeUser(email) {
    commit({ users: state.users.filter((u) => u.id !== email) });
  },
  // CAS import: the sample has no ISINs, so match on the first words of the scheme name.
  schemeCodeForIsin: async (isin, name) => {
    const n = name.toLowerCase();
    return SCHEMES.find((s) => s.name.toLowerCase().split(' ').slice(0, 2).every((w) => n.includes(w)))?.code || null;
  },
  importFolios(plan) {
    let { folios, holdings } = state;
    for (const f of plan) {
      let fid = f.folioId;
      if (!fid) {
        fid = id('f');
        const amc = SCHEMES.find((s) => s.code === f.holdings[0].schemeCode).amc;
        folios = [...folios, { id: fid, folioNo: f.folioNo, amc, holder: f.holder, portfolioId: f.portfolioId }];
      }
      for (const h of f.holdings) {
        const have = holdings.find((x) => x.folioId === fid && x.schemeCode === h.schemeCode);
        holdings = have
          ? holdings.map((x) => (x === have ? { ...x, txns: [...x.txns, ...h.txns] } : x))
          : [...holdings, { id: id('h'), folioId: fid, schemeCode: h.schemeCode, txns: h.txns }];
      }
    }
    commit({ folios, holdings });
  },
  addFolio({ folioNo, amc, holder, portfolioId, schemeCode, date, amount, units }) {
    const f = { id: id('f'), folioNo, amc, holder, portfolioId };
    const h = { id: id('h'), folioId: f.id, schemeCode, txns: [{ date, amount, units }] };
    commit({ folios: [...state.folios, f], holdings: [...state.holdings, h] });
    return f;
  },
};
