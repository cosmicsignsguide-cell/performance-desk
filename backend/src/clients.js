// Client registry. Source of truth is the `clients` collection in the store.
// `clients.json` next to the backend is the way to add or edit clients from the repo:
// every run upserts it into the store, so editing the file + redeploy = new client live.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { log, nowIso } from './util.js';

const FILE = path.resolve(process.env.DESK_CLIENTS_FILE || './clients.json');

// Says out loud what it found. The bare `catch { return [] }` this replaces made a missing file,
// a file sitting in the wrong folder and a file with a stray comma all look exactly like "no
// clients to add", and the run carried on as if nothing had happened. That silence cost two
// rounds of guessing at why 41 clients in the repo were still showing up as 2 on the server.
export function readClientsFile() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    log(`clients.json NOT FOUND at ${FILE} (${e.code || e.message}). Nothing will be added or updated from the file.`);
    return [];
  }
  try {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) { log(`clients.json at ${FILE} is not a JSON array, ignoring it`); return []; }
    log(`clients.json: read ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} from ${FILE}`);
    return rows;
  } catch (e) {
    log(`clients.json at ${FILE} is not valid JSON (${e.message}). Fix the file; nothing was added or updated.`);
    return [];
  }
}

export function normalizeClient(c) {
  const id = String(c.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!id) throw new Error('client needs an id');
  // Three kinds of account. 'app' is for install campaigns, where the outcome Meta reports is an
  // install rather than a purchase or a lead, so it is priced per install.
  const type = c.type === 'lead' ? 'lead' : c.type === 'app' ? 'app' : 'ecom';
  return {
    id,
    name: c.name || id,
    type,
    active: c.active !== false,
    currency: c.currency || 'INR',
    budget: Number(c.budget) || 0,               // monthly ads budget across platforms
    // An unset target is null, not a stand-in. It used to default to 3x ROAS or 500 CPL, which
    // read everywhere as a number the client had agreed to: the desk raised "KPI miss" against
    // it and, now that the target is shown on the client's own report, it would have appeared
    // there as a commitment nobody made. A target has to be entered to exist.
    target: type === 'ecom'
      ? { roas: Number(c.target?.roas) > 0 ? Number(c.target.roas) : null }
      : type === 'app'
        ? { cpi: Number(c.target?.cpi) > 0 ? Number(c.target.cpi) : null }
        : { cpl: Number(c.target?.cpl) > 0 ? Number(c.target.cpl) : null },
    am: c.am || '',
    contact: c.contact || '',                     // the client's own person, greeted on their report
    accounts: {
      meta: c.accounts?.meta ? String(c.accounts.meta).replace(/^act_/, '') : '',
      google: c.accounts?.google ? String(c.accounts.google).replace(/-/g, '') : '',
      shopify: c.accounts?.shopify ? {
        shop: String(c.accounts.shopify.shop || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
        tokenEnv: c.accounts.shopify.tokenEnv || '',
      } : null,
      ga4: c.accounts?.ga4 ? String(c.accounts.ga4) : '',
    },
    site: {
      url: c.site?.url || (c.accounts?.shopify?.shop ? `https://${c.accounts.shopify.shop}` : ''),
      productPath: c.site?.productPath || '',      // optional: /products/handle to test add to cart on
      leadFormPath: c.site?.leadFormPath || '',    // lead-gen: landing page path that must show a form
      expectText: c.site?.expectText || '',        // optional: text that must be on the homepage
    },
    sample: c.sample !== false && !c.accounts?.meta && !c.accounts?.google && !c.accounts?.shopify,  // no accounts at all = pure sample client
    updatedAt: nowIso(),
  };
}

export async function syncClientsFromFile() {
  const rows = readClientsFile();
  if (!rows.length) return [];
  const store = await db();
  const out = [];
  for (const raw of rows) {
    const c = normalizeClient(raw);
    await store.merge('clients', c.id, c);
    out.push(c);
  }
  log(`clients: upserted ${out.length} from clients.json`);
  return out;
}

export async function loadClients() {
  const store = await db();
  const rows = await store.list('clients');
  return rows.filter((c) => c.active !== false).map((c) => ({ ...c, id: c.id }));
}
