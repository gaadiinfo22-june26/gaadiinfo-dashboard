/**
 * Live challan / order status lookup.
 *
 * GaadiInfo's WhatsApp bot already looks up "Your Challan Status" by vehicle
 * number, so an internal status service exists. Point GAADIINFO_STATUS_URL at
 * it, using {vehicle}, {order} and {challan} placeholders, for example:
 *   GAADIINFO_STATUS_URL=https://internal.example/api/status?vehicle={vehicle}&order={order}
 *   GAADIINFO_STATUS_TOKEN=...   (sent as "Authorization: Bearer ...", optional)
 * Until then the workspace shows the status the bot shared in the chat and a
 * link to the government e-challan site.
 */

const PATTERNS = {
  vehicle: /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/,
  order: /^GI-\d{4}-\d{5,7}$/,
  challan: /^[A-Z0-9]{6,25}$/
};

function normalise(query) {
  const q = {};
  ['vehicle', 'order', 'challan'].forEach(k => {
    const v = String((query && query[k]) || '').toUpperCase().replace(/[\s-]/g, '');
    if (!v) return;
    const value = k === 'order' ? v.replace(/^GI(\d{4})(\d+)$/, 'GI-$1-$2') : v;
    if (!PATTERNS[k].test(value)) throw Object.assign(new Error(`That doesn't look like a valid ${k} number.`), { code: 'bad_request' });
    q[k] = value;
  });
  if (!Object.keys(q).length) throw Object.assign(new Error('Give a vehicle, order or challan number.'), { code: 'bad_request' });
  return q;
}

function createStatusProvider(cfg, deps) {
  const fetchImpl = (deps && deps.fetch) || fetch;
  const configured = !!cfg.url;

  async function lookup(query) {
    const q = normalise(query);
    if (!configured) {
      return { available: false, query: q, reason: 'Live status lookup is not connected yet. It needs GaadiInfo\'s internal order-status service (the one the WhatsApp bot uses).' };
    }
    const url = cfg.url
      .replace('{vehicle}', encodeURIComponent(q.vehicle || ''))
      .replace('{order}', encodeURIComponent(q.order || ''))
      .replace('{challan}', encodeURIComponent(q.challan || ''));
    const headers = { Accept: 'application/json' };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await fetchImpl(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      return { available: false, query: q, reason: `The status service returned HTTP ${res.status}.` };
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { text: text.slice(0, 2000) }; }
    return { available: true, query: q, fetchedAt: new Date().toISOString(), source: new URL(url).host, data };
  }

  return { configured, lookup };
}

module.exports = { createStatusProvider, normalise };
