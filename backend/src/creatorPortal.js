// Creator Portal: the self-serve side of the incentive scorecard. A creative team member logs
// in with their own Google account, uploads what they made, and gets back a short code to paste
// into the ad's name in Meta Ads Manager once it goes live. computeCreatorScores() (creators.js)
// is what actually notices the code on a real ad and flips the upload from "pending" to "linked";
// this module only creates the upload record and reads it back.
//
// Needs FIREBASE_SERVICE_ACCOUNT_JSON (already required for Firestore) on a project with
// Cloud Storage turned on. Storage now requires the Blaze (pay-as-you-go) plan even at zero
// real usage — that is a one-time console step, not a code change, and uploads fail with a
// clear message until it is done.

import { has, config } from './config.js';
import { nowIso, log } from './util.js';

// Visually unambiguous: no 0/O, 1/I/L, so a code is easy to read back off a phone screen and
// retype into Ads Manager without a mistake.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 4;

function randomCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `C-${s}`;
}

async function genCode(store) {
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    if (!(await store.get('creatorUploads', code))) return code;
  }
  throw new Error('could not mint a unique code, try again');
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;   // 20MB: a provenance record, not master storage

let bucketCache = null;
// Newer Firebase projects (created after Oct 2024) default to a
// "<project>.firebasestorage.app" bucket; older ones use "<project>.appspot.com".
// Rather than guess one and fail, try the real candidates and use whichever one
// actually exists -- that way this keeps working whichever convention this project
// got assigned, with no manual bucket-name lookup needed.
async function bucket() {
  if (bucketCache) return bucketCache;
  if (!has('firebase')) throw new Error('Firebase is not configured on this server (FIREBASE_SERVICE_ACCOUNT_JSON missing)');
  const admin = (await import('firebase-admin')).default;
  const sa = JSON.parse(config.firebase.serviceAccountJson);
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa), projectId: config.firebase.projectId || sa.project_id });
  const projectId = config.firebase.projectId || sa.project_id;
  const candidates = process.env.DESK_STORAGE_BUCKET
    ? [process.env.DESK_STORAGE_BUCKET]
    : [`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`];
  const storage = admin.storage();
  for (const name of candidates) {
    try {
      const b = storage.bucket(name);
      const [exists] = await b.exists();
      if (exists) { bucketCache = b; return b; }
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    `No Firebase Storage bucket found for project "${projectId}" (tried: ${candidates.join(', ')}). ` +
    `In the Firebase console, go to Build -> Storage and click "Get started" to create the default bucket ` +
    `(this requires turning on the Blaze pay-as-you-go plan, even though real usage will stay near $0).`
  );
}

function safeName(name) {
  return String(name || 'upload').replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80);
}

export async function createUpload(store, { creatorEmail, creatorName, clientId, clientName, format, note, fileBuffer, fileName, contentType }) {
  if (!creatorEmail) throw new Error('not signed in');
  if (!clientId) throw new Error('client is required');
  if (fileBuffer && fileBuffer.length > MAX_FILE_BYTES) throw new Error(`file is too big (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB)`);

  const code = await genCode(store);
  let storagePath = '';
  if (fileBuffer && fileBuffer.length) {
    const b = await bucket();
    storagePath = `creator-uploads/${code}/${safeName(fileName)}`;
    const file = b.file(storagePath);
    await file.save(fileBuffer, { contentType: contentType || 'application/octet-stream', resumable: false });
  }

  const doc = {
    code, creatorEmail, creatorName: creatorName || creatorEmail,
    clientId, clientName: clientName || clientId,
    format: format || 'Static', note: String(note || '').slice(0, 300),
    storagePath, fileName: fileName || '', contentType: contentType || '',
    status: 'pending', createdAt: nowIso(),
  };
  await store.set('creatorUploads', code, doc);
  log(`creator-portal: ${creatorEmail} uploaded ${code} for ${clientId} (${format})`);
  return doc;
}

// A signed URL minted at read time, same pattern as meta.js does for Meta's own video sources:
// nothing long-lived is stored, so a doc copied or logged somewhere does not leak a permanent link.
async function signedUrlFor(storagePath) {
  if (!storagePath) return '';
  try {
    const b = await bucket();
    const [url] = await b.file(storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
    return url;
  } catch (e) {
    log(`creator-portal: could not sign url for ${storagePath} (${String(e.message || e).slice(0, 120)})`);
    return '';
  }
}

// This creator's own uploads, newest first, each with a fresh preview URL and — once linked —
// the live numbers for the ad it became, read straight off the same entity tree the admin
// scorecard uses, so a creator sees the exact same CTR the incentive math is scoring them on.
export async function listMine(store, creatorEmail) {
  const rows = await store.list('creatorUploads', [['creatorEmail', '==', creatorEmail]]);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const entCache = new Map();
  const out = [];
  for (const u of rows) {
    const row = { ...u, previewUrl: await signedUrlFor(u.storagePath) };
    if (u.status === 'linked' && u.linkedClientId) {
      if (!entCache.has(u.linkedClientId)) entCache.set(u.linkedClientId, await store.get('entities', u.linkedClientId));
      const ent = entCache.get(u.linkedClientId);
      const ad = (ent?.ads || []).find((a) => String(a.id) === String(u.linkedAdId));
      if (ad) row.live = { status: ad.status || '', spend: ad.spend || 0, impressions: ad.impressions || 0, ctr: ad.ctr || 0, purchases: ad.purchases || 0, revenue: ad.revenue || 0 };
    }
    out.push(row);
  }
  return out;
}

// The team's own calendar day, not the server's: this agency works out of Delhi, and a raw
// UTC cutoff would roll today's race over at 5:30am IST instead of midnight.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export function istDateStr(d) { return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10); }
export function istToday() { return istDateStr(new Date()); }

// The live competition board: raw submission counts for today across the whole team, ranked
// highest first. Deliberately separate from the weekly effectiveness scorecard in creators.js
// (admin-only, fairness-adjusted, computed once a day) -- this is the number that moves while
// people are actually working, the one that makes the race visible in real time.
export async function listToday(store) {
  const rows = await store.list('creatorUploads');
  const today = istToday();
  const byCreator = new Map();
  for (const u of rows) {
    const t = new Date(u.createdAt);
    if (isNaN(t) || istDateStr(t) !== today) continue;
    const key = u.creatorEmail;
    if (!byCreator.has(key)) byCreator.set(key, { creatorEmail: u.creatorEmail, creatorName: u.creatorName || u.creatorEmail, count: 0, items: [] });
    const entry = byCreator.get(key);
    entry.count++;
    // The whole point of the race is that it is checkable -- a number alone invites "says who,"
    // so each creator's row carries what they actually submitted today, not just the tally.
    entry.items.push({ code: u.code, clientName: u.clientName, format: u.format, note: u.note || '', status: u.status, createdAt: u.createdAt });
  }
  const list = [...byCreator.values()];
  for (const c of list) c.items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return list.sort((a, b) => b.count - a.count || a.creatorName.localeCompare(b.creatorName));
}
