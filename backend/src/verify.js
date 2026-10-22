// Reconciliation: checks the figures the dashboard stored against what Shopify itself reports.
//
// The dashboard is only trustworthy if a team member can open a client and see the same number
// Shopify shows. Stored rows can drift (an order lands late, a refund is issued, a sync is
// missed), so this compares the last completed days row by row and says out loud where they
// disagree. It reads only: nothing is rewritten here. A mismatch raises an alert on that client,
// so the dashboard itself warns before anyone quotes the figure.
import { dailyIdRange } from './db.js';
import { shopifyTokenFor } from './config.js';
import { salesByDay } from './fetchers/shopify.js';
import { raise } from './alerts.js';
import { addDays, todayStr, log } from './util.js';

const DAYS = 7;
const close = (a, b, tolAbs, tolPct) => Math.abs(a - b) <= Math.max(tolAbs, Math.abs(b) * tolPct);

export async function verifyShopify(store, clients, { only = '' } = {}) {
  const today = todayStr(), since = addDays(today, -DAYS), until = addDays(today, -1);
  const out = { checked: 0, clean: 0, mismatched: 0, skipped: 0, problems: [] };
  for (const c of clients) {
    if (only && c.id !== only) continue;
    if (c.sample || !c.accounts?.shopify?.shop || !shopifyTokenFor(c)) { out.skipped++; continue; }
    try {
      const truth = await salesByDay(c, since, until);
      if (!truth) { out.skipped++; log(`verify ${c.id}: Shopify reports unavailable for this token, not checked`); continue; }
      const rows = (await store.list('daily', dailyIdRange(c.id, since, until))).filter((r) => r.platform === 'shopify');
      const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
      const bad = [];
      for (let d = since; d <= until; d = addDays(d, 1)) {
        const t = truth[d] || { orders: 0, netSales: 0, totalSales: 0 }, s = byDate[d] || { orders: 0, netSales: 0, totalSales: 0 };
        if ((s.orders || 0) !== (t.orders || 0)) bad.push(`${d} orders ${s.orders || 0} stored vs ${t.orders || 0} Shopify`);
        if (!close(s.netSales || 0, t.netSales || 0, 1, 0.005)) bad.push(`${d} net sales ${Math.round(s.netSales || 0)} stored vs ${Math.round(t.netSales || 0)} Shopify`);
        if ((s.totalSales || 0) > 0 && !close(s.totalSales, t.totalSales || 0, 1, 0.005)) bad.push(`${d} total sales ${Math.round(s.totalSales)} stored vs ${Math.round(t.totalSales || 0)} Shopify`);
      }
      out.checked++;
      if (bad.length) {
        out.mismatched++; out.problems.push({ client: c.id, diffs: bad.slice(0, 8) });
        log(`verify MISMATCH ${c.id}: ${bad.slice(0, 8).join('; ')}`);
        await raise(c, 'verify-shopify', 'warning', `Stored Shopify figures differ from Shopify for ${bad.length} item${bad.length > 1 ? 's' : ''} in the last ${DAYS} days (${bad[0]}). Run a daily sync for this client before quoting numbers.`);
      } else { out.clean++; log(`verify ${c.id}: matches Shopify for ${since} to ${until}`); }
    } catch (e) { out.skipped++; log(`verify ${c.id}: could not check (${String(e.message || e).slice(0, 120)})`); }
  }
  return out;
}

// Meta reconciliation. Read only. Pulls the last completed days straight from Meta with the
// ad account's own (unified) attribution setting, the same view Ads Manager shows, and compares
// them with the rows the dashboard stored. Spend, impressions and clicks must match closely;
// purchases, revenue and leads can differ when the sync's attribution windows differ, so those
// are reported separately instead of being called wrong.
const pick = (v, types) => { if (!Array.isArray(v)) return 0; for (const t of types) { const h = v.find((x) => x.action_type === t); if (h) return parseFloat(h.value) || 0; } return 0; };
export async function verifyMeta(store, clients, { only = '' } = {}) {
  const { config } = await import('./config.js');
  const today = todayStr(), since = addDays(today, -DAYS), until = addDays(today, -1);
  const out = { checked: 0, clean: 0, mismatched: 0, skipped: 0, problems: [], notes: [] };
  for (const c of clients) {
    if (only && c.id !== only) continue;
    if (c.sample || !c.accounts?.meta || !config.meta.token) { out.skipped++; continue; }
    try {
      const q = new URLSearchParams({ access_token: config.meta.token, level: 'account', time_increment: '1', fields: 'spend,impressions,clicks,actions,action_values', time_range: JSON.stringify({ since, until }), limit: '100' });
      const r = await fetch(`https://graph.facebook.com/${config.meta.apiVersion}/act_${c.accounts.meta}/insights?${q}`);
      const body = await r.json();
      if (!r.ok) { out.skipped++; out.notes.push(`${c.id}: Meta said ${body?.error?.message?.slice(0, 90) || r.status}`); continue; }
      const truth = Object.fromEntries((body.data || []).map((x) => [x.date_start, x]));
      const rows = (await store.list('daily', dailyIdRange(c.id, since, until))).filter((x) => x.platform === 'meta');
      const byDate = Object.fromEntries(rows.map((x) => [x.date, x]));
      const bad = [], attr = [];
      for (let d = since; d <= until; d = addDays(d, 1)) {
        const t = truth[d] || {}, s = byDate[d] || {};
        const T = { spend: parseFloat(t.spend) || 0, imp: parseFloat(t.impressions) || 0, clk: parseFloat(t.clicks) || 0, pur: pick(t.actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']), rev: pick(t.action_values, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']), lead: pick(t.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']) };
        if (!close(s.spend || 0, T.spend, 1, 0.01)) bad.push(`${d} spend ${Math.round(s.spend || 0)} stored vs ${Math.round(T.spend)} Meta`);
        if (!close(s.clicks || 0, T.clk, 5, 0.02)) bad.push(`${d} clicks ${s.clicks || 0} vs ${T.clk}`);
        if (!close(s.purchases || 0, T.pur, 0, 0.02)) attr.push(`${d} purchases ${s.purchases || 0} vs ${T.pur}`);
        if (!close(s.revenue || 0, T.rev, 1, 0.02)) attr.push(`${d} revenue ${Math.round(s.revenue || 0)} vs ${Math.round(T.rev)}`);
        if (!close(s.leads || 0, T.lead, 0, 0.02)) attr.push(`${d} leads ${s.leads || 0} vs ${T.lead}`);
      }
      out.checked++;
      if (bad.length || attr.length) { out.mismatched++; out.problems.push({ client: c.id, spendOrTraffic: bad.slice(0, 6), conversions: attr.slice(0, 6) }); log(`verifymeta MISMATCH ${c.id}: ${[...bad, ...attr].slice(0, 4).join('; ')}`); }
      else { out.clean++; log(`verifymeta ${c.id}: matches Meta for ${since} to ${until}`); }
    } catch (e) { out.skipped++; out.notes.push(`${c.id}: ${String(e.message || e).slice(0, 100)}`); }
  }
  return out;
}
