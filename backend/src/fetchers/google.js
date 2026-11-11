// Google Ads API fetcher (REST, GAQL). Read-only.
// Needs: developer token (Basic access), OAuth client id/secret + refresh token for a Google account
// that is a user on the MCC, the MCC id as login customer id, and the client's customer id in clients.json.

import { config } from '../config.js';
import { fetchJson, emptyDaily, log, num, nowIso, round, addDays } from '../util.js';

let cachedToken = null; // {token, exp}
export const ENTITY_DAYS = 95; // campaigns only, so Last month and the month before it work

export async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const body = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: config.google.refreshToken, grant_type: 'refresh_token' }),
  }, { retries: 1, label: 'google-oauth' });
  cachedToken = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function gaql(customerId, query) {
  const token = await accessToken();
  const url = `https://googleads.googleapis.com/${config.google.apiVersion}/customers/${customerId}/googleAds:searchStream`;
  const headers = { Authorization: `Bearer ${token}`, 'developer-token': config.google.developerToken, 'Content-Type': 'application/json' };
  if (config.google.loginCustomerId) headers['login-customer-id'] = config.google.loginCustomerId;
  const body = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify({ query }) }, { label: 'google-ads' });
  const chunks = Array.isArray(body) ? body : [body];   // searchStream returns an array of chunks with results[]
  return chunks.flatMap((c) => c.results || []);
}

const micros = (v) => num(v) / 1e6;

// A client can limit Google to campaigns whose name contains some text (campaignFilter.google).
const campFilter = (client) => String(client.campaignFilter?.google || '').trim().toLowerCase();
const keepCamp = (client, name) => { const f = campFilter(client); return !f || String(name || '').toLowerCase().includes(f); };
const DAY_METRICS = ['costMicros', 'impressions', 'clicks', 'conversions', 'conversionsValue', 'conversionsByConversionDate', 'conversionsValueByConversionDate'];

export async function fetchDaily(client, since, until) {
  let rows;
  if (!campFilter(client)) {
    rows = await gaql(client.accounts.google, `
      SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value,
             metrics.conversions_by_conversion_date, metrics.conversions_value_by_conversion_date
      FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  } else {
    // Filtered: pull per campaign and day, keep the matching campaigns, add them up per day.
    const camp = await gaql(client.accounts.google, `
      SELECT campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value,
             metrics.conversions_by_conversion_date, metrics.conversions_value_by_conversion_date
      FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`);
    const byDay = {};
    for (const r of camp) {
      if (!keepCamp(client, r.campaign?.name)) continue;
      const d = (byDay[r.segments.date] = byDay[r.segments.date] || { segments: { date: r.segments.date }, metrics: {} });
      for (const k of DAY_METRICS) d.metrics[k] = num(d.metrics[k]) + num(r.metrics[k]);
    }
    rows = Object.values(byDay);
    log(`google ${client.id}: only campaigns containing "${campFilter(client)}" (${new Set(camp.filter((r) => keepCamp(client, r.campaign?.name)).map((r) => r.campaign.name)).size} of ${new Set(camp.map((r) => r.campaign?.name)).size} with activity)`);
  }
  const isE = client.type !== 'lead';
  const funnel = isE ? await funnelByDay(client, since, until) : {};
  return rows.map((r) => {
    const row = emptyDaily(client.id, r.segments.date, 'google');
    row.spend = round(micros(r.metrics.costMicros)); row.impressions = num(r.metrics.impressions); row.clicks = num(r.metrics.clicks);
    const conv = num(r.metrics.conversions);
    if (isE) { row.purchases = Math.round(conv); row.revenue = round(num(r.metrics.conversionsValue)); } else { row.leads = Math.round(conv); }
    // Google's "by conversion time" columns: each conversion is put on the day it happened, not on
    // the day of the ad click behind it (the default above). Kept apart in gConvT and gValT.
    row.gConvT = round(num(r.metrics.conversionsByConversionDate), 2); row.gValT = round(num(r.metrics.conversionsValueByConversionDate));
    // Explicit zeros on days without funnel actions, so a merge never leaves a stale count behind.
    if (isE) Object.assign(row, { gLpv: 0, gAtc: 0, gIc: 0 }, funnel[r.segments.date] || {});
    return row;
  });
}

// The Google side of the funnel. Google Ads has no landing page view metric of its own, so these
// come from the account's conversion actions by category (page view, add to cart, begin checkout),
// counted with all_conversions because those steps are normally set as secondary actions and
// never show in "conversions". Kept in their own fields (gLpv, gAtc, gIc) so they never mix with
// Meta's pixel counts in lpv/atc/ic. An account with no such actions just reports zeros, and the
// dashboard says so instead of guessing.
async function funnelByDay(client, since, until) {
  try {
    const rows = await gaql(client.accounts.google, campFilter(client) ? `
      SELECT campaign.name, segments.date, segments.conversion_action_category, metrics.all_conversions
      FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'` : `
      SELECT segments.date, segments.conversion_action_category, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`);
    const key = { PAGE_VIEW: 'gLpv', ADD_TO_CART: 'gAtc', BEGIN_CHECKOUT: 'gIc' };
    const out = {};
    for (const r of rows) {
      if (r.campaign && !keepCamp(client, r.campaign.name)) continue;
      const k = key[r.segments.conversionActionCategory]; if (!k) continue;
      const d = (out[r.segments.date] = out[r.segments.date] || { gLpv: 0, gAtc: 0, gIc: 0 });
      d[k] += Math.round(num(r.metrics.allConversions));
    }
    return out;
  } catch (e) {
    log(`google ${client.id}: funnel actions unavailable (${String(e.message || e).slice(0, 120)})`);
    return {};
  }
}

// Spend per campaign per day, for the Order sources view (see meta.fetchCampaignSpend).
export async function fetchCampaignSpend(client, since, until) {
  const rows = await gaql(client.accounts.google, `
    SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros
    FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.cost_micros > 0`);
  const out = {};
  for (const r of rows) { const sp = round(micros(r.metrics.costMicros)); if (!sp || !keepCamp(client, r.campaign.name)) continue; (out[r.segments.date] = out[r.segments.date] || []).push([String(r.campaign.id), r.campaign.name || '', sp]); }
  return out;
}

export async function fetchEntities(client, until) {
  const since = addDays(until, -29);
  const isE = client.type !== 'lead';
  const [camp, campDaily] = await Promise.all([
    gaql(client.accounts.google, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND campaign.status != 'REMOVED'`),
    gaql(client.accounts.google, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign WHERE segments.date BETWEEN '${addDays(until, -(ENTITY_DAYS - 1))}' AND '${addDays(until, 1)}' AND metrics.cost_micros > 0`),
  ]);
  // Campaigns outside the client's filter are dropped from the tree as well.
  for (const list of [camp, campDaily]) for (let i = list.length - 1; i >= 0; i--) if (!keepCamp(client, list[i].campaign?.name)) list.splice(i, 1);
  const days = {};
  for (const r of campDaily) {
    const id = String(r.campaign.id); const m = (days[id] = days[id] || {}); const conv = num(r.metrics.conversions);
    m[r.segments.date] = [round(micros(r.metrics.costMicros)), num(r.metrics.impressions), num(r.metrics.clicks), isE ? Math.round(conv) : 0, isE ? round(num(r.metrics.conversionsValue)) : 0, isE ? 0 : Math.round(conv)];
  }
  // Campaigns that spent only before the last 30 days (last month) come from the per-day rows.
  const seen = new Set(camp.map((r) => String(r.campaign.id)));
  for (const r of campDaily) { const id = String(r.campaign.id); if (seen.has(id)) continue; seen.add(id); camp.push({ campaign: r.campaign, campaignBudget: {}, metrics: {} }); }
  const campaigns = camp.map((r) => {
    const spend = round(micros(r.metrics.costMicros)), imp = num(r.metrics.impressions), clicks = num(r.metrics.clicks), conv = num(r.metrics.conversions);
    const id = String(r.campaign.id);
    return {
      id, name: r.campaign.name, platform: 'google', status: r.campaign.status === 'ENABLED' ? 'ACTIVE' : r.campaign.status, channel: r.campaign.advertisingChannelType, dailyBudget: round(micros(r.campaignBudget?.amountMicros)), budgetLevel: 'campaign',
      spend, impressions: imp, clicks, purchases: isE ? Math.round(conv) : 0, revenue: isE ? round(num(r.metrics.conversionsValue)) : 0, leads: isE ? 0 : Math.round(conv),
      ctr: imp ? round(clicks / imp * 100, 2) : 0, cpm: imp ? round(spend / imp * 1000, 2) : 0, days: days[id] || {},
    };
  });
  return { campaigns, since, until, updatedAt: nowIso() };
}

// Every account under the manager (MCC) login, for the access check. Read only.
export async function listAccounts() {
  const rows = await gaql(config.google.loginCustomerId, 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager, customer_client.level FROM customer_client');
  return rows.map((r) => r.customerClient || {});
}
// Cost over the last 30 days for one account, for the access check. Read only.
export async function recentSpend(customerId) {
  const rows = await gaql(String(customerId), 'SELECT metrics.cost_micros FROM customer WHERE segments.date DURING LAST_30_DAYS');
  return rows.reduce((t, r) => t + num(r.metrics?.costMicros) / 1e6, 0);
}
export async function testToken(client) {
  const rows = await gaql(client.accounts.google, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
  const c = rows[0]?.customer || {};
  log(`google ads ok: ${c.descriptiveName} (${c.currencyCode}, ${c.timeZone})`);
  return c;
}
