// Leakage signals computed from the data already in the store. No API calls here.
// Each signal compares today (or the last few days) against the client's own baseline,
// so a school with 8 leads a day and a D2C brand with 200 orders a day get judged on their own numbers.
// Results go to signals/{clientId} for the dashboard and, when severe, to alerts.

import { config } from './config.js';
import { db } from './db.js';
import { addDays, todayStr, log, nowIso, round } from './util.js';
import { raise } from './alerts.js';

const ADS = ['meta', 'google'];
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

function hourNow() { return parseInt(new Date().toLocaleString('en-US', { timeZone: config.tz, hour: '2-digit', hour12: false }), 10) % 24; }

export async function computeSignals(client, entities, { mode = 'hourly' } = {}) {
  const store = await db();
  const today = todayStr();
  const since = addDays(today, -35);
  const rows = (await store.list('daily', [['clientId', '==', client.id], ['date', '>=', since]]));
  const on = (d, p) => rows.filter((r) => r.date === d && (p ? (Array.isArray(p) ? p.includes(r.platform) : r.platform === p) : true));
  const daysBack = (n, offset = 1) => Array.from({ length: n }, (_, i) => addDays(today, -(i + offset)));
  const isE = client.type !== 'lead';
  const items = [];
  const hour = hourNow();
  const dayFrac = Math.min(1, Math.max(0.05, hour / 24));
  const hasShopify = rows.some((r) => r.platform === 'shopify');
  const baselineDays = new Set(rows.map((r) => r.date)).size;

  // 1. No spend today after 10:00 local when yesterday had spend
  if (hour >= 10) {
    for (const p of ADS) {
      const y = sum(on(addDays(today, -1), p), 'spend'), t = sum(on(today, p), 'spend');
      if (y > 0 && t === 0 && on(today, p).length) items.push({ type: 'no-spend', severity: 'critical', message: `No ${p === 'meta' ? 'Meta' : 'Google'} spend today (yesterday ${Math.round(y)}). Check payment method, ad rejections and account status.`, value: 0, baseline: y });
    }
  }

  if (isE && hasShopify) {
    // 2. Checkout stuck: many checkouts started, very few completing, against this store's usual ratio
    const base = daysBack(14).map((d) => { const r = on(d, 'shopify'); const c = sum(r, 'checkoutsStarted'), o = sum(r, 'orders'); return c ? o / c : null; }).filter((x) => x !== null);
    const baseRatio = avg(base);
    const tr = on(today, 'shopify'); const tc = sum(tr, 'checkoutsStarted'), to = sum(tr, 'orders');
    if (baseRatio && tc >= 15 && to / tc < baseRatio * 0.35) items.push({ type: 'checkout-stuck', severity: 'critical', message: `${tc} checkouts started today, only ${to} orders (${Math.round(to / tc * 100)}% vs usual ${Math.round(baseRatio * 100)}%). Payment gateway or checkout issue likely. Test a checkout now.`, value: round(to / tc, 2), baseline: round(baseRatio, 2) });

    // 3. Orders far below the expected pace for this time of day, same weekday over the last 4 weeks
    const sameDow = [7, 14, 21, 28].map((n) => sum(on(addDays(today, -n), 'shopify'), 'orders')).filter((x) => x > 0);
    const expected = avg(sameDow) * dayFrac;
    if (dayFrac >= 0.4 && expected >= 5 && to < expected * 0.4) items.push({ type: 'orders-drop', severity: 'warning', message: `${to} orders so far today, normally about ${Math.round(expected)} by this hour. Not a tracking issue if checkouts are also down; check site and ads delivery.`, value: to, baseline: Math.round(expected) });

    // 4. Tracking mismatch: platform-reported purchases vs Shopify orders, last 3 full days vs 14-day baseline
    const cov = (days) => { const pp = days.reduce((s, d) => s + sum(on(d, ADS), 'purchases'), 0), so = days.reduce((s, d) => s + sum(on(d, 'shopify'), 'orders'), 0); return so ? pp / so : null; };
    const covBase = cov(daysBack(14, 4)), covNow = cov(daysBack(3));
    const ordersNow = daysBack(3).reduce((s, d) => s + sum(on(d, 'shopify'), 'orders'), 0);
    if (covBase && covNow !== null && ordersNow >= 10 && covNow < covBase * 0.6) items.push({ type: 'tracking-drop', severity: 'warning', message: `Ads platforms now attribute ${Math.round(covNow * 100)}% of Shopify orders, down from ${Math.round(covBase * 100)}%. Shopify is fine, tracking is not: check pixel, CAPI and the Shopify Meta/Google channel apps.`, value: round(covNow, 2), baseline: round(covBase, 2) });

    // 5. Low stock on a selling product
    for (const p of entities?.products || []) {
      if (p.inventory === null || p.inventory === undefined) continue;
      const perDay = (p.units7 || 0) / 7;
      if (perDay >= 1 && p.inventory / perDay < 5) items.push({ type: 'low-stock', severity: 'warning', message: `${p.title}: ${p.inventory} units left, selling ${round(perDay, 1)} a day. Ads pushing this SKU will hit sold out in about ${Math.max(0, Math.round(p.inventory / perDay))} days.`, value: p.inventory, baseline: round(perDay, 1) });
    }
  }

  if (!isE) {
    // 6. Lead volume drop: yesterday vs 14-day average
    const base = avg(daysBack(14, 2).map((d) => sum(on(d, ADS), 'leads')));
    const y = sum(on(addDays(today, -1), ADS), 'leads');
    if (base >= 5 && y < base * 0.4) items.push({ type: 'leads-drop', severity: 'warning', message: `${y} leads yesterday vs ${Math.round(base)} a day on average. Check the landing page form and lead form delivery first, then ads.`, value: y, baseline: Math.round(base) });
  }

  if (mode === 'daily') {
    // 7. Pacing
    const dom = parseInt(today.slice(8), 10), dim = new Date(parseInt(today.slice(0, 4)), parseInt(today.slice(5, 7)), 0).getDate();
    const mtdRows = rows.filter((r) => r.date >= today.slice(0, 8) + '01' && r.date < today && ADS.includes(r.platform));
    const mtd = sum(mtdRows, 'spend'); const expected = client.budget * (dom - 1) / dim; const projected = dom > 1 ? mtd / (dom - 1) * dim : 0;
    if (client.budget && dom > 5) {
      if (mtd > expected * 1.2) items.push({ type: 'overpacing', severity: 'warning', message: `Overpacing: projected ${Math.round(projected)} against a ${client.budget} budget. Confirm the client approved extra spend.`, value: Math.round(projected), baseline: client.budget });
      if (mtd < expected * 0.75) items.push({ type: 'underpacing', severity: 'warning', message: `Underpacing: projected ${Math.round(projected)} against a ${client.budget} budget. Scale winners or tell the client why you are holding.`, value: Math.round(projected), baseline: client.budget });
    }
    // 8. KPI vs target over the last 7 days
    const w = daysBack(7).flatMap((d) => on(d, ADS));
    const sp = sum(w, 'spend');
    // Only fires where a target was actually agreed. Raising "KPI miss" against a default
    // nobody set is noise that trains the team to ignore the flag it most needs to read.
    if (sp > 0) {
      if (isE && client.target?.roas) { const roas = sum(w, 'revenue') / sp; if (roas < client.target.roas * 0.8) items.push({ type: 'kpi-miss', severity: 'warning', message: `7-day ROAS ${round(roas, 2)}x against ${client.target.roas}x target.`, value: round(roas, 2), baseline: client.target.roas }); }
      else if (!isE && client.target?.cpl) { const leads = sum(w, 'leads'); const cpl = leads ? sp / leads : Infinity; if (cpl > client.target.cpl * 1.25) items.push({ type: 'kpi-miss', severity: 'warning', message: `7-day CPL ${Number.isFinite(cpl) ? Math.round(cpl) : 'n/a'} against ${client.target.cpl} target.`, value: Number.isFinite(cpl) ? Math.round(cpl) : null, baseline: client.target.cpl }); }
    }
    // 9. Creative fatigue and learning limited, from entities
    const fatigued = (entities?.ads || []).filter((a) => a.last7?.freq > 3.2 && a.prev7?.ctr && a.last7.ctr < a.prev7.ctr * 0.85 && a.prev7?.cpm && a.last7.cpm > a.prev7.cpm * 1.12 && a.last7.spend > 0);
    if (fatigued.length) items.push({ type: 'fatigue', severity: 'info', message: `${fatigued.length} creative${fatigued.length > 1 ? 's' : ''} fatiguing: ${fatigued.slice(0, 3).map((a) => a.name).join(', ')}. Brief a refresh.`, value: fatigued.length, baseline: 0 });
    const limited = (entities?.adsets || []).filter((s) => s.learning === 'FAIL' && s.spend > 0);
    if (limited.length) items.push({ type: 'learning-limited', severity: 'info', message: `${limited.length} ad set${limited.length > 1 ? 's' : ''} learning limited: ${limited.slice(0, 3).map((s) => s.name).join(', ')}.`, value: limited.length, baseline: 0 });
  }

  const doc = { clientId: client.id, computedAt: nowIso(), mode, baselineDays, items, sample: !!client.sample };
  const prev = (await store.get('signals', client.id)) || { items: [] };
  // Keep daily-only signals visible between daily runs.
  if (mode === 'hourly') doc.items = [...items, ...(prev.items || []).filter((i) => ['overpacing', 'underpacing', 'kpi-miss', 'fatigue', 'learning-limited'].includes(i.type))];
  await store.set('signals', client.id, doc);
  for (const it of items) if (it.severity === 'critical' && !client.sample) await raise(client, it.type, 'critical', it.message, { value: it.value, baseline: it.baseline });
  log(`signals ${client.id}: ${items.length ? items.map((i) => i.type).join(', ') : 'clean'} (baseline ${baselineDays} days)`);
  return doc;
}
