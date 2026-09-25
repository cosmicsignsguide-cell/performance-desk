import { config } from './config.js';

// Dates are handled as YYYY-MM-DD strings in the desk timezone (IST by default).
export function todayStr(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return now.toLocaleDateString('en-CA', { timeZone: config.tz }); // en-CA gives YYYY-MM-DD
}
export function dateStr(d) { return d.toLocaleDateString('en-CA', { timeZone: config.tz }); }
export function addDays(str, n) { const d = new Date(str + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
export function nowIso() { return new Date().toISOString(); }
export function tzOffset(date = new Date()) { const s = date.toLocaleString('en-US', { timeZone: config.tz, timeZoneName: 'longOffset' }); const m = s.match(/GMT([+-]\d{2}:\d{2})?/); return m && m[1] ? m[1] : '+00:00'; }

export const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

export async function fetchJson(url, opts = {}, { retries = 3, label = 'http' } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
      if (r.ok) return body;
      const msg = body?.error?.message || body?.error?.error_description || body?.errors?.[0]?.message || body?.error || text.slice(0, 300);
      const retryable = r.status === 429 || r.status >= 500 || /rate|limit|temporar/i.test(String(msg));
      lastErr = new Error(`${label} ${r.status}: ${msg}`);
      if (!retryable || i === retries) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (i === retries) throw e;
    }
    await new Promise((res) => setTimeout(res, 1500 * 2 ** i));
  }
  throw lastErr;
}

export function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// Empty daily row: every source writes the same shape so the dashboard can sum blindly.
export function emptyDaily(clientId, date, platform) {
  return {
    clientId, date, platform,
    spend: 0, impressions: 0, clicks: 0,
    purchases: 0, revenue: 0, leads: 0,
    // Meta pixel funnel (ads traffic only)
    lpv: 0, atc: 0, ic: 0,
    // Shopify
    orders: 0, grossSales: 0, netSales: 0, refunds: 0, newCustomerOrders: 0, units: 0, checkoutsStarted: 0,
    // GA4 (whole site)
    sessions: 0, ga4Atc: 0, ga4Checkouts: 0, ga4Purchases: 0,
    updatedAt: nowIso(),
  };
}
