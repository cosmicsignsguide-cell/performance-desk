// Product categories from the client's own naming (clients.json "categories": [[name, [keywords]]]).
// First match wins, so a narrower category ("Recliner") is listed before a wider one ("Sofa covers").
// Used to put Shopify line items and Google Shopping/PMax product rows into the same buckets the
// dashboard uses for Meta spend by ad names.
export const UNTAGGED = 'Untagged / mixed';
const norm = (t) => ' ' + String(t || '').toLowerCase().replace(/[_|\-\/.:+,#()[\]]+/g, ' ').replace(/\s+/g, ' ') + ' ';
export function catOf(client, ...texts) {
  const cats = client.categories || [];
  for (const t of texts) {
    if (!t) continue;
    const n = norm(t);
    for (const [name, kws] of cats) if ((kws || []).some((k) => n.includes(String(k).toLowerCase()))) return name;
  }
  return null;
}

// The catch-all category is the last one in the client's list ("Other home & storage" for Hokipo).
// Untagged and the catch-all carry an item breakdown (catd) on each day row, so the dashboard can
// show what sits inside them. Kept to the top items per day so the rows stay small.
export const otherCat = (client) => { const c = client.categories || []; return c.length ? c[c.length - 1][0] : null; };
export function addDetail(det, client, cat, label, v) {
  if (cat !== UNTAGGED && cat !== otherCat(client)) return;
  const o = (det[cat] = det[cat] || {}); const k = String(label || '(no name)').slice(0, 90); o[k] = (o[k] || 0) + v;
}
export function trimDetail(det, n = 12) {
  const out = {};
  for (const [cat, m] of Object.entries(det || {})) {
    const top = Object.entries(m).filter(([, v]) => (Array.isArray(v) ? v[1] : v) > 0).sort((a, b) => (Array.isArray(b[1]) ? b[1][1] : b[1]) - (Array.isArray(a[1]) ? a[1][1] : a[1])).slice(0, n);
    out[cat] = Object.fromEntries(top.map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => Math.round(x)) : Math.round(v)]));
  }
  return out;
}
