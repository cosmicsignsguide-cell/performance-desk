// GA4 Data API fetcher (optional). Gives whole-site sessions and the store funnel
// (add_to_cart, begin_checkout, purchase). Uses the same Google OAuth refresh token as Google Ads,
// which must have been created with the analytics.readonly scope (the helper script asks for both).
// Set accounts.ga4 to the numeric property id in clients.json.

import { fetchJson, emptyDaily, log, num, nowIso } from '../util.js';
import { accessToken } from './google.js';

async function runReport(propertyId, body) {
  const token = await accessToken();
  return fetchJson(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, { label: 'ga4' });
}

export async function fetchDaily(client, since, until) {
  const pid = client.accounts.ga4;
  const [sessions, events] = await Promise.all([
    runReport(pid, { dateRanges: [{ startDate: since, endDate: until }], dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }] }),
    runReport(pid, { dateRanges: [{ startDate: since, endDate: until }], dimensions: [{ name: 'date' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['add_to_cart', 'begin_checkout', 'purchase', 'generate_lead'] } } } }),
  ]);
  const byDay = {};
  const fmt = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const row = (d) => (byDay[d] = byDay[d] || emptyDaily(client.id, d, 'ga4'));
  for (const r of sessions.rows || []) row(fmt(r.dimensionValues[0].value)).sessions = num(r.metricValues[0].value);
  for (const r of events.rows || []) {
    const d = fmt(r.dimensionValues[0].value), ev = r.dimensionValues[1].value, v = num(r.metricValues[0].value);
    const x = row(d);
    if (ev === 'add_to_cart') x.ga4Atc = v; else if (ev === 'begin_checkout') x.ga4Checkouts = v; else if (ev === 'purchase') x.ga4Purchases = v; else if (ev === 'generate_lead') x.leads = v;
  }
  return Object.values(byDay);
}

export async function testToken(client) {
  const r = await runReport(client.accounts.ga4, { dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }], metrics: [{ name: 'sessions' }] });
  log(`ga4 ok: property ${client.accounts.ga4}, sessions yesterday ${r.rows?.[0]?.metricValues?.[0]?.value ?? 0}`);
  return r;
}
