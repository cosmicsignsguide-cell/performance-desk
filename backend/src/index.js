// Entry point. Run as:  node src/index.js <command>
//   daily [N]    full sync: last DESK_RESTATE_DAYS days re-pulled (first run: DESK_HISTORY_DAYS), entities, products, signals
//                N re-pulls that many days instead, for a one-off backfill (also /run?mode=daily&days=N)
//   hourly       today + yesterday only, then signals
//   sitewatch    synthetic site checks for every client with a site url
//   seed         write the two sample clients and their sample data (dashboard works before any token exists)
//   test-tokens  call each configured API once per client and print what came back
//   status       print sync status per client

import { config, has, shopifyTokenFor } from './config.js';
import { db, dailyId, dailyIdRange } from './db.js';
import { syncClientsFromFile, loadClients, normalizeClient } from './clients.js';
import { todayStr, addDays, log, nowIso } from './util.js';
import * as meta from './fetchers/meta.js';
import * as google from './fetchers/google.js';
import * as shopify from './fetchers/shopify.js';
import * as ga4 from './fetchers/ga4.js';
import { runSitewatch } from './sitewatch.js';
import { computeSignals } from './signals.js';
import { ensureReportTokens, listLinks, reportPayload, reportUrl, resolveToken, rotateReportToken, videoPreviewFor, videoUrlFor } from './report.js';
import { weeklyReports } from './gamma.js';
import { computeCreatorScores } from './creators.js';
import { createUpload, listMine, listToday, istToday } from './creatorPortal.js';
import { raise } from './alerts.js';
import { handleChat, notesApi } from './chat/index.js';
import { verifyShopify, verifyMeta } from './verify.js';
import { buildSourceFeed } from './orderSources.js';
import Sample from './sample.cjs';

const SAMPLE_FALLBACK = /^(1|true|yes)$/i.test(process.env.DESK_SAMPLE_FALLBACK || '');

function sourceState(client, source) {
  const a = client.accounts || {};
  if (source === 'meta') return !a.meta ? 'not-configured' : has('meta') ? 'ready' : 'no-token';
  if (source === 'google') return !a.google ? 'not-configured' : has('google') ? 'ready' : 'no-token';
  if (source === 'shopify') return !a.shopify?.shop ? 'not-configured' : shopifyTokenFor(client) ? 'ready' : 'no-token';
  if (source === 'ga4') return !a.ga4 ? 'not-configured' : has('ga4') ? 'ready' : 'no-token';
  return 'not-configured';
}

// Order sources live in orderdays/{clientId}_{date}: the grouped orders of that day from Shopify
// plus each ad platform's spend per campaign that day. The three parts are written by three
// different steps of the sync, so each writes only its own fields (merge), and every day of the
// window is written, empty days included, so a stale figure is always overwritten. Arrays rather
// than maps on purpose: a merge replaces an array whole, where it would deep-merge a map and keep
// a campaign that has since dropped to zero.
async function writeOrderDays(store, client, since, until, byDate, pick) {
  const rows = [];
  for (let d = since; d <= until; d = addDays(d, 1)) rows.push({ id: `${client.id}_${d}`, data: { clientId: client.id, date: d, ...pick(byDate[d]), updatedAt: nowIso() } });
  await store.batchSet('orderdays', rows);
}
const tracksOrders = (client) => client.type !== 'lead' && !!client.accounts?.shopify?.shop;

async function writeDaily(store, rows) {
  await store.batchSet('daily', rows.map((r) => ({ id: dailyId(r.clientId, r.date, r.platform), data: { ...r, updatedAt: nowIso() } })));
}

// "Has this client ever had a real row for this source?" needs one row, not the whole history. It
// used to read every row ever written (about 120 per source) on every sync of every client, which
// made it one of the larger lines in the daily read bill for a question with a one word answer.
// A handful is fetched rather than exactly one so a stray sample row sorting first cannot hide a
// real one behind it.
async function firstRun(store, client, platform) {
  const rows = await store.list('daily', [['clientId', '==', client.id], ['platform', '==', platform]], { limit: 10 });
  return rows.filter((r) => !r.sample).length === 0;
}

async function markSync(store, client, source, patch) {
  await store.merge('syncs', client.id, { [source]: { at: nowIso(), ...patch }, clientId: client.id });
}

async function seedSampleFor(store, client, until, sources) {
  const { daily, entities, sitewatch } = Sample.build(client, until, config.historyDays);
  const rows = daily.filter((r) => sources.includes(r.platform));
  await writeDaily(store, rows);
  const prev = (await store.get('entities', client.id)) || {};
  const ent = { ...prev, clientId: client.id, since: entities.since, until: entities.until, updatedAt: nowIso() };
  if (sources.includes('meta')) { ent.campaigns = [...(prev.campaigns || []).filter((c) => c.platform !== 'meta'), ...entities.campaigns.filter((c) => c.platform === 'meta')]; ent.adsets = entities.adsets; ent.ads = entities.ads; }
  if (sources.includes('google')) ent.campaigns = [...(ent.campaigns || prev.campaigns || []).filter((c) => c.platform !== 'google'), ...entities.campaigns.filter((c) => c.platform === 'google')];
  if (sources.includes('shopify')) { ent.products = entities.products; ent.recentOrders = entities.recentOrders; }
  if (sources.includes('meta')) { ent.issues = entities.issues; ent.account = entities.account; }
  ent.sources = { ...(prev.sources || {}), ...Object.fromEntries(sources.map((s) => [s, 'sample'])) };
  await store.set('entities', client.id, ent);
  if (client.sample) {
    await store.set('sitewatch', client.id, sitewatch);
    const intra = Sample.buildIntraday(client, until);
    for (const doc of intra) await store.set('intraday', `${client.id}_${doc.date}`, doc);
  }
  for (const s of sources) await markSync(store, client, s, { ok: true, mode: 'sample', error: '' });
  return ent;
}

// The campaign / ad set / ad pull is the expensive part of a daily run, a dozen API calls against
// one ad account. Daily rows are cheap and always refresh. So if the entity tree was pulled within
// the last hour, a second daily run in that hour reuses it instead of burning the platform's rate
// limit budget again. DESK_ENTITY_MIN_MINUTES=0 turns this off.
const MIN_HISTORY = 30;
const ENTITY_MIN_MIN = Number(process.env.DESK_ENTITY_MIN_MINUTES ?? 60);
function entitiesDue(ent, source) {
  if (!ENTITY_MIN_MIN) return true;
  const at = ent?.entitiesAt?.[source];
  if (!at) return true;
  const mins = (Date.now() - new Date(at).getTime()) / 60000;
  if (mins < ENTITY_MIN_MIN) { log(`${source}: entity tree pulled ${Math.round(mins)} min ago, reusing it`); return false; }
  return true;
}

// days: a one-off backfill window that overrides the usual 7-day restate. This exists because a
// fetcher bug is only half fixed when new rows are right and the stored history still carries the
// old wrong numbers, and every window the dashboard shows (this month, last month, 90-day trend)
// reads that history. Passing ?days=95 re-pulls the whole visible past in one run instead of
// editing DESK_RESTATE_DAYS on the host and waiting out two redeploys.
async function syncClient(store, client, { mode, days }) {
  const today = todayStr();
  const untilFull = addDays(today, -1);            // last complete day for entity/product windows
  const backfill = Number.isFinite(days) && days > 0 ? Math.min(Math.round(days), 365) : 0;
  const restateSince = addDays(today, -(backfill || config.restateDays));
  const isE = client.type !== 'lead';
  const ent = (await store.get('entities', client.id)) || { clientId: client.id, campaigns: [], adsets: [], ads: [], products: [], sources: {} };
  ent.sources = ent.sources || {};
  // Every source must have at least MIN_HISTORY days behind it. A client added today only has
  // yesterday and today from an hourly run, so the first sync of each source after it is added
  // (or after this check was introduced) pulls the full history window once and records where that
  // reached in syncs/{client}.{source}.histSince. One read per client, and it is not repeated.
  const syncDoc = (await store.get('syncs', client.id)) || {};
  const histOk = (source) => { const h = syncDoc[source]?.histSince; return !!h && h <= addDays(today, -MIN_HISTORY); };

  if (client.sample) { // pure sample client: regenerate so dates keep rolling
    const s = await seedSampleFor(store, client, today, ['meta', 'google', 'shopify', 'ga4']);
    return { entities: s };
  }

  const platforms = { meta: ['meta'], google: ['google'], shopify: ['shopify'], ga4: ['ga4'] };
  // A client whose every source is skipped used to produce no output at all. A run of 44 such
  // clients finished in under a minute and wrote nothing to the log, which reads exactly like a
  // run that never happened. Say what was skipped and why, once per client.
  const skipped = [];
  for (const source of ['meta', 'google', 'shopify', 'ga4']) {
    const state = sourceState(client, source);
    if (state === 'not-configured') { skipped.push(`${source}: no account id on the client`); continue; }
    if (state === 'no-token') {
      skipped.push(`${source}: account id present, token missing`);
      await markSync(store, client, source, { ok: false, mode: 'waiting', error: 'no token configured yet' });
      if (SAMPLE_FALLBACK && mode === 'daily') await seedSampleFor(store, client, today, platforms[source]);
      continue;
    }
    try {
      const needHist = !backfill && !histOk(source);
      const since = backfill ? restateSince
        : needHist ? addDays(today, -Math.max(config.historyDays, MIN_HISTORY + 1))
        : mode === 'hourly' ? addDays(today, -1)
        : (await firstRun(store, client, source)) ? addDays(today, -config.historyDays) : restateSince;
      if (source === 'meta') {
        const rows = await meta.fetchDaily(client, since, today);
        await writeDaily(store, rows);
        if (tracksOrders(client)) {
          try { const sp = await meta.fetchCampaignSpend(client, since, today); await writeOrderDays(store, client, since, today, sp, (x) => ({ spendMeta: (x || []).flat() })); }
          catch (e) { log(`${client.id}/meta: campaign spend for order sources skipped: ${String(e.message || e).slice(0, 120)}`); }
        }
        if (mode === 'daily' && entitiesDue(ent, source)) {
          const e = await meta.fetchEntities(client, untilFull);
          ent.campaigns = [...(ent.campaigns || []).filter((c) => c.platform !== 'meta'), ...e.campaigns];
          ent.adsets = e.adsets; ent.ads = e.ads; ent.since = e.since; ent.until = e.until;
          ent.issues = e.issues; ent.account = e.account;
          ent.entitiesAt = { ...(ent.entitiesAt || {}), meta: nowIso() };
        } else if (mode === 'hourly' && (ent.ads || []).length) {
          // Keep today's per-day tuples fresh between daily runs. Failure here must not fail the sync.
          try {
            const t = await meta.fetchTodayDays(client, today);
            const merge = (list, map) => { for (const x of list || []) { const d = map[x.id]; x.days = { ...(x.days || {}) }; if (d && d[today]) x.days[today] = d[today]; else if (x.days[today]) x.days[today] = [0, 0, 0, 0, 0, 0, 0]; } };
            merge((ent.campaigns || []).filter((c) => c.platform === 'meta'), t.campaign);
            merge(ent.adsets, t.adset);
            merge(ent.ads, t.ad);
          } catch (e) { log(`${client.id}/meta: today top-up skipped: ${(e.message || e).toString().slice(0, 120)}`); }
        }
      } else if (source === 'google') {
        const rows = await google.fetchDaily(client, since, today);
        await writeDaily(store, rows);
        if (tracksOrders(client)) {
          try { const sp = await google.fetchCampaignSpend(client, since, today); await writeOrderDays(store, client, since, today, sp, (x) => ({ spendGoogle: (x || []).flat() })); }
          catch (e) { log(`${client.id}/google: campaign spend for order sources skipped: ${String(e.message || e).slice(0, 120)}`); }
        }
        if (mode === 'daily' && entitiesDue(ent, source)) {
          const e = await google.fetchEntities(client, untilFull);
          ent.campaigns = [...(ent.campaigns || []).filter((c) => c.platform !== 'google'), ...e.campaigns];
          ent.entitiesAt = { ...(ent.entitiesAt || {}), google: nowIso() };
        }
      } else if (source === 'shopify' && isE) {
        const { rows, recentOrders, orderDays } = await shopify.fetchDaily(client, since, today);
        await writeDaily(store, rows);
        if (orderDays) await writeOrderDays(store, client, since, today, orderDays, (x) => ({ g: (x?.g || []).flat(), gw: 12, test: x?.test || { n: 0, v: 0 }, cancelled: x?.cancelled || { n: 0, v: 0 } }));
        // On a backfill, one line per day of what the order sources came to, so a run can be checked
        // against Shopify or an export without opening the dashboard. Private service log only.
        if (orderDays && backfill) for (const d of Object.keys(orderDays).sort()) {
          const g = orderDays[d].g || []; const by = { Meta: 0, Google: 0, Other: 0 }, ch = {};
          for (const r of g) { by[r[0]] += r[8]; ch[r[1]] = (ch[r[1]] || 0) + r[8]; }
          log(`${client.id}/sources ${d}: G${by.Google} M${by.Meta} O${by.Other} test ${orderDays[d].test.n} cancelled ${orderDays[d].cancelled.n} | ${Object.entries(ch).map(([k, v]) => k + ' ' + v).join(', ')}`);
        }
        if (orderDays && backfill) {
          // How well orders tie back to ad platform campaigns over the window: matched campaigns with
          // their spend and store ROAS, and the paid order value that could not be tied to a campaign.
          try {
            const docs = (await store.list('orderdays', dailyIdRange(client.id, since, today))).filter((x) => x.clientId === client.id);
            const f = buildSourceFeed(docs, { internal: true, entities: ent });
            const agg = {};
            for (const r of f.rows) { if (!/\(paid\)/.test(r[2])) continue; const a2 = agg[r[3]] || (agg[r[3]] = { n: 0, v: 0, s: 0 }); a2.n += r[4]; a2.v += r[5]; }
            for (const r of f.spend) { const a2 = agg[r[1]] || (agg[r[1]] = { n: 0, v: 0, s: 0 }); a2.s += r[2]; }
            const list = Object.entries(agg).map(([k, x]) => ({ k, ...x, name: f.camps[k]?.name || '', matched: !!f.camps[k]?.id })).sort((a2, b2) => b2.v - a2.v);
            const um = list.filter((x) => !x.matched);
            log(`${client.id}/sources campaigns: ${list.filter((x) => x.matched).length} matched, paid order value unmatched ${Math.round(um.reduce((t, x) => t + x.v, 0))} of ${Math.round(list.reduce((t, x) => t + x.v, 0))}`);
            for (const x of list.slice(0, 12)) log(`${client.id}/sources camp ${x.matched ? 'OK ' : 'NO '}${x.k.slice(0, 60)} "${String(x.name).slice(0, 50)}" orders ${x.n} value ${Math.round(x.v)} spend ${Math.round(x.s)} roas ${x.s ? (x.v / x.s).toFixed(2) : '-'}`);
          } catch (e) { log(`${client.id}/sources campaigns check failed: ${String(e.message || e).slice(0, 120)}`); }
        }
        ent.recentOrders = recentOrders;
        if (mode === 'daily' && entitiesDue(ent, source)) {
          ent.products = await shopify.fetchProducts(client, untilFull); ent.entitiesAt = { ...(ent.entitiesAt || {}), shopify: nowIso() };
          const p0 = ent.products[0];
          log(`${client.id}/products: ${ent.products.length}, ${ent.products.filter((p) => p.title).length} with a name, ${ent.products.filter((p) => p.url).length} with a link${p0 ? `, top ${JSON.stringify({ id: p0.id, title: p0.title, url: p0.url, image: !!p0.image, price: p0.price }).slice(0, 300)}` : ''}`);
        }
      } else if (source === 'ga4') {
        const rows = await ga4.fetchDaily(client, since, today);
        await writeDaily(store, rows);
      }
      ent.sources[source] = 'live';
      await markSync(store, client, source, { ok: true, mode: 'live', error: '', since, until: today, ...(needHist ? { histSince: since } : {}) });
      log(`${client.id}/${source}: synced ${since} to ${today}`);
    } catch (e) {
      const msg = (e.message || String(e)).slice(0, 300);
      await markSync(store, client, source, { ok: false, mode: 'error', error: msg });
      log(`${client.id}/${source}: FAILED ${msg}`);
      if (mode === 'daily') await raise(client, `sync-${source}`, 'warning', `${source} sync failed: ${msg}`);
    }
  }
  if (skipped.length === 4) log(`${client.id}: nothing to sync (${skipped.join('; ')})`);
  else if (skipped.length) log(`${client.id}: skipped ${skipped.join('; ')}`);
  ent.updatedAt = nowIso();
  await store.set('entities', client.id, ent);
  if (mode === 'hourly') await intradaySnapshot(store, client, today);
  await writeRollup(store, client, today);
  return { entities: ent };
}

// One document per client holding the daily rows the dashboard needs, so opening the page costs
// one read per client instead of one per row.
//
// The numbers here are not recomputed. The rows are read back from the store exactly as they were
// written and packed as they are, so the rollup cannot disagree with the source: it is the source,
// in a different shape. Anything else would be a second version of the truth, which is the one
// thing this desk is not allowed to have.
//
// Why it matters: the dashboard was reading 31 clients x 35 days x 3 platforms, about 3,300
// documents, every single time anyone opened it. Firestore's free tier allows 50,000 reads a day,
// so the whole team shared roughly thirteen page loads before the dashboard simply stopped
// loading. This makes the same page cost 31.
export const ROLLUP_DAYS = 40;   // a little past the dashboard's 35 so a range change needs no resync
async function writeRollup(store, client, today) {
  try {
    const since = addDays(today, -(ROLLUP_DAYS - 1));
    // Range on the document id, so Firestore returns only the 40 days wanted. This used to read
    // the client's entire history and discard everything older than 40 days in JavaScript, and it
    // ran for every client on every sync: the line that spent the day's read quota.
    const rows = (await store.list('daily', dailyIdRange(client.id, since, today)))
      .filter((r) => r.clientId === client.id && r.date >= since && r.date <= today)
      .sort((a, b) => (a.date === b.date ? String(a.platform).localeCompare(b.platform) : a.date < b.date ? -1 : 1));
    await store.set('rollup', client.id, {
      clientId: client.id, from: since, to: today, days: ROLLUP_DAYS,
      rows, count: rows.length, updatedAt: nowIso(),
    });
  } catch (e) {
    // A rollup that fails is a slower dashboard, not a wrong one: the page falls back to reading
    // the daily rows. So it must never take the sync down with it.
    log(`rollup ${client.id}: FAILED (${String(e.message || e).slice(0, 120)})`);
  }
}

// Hourly snapshot of today's cumulative numbers, so the dashboard can draw "today so far" against the same weekday last week.
async function intradaySnapshot(store, client, today) {
  const rows = await store.list('daily', [['clientId', '==', client.id], ['date', '==', today]]);
  if (!rows.length) return;
  const hour = new Date().toLocaleString('en-US', { timeZone: config.tz, hour: '2-digit', hour12: false }).padStart(2, '0');
  const sum = (k, plats) => rows.filter((r) => !plats || plats.includes(r.platform)).reduce((s, r) => s + (r[k] || 0), 0);
  const snap = { spend: Math.round(sum('spend', ['meta', 'google'])), purchases: sum('purchases', ['meta', 'google']), revenue: Math.round(sum('revenue', ['meta', 'google'])), leads: sum('leads', ['meta', 'google']), orders: sum('orders', ['shopify']), netSales: Math.round(sum('netSales', ['shopify'])), checkoutsStarted: sum('checkoutsStarted', ['shopify']) };
  const id = `${client.id}_${today}`;
  const prev = (await store.get('intraday', id)) || { clientId: client.id, date: today, hours: {} };
  prev.hours[hour] = snap; prev.updatedAt = nowIso();
  await store.set('intraday', id, prev);
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const store = await db();
  log(`performance desk: ${cmd} (store: ${store.kind}${store.root ? ' ' + store.root : ''}, tz ${config.tz})`);

  if (cmd === 'seed') {
    for (const c of Sample.SAMPLE_CLIENTS) await store.merge('clients', c.id, normalizeClient(c));
    await syncClientsFromFile();
    const clients = await loadClients();
    for (const c of clients) {
      if (c.sample) { await seedSampleFor(store, c, todayStr(), ['meta', 'google', 'shopify', 'ga4']); log(`seeded sample data for ${c.id}`); }
      else if (SAMPLE_FALLBACK) { const src = ['meta', 'google', 'shopify', 'ga4'].filter((s) => sourceState(c, s) === 'no-token'); if (src.length) { await seedSampleFor(store, c, todayStr(), src); log(`seeded sample fallback for ${c.id}: ${src.join(', ')}`); } }
      const ent = await store.get('entities', c.id);
      await computeSignals(c, ent, { mode: 'daily' });
    }
    log('seed done');
    return;
  }

  if (cmd === 'daily' || cmd === 'hourly') {
    const days = cmd === 'daily' ? parseInt(process.argv[3] || '', 10) : NaN;   // node src/index.js daily 95
    await syncClientsFromFile();
    const clients = await loadClients();
    for (const c of clients) {
      const { entities } = await syncClient(store, c, { mode: cmd, days });
      await computeSignals(c, entities, { mode: cmd });
    }
    await store.set('meta', 'lastRun', { [cmd]: nowIso(), clients: clients.length });
    log(`${cmd} done for ${clients.length} clients`);
    return;
  }

  if (cmd === 'sitewatch') {
    await syncClientsFromFile();
    await runSitewatch(await loadClients());
    await store.merge('meta', 'lastRun', { sitewatch: nowIso() });
    return;
  }

  if (cmd === 'test-tokens') {
    await syncClientsFromFile();
    for (const c of await loadClients()) {
      if (c.sample) continue;
      log(`--- ${c.name}`);
      for (const [src, mod] of [['meta', meta], ['google', google], ['shopify', shopify], ['ga4', ga4]]) {
        const st = sourceState(c, src);
        if (st !== 'ready') { log(`${src}: ${st}`); continue; }
        try { await mod.testToken(c); } catch (e) { log(`${src}: FAILED ${e.message}`); }
      }
    }
    return;
  }

  if (cmd === 'serve') {
    // One always-available HTTP service. Two jobs:
    //   POST /sync?mode=hourly|daily   the dashboard's "Sync now" button (waits for the result)
    //   GET|POST /run?mode=...         an external scheduler (cron-job.org and the like) kicks off a
    //                                  run and gets 202 straight back, so it never hits a timeout.
    // Both need DESK_SYNC_KEY, as a Bearer token or as ?key= for schedulers that cannot set headers.
    const http = await import('node:http');
    const port = parseInt(process.env.PORT || '10000', 10);
    const running = new Set();
    // Report links point at the dashboard host, which serves report.html; that page then calls
    // this API for the data. Falls back to this host so /links still returns something usable
    // before DESK_REPORT_BASE is set.
    const reportBase = (req) => (process.env.DESK_REPORT_BASE || '').replace(/\/$/, '') || `https://${req.headers.host}`;

    async function runMode(mode, days, url = new URL('http://x/')) {
      await syncClientsFromFile();
      const clients = await loadClients();
      // A new client gets its report link the first time it syncs. Existing links are never
      // regenerated here, so a link already sent to a client keeps working across deploys.
      const made = await ensureReportTokens(store, clients);
      if (made) log(`reports: created ${made} client link${made > 1 ? 's' : ''}`);
      if (mode === 'sitewatch') {
        await runSitewatch(clients);
        await store.merge('meta', 'lastRun', { sitewatch: nowIso() });
        return { mode, clients: clients.length };
      }
      if (mode === 'verify') {
        const r = await verifyShopify(store, clients, { only: String(url.searchParams.get('client') || '').trim().toLowerCase() });
        await store.merge('meta', 'lastRun', { verify: nowIso(), verifySummary: `${r.clean} clean, ${r.mismatched} mismatched, ${r.skipped} skipped` });
        return { mode, ...r };
      }
      if (mode === 'verifymeta') {
        const r = await verifyMeta(store, clients, { only: String(url.searchParams.get('client') || '').trim().toLowerCase() });
        await store.merge('meta', 'lastRun', { verifyMeta: nowIso(), verifyMetaSummary: `${r.clean} clean, ${r.mismatched} mismatched, ${r.skipped} skipped`, verifyMetaProblems: r.problems.slice(0, 60) });
        return { mode, ...r };
      }
      if (mode === 'weekly') {
        // Built from the rows already in the store, not from a fresh pull, so the deck and the
        // dashboard are looking at exactly the same numbers.
        const r = await weeklyReports(store, clients, { force: url.searchParams.get('force') === '1', only: url.searchParams.get('client') || '' });
        await store.merge('meta', 'lastRun', { weekly: nowIso() });
        return { mode, clients: clients.length, ...r };
      }
      if (mode === 'creators') {
        // Creative-team incentive scorecard, built from the entity trees already synced today.
        // ?since=&until= overrides the default current-Monday-to-today window for a one-off
        // recompute of a past week; otherwise it is always "this week so far".
        const since = url.searchParams.get('since') || undefined;
        const until = url.searchParams.get('until') || undefined;
        const r = await computeCreatorScores(store, clients, { since, until });
        await store.merge('meta', 'lastRun', { creators: nowIso() });
        return { mode, weekId: r.weekId, creators: r.creators.length, teamAvgQty: r.teamAvgQty };
      }
      // ?client=<id> syncs one account instead of the whole book. Chasing a single failing client
      // through a 31 account run costs a few thousand Firestore writes and a real dent in the Meta
      // rate limit, and the other thirty were already fine. The run is not recorded as the day's
      // lastRun either, because one client is not the book.
      const only = String(url.searchParams.get('client') || '').trim().toLowerCase();
      const list = only ? clients.filter((c) => c.id === only) : clients;
      if (only && !list.length) return { mode, clients: 0, error: `no client with id "${only}"` };

      const failures = [];
      log(`run ${mode}: ${list.length} client${list.length === 1 ? '' : 's'} to sync${only ? ` (only ${only})` : ''}`);
      if (!list.length) log(`run ${mode}: the store returned no clients, so nothing was synced`);
      for (const c of list) {
        // One client throwing used to end the whole run where it stood, so clients later in the
        // file silently never synced and the log gave no hint that the rest had been dropped.
        let entities;
        try { ({ entities } = await syncClient(store, c, { mode, days })); }
        catch (e) {
          const msg = String(e.message || e).slice(0, 300);
          log(`${c.id}: run aborted for this client, continuing with the rest (${msg})`);
          failures.push(`${c.id}: ${msg}`);
          continue;
        }
        await computeSignals(c, entities, { mode });
        // The per source errors are already stored for the dashboard; surfacing them in the
        // response too means a one client run answers "why is this broken" without a log dive.
        const sy = (await store.get('syncs', c.id)) || {};
        for (const src of Object.keys(sy)) {
          const v = sy[src];
          if (v && typeof v === 'object' && v.ok === false && v.error) failures.push(`${c.id}/${src}: ${v.error}`);
        }
      }
      let verified;
      if (mode === 'daily' && !only) { try { verified = await verifyShopify(store, clients); await store.merge('meta', 'lastRun', { verify: nowIso(), verifySummary: `${verified.clean} clean, ${verified.mismatched} mismatched, ${verified.skipped} skipped` }); } catch (e) { log('verify after daily failed: ' + String(e.message || e).slice(0, 120)); } }
      // Creator scorecard rides the existing daily cron rather than needing a schedule of its
      // own: every full-book daily sync also refreshes "this week so far" from the entity trees
      // it just pulled. Wrapped so a scoring bug costs the scorecard, never the sync it rides on.
      if (mode === 'daily' && !only) { try { await computeCreatorScores(store, clients); } catch (e) { log('creator scores after daily failed: ' + String(e.message || e).slice(0, 120)); } }
      if (!only) await store.merge('meta', 'lastRun', { [mode]: nowIso() });
      return { mode, clients: list.length, ...(verified ? { verify: { clean: verified.clean, mismatched: verified.mismatched } } : {}), ...(only ? { client: only } : {}), ...(failures.length ? { failures } : {}) };
    }

    // Every request is wrapped, because until this existed a single Firestore failure took the
    // whole API down: the rejection went unhandled, node exited, Render restarted it, and the next
    // request killed it again. Health flapped between 200 and 502 and nothing said why. A broken
    // dependency should make the desk answer "I cannot reach the store", not disappear.
    let clientLogHits = [];
    http.createServer((req, res) => { handle(req, res).catch((e) => {
      const msg = String(e && e.message || e);
      log(`request ${req.method} ${String(req.url).split('?')[0]} FAILED: ${msg.slice(0, 300)}`);
      // ACCOUNT_STATE_INVALID, UNAUTHENTICATED and PERMISSION_DENIED from googleapis all mean the
      // service account itself has been rejected. That is a credential problem in the Google
      // project, not a bad request, so it is named rather than buried in a generic 500.
      const cred = /ACCOUNT_STATE_INVALID|UNAUTHENTICATED|PERMISSION_DENIED|invalid_grant/i.test(msg);
      try {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: cred ? 'datastore credential rejected' : 'request failed', detail: msg.slice(0, 400) }));
      } catch { /* response already gone */ }
    }); }).listen(port, () => log(`desk api listening on ${port} (/sync, /run, /health)`));

    // The last line of defence. A background run started by /run has no request to answer to, so
    // a rejection inside it would otherwise still kill the process. These handlers log and carry
    // on: a failed sync must cost that sync, never the service. Deliberately not wrapped around
    // startup errors, which should still stop the process, because a desk that cannot read its
    // own clients file has nothing useful to serve.
    process.on('unhandledRejection', (e) => log(`unhandled rejection: ${String(e && e.message || e).slice(0, 300)}`));
    process.on('uncaughtException', (e) => log(`uncaught exception: ${String(e && e.message || e).slice(0, 300)}`));

    async function handle(req, res) {
      res.setHeader('Access-Control-Allow-Origin', process.env.DESK_ALLOWED_ORIGIN || '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health' || url.pathname === '/') { res.end('ok'); return; }

      // Browser error beacon. The dashboard reports its own script errors here so they show up in
      // the service logs. It accepts a tiny text body, stores nothing, and returns nothing, so it
      // cannot leak data. A per-minute cap keeps a broken page from flooding the log.
      if (url.pathname === '/clientlog' && req.method === 'POST') {
        const now = Date.now(); clientLogHits = clientLogHits.filter((t) => now - t < 60000);
        let body = ''; let over = false;
        req.on('data', (c) => { body += c; if (body.length > 2000) { over = true; req.destroy(); } });
        req.on('end', () => { if (!over && clientLogHits.length < 30) { clientLogHits.push(now); log('clientlog: ' + body.replace(/[\r\n]+/g, ' ').slice(0, 1500)); } res.writeHead(204); res.end(); });
        return;
      }

      // GET /r/<token> — the client report feed. Public by design: the token is the credential.
      // A bad, unknown or revoked token gets the same flat 404 as a missing route, so the
      // endpoint cannot be used to find out which tokens exist.
      if (url.pathname.startsWith('/r/')) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        // /r/<token>            the report feed
        // /r/<token>/v/<adId>   a playable URL for one video creative of that client
        const [tok, kind, id] = url.pathname.slice(3).split('/');
        const clientId = await resolveToken(store, tok);
        if (!clientId) { res.writeHead(404); res.end('not found'); return; }

        if (kind === 'v') {
          // The Meta token is used here, on the server, and the browser is sent on to the signed
          // file. Nothing that identifies the account or authorises anything reaches the page.
          const src = await videoUrlFor(store, clientId, id);
          if (!src) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(302, { Location: src });
          res.end();
          return;
        }
        if (kind === 'p') {
          const src = await videoPreviewFor(store, clientId, id);
          if (!src) { res.writeHead(404); res.end('not found'); return; }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ src }));
          return;
        }
        if (kind === 'd') {
          // The team's own client page, for the client. Everything the page needs for this one
          // client and nothing about any other: the client record (without the store token name
          // or the AM), its daily rows, entity tree, signals, sync state, intraday and order
          // sources. The token is the only key, exactly like the report link.
          const c = await store.get('clients', clientId);
          if (!c || c.active === false) { res.writeHead(404); res.end('not found'); return; }
          const until = todayStr(), since = addDays(until, -95);
          const roll = await store.get('rollup', clientId).catch(() => null);
          let daily = Array.isArray(roll?.rows) ? roll.rows : (await store.list('daily', [['clientId', '==', clientId]]));
          daily = daily.filter((r) => r.clientId === clientId && r.date >= since && !r.sample);
          const ent = (await store.get('entities', clientId)) || {};
          const { recentOrders, ...entOut } = ent;
          const [sig, sy, intra, lastRun, od] = await Promise.all([
            store.get('signals', clientId).catch(() => null), store.get('syncs', clientId).catch(() => null),
            store.list('intraday', dailyIdRange(clientId, addDays(until, -8), until)).catch(() => []),
            store.get('meta', 'lastRun').catch(() => null),
            (c.type !== 'lead' && c.accounts?.shopify?.shop) ? store.list('orderdays', dailyIdRange(clientId, since, until)).catch(() => []) : Promise.resolve([]),
          ]);
          const { am, accounts, ...rest } = c;
          const client = { ...rest, id: clientId, accounts: { meta: accounts?.meta || '', google: accounts?.google || '', ga4: accounts?.ga4 ? 'yes' : '', shopify: accounts?.shopify?.shop ? { shop: accounts.shopify.shop } : null } };
          const odDocs = od.filter((x) => x.clientId === clientId);
          const sources = odDocs.some((x) => Array.isArray(x.g)) ? { client: { id: clientId, name: c.name, currency: c.currency || 'INR' }, since, until, ...buildSourceFeed(odDocs, { internal: true, entities: ent }) } : null;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ today: until, client, daily, entities: { ...entOut, clientId }, signals: sig || { clientId, items: [] }, syncs: sy || {}, intraday: intra.filter((x) => x.clientId === clientId), lastRun: lastRun ? { hourly: lastRun.hourly || '', daily: lastRun.daily || '' } : {}, sources }));
          return;
        }
        if (kind) { res.writeHead(404); res.end('not found'); return; }

        const data = await reportPayload(store, clientId);
        if (!data) { res.writeHead(404); res.end('not found'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
        return;
      }

      const isCreatorRoute = url.pathname.startsWith('/creator/');
      const isChatRoute = url.pathname === '/chat' || url.pathname.startsWith('/chat/');
      if (!isCreatorRoute && !isChatRoute && !['/sync', '/run', '/links', '/rotate', '/creators', '/creators/today', '/sources'].includes(url.pathname)) { res.writeHead(404); res.end('not found'); return; }

      // Two ways in, and only one of them may ever reach a browser.
      //
      // DESK_SYNC_KEY is for server to server: a scheduler, or someone running curl. It is a
      // shared secret, so it belongs in an environment variable and nowhere else. It used to be
      // shipped in the dashboard's config.js, which a static host serves to anyone who asks for
      // it, logged in or not. That handed every visitor the ability to start a weekly run and
      // spend the workspace's Gamma credits, or to loop a 365 day backfill until Meta rate
      // limited every account.
      //
      // The dashboard now sends the signed-in user's Firebase ID token instead. It is short
      // lived, it is issued per person, and it cannot be used for anything the person could not
      // already do. The email must be verified and on the allow list, checked here and not in
      // the browser, because a check the browser performs is a check an attacker can skip.
      //
      // The allow list is a team domain OR a named address. Both are needed: the agency signs in
      // on per4mance.guru, but the owner's account is a personal gmail, and a domain rule alone
      // locked him out of his own dashboard. config.js carries the same list for the sign-in
      // screen, but that copy is advisory only. This one decides.
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const key = bearer || url.searchParams.get('key') || '';
      // DESK_CREATORS_KEY is a second, narrower shared key: read-only, /creators only, so the
      // scorecard can be pulled by a separate tool without handing out the main sync key, which
      // can also trigger a full daily/backfill run against every client's ad accounts.
      const creatorsKeyOk = url.pathname === '/creators' && !!process.env.DESK_CREATORS_KEY && key === process.env.DESK_CREATORS_KEY;
      const keyOk = (!!process.env.DESK_SYNC_KEY && key === process.env.DESK_SYNC_KEY) || creatorsKeyOk;
      let who = keyOk ? (creatorsKeyOk ? 'creators key' : 'sync key') : '';

      if (!keyOk && bearer.includes('.')) {           // a JWT has dots; a shared key does not
        try {
          const admin = (await import('firebase-admin')).default;
          const t = await admin.auth().verifyIdToken(bearer);
          const email = String(t.email || '').toLowerCase();
          const list = (v, d) => String(process.env[v] || d).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
          const domains = list('DESK_ALLOWED_DOMAINS', 'per4mance.guru');
          const emails = list('DESK_ALLOWED_EMAILS', '');
          const allowed = domains.some((d) => email.endsWith('@' + d)) || emails.includes(email);
          if (t.email_verified && allowed) who = email;
          else log(`auth: ${email || 'no email'} rejected (verified ${!!t.email_verified}, allowed ${allowed})`);
        } catch (e) {
          log(`auth: token rejected (${String(e.message || e).slice(0, 80)})`);
        }
      }

      if (!who) { res.writeHead(401); res.end('unauthorized'); return; }
      if (who !== 'sync key') log(`auth: ${url.pathname} requested by ${who}`);

      // Garuda chatbot. Team members only (a signed-in teammate, never a shared key), read-only:
      // it answers from the synced data and cannot touch an ad account.
      if (isChatRoute) {
        if (!who.includes('@')) { res.writeHead(403); res.end('sign in with your own account'); return; }
        const isGet = req.method === 'GET';
        if (!isGet && req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
        let payload = {};
        if (!isGet) {
          let body = ''; let over = false;
          await new Promise((resolve) => {
            req.on('data', (c) => { body += c; if (body.length > 100000) { over = true; req.destroy(); } });
            req.on('end', resolve); req.on('close', resolve);
          });
          if (over) { res.writeHead(413); res.end('too large'); return; }
          try { payload = body ? JSON.parse(body) : {}; } catch { res.writeHead(400); res.end('bad json'); return; }
        }
        const out = url.pathname === '/chat' && !isGet
          ? await handleChat(store, who, payload)
          : url.pathname.startsWith('/chat/notes') ? await notesApi(store, who, req.method, url.pathname, url.searchParams, payload)
          : { status: 404, body: 'not found' };
        res.writeHead(out.status, { 'Content-Type': typeof out.body === 'string' ? 'text/plain' : 'application/json' });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
        return;
      }

      // GET /links — every client's report URL, for pasting into an email. Behind the sync key.
      // GET /sources?client=<id>&days=95 — the team's Order sources view for one client: raw UTM
      // values, the ledger and the Direct bucket evidence. Same sign-in as Sync now.
      if (url.pathname === '/sources') {
        const id = String(url.searchParams.get('client') || '').trim().toLowerCase();
        const n = Math.min(Math.max(parseInt(url.searchParams.get('days') || '95', 10) || 95, 1), 120);
        const c = id && (await store.get('clients', id));
        if (!c) { res.writeHead(404); res.end('not found'); return; }
        const until = todayStr(), since = addDays(until, -(n - 1));
        const docs = (await store.list('orderdays', dailyIdRange(id, since, until))).filter((x) => x.clientId === id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ client: { id, name: c.name, currency: c.currency || 'INR' }, since, until, ...buildSourceFeed(docs, { internal: true, entities: await store.get('entities', id) }) }));
        return;
      }

      if (url.pathname === '/links') {
        const clients = await loadClients();
        const rows = await listLinks(store, clients, reportBase(req));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rows, null, 1));
        return;
      }

      // GET /creators?week=<id> — the full, every-creator leaderboard. Admin-only by design: a
      // creator's own Firebase sign-in (checked above, which is enough for /creator/* further
      // down) does NOT unlock this one, only the two shared keys do, so a teammate signed in
      // with an ordinary per4mance.guru account cannot see how everyone else scored. Read-only:
      // it never triggers a sync or a recompute, only /run?mode=creators does that. "current"
      // (the default) is always this week so far.
      if (url.pathname === '/creators') {
        if (!keyOk) { res.writeHead(403); res.end('admin only'); return; }
        const wid = url.searchParams.get('week') || 'current';
        const doc = await store.get('creatorScores', wid);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(doc || { error: `no scorecard for "${wid}" yet` }));
        return;
      }

      // GET /creators/today: admin view of the same live race /creator/today gives each
      // creator, raw submission counts for the current IST day, highest first.
      if (url.pathname === '/creators/today') {
        if (!keyOk) { res.writeHead(403); res.end('admin only'); return; }
        const rows = await listToday(store);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ day: istToday(), rows }));
        return;
      }

      // Creator Portal routes. These accept a signed-in teammate's own Firebase token (set
      // above as `who` = their email) but NOT the shared keys, because there is no "me" for a
      // shared key to mean — isCreator below is what actually enforces that.
      if (isCreatorRoute) {
        const isCreator = who.includes('@');
        if (!isCreator) { res.writeHead(403); res.end('sign in with your own account'); return; }

        // GET /creator/clients — the dropdown list for the upload form.
        if (url.pathname === '/creator/clients' && req.method === 'GET') {
          const clients = (await loadClients()).filter((c) => c.type === 'ecom' && !c.sample);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(clients.map((c) => ({ id: c.id, name: c.name }))));
          return;
        }

        // GET /creator/mine — this person's own uploads, with live performance once linked.
        if (url.pathname === '/creator/mine' && req.method === 'GET') {
          const rows = await listMine(store, who);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(rows));
          return;
        }

        // GET /creator/today: the live race, raw submission counts for everyone today, not
        // just this person's own. Deliberately open to any signed-in creator (unlike /creators,
        // which stays admin-only) because the whole point is that the team can see it moving.
        if (url.pathname === '/creator/today' && req.method === 'GET') {
          const rows = await listToday(store);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ day: istToday(), rows }));
          return;
        }

        // POST /creator/upload — { clientId, format, note, fileName, contentType, fileBase64 }.
        // Body is read as JSON rather than multipart because this server has no framework and a
        // hand-rolled multipart parser is a worse place to get something subtly wrong than a
        // size-capped JSON read. Capped well above the file cap in creatorPortal.js so the cap
        // the uploader actually sees is the friendly one, not a raw socket cutoff.
        if (url.pathname === '/creator/upload' && req.method === 'POST') {
          let body = ''; let over = false;
          req.on('data', (c) => { body += c; if (body.length > 28 * 1024 * 1024) { over = true; req.destroy(); } });
          req.on('end', async () => {
            if (over) { try { res.writeHead(413); res.end('file too large'); } catch {} return; }
            let payload;
            try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
            try {
              const clients = await loadClients();
              const client = clients.find((c) => c.id === payload.clientId);
              if (!client) { res.writeHead(400); res.end('unknown client'); return; }
              const fileBuffer = payload.fileBase64 ? Buffer.from(String(payload.fileBase64), 'base64') : null;
              const doc = await createUpload(store, {
                creatorEmail: who, creatorName: payload.creatorName || who,
                clientId: client.id, clientName: client.name,
                format: payload.format, note: payload.note,
                fileBuffer, fileName: payload.fileName, contentType: payload.contentType,
              });
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, code: doc.code }));
            } catch (e) {
              log(`creator-portal upload FAILED (${who}): ${String(e.message || e).slice(0, 200)}`);
              res.writeHead(400); res.end(String(e.message || e).slice(0, 300));
            }
          });
          return;
        }

        res.writeHead(404); res.end('not found'); return;
      }

      // GET /rotate?client=<id> — kill the old link and issue a new one.
      if (url.pathname === '/rotate') {
        const id = url.searchParams.get('client') || '';
        if (!id) { res.writeHead(400); res.end('client required'); return; }
        const token = await rotateReportToken(store, id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, client: id, url: reportUrl(reportBase(req), token) }));
        return;
      }

      const asked = url.searchParams.get('mode');
      const mode = ['daily', 'hourly', 'sitewatch', 'weekly', 'verify', 'verifymeta', 'creators'].includes(asked) ? asked : 'hourly';
      // ?days=N restates N days of history instead of the usual 7. Ignored for hourly and
      // sitewatch, which have nothing to restate.
      const days = mode === 'daily' ? parseInt(url.searchParams.get('days') || '', 10) : NaN;
      // One client's run is keyed separately from the whole book's, so debugging a broken account
      // is not blocked by whichever cron happens to be mid-flight.
      const lockOn = String(url.searchParams.get('client') || '').trim().toLowerCase();
      const lock = mode + (lockOn ? ':' + lockOn : '');
      if (running.has(lock)) { res.writeHead(409); res.end(`${lock} is already running`); return; }

      if (url.pathname === '/run') {          // fire and forget, answer immediately
        running.add(lock);
        res.writeHead(202); res.end(JSON.stringify({ ok: true, started: lock, days: Number.isFinite(days) ? days : undefined }));
        runMode(mode, days, url).then((r) => log(`run ${lock} done (${r.clients} clients)${r.failures ? ' with ' + r.failures.length + ' failure(s)' : ''}`))
          .catch((e) => log(`run ${lock} FAILED ${e.message || e}`))
          .finally(() => running.delete(lock));
        return;
      }

      running.add(lock);                       // /sync: the button waits for the answer
      try { const r = await runMode(mode, days, url); res.end(JSON.stringify({ ok: true, ...r })); }
      catch (e) { res.writeHead(500); res.end(String(e.message || e)); }
      finally { running.delete(lock); }
    }
    return;
  }

  if (cmd === 'status') {
    for (const s of await store.list('syncs')) log(JSON.stringify(s));
    return;
  }
  console.log('unknown command', cmd);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
