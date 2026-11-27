// Meta Marketing API fetcher. Read-only. Needs META_ACCESS_TOKEN (system user, ads_read + read_insights)
// and the client's ad account id (without the act_ prefix) in clients.json.
//
// Field notes (Ads Insights API):
//   actions[action_type=purchase|omni_purchase] -> purchases; action_values[...] -> revenue
//   actions[action_type=lead] -> leads (covers instant forms and website leads)
//   actions[action_type=mobile_app_install|omni_app_install] -> installs. An app-install client has
//     no purchases and no leads to report, so without this its page is spend and nothing else.
//     In-app purchases already arrive under omni_purchase, so revenue and ROAS need no special case.
//   actions[action_type=video_view] -> 3 second video plays  (Ads Manager "3-second video plays")
//   video_thruplay_watched_actions -> ThruPlays; video_play_actions -> plays
//   landing_page_view / add_to_cart / initiate_checkout -> pixel funnel (omni_ variants preferred)
//
// Entities carry `days`: { "YYYY-MM-DD": [spend, impressions, clicks, purchases, revenue, leads] } for the last
// ENTITY_DAYS days, so the dashboard can show any date range (today, yesterday, 7d...) per campaign, ad set and ad
// without another API call. The flat 30 day totals stay on the object for fatigue and ranking logic.

import { AsyncLocalStorage } from 'node:async_hooks';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { emptyDaily, log, num, nowIso, round, addDays } from '../util.js';
import { catOf, UNTAGGED, addDetail, trimDetail } from '../categories.js';
import { productCategories } from './shopify.js';

const BASE = () => `https://graph.facebook.com/${config.meta.apiVersion}`;
export const ENTITY_DAYS = 35;
// Campaigns keep a longer per-day history (there are few of them, so it is cheap) so the Last
// month range and its comparison with the month before work in the campaigns table.
export const CAMPAIGN_DAYS = 60;   // two months of per-day campaign history for every account (was 95)

function act(v, types) {
  if (!Array.isArray(v)) return 0;
  for (const t of types) { const hit = v.find((x) => x.action_type === t); if (hit) return num(hit.value); }
  return 0;
}
const STD_PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
// The purchase action types for the account being pulled right now. Usually the standard ones; for
// a client with metaPurchase set, its custom conversion (see each() below). Carried in async
// context so the many places that read purchases need no extra argument and parallel runs for
// different clients cannot mix them up.
const purchaseCtx = new AsyncLocalStorage();
const PURCHASE_ = () => purchaseCtx.getStore() || STD_PURCHASE;
const LEAD = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
// Brands whose ads start WhatsApp or Messenger chats (SkySham, SkyTours) get most of their leads as
// conversations, not form fills. For a client with metaLead 'conversations' a lead is a form lead
// plus a conversation started, so CPL is spend per enquiry of either kind.
const CONV = ['onsite_conversion.messaging_conversation_started_7d'];
const leadCtx = new AsyncLocalStorage();
const leadsOf = (actions) => act(actions, LEAD) + (leadCtx.getStore() === 'conversations' ? act(actions, CONV) : 0);
const inCtx = (client, types, fn) => purchaseCtx.run(types, () => leadCtx.run(client.metaLead || '', fn));
const INSTALL = ['omni_app_install', 'mobile_app_install', 'app_install'];
const LPV = ['landing_page_view'];
const ATC = ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];
const IC = ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'];
const V3S = ['video_view'];

const INSIGHT_FIELDS = 'spend,impressions,clicks,frequency,reach,actions,action_values,conversions,video_play_actions,video_thruplay_watched_actions';
const DAILY_FIELDS = 'spend,impressions,clicks,actions,action_values,conversions';
// Qualified lead = the CRM stage event sent back through the Conversion API (Berkowits: Prospect).
// Meta reports it under actions, conversions or both; the larger one is taken so it is never counted twice.
const QL_KEY = 'offsite_conversion.fb_pixel_custom.PROSPECT';
const qlOf = (r) => Math.max(act(r.actions, [QL_KEY]), act(r.conversions, [QL_KEY]));
const convosOf = (r) => act(r.actions, CONV);

// Meta rate limiting, handled properly because it decides whether this works at 31 clients.
// Two halves:
//   1. Proactive. Every response carries x-business-use-case-usage with how much of the hourly
//      budget this ad account has burned. Past 75% we slow down before Meta ever says no.
//   2. Reactive. Codes 4, 17, 32 and 613 mean the budget is gone. Backing off seconds is useless,
//      the window is minutes, so we wait properly. Meta often tells us how long in
//      estimated_time_to_regain_access; we trust it, capped so a run cannot hang forever.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_CODES = [4, 17, 32, 613, 80000, 80004];
const MAX_WAIT_MS = 5 * 60 * 1000;
// Cooldown is kept per ad account. Meta throttles accounts one by one, so a single throttled
// account (a 90 day restate on a busy store, say) must not freeze every other client behind it.
const cooldowns = new Map();
const keyOf = (url) => (String(url).match(/\/act_(\d+)/) || [])[1] || 'global';
const cdUntil = (k) => cooldowns.get(k) || 0;
const hold = (k, t) => cooldowns.set(k, Math.max(cdUntil(k), t));

const lastUsageLog = new Map();
function readUsage(headers, k) {
  const raw = headers.get('x-business-use-case-usage') || headers.get('x-ad-account-usage') || headers.get('x-app-usage');
  if (!raw) return;
  let parsed; try { parsed = JSON.parse(raw); } catch { return; }
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  for (const u of entries) {
    if (!u || typeof u !== 'object') continue;
    const pct = Math.max(num(u.call_count), num(u.total_cputime), num(u.total_time));
    const regain = num(u.estimated_time_to_regain_access);
    // Say which of Meta's budgets is running out (insights, management...), once a minute at most,
    // so a slow account can be told apart from one that is simply too big for a single pull.
    if ((pct >= 75 || regain > 0) && Date.now() - (lastUsageLog.get(k) || 0) > 60000) {
      lastUsageLog.set(k, Date.now());
      log(`meta: act_${k} usage ${u.type || 'app'} calls ${num(u.call_count)}% cpu ${num(u.total_cputime)}% time ${num(u.total_time)}%${regain ? `, Meta says wait ${regain} min` : ''}`);
    }
    if (regain > 0) hold(k, Date.now() + Math.min(regain * 60000, MAX_WAIT_MS));
    else if (pct >= 90) hold(k, Date.now() + 60000);
    else if (pct >= 75) hold(k, Date.now() + 15000);
  }
}

// How long one account may keep a run waiting on Meta's throttle, per hour. Past this the call
// fails for that account only, so one heavily throttled account (Firvt, Whimsy) cannot hold up
// every client queued behind it in a full sync; it is picked up again on the next run.
const WAIT_BUDGET_MS = 20 * 60 * 1000;
// The background creatives run (mode=creatives) holds nothing up, so it may wait out a full
// Meta cooldown (often 40 to 55 minutes on a big account such as Mackly Store) instead of giving up.
const patient = new AsyncLocalStorage();
export const runPatiently = (fn) => patient.run(true, fn);
const budgetMs = () => (patient.getStore() ? 90 * 60 * 1000 : WAIT_BUDGET_MS);
// Charged in real time, not per request: when several requests to one account wait out the same
// cooldown side by side, that is one stretch of waiting, not several. (Counting each request's wait
// separately had a busy account like Berkowits "use up" 20 minutes in about 10.)
const waitedFast = new Map(), waitedPatient = new Map();   // account -> { since, ms, until }
// The hourly sync and the background creatives run keep separate tallies, so a long creatives
// wait on one account does not use up the hourly sync's 20 minutes for it.
function chargeWait(k, ms) {
  const waited = patient.getStore() ? waitedPatient : waitedFast;
  const now = Date.now(), w = waited.get(k);
  const cur = !w || now - w.since > 60 * 60 * 1000 ? { since: now, ms: 0, until: 0 } : w;
  const end = now + ms, extra = Math.max(0, end - Math.max(now, cur.until || 0));
  if (cur.ms + extra > budgetMs()) { waited.set(k, cur); return false; }
  cur.ms += extra; cur.until = Math.max(cur.until || 0, end); waited.set(k, cur); return true;
}

async function metaGet(url) {
  const k = keyOf(url);
  for (let attempt = 0; ; attempt++) {
    const wait = cdUntil(k) - Date.now();
    if (wait > 0) {
      if (k !== 'global' && !chargeWait(k, wait)) throw new Error(`meta: act_${k} is throttled by Meta (waited over ${budgetMs() / 60000} min this hour), skipped for this run`);
      log(`meta: pacing act_${k}, waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait);
    }
    let r, text;
    try { r = await fetch(url); text = await r.text(); }
    catch (e) { if (attempt >= 3) throw e; await sleep(3000 * (attempt + 1)); continue; }
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    readUsage(r.headers, k);
    if (r.ok) return body;
    const err = body?.error || {};
    const msg = err.message || String(body.raw || text).slice(0, 300);
    const rateLimited = RATE_CODES.includes(err.code) || /request limit reached|rate limit|too many calls/i.test(msg);
    if (rateLimited && attempt < 3) {
      const backoff = Math.min([45000, 90000, 180000][attempt], MAX_WAIT_MS);
      log(`meta: rate limited (code ${err.code || r.status}), waiting ${backoff / 1000}s`);
      hold(k, Date.now() + backoff);
      continue;
    }
    if (r.status >= 500 && !TOO_MUCH.test(msg) && attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
    throw new Error(`meta ${r.status}: ${msg}`);
  }
}

async function paged(url) {
  const out = [];
  let next = url;
  while (next) {
    let body;
    try { body = await metaGet(next); }
    catch (e) {
      // A list call (ads with their creatives, say) that Meta finds too heavy cannot be split by
      // date, but it can be asked for in smaller pages. Halve the page size and ask again.
      const lim = Number(new URL(next).searchParams.get('limit') || 25);
      // Berkowits's ads list answered "An unknown error occurred" (a 500) at 50 a page, so that counts too.
      if (!TOO_MUCH.test(String(e.message || e)) || lim <= 5) throw e;
      const u = new URL(next); u.searchParams.set('limit', String(Math.max(5, Math.floor(lim / 2)))); next = u.toString();
      log(`meta: page too heavy, asking for ${u.searchParams.get('limit')} at a time`);
      continue;
    }
    out.push(...(body.data || []));
    next = body.paging?.next || null;
  }
  return out;
}

// Meta answers a query it considers too heavy with a 500 and this message. Retrying the same query
// never helps; the range has to get smaller. So we halve the window and ask twice, as deep as needed.
// "Service temporarily unavailable" (400) is also how Meta answers an insights call that is too big
// for it right now (Mackly Store's per-ad days), so it is split like the others instead of failing.
const TOO_MUCH = /reduce the amount of data|please reduce|too much data|unknown error|temporarily unavailable/i;
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

async function pagedRange(build, since, until, depth = 0) {
  try {
    return await paged(build(since, until));
  } catch (e) {
    const span = daysBetween(since, until);
    if (!TOO_MUCH.test(String(e.message || e)) || span < 1 || depth >= 5) throw e;
    const mid = addDays(since, Math.floor(span / 2));
    log(`meta: ${since}..${until} too heavy, splitting into two`);
    const a = await pagedRange(build, since, mid, depth + 1);
    const b = await pagedRange(build, addDays(mid, 1), until, depth + 1);
    return [...a, ...b];
  }
}

// Meta throttles an account that gets a dozen simultaneous insight calls, and the throttle also
// surfaces as a 500. Three at a time keeps it happy and costs only a few seconds.
async function pool(tasks, n = 3) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

function insightsUrl(accountId, params) {
  const q = new URLSearchParams({ access_token: config.meta.token, fields: INSIGHT_FIELDS, limit: '100', action_attribution_windows: JSON.stringify(config.meta.attribution.split(',')), ...params });
  return `${BASE()}/act_${accountId}/insights?${q}`;
}

function rowFromInsight(clientId, r, platform = 'meta') {
  const row = emptyDaily(clientId, r.date_start, platform);
  row.spend = num(r.spend); row.impressions = num(r.impressions); row.clicks = num(r.clicks);
  row.purchases = act(r.actions, PURCHASE_()); row.revenue = act(r.action_values, PURCHASE_());
  row.leads = leadsOf(r.actions);
  row.installs = act(r.actions, INSTALL);
  row.lpv = act(r.actions, LPV); row.atc = act(r.actions, ATC); row.ic = act(r.actions, IC);
  return row;
}

// Daily account-level rows between two dates (inclusive).
async function fetchDailyOne(client, since, until) {
  const accountId = client.accounts.meta;
  const data = await pagedRange(
    (s, u) => insightsUrl(accountId, { level: 'account', time_increment: '1', time_range: JSON.stringify({ since: s, until: u }) }),
    since, until);
  const rows = data.map((r) => rowFromInsight(client.id, r));
  // A client with a Meta campaign segment (Berkowits: "products" in the name) gets, on every day
  // row, the share of that day that belongs to the matching campaigns (row.seg), as on Google, so
  // one page can count only the segment and another only the rest.
  const rule = segRule(client);
  if (rule) {
    const camp = await pagedRange(
      (s, u) => insightsUrl(accountId, { level: 'campaign', time_increment: '1', fields: DAILY_FIELDS + ',campaign_name', time_range: JSON.stringify({ since: s, until: u }) }),
      since, until);
    const seg = {};
    for (const r of camp) {
      if (!String(r.campaign_name || '').toLowerCase().includes(rule)) continue;
      const d = (seg[r.date_start] = seg[r.date_start] || { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, leads: 0 });
      d.spend += num(r.spend); d.impressions += num(r.impressions); d.clicks += num(r.clicks);
      d.purchases += act(r.actions, PURCHASE_()); d.revenue += act(r.action_values, PURCHASE_()); d.leads += leadsOf(r.actions);
    }
    for (const row of rows) { const d = seg[row.date] || {}; row.seg = { spend: round(d.spend || 0), impressions: d.impressions || 0, clicks: d.clicks || 0, purchases: d.purchases || 0, revenue: round(d.revenue || 0), leads: d.leads || 0 }; }
  }
  if (client.categories?.length && client.accounts?.shopify) {
    const cx = await metaCatalogByDay(client, accountId, since, until).catch((e) => { log(`meta ${client.id}: catalog product split unavailable (${String(e.message || e).slice(0, 160)})`); return null; });
    if (cx) for (const row of rows) { row.catx = cx.out[row.date] || {}; row.catxd = trimDetail(cx.det[row.date] || {}); }
  }
  return rows;
}

// Catalog ad spend by product category, per day and ad set. Catalog ad sets ("All product
// catalog") and audience ad sets show many products, so their names say nothing about what was
// sold; Meta reports their spend per catalog product (breakdown product_id, "<id>, <name>"), and
// each product is matched to its Shopify product and so to its category. Written on the Meta day
// row as catx: { adsetId: { category: spend } }. The dashboard uses it for ad sets whose name has
// no category, after their ads' names and before the campaign name; everything else is split by
// names as before. One call for the whole range; a long restate may wait out Meta's hourly limit.
async function metaCatalogByDay(client, accountId, since, until) {
  const call = () => pagedRange((s, u) => insightsUrl(accountId, { level: 'adset', time_increment: '1', breakdowns: 'product_id', fields: 'spend,adset_id', time_range: JSON.stringify({ since: s, until: u }) }), since, until);
  const [pmap, rows] = await Promise.all([productCategories(client), daysBetween(since, until) > 3 ? runPatiently(call) : call()]);
  const out = {}, det = {}; let seen = 0, matched = 0; const fmt = [];
  for (const r of rows) {
    const d = r.date_start, v = num(r.spend), pid = String(r.product_id || ''); if (!v || !pid || /unknown/i.test(pid)) continue;
    seen += v; if (fmt.length < 2) fmt.push(pid);
    const name = pid.includes(',') ? pid.slice(pid.indexOf(',') + 1).trim() : '';
    const shopId = (pid.match(/\d{10,}/g) || []).find((x) => pmap.has(x));
    const p = shopId ? pmap.get(shopId) : null;
    const k = (p && p.cat !== UNTAGGED ? p.cat : null) || catOf(client, name) || null;
    if (!k) continue;
    matched += v;
    const a = ((out[d] = out[d] || {})[r.adset_id] = out[d][r.adset_id] || {}); a[k] = (a[k] || 0) + v;
    addDetail((det[d] = det[d] || {}), client, k, 'Catalog: ' + (p?.title || name || pid), v);
  }
  for (const d in out) for (const a in out[d]) for (const k in out[d][a]) out[d][a][k] = round(out[d][a][k]);
  log(`meta ${client.id}: catalog spend by product ${since}..${until}: ${Math.round(matched)} of ${Math.round(seen)} matched to a category (ids like ${fmt.join(' | ').slice(0, 160)})`);
  return { out, det };
}
const segRule = (client) => { const m = client.segment?.match?.meta; return m && m !== '*' ? String(m).toLowerCase() : ''; };

// Spend per campaign per day, for the Order sources view: what each campaign cost on the days its
// orders came in, so a campaign's store ROAS can be read off the same window. Small call (three
// fields, campaign level) and only made for clients whose orders are tracked.
async function fetchCampaignSpendOne(client, since, until) {
  const accountId = client.accounts.meta;
  const data = await pagedRange(
    (s, u) => insightsUrl(accountId, { level: 'campaign', time_increment: '1', fields: 'spend,campaign_id,campaign_name', time_range: JSON.stringify({ since: s, until: u }) }),
    since, until);
  const out = {};
  for (const r of data) { const sp = round(num(r.spend)); if (!sp) continue; (out[r.date_start] = out[r.date_start] || []).push([String(r.campaign_id), r.campaign_name || '', sp]); }
  return out;
}

function metrics(r) {
  const spend = num(r.spend), imp = num(r.impressions), clicks = num(r.clicks);
  return {
    spend, impressions: imp, clicks,
    purchases: act(r.actions, PURCHASE_()), revenue: act(r.action_values, PURCHASE_()), leads: leadsOf(r.actions),
    installs: act(r.actions, INSTALL),
    qualified: qlOf(r), convos: convosOf(r),
    freq: round(num(r.frequency), 2),
    ctr: imp ? round(clicks / imp * 100, 2) : 0,
    cpm: imp ? round(spend / imp * 1000, 2) : 0,
    v3s: act(r.actions, V3S),
    thruplays: act(r.video_thruplay_watched_actions, ['video_view']),
    plays: act(r.video_play_actions, ['video_view']),
  };
}
// Seventh slot is installs. Appended rather than inserted so tuples already stored stay readable.
const dayTuple = (r) => [round(num(r.spend)), num(r.impressions), num(r.clicks), act(r.actions, PURCHASE_()), round(act(r.action_values, PURCHASE_())), leadsOf(r.actions), act(r.actions, INSTALL), qlOf(r), convosOf(r)];
function daysMap(rows, idKey) {
  const out = {};
  for (const r of rows) { const m = (out[r[idKey]] = out[r[idKey]] || {}); m[r.date_start] = dayTuple(r); }
  return out;
}

const ACCOUNT_STATUS = { 1: 'Active', 2: 'Disabled', 3: 'Unsettled (payment due)', 7: 'Pending risk review', 8: 'Pending settlement', 9: 'In grace period', 100: 'Pending closure', 101: 'Closed', 201: 'Any active', 202: 'Any closed' };
const budgetOf = (o) => (o?.daily_budget ? { dailyBudget: num(o.daily_budget) / 100 } : o?.lifetime_budget ? { lifetimeBudget: num(o.lifetime_budget) / 100 } : {});

// Hourly top-up for the entity tree. fetchEntities only runs in the daily sync, so without this the
// per-day tuples for today stay at whatever they were at 02:00 and every ad reads "No spend" all day.
// Three small calls (campaign, ad set, ad level, today only) that are merged into the stored tree.
async function fetchTodayDaysOne(client, today) {
  const accountId = client.accounts.meta;
  const ins = (level, idField) => (s, u) => insightsUrl(accountId, { level, time_increment: '1', fields: DAILY_FIELDS + ',' + idField, time_range: JSON.stringify({ since: s, until: u }) });
  const [camp, set, ad] = await pool([
    () => pagedRange(ins('campaign', 'campaign_id'), today, today),
    () => pagedRange(ins('adset', 'adset_id'), today, today),
    () => pagedRange(ins('ad', 'ad_id'), today, today),
  ], 2);
  return { campaign: daysMap(camp, 'campaign_id'), adset: daysMap(set, 'adset_id'), ad: daysMap(ad, 'ad_id') };
}


// Resumable creatives pulls. A big account (Berkowits) needs 30 to 90 minutes of Meta waits for one
// pull, and the server's instance gets recycled within that time, which threw the whole pull away
// again and again. Each finished piece of the pull is now saved (gzipped, split under Firestore's
// 1 MB) the moment it arrives, so the next try picks up where the last one stopped. Pieces are
// keyed by account, day and window, and deleted once the whole pull is saved.
let PART_STORE = null;
export function setPartStore(store) { PART_STORE = store; }
async function partGet(key) {
  if (!PART_STORE) return null;
  try {
    const h = await PART_STORE.get('entparts', key); if (!h || !h.n) return null;
    let b64 = ''; for (let i = 0; i < h.n; i++) { const c = await PART_STORE.get('entparts', `${key}~${i}`); if (!c) return null; b64 += c.d; }
    return JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString());
  } catch { return null; }
}
async function partSet(key, val) {
  if (!PART_STORE) return;
  try {
    const b64 = zlib.gzipSync(JSON.stringify(val)).toString('base64'), CH = 900000, n = Math.max(1, Math.ceil(b64.length / CH));
    for (let i = 0; i < n; i++) await PART_STORE.set('entparts', `${key}~${i}`, { d: b64.slice(i * CH, (i + 1) * CH), at: nowIso() });
    await PART_STORE.set('entparts', key, { n, at: nowIso() });
    log(`meta: pull piece ${key.split('_').pop()} of 12 saved for act_${key.split('_')[0]} (${Math.round(b64.length / 1024)} KB)`);
  } catch (e) { log(`meta: could not save a pull piece (${String(e.message || e).slice(0, 80)})`); }
}
async function partClear(keys) {
  if (!PART_STORE?.batchDelete) return;
  try { const ids = []; for (const k of keys) { const h = await PART_STORE.get('entparts', k).catch(() => null); ids.push(k); for (let i = 0; i < (h?.n || 0); i++) ids.push(`${k}~${i}`); } await PART_STORE.batchDelete('entparts', ids); } catch { /* left behind, harmless */ }
}

const AD_FIELDS = 'id,name,adset_id,effective_status,created_time,issues_info,preview_shareable_link,creative.thumbnail_width(480).thumbnail_height(480){object_type,thumbnail_url,video_id,image_url,instagram_permalink_url,effective_object_story_id}';
// Campaigns, ad sets and ads: 30 day totals, per-day tuples for the last ENTITY_DAYS days, statuses, budgets, issues.
async function fetchEntitiesOne(client, until) {
  const accountId = client.accounts.meta;
  const since = addDays(until, -29);
  // A very large account (Berkowits) can set shorter per-day history on the client so the pull fits
  // Meta's hourly allowance: campaignDays for campaigns (default 95), entityDays for ad sets and ads (35).
  const campN = Math.min(CAMPAIGN_DAYS, Math.max(14, Number(client.campaignDays) || CAMPAIGN_DAYS));
  const entN = Math.min(ENTITY_DAYS, Math.max(7, Number(client.entityDays) || ENTITY_DAYS));
  const dSince = addDays(until, -(entN - 1)), dUntil = addDays(until, 1); // includes today
  const q = (fields, extra = {}) => new URLSearchParams({ access_token: config.meta.token, fields, limit: '100', ...extra });
  const ins = (level, fields, extra = {}) => (s, u) => insightsUrl(accountId, { level, time_range: JSON.stringify({ since: s, until: u }), fields, ...extra });
  const partKey = (i) => `${accountId}_${until}_${campN}_${entN}_${i}`, usedKeys = [];
  let resumed = 0;
  const resumable = (tasks) => tasks.map((fn, i) => async () => { const k = partKey(i); usedKeys.push(k); const hit = await partGet(k); if (hit) { resumed++; return hit; } const v = await fn(); await partSet(k, v); return v; });
  const heavy = !!(client.campaignDays || client.entityDays);
  const [camps, sets, adsIns, ads7, ads14, campDays, setDays, adDays, adsetObjs, adObjsList, campObjs, account, lifeRows] = await pool(resumable([
    () => pagedRange(ins('campaign', INSIGHT_FIELDS + ',campaign_id,campaign_name'), since, until),
    () => pagedRange(ins('adset', INSIGHT_FIELDS + ',adset_id,adset_name,campaign_id,campaign_name'), since, until),
    () => pagedRange(ins('ad', INSIGHT_FIELDS + ',ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name'), since, until),
    () => pagedRange(ins('ad', 'spend,impressions,clicks,frequency,ad_id'), addDays(until, -6), until),
    () => pagedRange(ins('ad', 'spend,impressions,clicks,frequency,ad_id'), addDays(until, -13), addDays(until, -7)),
    () => pagedRange(ins('campaign', DAILY_FIELDS + ',campaign_id', { time_increment: '1' }), addDays(until, -(campN - 1)), dUntil),
    () => pagedRange(ins('adset', DAILY_FIELDS + ',adset_id', { time_increment: '1' }), dSince, dUntil),
    () => pagedRange(ins('ad', DAILY_FIELDS + ',ad_id', { time_increment: '1' }), dSince, dUntil),
    () => paged(`${BASE()}/act_${accountId}/adsets?${q('id,name,campaign_id,effective_status,learning_stage_info,daily_budget,lifetime_budget,optimization_goal,created_time')}`),
    // A very large account (Berkowits) has thousands of old ads: listing them all took over an hour
    // of Meta waits. There, only the ads that delivered are looked up, by id, after the insights.
    () => (heavy ? [] : paged(`${BASE()}/act_${accountId}/ads?${q(AD_FIELDS)}`)),
    () => paged(`${BASE()}/act_${accountId}/campaigns?${q('id,name,effective_status,objective,daily_budget,lifetime_budget,bid_strategy')}`),
    () => metaGet(`${BASE()}/act_${accountId}?${q('name,account_status,disable_reason,currency,amount_spent,spend_cap,timezone_name')}`),
    // Clients with optimisation rules (Hokipo): lifetime spend, purchases and revenue of every
    // active ad, since a new creative is judged on its whole life until it has spent ₹2,500.
    () => (client.rules ? paged(insightsUrl(accountId, { level: 'ad', date_preset: 'maximum', fields: 'spend,actions,action_values,ad_id', filtering: JSON.stringify([{ field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] }]) })) : []),
  ]), 2);
  const lifeBy = Object.fromEntries((lifeRows || []).map((r) => [r.ad_id, { spend: round(num(r.spend)), purchases: act(r.actions, PURCHASE_()), revenue: round(act(r.action_values, PURCHASE_())) }]));
  let adObjs = adObjsList;
  if (heavy) {
    const k = partKey('ads'); usedKeys.push(k);
    adObjs = await partGet(k);
    if (!adObjs) {
      const ids = [...new Set([...adsIns, ...adDays, ...ads7].map((r) => r.ad_id).filter(Boolean))];
      adObjs = [];
      // (Graph's ?ids= lookup is gone from v26, so the ads edge is filtered by id instead.)
      for (let i = 0; i < ids.length; i += 50) adObjs.push(...await paged(`${BASE()}/act_${accountId}/ads?${q(AD_FIELDS, { limit: '50', filtering: JSON.stringify([{ field: 'id', operator: 'IN', value: ids.slice(i, i + 50) }]) })}`));
      await partSet(k, adObjs);
      log(`meta: act_${accountId} looked up ${adObjs.length} ads that delivered (of ${ids.length})`);
    }
  }
  if (resumed) log(`meta: act_${accountId} creatives pull resumed, ${resumed} of 12 pieces were already saved`);
  await partClear(usedKeys);
  const setInfo = Object.fromEntries(adsetObjs.map((s) => [s.id, s]));
  const adInfo = Object.fromEntries(adObjs.map((a) => [a.id, a]));
  const campInfo = Object.fromEntries(campObjs.map((c) => [c.id, c]));
  const by7 = Object.fromEntries(ads7.map((r) => [r.ad_id, r]));
  const by14 = Object.fromEntries(ads14.map((r) => [r.ad_id, r]));
  const cDays = daysMap(campDays, 'campaign_id'), sDays = daysMap(setDays, 'adset_id'), aDays = daysMap(adDays, 'ad_id');

  const campaigns = camps.map((r) => {
    const info = campInfo[r.campaign_id] || {};
    return { id: r.campaign_id, name: r.campaign_name, platform: 'meta', status: info.effective_status || '', objective: info.objective || '', bidStrategy: info.bid_strategy || '', ...budgetOf(info), budgetLevel: info.daily_budget || info.lifetime_budget ? 'campaign' : 'adset', ...metrics(r), days: cDays[r.campaign_id] || {} };
  });
  // Campaigns that had no spend in the last 30 days but are active still matter (paused/new ones with budget),
  // and so do ones that only spent earlier (last month), which the per-day history covers.
  for (const c of campObjs) if (!campaigns.some((x) => x.id === c.id) && (c.effective_status === 'ACTIVE' || cDays[c.id])) campaigns.push({ id: c.id, name: c.name, platform: 'meta', status: c.effective_status, objective: c.objective || '', ...budgetOf(c), budgetLevel: c.daily_budget || c.lifetime_budget ? 'campaign' : 'adset', ...metrics({}), days: cDays[c.id] || {} });

  const adsets = sets.map((r) => {
    const info = setInfo[r.adset_id] || {};
    return { id: r.adset_id, name: r.adset_name, campaignId: r.campaign_id, campaignName: r.campaign_name, status: info.effective_status || '', createdDate: info.created_time ? info.created_time.slice(0, 10) : '', learning: info.learning_stage_info?.status || '', optimization: info.optimization_goal || '', ...budgetOf(info), ...metrics(r), days: sDays[r.adset_id] || {} };
  });
  const ads = adsIns.map((r) => {
    const info = adInfo[r.ad_id] || {}; const cr = info.creative || {};
    const m = metrics(r);
    const type = (cr.object_type || '').toUpperCase();
    const isVideo = type === 'VIDEO' || !!cr.video_id || m.plays > 0;
    const format = isVideo ? 'Video' : /carousel/i.test(r.ad_name) ? 'Carousel' : 'Static';
    const created = info.created_time ? info.created_time.slice(0, 10) : '';
    const daysLive = created ? Math.max(1, Math.round((new Date(until) - new Date(created)) / 86400000)) : null;
    const a7 = by7[r.ad_id] || {}, a14 = by14[r.ad_id] || {};
    const mk = (x) => ({ spend: num(x.spend), ctr: num(x.impressions) ? round(num(x.clicks) / num(x.impressions) * 100, 2) : 0, cpm: num(x.impressions) ? round(num(x.spend) / num(x.impressions) * 1000, 2) : 0, freq: round(num(x.frequency), 2) });
    const issues = (info.issues_info || []).map((i) => i.error_summary || i.error_message).filter(Boolean);
    return {
      id: r.ad_id, name: r.ad_name, adsetId: r.adset_id, adsetName: r.adset_name, campaignId: r.campaign_id, campaignName: r.campaign_name,
      status: info.effective_status || '', issues, format, isVideo, createdDate: created, daysLive,
      thumb: cr.image_url || cr.thumbnail_url || '',
      // Meta's own shareable preview page. It opens without a login and plays the video, which the
      // raw file route cannot do (error #10) and an embedded preview cannot do (Meta refuses framing).
      previewUrl: /^https:\/\/(fb\.me|[a-z0-9.-]*facebook\.com)\//i.test(info.preview_shareable_link || '') ? info.preview_shareable_link : '',
      // Kept so a video can be played on demand. The playable file itself is NOT stored: Meta
      // hands back a signed URL that expires, so a stored one would be dead by the next sync.
      // The id is stable, and the media route trades it for a fresh URL at the moment of play.
      videoId: cr.video_id || '',
      // Public post handles, used to embed the video inside the dashboard. Dark (unpublished) ads
      // have no public post, so the embed can fail there and the UI falls back to the Meta link.
      igUrl: /^https:\/\/www\.instagram\.com\/(p|reel|tv)\/[\w-]+/i.test(cr.instagram_permalink_url || '') ? cr.instagram_permalink_url : '',
      fbPost: /^\d+_\d+$/.test(cr.effective_object_story_id || '') ? cr.effective_object_story_id : '',
      hookRate: isVideo && m.impressions ? round(m.v3s / m.impressions * 100, 1) : null,
      holdRate: isVideo && m.v3s ? round(m.thruplays / m.v3s * 100, 1) : null,
      ...m, last7: mk(a7), prev7: mk(a14), days: aDays[r.ad_id] || {}, ...(lifeBy[r.ad_id] ? { life: lifeBy[r.ad_id] } : {}),
    };
  });
  // Rules clients: active ads and ad sets that have not spent in the window still count (a fresh
  // creative, an ad set that just went live), so they are added with zero numbers.
  if (client.rules) {
    const seenAd = new Set(ads.map((a) => a.id)), seenSet = new Set(adsets.map((a) => a.id)), campName = Object.fromEntries(campObjs.map((c) => [c.id, c.name]));
    for (const a of adObjs) {
      if (a.effective_status !== 'ACTIVE' || seenAd.has(a.id)) continue;
      const cr = a.creative || {}, st = setInfo[a.adset_id] || {};
      ads.push({ id: a.id, name: a.name, adsetId: a.adset_id, adsetName: st.name || '', campaignId: st.campaign_id || '', campaignName: campName[st.campaign_id] || '', status: a.effective_status, issues: [], format: cr.video_id ? 'Video' : 'Static', isVideo: !!cr.video_id,
        createdDate: a.created_time ? a.created_time.slice(0, 10) : '', daysLive: null, thumb: cr.image_url || cr.thumbnail_url || '', previewUrl: '', videoId: cr.video_id || '', spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, leads: 0, days: {}, ...(lifeBy[a.id] ? { life: lifeBy[a.id] } : {}) });
    }
    for (const st of adsetObjs) {
      if (st.effective_status !== 'ACTIVE' || seenSet.has(st.id)) continue;
      adsets.push({ id: st.id, name: st.name, campaignId: st.campaign_id, campaignName: campName[st.campaign_id] || '', status: st.effective_status, createdDate: st.created_time ? st.created_time.slice(0, 10) : '', ...budgetOf(st), spend: 0, purchases: 0, revenue: 0, days: {} });
    }
  }
  // Delivery issues: anything Ads Manager would show a red or yellow status for.
  const issues = [];
  const st = num(account.account_status);
  if (st && st !== 1) issues.push({ level: 'account', severity: 'critical', text: `Ad account ${ACCOUNT_STATUS[st] || 'status ' + st}${account.disable_reason ? ' (reason ' + account.disable_reason + ')' : ''}` });
  for (const a of adObjs) {
    if (['DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW'].includes(a.effective_status)) issues.push({ level: 'ad', id: a.id, severity: a.effective_status === 'PENDING_REVIEW' ? 'info' : 'warning', text: `${a.name}: ${a.effective_status.toLowerCase().replace(/_/g, ' ')}${(a.issues_info || []).length ? ', ' + a.issues_info.map((i) => i.error_summary || i.error_message).join('; ') : ''}` });
  }
  for (const s of adsetObjs) if (s.learning_stage_info?.status === 'FAIL' && s.effective_status === 'ACTIVE') issues.push({ level: 'adset', id: s.id, severity: 'info', text: `${s.name}: learning limited` });
  const acct = { platform: 'meta', name: account.name, status: ACCOUNT_STATUS[st] || String(st || ''), statusCode: st, currency: account.currency, amountSpent: num(account.amount_spent) / 100, spendCap: num(account.spend_cap) / 100, timezone: account.timezone_name };
  return { campaigns, adsets, ads, issues, account: acct, since, until, updatedAt: nowIso() };
}

// A playable URL for one video, fetched at the moment it is asked for.
//
// This exists so a client can press play on a video creative in their own report without our
// Meta access token ever going near that page. The alternative everyone reaches for first is to
// drop Meta's ad-preview iframe or a token-bearing URL into the page, and that hands the agency's
// token to anyone the link is forwarded to: every ad account it can reach, read and write. So the
// token stays on this server, the server does the asking, and the browser is sent on to the
// signed file. The URL that comes back is short lived by design, which is exactly why it is
// fetched per play rather than stored on the row.
export async function videoSource(videoId) {
  if (!/^\d+$/.test(String(videoId || ''))) return '';
  const q = new URLSearchParams({ access_token: config.meta.token, fields: 'source' });
  try {
    // metaGet rather than a bare fetch, so this shares the account's rate-limit cooldown with
    // every other Meta call instead of racing them.
    const body = await metaGet(`${BASE()}/${videoId}?${q}`);
    return body?.source || '';
  } catch (e) {
    log(`meta: no playable source for video ${videoId} (${String(e.message || e).slice(0, 100)})`);
    return '';
  }
}

// Fallback when Meta will not hand over the raw file (the `source` field needs a permission the app
// may not hold for videos owned by a Page). Meta's own ad preview plays the video inside an iframe
// and only needs ads_read. The iframe URL is signed by Meta and carries no access token, so it is
// safe to pass to the browser. Read only.
export async function adPreviewSrc(adId) {
  if (!/^\d{5,25}$/.test(String(adId || ''))) return '';
  const q = new URLSearchParams({ access_token: config.meta.token, ad_format: 'MOBILE_FEED_STANDARD' });
  try {
    const body = await metaGet(`${BASE()}/${adId}/previews?${q}`);
    const html = String(body?.data?.[0]?.body || '');
    const m = html.match(/src="([^"]+)"/);
    if (!m) return '';
    const src = m[1].replace(/&amp;/g, '&');
    return /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(src) ? src : '';
  } catch (e) {
    log(`meta: no preview for ad ${adId} (${String(e.message || e).slice(0, 100)})`);
    return '';
  }
}

// Every ad account the system user can read, for the access check. Read only.
export async function listAccounts() {
  const out = []; let url = `${BASE()}/me/adaccounts?${new URLSearchParams({ access_token: config.meta.token, fields: 'name,account_id,account_status,currency,business_name', limit: '200' })}`;
  for (let i = 0; url && i < 20; i++) { const b = await metaGet(url); out.push(...(b.data || [])); url = b.paging?.next || ''; }
  return out;
}
// Spend over the last 30 days for one account, for the access check. Read only.
export async function recentSpend(actId) {
  const q = new URLSearchParams({ access_token: config.meta.token, fields: 'spend', date_preset: 'last_30d' });
  const b = await metaGet(`${BASE()}/act_${actId}/insights?${q}`);
  return Number(b.data?.[0]?.spend || 0);
}
// Every action type the account recorded over the last 30 days, for the access check: shows what a
// purchase is called on an account whose sales come through as zero. Read only.
export async function recentActions(actId) {
  const q = new URLSearchParams({ access_token: config.meta.token, fields: 'actions,action_values', date_preset: 'last_30d' });
  const b = await metaGet(`${BASE()}/act_${actId}/insights?${q}`);
  const r = b.data?.[0] || {}; const vals = Object.fromEntries((r.action_values || []).map((x) => [x.action_type, num(x.value)]));
  return (r.actions || []).map((x) => ({ type: x.action_type, n: num(x.value), v: vals[x.action_type] || 0 })).sort((a, b) => b.n - a.n);
}
// Custom conversions on one account, and the last 30 days per campaign (spend and every action with
// its value), for the access check: shows how an account counts sales and how campaigns are named.
export async function accountDetail(actId) {
  const q = new URLSearchParams({ access_token: config.meta.token, fields: 'id,name,custom_event_type,is_archived,rule', limit: '200' });
  const convs = await paged(`${BASE()}/act_${actId}/customconversions?${q}`).catch((e) => [{ name: 'ERR ' + String(e.message || e).slice(0, 100) }]);
  const q2 = new URLSearchParams({ access_token: config.meta.token, level: 'campaign', fields: 'campaign_id,campaign_name,spend,actions,action_values', date_preset: 'last_30d', limit: '200' });
  const camps = await paged(`${BASE()}/act_${actId}/insights?${q2}`).catch((e) => [{ campaign_name: 'ERR ' + String(e.message || e).slice(0, 100) }]);
  return { convs, camps };
}
async function testTokenOne(client) {
  const q = new URLSearchParams({ access_token: config.meta.token, fields: 'name,currency,account_status,timezone_name' });
  const body = await metaGet(`${BASE()}/act_${client.accounts.meta}?${q}`);
  log(`meta ok: ${body.name} (${body.currency}, status ${body.account_status}, ${body.timezone_name})`);
  return body;
}

// ---------------------------------------------------------------------------------------------
// A client can run on more than one Meta ad account (Whimsy spends from two). accounts.meta then
// holds the ids separated by commas, every account is pulled on its own, and the results are
// merged here, so nothing above this line and nothing in the sync had to change.
export const metaIds = (client) => String(client?.accounts?.meta || '').split(/[\s,]+/).map((x) => x.replace(/^act_/, '')).filter(Boolean);
const forAccount = (client, id) => ({ ...client, accounts: { ...client.accounts, meta: id } });
// A custom conversion is found by its name on each account, once per process.
const convCache = new Map();
async function purchaseTypes(client, id) {
  // Given as action types outright (Berkowits Product Ad: its custom events carry the sale value,
  // which is what the account's own PG_ROAS column divides by spend).
  if (Array.isArray(client.metaPurchaseTypes) && client.metaPurchaseTypes.length) return client.metaPurchaseTypes;
  if (!client.metaPurchase && !client.metaPurchaseId) return STD_PURCHASE;
  const key = `${id}|${String(client.metaPurchase).toLowerCase()}|${client.metaPurchaseId || ''}`;
  if (!convCache.has(key) && client.metaPurchaseId) {
    // Given by id: use it, and log what Meta calls it so the mapping can be checked.
    let label = '';
    try { const q = new URLSearchParams({ access_token: config.meta.token, fields: 'name,rule,custom_event_type' }); const b = await metaGet(`${BASE()}/${client.metaPurchaseId}?${q}`); label = ` = "${b.name || '?'}" rule ${String(b.rule || '').slice(0, 160)}`; }
    catch (e) { label = ` (name not readable: ${String(e.message || e).slice(0, 80)})`; }
    log(`meta ${client.id}: purchases counted from custom conversion ${client.metaPurchaseId}${label}`);
    convCache.set(key, [`offsite_conversion.custom.${client.metaPurchaseId}`]);
  }
  if (!convCache.has(key)) {
    let types = null;
    try {
      const q = new URLSearchParams({ access_token: config.meta.token, fields: 'id,name,custom_event_type,is_archived', limit: '200' });
      const list = await paged(`${BASE()}/act_${id}/customconversions?${q}`);
      const want = client.metaPurchase.toLowerCase();
      const hit = list.filter((c) => String(c.name || '').toLowerCase() === want && !c.is_archived);
      if (hit.length) types = hit.map((c) => `offsite_conversion.custom.${c.id}`);
      log(`meta ${client.id}: purchases counted from custom conversion "${client.metaPurchase}"${types ? ` (${types.join(', ')})` : ' NOT FOUND on act_' + id + ' (it has: ' + list.map((c) => `${c.name} ${c.id}`).join(', ').slice(0, 300) + '), falling back to standard purchases'}`);
    } catch (e) { log(`meta ${client.id}: could not list custom conversions (${String(e.message || e).slice(0, 120)}), using standard purchases`); }
    if (types) convCache.set(key, types); else return STD_PURCHASE;
  }
  return convCache.get(key);
}
async function each(client, fn) {
  const ids = metaIds(client); const out = [];
  for (const id of ids) { const types = await purchaseTypes(client, id); out.push(await inCtx(client, types, () => fn(forAccount(client, id)))); }
  return out;
}

export async function fetchDaily(client, since, until) {
  const parts = await each(client, (c) => fetchDailyOne(c, since, until));
  if (parts.length === 1) return parts[0];
  const by = new Map();
  for (const row of parts.flat()) {
    const k = row.date, cur = by.get(k);
    if (!cur) { by.set(k, { ...row }); continue; }
    for (const [f, v] of Object.entries(row)) if (typeof v === 'number') cur[f] = (cur[f] || 0) + v;
    if (row.cats) { cur.cats = { ...(cur.cats || {}) }; for (const [k, v] of Object.entries(row.cats)) cur.cats[k] = round((cur.cats[k] || 0) + v); }
    if (row.catx) cur.catx = { ...(cur.catx || {}), ...row.catx };
    if (row.catxd) { cur.catxd = { ...(cur.catxd || {}) }; for (const [k, m] of Object.entries(row.catxd)) cur.catxd[k] = { ...(cur.catxd[k] || {}), ...m }; }
    if (row.catd) { cur.catd = { ...(cur.catd || {}) }; for (const [k, m] of Object.entries(row.catd)) cur.catd[k] = { ...(cur.catd[k] || {}), ...m }; }
  }
  return [...by.values()].map((r) => ({ ...r, spend: round(r.spend), revenue: round(r.revenue) }));
}
export async function fetchCampaignSpend(client, since, until) {
  const parts = await each(client, (c) => fetchCampaignSpendOne(c, since, until));
  if (parts.length === 1) return parts[0];
  const out = {}; for (const p of parts) for (const [d, arr] of Object.entries(p)) (out[d] = out[d] || []).push(...arr);
  return out;
}
export async function fetchTodayDays(client, today) {
  const parts = await each(client, (c) => fetchTodayDaysOne(c, today));
  if (parts.length === 1) return parts[0];
  return parts.reduce((a, p) => ({ campaign: { ...a.campaign, ...p.campaign }, adset: { ...a.adset, ...p.adset }, ad: { ...a.ad, ...p.ad } }), { campaign: {}, adset: {}, ad: {} });
}
// With two or more accounts on one client, one account that Meta throttles no longer costs the
// others their campaigns, ad sets and ads: the accounts that answered are returned, each row tagged
// with its account (acct), and the ones that did not are listed in failed so the caller can keep
// what it already had for them. Only when every account fails does this throw.
export async function fetchEntities(client, until) {
  const ids = metaIds(client);
  if (ids.length === 1) { const types = await purchaseTypes(client, ids[0]); const one = await inCtx(client, types, () => fetchEntitiesOne(forAccount(client, ids[0]), until)); return tagAcct(one, ids[0]); }
  const parts = [], failed = []; let last = null;
  for (const id of ids) {
    try { const types = await purchaseTypes(client, id); parts.push(tagAcct(await inCtx(client, types, () => fetchEntitiesOne(forAccount(client, id), until)), id)); }
    catch (e) { failed.push(id); last = e; log(`${client.id}/meta: creatives for act_${id} skipped (${String(e.message || e).slice(0, 100)})`); }
  }
  if (!parts.length) throw last;
  const res = mergeEntityParts(parts); res.failed = failed; return res;
}
const tagAcct = (p, id) => { for (const k of ['campaigns', 'adsets', 'ads']) for (const x of p[k] || []) x.acct = id; return p; };
function mergeEntityParts(parts) {
  if (parts.length === 1) return parts[0];
  const cat = (k) => parts.flatMap((p) => p[k] || []);
  // The account card shows the worst status of the set, so a disabled second account is not hidden.
  const worst = parts.map((p) => p.account).sort((a, b) => (a.statusCode === 1) - (b.statusCode === 1))[0];
  return { ...parts[0], campaigns: cat('campaigns'), adsets: cat('adsets'), ads: cat('ads'), issues: cat('issues'), account: { ...worst, name: parts.map((p) => p.account?.name).filter(Boolean).join(' + '), amountSpent: parts.reduce((t, p) => t + (p.account?.amountSpent || 0), 0), accounts: parts.map((p) => p.account) } };
}
export async function testToken(client) { const r = await each(client, (c) => testTokenOne(c)); return r[0]; }
