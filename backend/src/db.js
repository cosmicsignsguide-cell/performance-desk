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
    async list(col, filter) {
      let q = fs_.collection(C(col));
      if (filter) for (const [k, op, v] of filter) q = q.where(k, op, v);
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
    const x = row[k];
    switch (op) { case '==': return x === v; case '>=': return x >= v; case '<=': return x <= v; case '>': return x > v; case '<': return x < v; case 'in': return v.includes(x); default: return true; }
  });
  return {
    kind: 'file',
    root,
    async set(col, id, data) { const o = read(col); o[id] = data; write(col, o); },
    async merge(col, id, data) { const o = read(col); o[id] = { ...(o[id] || {}), ...data }; write(col, o); },
    async get(col, id) { return read(col)[id] || null; },
    async add(col, data) { const o = read(col); const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; o[id] = data; write(col, o); return id; },
    async list(col, filter) { return Object.entries(read(col)).map(([id, d]) => ({ id, ...d })).filter((r) => matches(r, filter)); },
    async batchSet(col, rows) { const o = read(col); rows.forEach(({ id, data }) => { o[id] = { ...(o[id] || {}), ...data }; }); write(col, o); },
  };
}

export async function db() {
  if (impl) return impl;
  impl = has('firebase') ? await firestoreImpl() : fileImpl();
  return impl;
}

export const dailyId = (clientId, date, platform) => `${clientId}_${date}_${platform}`;
