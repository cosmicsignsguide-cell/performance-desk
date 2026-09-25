// Entry point. Run as:  node src/index.js <command>
//   daily        full sync: last DESK_RESTATE_DAYS days re-pulled (first run: DESK_HISTORY_DAYS), entities, products, signals
//   hourly       today + yesterday only, then signals
//   sitewatch    synthetic site checks for every client with a site url
//   seed         write the two sample clients and their sample data (dashboard works before any token exists)
//   test-tokens  call each configured API once per client and print what came back
//   status       print sync status per client

import { config, has, shopifyTokenFor } from './config.js';
import { db, dailyId } from './db.js';
import { syncClientsFromFile, loadClients, normalizeClient } from './clients.js';
import { todayStr, addDays, log, nowIso } from './util.js';
import * as meta from './fetchers/meta.js';
import * as google from './fetchers/google.js';
import * as shopify from './fetchers/shopify.js';
import * as ga4 from './fetchers/ga4.js';
import { runSitewatch } from './sitewatch.js';
import { computeSignals } from './signals.js';
import { raise } from './alerts.js';
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

async function writeDaily(store, rows) {
  await store.batchSet('daily', rows.map((r) => ({ id: dailyId(r.clientId, r.date, r.platform), data: { ...r, updatedAt: nowIso() } })));
}

async function firstRun(store, client, platform) {
  const rows = await store.list('daily', [['clientId', '==', client.id], ['platform', '==', platform]]);
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
const ENTITY_MIN_MIN = Number(process.env.DESK_ENTITY_MIN_MINUTES ?? 60);
function entitiesDue(ent, source) {
  if (!ENTITY_MIN_MIN) return true;
  const at = ent?.entitiesAt?.[source];
  if (!at) return true;
  const mins = (Date.now() - new Date(at).getTime()) / 60000;
  if (mins < ENTITY_MIN_MIN) { log(`${source}: entity tree pulled ${Math.round(mins)} min ago, reusing it`); return false; }
  return true;
}

async function syncClient(store, client, { mode }) {
  const today = todayStr();
  const untilFull = addDays(today, -1);            // last complete day for entity/product windows
  const restateSince = addDays(today, -config.restateDays);
  const isE = client.type !== 'lead';
  const ent = (await store.get('entities', client.id)) || { clientId: client.id, campaigns: [], adsets: [], ads: [], products: [], sources: {} };
  ent.sources = ent.sources || {};

  if (client.sample) { // pure sample client: regenerate so dates keep rolling
    const s = await seedSampleFor(store, client, today, ['meta', 'google', 'shopify', 'ga4']);
    return { entities: s };
  }

  const platforms = { meta: ['meta'], google: ['google'], shopify: ['shopify'], ga4: ['ga4'] };
  for (const source of ['meta', 'google', 'shopify', 'ga4']) {
    const state = sourceState(client, source);
    if (state === 'not-configured') continue;
    if (state === 'no-token') {
      await markSync(store, client, source, { ok: false, mode: 'waiting', error: 'no token configured yet' });
      if (SAMPLE_FALLBACK && mode === 'daily') await seedSampleFor(store, client, today, platforms[source]);
      continue;
    }
    try {
      const since = mode === 'hourly' ? addDays(today, -1) : (await firstRun(store, client, source)) ? addDays(today, -config.historyDays) : restateSince;
      if (source === 'meta') {
        const rows = await meta.fetchDaily(client, since, today);
        await writeDaily(store, rows);
        if (mode === 'daily' && entitiesDue(ent, source)) {
          const e = await meta.fetchEntities(client, untilFull);
          ent.campaigns = [...(ent.campaigns || []).filter((c) => c.platform !== 'meta'), ...e.campaigns];
          ent.adsets = e.adsets; ent.ads = e.ads; ent.since = e.since; ent.until = e.until;
          ent.issues = e.issues; ent.account = e.account;
          ent.entitiesAt = { ...(ent.entitiesAt || {}), meta: nowIso() };
        }
      } else if (source === 'google') {
        const rows = await google.fetchDaily(client, since, today);
        await writeDaily(store, rows);
        if (mode === 'daily' && entitiesDue(ent, source)) {
          const e = await google.fetchEntities(client, untilFull);
          ent.campaigns = [...(ent.campaigns || []).filter((c) => c.platform !== 'google'), ...e.campaigns];
          ent.entitiesAt = { ...(ent.entitiesAt || {}), google: nowIso() };
        }
      } else if (source === 'shopify' && isE) {
        const { rows, recentOrders } = await shopify.fetchDaily(client, since, today);
        await writeDaily(store, rows);
        ent.recentOrders = recentOrders;
        if (mode === 'daily' && entitiesDue(ent, source)) { ent.products = await shopify.fetchProducts(client, untilFull); ent.entitiesAt = { ...(ent.entitiesAt || {}), shopify: nowIso() }; }
      } else if (source === 'ga4') {
        const rows = await ga4.fetchDaily(client, since, today);
        await writeDaily(store, rows);
      }
      ent.sources[source] = 'live';
      await markSync(store, client, source, { ok: true, mode: 'live', error: '', since, until: today });
      log(`${client.id}/${source}: synced ${since} to ${today}`);
    } catch (e) {
      const msg = (e.message || String(e)).slice(0, 300);
      await markSync(store, client, source, { ok: false, mode: 'error', error: msg });
      log(`${client.id}/${source}: FAILED ${msg}`);
      if (mode === 'daily') await raise(client, `sync-${source}`, 'warning', `${source} sync failed: ${msg}`);
    }
  }
  ent.updatedAt = nowIso();
  await store.set('entities', client.id, ent);
  if (mode === 'hourly') await intradaySnapshot(store, client, today);
  return { entities: ent };
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
    await syncClientsFromFile();
    const clients = await loadClients();
    for (const c of clients) {
      const { entities } = await syncClient(store, c, { mode: cmd });
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

    async function runMode(mode) {
      await syncClientsFromFile();
      const clients = await loadClients();
      if (mode === 'sitewatch') {
        await runSitewatch(clients);
        await store.merge('meta', 'lastRun', { sitewatch: nowIso() });
        return { mode, clients: clients.length };
      }
      for (const c of clients) { const { entities } = await syncClient(store, c, { mode }); await computeSignals(c, entities, { mode }); }
      await store.merge('meta', 'lastRun', { [mode]: nowIso() });
      return { mode, clients: clients.length };
    }

    http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', process.env.DESK_ALLOWED_ORIGIN || '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health' || url.pathname === '/') { res.end('ok'); return; }
      if (url.pathname !== '/sync' && url.pathname !== '/run') { res.writeHead(404); res.end('not found'); return; }

      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
      if (!process.env.DESK_SYNC_KEY || key !== process.env.DESK_SYNC_KEY) { res.writeHead(401); res.end('unauthorized'); return; }

      const asked = url.searchParams.get('mode');
      const mode = ['daily', 'hourly', 'sitewatch'].includes(asked) ? asked : 'hourly';
      if (running.has(mode)) { res.writeHead(409); res.end(`${mode} is already running`); return; }

      if (url.pathname === '/run') {          // fire and forget, answer immediately
        running.add(mode);
        res.writeHead(202); res.end(JSON.stringify({ ok: true, started: mode }));
        runMode(mode).then((r) => log(`run ${mode} done (${r.clients} clients)`))
          .catch((e) => log(`run ${mode} FAILED ${e.message || e}`))
          .finally(() => running.delete(mode));
        return;
      }

      running.add(mode);                       // /sync: the button waits for the answer
      try { const r = await runMode(mode); res.end(JSON.stringify({ ok: true, ...r })); }
      catch (e) { res.writeHead(500); res.end(String(e.message || e)); }
      finally { running.delete(mode); }
    }).listen(port, () => log(`desk api listening on ${port} (/sync, /run, /health)`));
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
