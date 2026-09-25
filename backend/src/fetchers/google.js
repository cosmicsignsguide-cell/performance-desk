// Google Ads API fetcher (REST, GAQL). Read-only.
// Needs: developer token (Basic access), OAuth client id/secret + refresh token for a Google account
// that is a user on the MCC, the MCC id as login customer id, and the client's customer id in clients.json.

import { config } from '../config.js';
import { fetchJson, emptyDaily, log, num, nowIso, round, addDays } from '../util.js';

let cachedToken = null; // {token, exp}
export const ENTITY_DAYS = 35;

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

export async function fetchDaily(client, since, until) {
  const rows = await gaql(client.accounts.google, `
    SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  const isE = client.type !== 'lead';
  return rows.map((r) => {
    const row = emptyDaily(client.id, r.segments.date, 'google');
    row.spend = round(micros(r.metrics.costMicros)); row.impressions = num(r.metrics.impressions); row.clicks = num(r.metrics.clicks);
    const conv = num(r.metrics.conversions);
    if (isE) { row.purchases = Math.round(conv); row.revenue = round(num(r.metrics.conversionsValue)); } else { row.leads = Math.round(conv); }
    return row;
  });
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
      SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign WHERE segments.date BETWEEN '${addDays(until, -(ENTITY_DAYS - 1))}' AND '${addDays(until, 1)}' AND metrics.cost_micros > 0`),
  ]);
  const days = {};
  for (const r of campDaily) {
    const id = String(r.campaign.id); const m = (days[id] = days[id] || {}); const conv = num(r.metrics.conversions);
    m[r.segments.date] = [round(micros(r.metrics.costMicros)), num(r.metrics.impressions), num(r.metrics.clicks), isE ? Math.round(conv) : 0, isE ? round(num(r.metrics.conversionsValue)) : 0, isE ? 0 : Math.round(conv)];
  }
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

export async function testToken(client) {
  const rows = await gaql(client.accounts.google, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
  const c = rows[0]?.customer || {};
  log(`google ads ok: ${c.descriptiveName} (${c.currencyCode}, ${c.timeZone})`);
  return c;
}
