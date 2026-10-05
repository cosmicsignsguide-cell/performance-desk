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
