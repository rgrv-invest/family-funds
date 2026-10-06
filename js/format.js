const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n3 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

export const rupees = (v) => `₹${inr0.format(Math.round(v))}`;
export const fmtNav = (v) => `₹${inr2.format(v)}`;
export const fmtUnits = (v) => n3.format(v);

// Compact Indian notation: ₹4.2 K, ₹12.4 L, ₹1.32 Cr
export function compact(v) {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(a >= 1e9 ? 0 : 2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(a >= 1e6 ? 1 : 2)} L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)} K`;
  return `${s}₹${Math.round(a)}`;
}

export const pct = (v, dp = 1) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(dp)}%`);
export const signedPct = (v, dp = 1) =>
  v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(dp)}%`;
export const signedRupees = (v) => `${v >= 0 ? '+' : '−'}₹${inr0.format(Math.abs(Math.round(v)))}`;
export const tone = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');

export function date(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
