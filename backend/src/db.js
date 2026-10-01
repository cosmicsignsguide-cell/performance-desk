// Storage layer. With FIREBASE_SERVICE_ACCOUNT_JSON set it writes to Firestore.
// Without it, it writes JSON files under DESK_DATA_DIR so the whole pipeline can be
// run and inspected on a laptop before any cloud setup.
//
// Collections (the data contract the dashboard reads):
//   clients/{clientId}                       config for one client
//   daily/{clientId}_{yyyy-mm-dd}_{platform} one row per client per day per source
//   entities/{clientId}                      campaigns, ad sets, ads, products (last 30 days)
//   sitewatch/{clientId}                     latest site check + short history
//   syncs/{clientId}                         per-source sync status
//   alerts/{autoId}                          alert log (what was sent where)
//   signals/{clientId}                       computed leakage signals with baselines

import fs from 'node:fs';
import path from 'node:path';
import { config, has } from './config.js';

let impl = null;

// Set DESK_COLLECTION_PREFIX (for example "pd_") when this shares a Firebase project with another
// app, so `clients` becomes `pd_clients` and nothing collides. The dashboard reads the same value
// from frontend/config.js as `collectionPrefix`. Leave it unset on a project of its own.
export const PREFIX = process.env.DESK_COLLECTION_PREFIX || '';
const C = (col) => PREFIX + col;

async function firestoreImpl() {
  const admin = (await import('firebase-admin')).default;
  const sa = JSON.parse(config.firebase.serviceAccountJson);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: config.firebase.projectId || sa.project_id });
  }
  const fs_ = admin.firestore();
  fs_.settings({ ignoreUndefinedProperties: true });
  return {
    kind: 'firestore',
    prefix: PREFIX,
    async set(col, id, data) { await fs_.collection(C(col)).doc(id).set(data, { merge: false }); },
    async merge(col, id, data) { await fs_.collection(C(col)).doc(id).set(data, { merge: true }); },
    async get(col, id) { const s = await fs_.collection(C(col)).doc(id).get(); return s.exists ? s.data() : null; },
    async add(col, data) { const r = await fs_.collection(C(col)).add(data); return r.id; },
    // A filter key of '__id__' means the document id. It matters because Firestore charges per
    // document read, and an equality on one field plus a range on another needs a composite index
    // that has to be created by hand before the query will run at all. A range on the id alone
    // needs no index, so callers whose ids carry the thing they want to range over (daily rows are
    // `${clientId}_${date}_${platform}`) can narrow server side instead of reading the whole
    // history and throwing most of it away in JavaScript.
    async list(col, filter, opts = {}) {
      let q = fs_.collection(C(col));
      const ID = admin.firestore.FieldPath.documentId();
      if (filter) for (const [k, op, v] of filter) q = q.where(k === '__id__' ? ID : k, op, v);
      if (opts.limit) q = q.limit(opts.limit);
      const s = await q.get();
      return s.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async batchSet(col, rows) {  // rows: [{id, data}]
      for (let i = 0; i < rows.length; i += 400) {
        const b = fs_.batch();
        rows.slice(i, i + 400).forEach(({ id, data }) => b.set(fs_.collection(C(col)).doc(id), data, { merge: true }));
        await b.commit();
      }
    },
  };
}

function fileImpl() {
  const root = path.resolve(config.dataDir);
  const file = (col) => path.join(root, `${col}.json`);
  const read = (col) => { try { return JSON.parse(fs.readFileSync(file(col), 'utf8')); } catch { return {}; } };
  const write = (col, obj) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file(col), JSON.stringify(obj, null, 1)); };
  const matches = (row, filter) => !filter || filter.every(([k, op, v]) => {
    const x = k === '__id__' ? row.id : row[k];
    switch (op) { case '==': return x === v; case '>=': return x >= v; case '<=': return x <= v; case '>': return x > v; case '<': return x < v; case 'in': return v.includes(x); default: return true; }
  });
  return {
    kind: 'file',
    root,
    async set(col, id, data) { const o = read(col); o[id] = data; write(col, o); },
    async merge(col, id, data) { const o = read(col); o[id] = { ...(o[id] || {}), ...data }; write(col, o); },
    async get(col, id) { return read(col)[id] || null; },
    async add(col, data) { const o = read(col); const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; o[id] = data; write(col, o); return id; },
    async list(col, filter, opts = {}) {
      const rows = Object.entries(read(col)).map(([id, d]) => ({ id, ...d })).filter((r) => matches(r, filter)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return opts.limit ? rows.slice(0, opts.limit) : rows;
    },
    async batchSet(col, rows) { const o = read(col); rows.forEach(({ id, data }) => { o[id] = { ...(o[id] || {}), ...data }; }); write(col, o); },
  };
}

export async function db() {
  if (impl) return impl;
  impl = has('firebase') ? await firestoreImpl() : fileImpl();
  return impl;
}

export const dailyId = (clientId, date, platform) => `${clientId}_${date}_${platform}`;

// A document id filter covering one client's daily rows between two dates, inclusive. Safe because
// the id is `${clientId}_${date}_${platform}`, the date is fixed width ISO so sorting it as text
// sorts it as time, and the separator is '_'. Client ids that are prefixes of other client ids
// (mackly and mackly-active, whimsy and whimsy-2) stay apart because the longer ones continue with
// '-', which sorts below '_' and below every digit, so they fall outside the shorter one's range.
export const dailyIdRange = (clientId, since, until) => [
  ['__id__', '>=', `${clientId}_${since}`],
  ['__id__', '<=', `${clientId}_${until}_`],
];
