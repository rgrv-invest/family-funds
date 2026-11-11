// Share prices (data/prices.json) and sector / market-cap data (data/stock-meta.json), saved on this
// site by the daily GitHub job. The date in the URL busts caches once a day; no-cache makes the
// browser check for a newer copy whenever it asks.
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function getJson(path) {
  try {
    const r = await fetch(`${path}?v=${today()}`, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch (e) {
    console.warn('Could not load', path, e);
    return null;
  }
}

export async function loadSharePrices() {
  const [prices, meta] = await Promise.all([getJson('data/prices.json'), getJson('data/stock-meta.json')]);
  return { prices, meta };
}
