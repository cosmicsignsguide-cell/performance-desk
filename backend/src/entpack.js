// Creatives trees (entities/{clientId}) are packed when they are big, so nothing has to be cut to
// fit Firestore's 1 MB document limit. Berkowits' tree is ~940 KB of JSON and was losing almost
// all of its ad day-by-day history to the trim. Gzipped it is a fraction of that.
//
// Packed shape: { packed: 1, enc: 'gzip-b64', kb, zkb, parts, z: [chunk, ...] } plus a few small
// fields copied as-is (clientId, updatedAt, entitiesAt, since, until) so cheap reads still see them.
// When the chunks together pass ~850 KB they move to entchunks/{clientId}_{i} and the doc keeps
// only the count. The dashboard unpacks the same shape in the browser (DecompressionStream).
import zlib from 'node:zlib';

const PACK_OVER_KB = 300;          // small trees stay plain, readable as before
const CHUNK = 700 * 1024;          // characters per base64 chunk
const INLINE_MAX = 850 * 1024;     // all chunks inside the doc up to this size
const KEEP = ['clientId', 'updatedAt', 'entitiesAt', 'since', 'until', 'sample'];

export function packedKb(ent) {
  return Math.round(zlib.gzipSync(Buffer.from(JSON.stringify(ent)), { level: 9 }).length * 4 / 3 / 1024);
}

export function wrapStore(store) {
  const base = { get: store.get.bind(store), set: store.set.bind(store), list: store.list.bind(store) };
  const unpack = async (id, doc) => {
    if (!doc || !doc.packed) return doc;
    let parts = Array.isArray(doc.z) ? doc.z : null;
    if (!parts) { parts = []; for (let i = 0; i < (doc.parts || 0); i++) { const p = await base.get('entchunks', `${id}_${i}`); parts.push(p ? p.z : ''); } }
    return JSON.parse(zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8'));
  };
  store.get = async (col, id) => { const d = await base.get(col, id); return col === 'entities' ? unpack(id, d) : d; };
  store.list = async (col, filter, opts) => { const rows = await base.list(col, filter, opts); return col === 'entities' ? Promise.all(rows.map(async (r) => ({ id: r.id, ...(await unpack(r.id, r)) }))) : rows; };
  store.set = async (col, id, data) => {
    if (col !== 'entities' || !data) return base.set(col, id, data);
    const json = JSON.stringify(data), kb = Math.round(Buffer.byteLength(json) / 1024);
    if (kb <= PACK_OVER_KB) return base.set(col, id, data);
    const b64 = zlib.gzipSync(Buffer.from(json), { level: 9 }).toString('base64');
    const chunks = []; for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
    const head = Object.fromEntries(KEEP.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
    const meta = { ...head, packed: 1, enc: 'gzip-b64', kb, zkb: Math.round(b64.length / 1024), parts: chunks.length };
    if (b64.length <= INLINE_MAX) return base.set(col, id, { ...meta, z: chunks });
    for (let i = 0; i < chunks.length; i++) await base.set('entchunks', `${id}_${i}`, { clientId: data.clientId || id, i, z: chunks[i] });
    return base.set(col, id, meta);
  };
  return store;
}
