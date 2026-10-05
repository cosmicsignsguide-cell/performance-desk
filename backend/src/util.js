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
      // Google Ads searchStream answers with an ARRAY, so the error sits at body[0].error, and the
      // part worth reading (errorCode) is buried in details[].errors[] far past any short
      // truncation. Unwrap both so a failure says what is actually wrong instead of the generic
      // "The caller does not have permission".
      const b0 = Array.isArray(body) ? body[0] : body;
      const gaFail = (b0?.error?.details || []).find((d) => String(d['@type'] || '').includes('GoogleAdsFailure'));
      const gaMsg = (gaFail?.errors || []).map((e) => `${JSON.stringify(e.errorCode)} ${e.message || ''}`.trim()).join(' | ');
      const msg = gaMsg || b0?.error?.message || b0?.error?.error_description || b0?.errors?.[0]?.message || b0?.error || text.slice(0, 600);
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
    // App-install clients: the outcome Meta reports is an install, not a purchase or a lead.
    installs: 0,
    // Meta pixel funnel (ads traffic only)
    lpv: 0, atc: 0, ic: 0,
    // Shopify
    orders: 0, grossSales: 0, netSales: 0, totalSales: 0, taxes: 0, discounts: 0, refunds: 0, newCustomerOrders: 0, units: 0, checkoutsStarted: 0,
    // Orders by the source the STORE recorded, not by what a platform claims it caused.
    srcMeta: 0, srcGoogle: 0, srcDirect: 0, srcOther: 0, srcUnknown: 0, srcNone: 0,
    // GA4 (whole site)
    sessions: 0, ga4Atc: 0, ga4Checkouts: 0, ga4Purchases: 0,
    updatedAt: nowIso(),
  };
}
