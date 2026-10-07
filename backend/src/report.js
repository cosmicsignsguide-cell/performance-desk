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
import * as meta from './fetchers/meta.js';

const DAYS = 95;                 // enough for this month, last month, and a 90-day trend
const newToken = () => crypto.randomBytes(24).toString('base64url');   // 192 bits

// Only these fields ever leave the building. Everything else on a daily row stays internal.
const PUBLIC_FIELDS = [
  'spend', 'impressions', 'clicks', 'purchases', 'revenue', 'leads',
  'orders', 'netSales', 'refunds', 'units', 'newCustomerOrders', 'checkoutsStarted',
  'sessions',
];

// ---------------------------------------------------------------------------
// Campaign and ad names are written for the agency, not the client:
//   "PG | Firvt | MOF | Catgory Wise - Catalog | 03-09-26"
// Shown as-is that reads as amateur, and it hands over the whole internal naming
// system, funnel structure and testing cadence to anyone the client forwards it to.
// So the cleaning happens HERE, on the server, and the raw name never enters the
// payload at all. Funnel codes become words a client already understands.
const FUNNEL = { TOF:'Prospecting', TOFU:'Prospecting', COLD:'Prospecting',
                 MOF:'Consideration', MOFU:'Consideration', WARM:'Consideration',
                 BOF:'Retargeting', BOFU:'Retargeting', RT:'Retargeting', RTG:'Retargeting', RMK:'Retargeting' };
// Buying structures, test markers and agency shorthand. None of it means anything to a client.
const NOISE = new Set(['ABO','CBO','ASC','ADV','AAA','DPA','DABA','LAL','LLA','FT','BAU','DCT','CT','PG','P4G',
                       'TEST','TESTING','COPY','NEW','OLD','FINAL','DRAFT','V1','V2','V3','V4','A','B','C']);
const DATEY = /^\d{1,2}[-/.]\d{1,2}([-/.]\d{2,4})?$/;
const MONTHY = /^\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{0,4}$/i;

function titleish(t) {
  // Shouty tokens get title case; anything already mixed case is left exactly as written.
  if (!/[a-z]/.test(t) && t.length > 3) return t.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
  return t;
}

// Creative-team incentive tagging: the creator adds their initials as the LAST pipe segment
// of the ad name, e.g. "PG | Firvt | MOF | Girl Boxers | Reels | 19-09-25 | MK". Checked on the
// final segment only, never a middle one, so an ordinary two-letter word elsewhere in the name
// is never mistaken for a tag. A segment that is already a known funnel or noise code, or a
// date, is never read as one either, so "...| V2" or "...| 19-09-25" cannot collide with it.
const CREATOR_TAG_RE = /^[A-Za-z]{2,4}$/;
export function extractCreatorTag(raw) {
  const src = String(raw || '').trim();
  const parts = src.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1];
  if (!CREATOR_TAG_RE.test(last)) return '';
  const u = last.toUpperCase();
  if (FUNNEL[u] || NOISE.has(u)) return '';
  if (DATEY.test(last) || MONTHY.test(last)) return '';
  return u;
}

export function cleanName(raw, clientName, kind) {
  // Pipes are the usual separator, but underscores are just as common and leak the same way,
  // so fall back to them before giving up and treating the name as one opaque string.
  const src = String(raw || '').trim();
  const creatorTag = extractCreatorTag(src);
  let parts = src.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  // The creator tag is an internal, agency-side detail (who gets credit for this creative), not
  // something the client ordered or should ever see on their own report. Drop it here, before
  // any of the noise filtering below, so it never has a chance to survive as if it were content.
  if (creatorTag && parts.length > 1) parts = parts.slice(0, -1);
  if (parts.length < 2) parts = src.split(/\s*_\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) parts = src.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);  // spaced dash only, so "Anti-Tarnish" survives
  const list = parts.length > 1 ? parts : [src];
  const client = String(clientName || '').toLowerCase();
  let stage = '';
  const keep = [];
  for (let t of list) {
    t = t.replace(/[\s-]*\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b\s*$/, '').trim();   // trailing glued date
    if (!t) continue;
    const u = t.toUpperCase();
    if (FUNNEL[u]) { stage = stage || FUNNEL[u]; continue; }
    if (NOISE.has(u)) continue;
    if (DATEY.test(t) || MONTHY.test(t)) continue;
    if (/^[\d\s-]+$/.test(t)) continue;                       // pure numbers
    if (t.toLowerCase() === client) continue;                 // the client's own name
    keep.push(titleish(t.replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ')));
  }
  // Last line of defence. Whatever the separator was, a name that still carries the client's
  // own name or a bare funnel code gets it stripped here, because this string is about to be
  // shown to that client and there is no second chance to catch it.
  let body = keep.join(' ').trim();
  if (client) body = body.replace(new RegExp('\\b' + client.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig'), '').trim();
  body = body.replace(/\b(TOFU?|MOFU?|BOFU?|ABO|CBO|RTG?)\b/gi, (m2) => { stage = stage || FUNNEL[m2.toUpperCase()] || ''; return ''; });
  body = body.replace(/\s{2,}/g, ' ').replace(/^[\s·,-]+|[\s·,-]+$/g, '').trim();
  if (stage && body) return `${stage} · ${body}`;
  if (stage) return stage;
  if (body) return body;
  return kind === 'ad' ? 'Creative' : 'Campaign';
}

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

// A playable URL for one of this client's video creatives.
//
// Two checks before Meta is ever called, because this route is reachable by anyone holding a
// report link: the token must resolve to a client, and the ad id must belong to THAT client's
// own entity tree. Without the second check a client with a valid link could read any ad id off
// another client's account by guessing, which is the same cross-client leak the payload
// allow-list exists to prevent. An id that is not in the tree is treated as not found.
export async function videoUrlFor(store, clientId, adId) {
  if (!clientId || !/^\d{5,25}$/.test(String(adId || ''))) return '';
  const ent = await store.get('entities', clientId);
  const ad = (ent?.ads || []).find((a) => String(a.id) === String(adId));
  if (!ad || !ad.videoId) return '';
  return meta.videoSource(ad.videoId);
}

// Same two checks as videoUrlFor, then Meta's own preview player instead of the raw file.
export async function videoPreviewFor(store, clientId, adId) {
  if (!clientId || !/^\d{5,25}$/.test(String(adId || ''))) return '';
  const ent = await store.get('entities', clientId);
  const ad = (ent?.ads || []).find((a) => String(a.id) === String(adId));
  if (!ad) return '';
  return meta.adPreviewSrc(ad.id);
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

  // Top performers. These come off the entity tree, which the sync rebuilds over a rolling
  // 30-day window, so they are ALWAYS last-30-days regardless of which period the reader has
  // selected. The page labels them that way rather than quietly letting them mean something
  // different per tab.
  const ent = (await store.get('entities', clientId)) || {};
  const isE = c.type !== 'lead';
  const score = (x) => (isE ? (x.revenue || 0) : (x.leads || 0));
  const roasOf = (x) => (x.spend ? round((x.revenue || 0) / x.spend, 2) : 0);
  const cplOf = (x) => (x.leads ? round(x.spend / x.leads, 2) : null);
  const top = (arr, n) => (arr || []).filter((x) => x && x.spend > 0)
    .sort((a, b) => score(b) - score(a) || (b.spend || 0) - (a.spend || 0)).slice(0, n);

  const campaigns = top(ent.campaigns, 5).map((x) => ({
    name: cleanName(x.name, c.name, 'campaign'),
    platform: x.platform === 'google' ? 'Google' : 'Meta',
    spend: round(x.spend), purchases: x.purchases || 0, leads: x.leads || 0,
    revenue: round(x.revenue || 0), roas: roasOf(x), cpl: cplOf(x),
  }));

  // Creatives carry a filter on the page, so enough of them are sent to filter through: the
  // spending ones the client came to see, and the paused and never-run ones behind a chip. Still
  // ranked by what each brought back, so the head of the list is the same whichever chip is on.
  const creatives = (ent.ads || []).slice()
    .sort((a, b) => score(b) - score(a) || (b.spend || 0) - (a.spend || 0))
    .slice(0, 40)
    .map((x) => ({
      id: x.id,
      name: cleanName(x.name, c.name, 'ad'),
      format: x.format || (x.isVideo ? 'Video' : 'Static'),
      // ACTIVE, PAUSED, DISAPPROVED and so on, lowercased. The page groups these into the three
      // states a client cares about rather than showing Meta's vocabulary.
      status: String(x.status || '').toLowerCase(),
      isVideo: !!x.isVideo,
      // Whether a play button should appear. The playable file is fetched through this server
      // when the client presses play, so no Meta token is ever put on the page.
      hasVideo: !!(x.isVideo && x.videoId),
      // fbcdn thumbnail links are signed and expire, so the page must survive a dead image.
      // They are refreshed on every sync, which is one more reason the schedules matter.
      thumb: x.thumb || '',
      spend: round(x.spend || 0), purchases: x.purchases || 0, leads: x.leads || 0,
      revenue: round(x.revenue || 0), roas: roasOf(x), cpl: cplOf(x),
      ctr: x.ctr || 0,
    }));

  const products = (ent.products || []).slice()
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 5)
    .map((p) => ({ title: p.title || 'Product', revenue: round(p.revenue || 0), units: p.units || 0, orders: p.orders || 0, image: p.image || '', price: round(p.price || 0) }));

  // Budget and target now go to the client, by decision: they are what was agreed, so the client
  // is entitled to see the month measured against them. Both are sent only when they are actually
  // set on the client record. An unset target used to fall back to 3x, which put an invented
  // number on a page the client reads as a commitment; nothing is invented here, and the page
  // says "not set" rather than guessing. The AM and the internal slug still stay out.
  const target = c.type === 'lead' ? (c.target?.cpl ?? null) : (c.target?.roas ?? null);
  return {
    top: { window: 'last 30 days', campaigns, creatives, products },
    agency: process.env.DESK_AGENCY_NAME || 'Per4mance Guru',
    agencySite: process.env.DESK_AGENCY_SITE || 'https://per4mance.guru',
    // contact is the client's own person, so it belongs to them; am stays out, it is ours.
    client: {
      name: c.name, currency: c.currency || 'INR', type: c.type === 'lead' ? 'lead' : 'ecom',
      contact: c.contact || '',
      budget: Number(c.budget) > 0 ? Number(c.budget) : null,
      target: Number(target) > 0 ? Number(target) : null,
    },
    today,
    generatedAt: nowIso(),
    daily,
  };
}
