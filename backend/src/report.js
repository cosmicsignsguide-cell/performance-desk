// Client-facing report: one unguessable link per client, served by this API.
//
// The security model, stated plainly because the whole design rests on it:
//   * the token IS the credential, so it is long, random, and never committed to the repo
//   * a token maps to exactly ONE client, so a leaked link exposes that client and no other.
//     Per4mance Guru runs competing brands side by side (four K.R. Mangalam schools, several
//     kids-innerwear D2C brands), so cross-client leakage is the one failure that would cost
//     real accounts. Scoping happens here, on the server, not in the page.
//   * the browser never talks to Firestore, so there are no database credentials in the page
//     and nothing for a curious client to re-point at someone else's id
//   * the payload is built by an allow-list below. A new internal field added to a daily row
//     later does not silently start appearing in a client's report.

import crypto from 'node:crypto';
import { addDays, nowIso, round, todayStr } from './util.js';

const DAYS = 95;                 // enough for this month, last month, and a 90-day trend
const newToken = () => crypto.randomBytes(24).toString('base64url');   // 192 bits

// Only these fields ever leave the building. Everything else on a daily row stays internal.
const PUBLIC_FIELDS = [
  'spend', 'impressions', 'clicks', 'purchases', 'revenue', 'leads',
  'orders', 'netSales', 'refunds', 'units', 'newCustomerOrders', 'checkoutsStarted',
  'sessions',
];

// One report doc per client, keyed by the token itself so a lookup is a single get().
export async function ensureReportTokens(store, clients) {
  const existing = await store.list('reports');
  const byClient = new Map(existing.map((r) => [r.clientId, r]));
  let made = 0;
  for (const c of clients) {
    if (c.report === false) continue;
    if (byClient.has(c.id)) continue;
    await store.set('reports', newToken(), { clientId: c.id, enabled: true, createdAt: nowIso() });
    made += 1;
  }
  return made;
}

// Replace a client's link. The old token stops working the moment this returns.
export async function rotateReportToken(store, clientId) {
  const existing = await store.list('reports', [['clientId', '==', clientId]]);
  for (const r of existing) await store.set('reports', r.id, { ...r, enabled: false, revokedAt: nowIso() });
  const token = newToken();
  await store.set('reports', token, { clientId, enabled: true, createdAt: nowIso() });
  return token;
}

// The token sits in the URL fragment, after the #. A fragment is never sent to any server, so
// it stays out of the static host's access logs and out of the Referer header if the client
// clicks a link from the report. The page reads it with location.hash and asks the API itself.
export const reportUrl = (base, token) => `${String(base).replace(/\/$/, '')}/report.html#${token}`;

export async function listLinks(store, clients, base) {
  const rows = await store.list('reports');
  const live = rows.filter((r) => r.enabled !== false);
  return clients.map((c) => {
    const r = live.find((x) => x.clientId === c.id);
    return { id: c.id, name: c.name, url: r ? reportUrl(base, r.id) : null };
  });
}

export async function resolveToken(store, token) {
  if (!token || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) return null;      // shape check before any read
  const row = await store.get('reports', token);
  if (!row || row.enabled === false || !row.clientId) return null;
  return row.clientId;
}

export async function reportPayload(store, clientId) {
  const c = await store.get('clients', clientId);
  if (!c || c.active === false) return null;
  const today = todayStr();
  const since = addDays(today, -(DAYS - 1));
  const rows = await store.list('daily', [['clientId', '==', clientId]]);

  const daily = rows
    .filter((r) => r.date >= since && r.date <= today && !r.sample)
    .map((r) => {
      const out = { date: r.date, platform: r.platform };
      for (const k of PUBLIC_FIELDS) if (r[k]) out[k] = round(r[k]);
      return out;
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // The client's own name for themselves, never the internal slug, and never the AM, the
  // budget or the target: those are the agency's side of the relationship, not the client's.
  return {
    agency: process.env.DESK_AGENCY_NAME || 'Per4mance Guru',
    agencySite: process.env.DESK_AGENCY_SITE || 'https://per4mance.guru',
    client: { name: c.name, currency: c.currency || 'INR', type: c.type === 'lead' ? 'lead' : 'ecom' },
    today,
    generatedAt: nowIso(),
    daily,
  };
}
