// Client registry. Source of truth is the `clients` collection in the store.
// `clients.json` next to the backend is the way to add or edit clients from the repo:
// every run upserts it into the store, so editing the file + redeploy = new client live.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { log, nowIso } from './util.js';

const FILE = path.resolve(process.env.DESK_CLIENTS_FILE || './clients.json');

export function readClientsFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

export function normalizeClient(c) {
  const id = String(c.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!id) throw new Error('client needs an id');
  const type = c.type === 'lead' ? 'lead' : 'ecom';
  return {
    id,
    name: c.name || id,
    type,
    active: c.active !== false,
    currency: c.currency || 'INR',
    budget: Number(c.budget) || 0,               // monthly ads budget across platforms
    target: type === 'ecom' ? { roas: Number(c.target?.roas) || 3 } : { cpl: Number(c.target?.cpl) || 500 },
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
