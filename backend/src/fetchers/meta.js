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

import { config } from '../config.js';
import { emptyDaily, log, num, nowIso, round, addDays } from '../util.js';

const BASE = () => `https://graph.facebook.com/${config.meta.apiVersion}`;
export const ENTITY_DAYS = 35;

function act(v, types) {
  if (!Array.isArray(v)) return 0;
  for (const t of types) { const hit = v.find((x) => x.action_type === t); if (hit) return num(hit.value); }
  return 0;
}
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const LEAD = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const INSTALL = ['omni_app_install', 'mobile_app_install', 'app_install'];
const LPV = ['landing_page_view'];
const ATC = ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];
const IC = ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'];
const V3S = ['video_view'];

const INSIGHT_FIELDS = 'spend,impressions,clicks,frequency,reach,actions,action_values,video_play_actions,video_thruplay_watched_actions';
const DAILY_FIELDS = 'spend,impressions,clicks,actions,action_values';

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
let cooldownUntil = 0;

function readUsage(headers) {
  const raw = headers.get('x-business-use-case-usage') || headers.get('x-ad-account-usage') || headers.get('x-app-usage');
  if (!raw) return;
  let parsed; try { parsed = JSON.parse(raw); } catch { return; }
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  for (const u of entries) {
    if (!u || typeof u !== 'object') continue;
    const pct = Math.max(num(u.call_count), num(u.total_cputime), num(u.total_time));
    const regain = num(u.estimated_time_to_regain_access);
    if (regain > 0) cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(regain * 60000, MAX_WAIT_MS));
    else if (pct >= 90) cooldownUntil = Math.max(cooldownUntil, Date.now() + 60000);
    else if (pct >= 75) cooldownUntil = Math.max(cooldownUntil, Date.now() + 15000);
  }
}

async function metaGet(url) {
  for (let attempt = 0; ; attempt++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) { log(`meta: pacing, waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); }
    let r, text;
    try { r = await fetch(url); text = await r.text(); }
    catch (e) { if (attempt >= 3) throw e; await sleep(3000 * (attempt + 1)); continue; }
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    readUsage(r.headers);
    if (r.ok) return body;
    const err = body?.error || {};
    const msg = err.message || String(body.raw || text).slice(0, 300);
    const rateLimited = RATE_CODES.includes(err.code) || /request limit reached|rate limit|too many calls/i.test(msg);
    if (rateLimited && attempt < 3) {
      const backoff = Math.min([45000, 90000, 180000][attempt], MAX_WAIT_MS);
      log(`meta: rate limited (code ${err.code || r.status}), waiting ${backoff / 1000}s`);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
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
    const body = await metaGet(next);
    out.push(...(body.data || []));
    next = body.paging?.next || null;
  }
  return out;
}

// Meta answers a query it considers too heavy with a 500 and this message. Retrying the same query
// never helps; the range has to get smaller. So we halve the window and ask twice, as deep as needed.
const TOO_MUCH = /reduce the amount of data|please reduce|too much data|unknown error/i;
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
  row.purchases = act(r.actions, PURCHASE); row.revenue = act(r.action_values, PURCHASE);
  row.leads = act(r.actions, LEAD);
  row.installs = act(r.actions, INSTALL);
  row.lpv = act(r.actions, LPV); row.atc = act(r.actions, ATC); row.ic = act(r.actions, IC);
  return row;
}

// Daily account-level rows between two dates (inclusive).
export async function fetchDaily(client, since, until) {
  const accountId = client.accounts.meta;
  const data = await pagedRange(
    (s, u) => insightsUrl(accountId, { level: 'account', time_increment: '1', time_range: JSON.stringify({ since: s, until: u }) }),
    since, until);
  return data.map((r) => rowFromInsight(client.id, r));
}

function metrics(r) {
  const spend = num(r.spend), imp = num(r.impressions), clicks = num(r.clicks);
  return {
    spend, impressions: imp, clicks,
    purchases: act(r.actions, PURCHASE), revenue: act(r.action_values, PURCHASE), leads: act(r.actions, LEAD),
    installs: act(r.actions, INSTALL),
    freq: round(num(r.frequency), 2),
    ctr: imp ? round(clicks / imp * 100, 2) : 0,
    cpm: imp ? round(spend / imp * 1000, 2) : 0,
    v3s: act(r.actions, V3S),
    thruplays: act(r.video_thruplay_watched_actions, ['video_view']),
    plays: act(r.video_play_actions, ['video_view']),
  };
}
// Seventh slot is installs. Appended rather than inserted so tuples already stored stay readable.
const dayTuple = (r) => [round(num(r.spend)), num(r.impressions), num(r.clicks), act(r.actions, PURCHASE), round(act(r.action_values, PURCHASE)), act(r.actions, LEAD), act(r.actions, INSTALL)];
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
export async function fetchTodayDays(client, today) {
  const accountId = client.accounts.meta;
  const ins = (level, idField) => (s, u) => insightsUrl(accountId, { level, time_increment: '1', fields: DAILY_FIELDS + ',' + idField, time_range: JSON.stringify({ since: s, until: u }) });
  const [camp, set, ad] = await pool([
    () => pagedRange(ins('campaign', 'campaign_id'), today, today),
    () => pagedRange(ins('adset', 'adset_id'), today, today),
    () => pagedRange(ins('ad', 'ad_id'), today, today),
  ], 2);
  return { campaign: daysMap(camp, 'campaign_id'), adset: daysMap(set, 'adset_id'), ad: daysMap(ad, 'ad_id') };
}

// Campaigns, ad sets and ads: 30 day totals, per-day tuples for the last ENTITY_DAYS days, statuses, budgets, issues.
export async function fetchEntities(client, until) {
  const accountId = client.accounts.meta;
  const since = addDays(until, -29);
  const dSince = addDays(until, -(ENTITY_DAYS - 1)), dUntil = addDays(until, 1); // includes today
  const q = (fields, extra = {}) => new URLSearchParams({ access_token: config.meta.token, fields, limit: '100', ...extra });
  const ins = (level, fields, extra = {}) => (s, u) => insightsUrl(accountId, { level, time_range: JSON.stringify({ since: s, until: u }), fields, ...extra });
  const [camps, sets, adsIns, ads7, ads14, campDays, setDays, adDays, adsetObjs, adObjs, campObjs, account] = await pool([
    () => pagedRange(ins('campaign', INSIGHT_FIELDS + ',campaign_id,campaign_name'), since, until),
    () => pagedRange(ins('adset', INSIGHT_FIELDS + ',adset_id,adset_name,campaign_id,campaign_name'), since, until),
    () => pagedRange(ins('ad', INSIGHT_FIELDS + ',ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name'), since, until),
    () => pagedRange(ins('ad', 'spend,impressions,clicks,frequency,ad_id'), addDays(until, -6), until),
    () => pagedRange(ins('ad', 'spend,impressions,clicks,frequency,ad_id'), addDays(until, -13), addDays(until, -7)),
    () => pagedRange(ins('campaign', DAILY_FIELDS + ',campaign_id', { time_increment: '1' }), dSince, dUntil),
    () => pagedRange(ins('adset', DAILY_FIELDS + ',adset_id', { time_increment: '1' }), dSince, dUntil),
    () => pagedRange(ins('ad', DAILY_FIELDS + ',ad_id', { time_increment: '1' }), dSince, dUntil),
    () => paged(`${BASE()}/act_${accountId}/adsets?${q('id,name,campaign_id,effective_status,learning_stage_info,daily_budget,lifetime_budget,optimization_goal')}`),
    () => paged(`${BASE()}/act_${accountId}/ads?${q('id,name,adset_id,effective_status,created_time,issues_info,preview_shareable_link,creative.thumbnail_width(480).thumbnail_height(480){object_type,thumbnail_url,video_id,image_url,instagram_permalink_url,effective_object_story_id}')}`),
    () => paged(`${BASE()}/act_${accountId}/campaigns?${q('id,name,effective_status,objective,daily_budget,lifetime_budget,bid_strategy')}`),
    () => metaGet(`${BASE()}/act_${accountId}?${q('name,account_status,disable_reason,currency,amount_spent,spend_cap,timezone_name')}`),
  ], 2);
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
  // Campaigns that had no spend in the last 30 days but are active still matter (paused/new ones with budget)
  for (const c of campObjs) if (!campaigns.some((x) => x.id === c.id) && c.effective_status === 'ACTIVE') campaigns.push({ id: c.id, name: c.name, platform: 'meta', status: c.effective_status, objective: c.objective || '', ...budgetOf(c), budgetLevel: c.daily_budget || c.lifetime_budget ? 'campaign' : 'adset', ...metrics({}), days: cDays[c.id] || {} });

  const adsets = sets.map((r) => {
    const info = setInfo[r.adset_id] || {};
    return { id: r.adset_id, name: r.adset_name, campaignId: r.campaign_id, campaignName: r.campaign_name, status: info.effective_status || '', learning: info.learning_stage_info?.status || '', optimization: info.optimization_goal || '', ...budgetOf(info), ...metrics(r), days: sDays[r.adset_id] || {} };
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
      ...m, last7: mk(a7), prev7: mk(a14), days: aDays[r.ad_id] || {},
    };
  });
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

export async function testToken(client) {
  const q = new URLSearchParams({ access_token: config.meta.token, fields: 'name,currency,account_status,timezone_name' });
  const body = await metaGet(`${BASE()}/act_${client.accounts.meta}?${q}`);
  log(`meta ok: ${body.name} (${body.currency}, status ${body.account_status}, ${body.timezone_name})`);
  return body;
}
