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
