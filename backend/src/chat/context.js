// Builds the data block the chatbot answers from. Everything in it is read from the same documents
// the dashboard reads (rollup rows, the entity tree, signals, site watch, sync status), and the
// totals use the same arithmetic as the dashboard's own aggregator, so the bot cannot disagree
// with the screen. Missing values are written as "n/a" and the prompt says that means unavailable.
//
// Two shapes: a portfolio table of every active client when none is selected, and a deep block for
// one client when one is. A client block costs 4 reads, the portfolio costs about 4 per client, so
// both are cached for a minute: a chat of five questions is one set of reads, not five.

import { todayStr, addDays, round } from '../util.js';

const SUMS = ['spend', 'impressions', 'clicks', 'purchases', 'revenue', 'leads', 'lpv', 'atc', 'ic', 'orders', 'grossSales', 'netSales', 'totalSales', 'refunds', 'newCustomerOrders', 'units', 'checkoutsStarted', 'installs', 'sessions', 'shSessions', 'shAtc', 'srcMeta', 'srcGoogle'];
const ADS = ['meta', 'google'];

function agg(rows) {
  const o = {}; SUMS.forEach((k) => { o[k] = 0; });
  let hasShop = false, hasGa = false;
  for (const r of rows) { SUMS.forEach((k) => { o[k] += r[k] || 0; }); if (r.platform === 'shopify') hasShop = true; if (r.platform === 'ga4') hasGa = true; }
  o.hasShop = hasShop; o.hasGa = hasGa;
  o.ctr = o.impressions ? o.clicks / o.impressions * 100 : null;
  o.cpm = o.impressions ? o.spend / o.impressions * 1000 : null;
  o.cpc = o.clicks ? o.spend / o.clicks : null;
  o.sales = Math.max(o.totalSales || 0, o.netSales || 0);
  o.roas = o.spend ? o.revenue / o.spend : null;
  o.mer = hasShop && o.spend ? o.netSales / o.spend : null;
  const cnt = hasShop ? o.orders : o.purchases;
  o.cpa = cnt ? o.spend / cnt : null;
  o.cac = hasShop && o.newCustomerOrders ? o.spend / o.newCustomerOrders : null;
  o.aov = hasShop && o.orders ? o.netSales / o.orders : (o.purchases ? o.revenue / o.purchases : null);
  o.coverage = hasShop && o.orders ? o.purchases / o.orders : null;
  o.cpl = o.leads ? o.spend / o.leads : null;
  o.cpi = o.installs ? o.spend / o.installs : null;
  o.newShare = hasShop && o.orders ? o.newCustomerOrders / o.orders * 100 : null;
  o.abandoned = hasShop ? Math.max(0, o.checkoutsStarted - o.orders) : null;
  o.storeCvr = o.hasGa && o.sessions ? (o.hasShop ? o.orders : 0) / o.sessions * 100 : null;
  return o;
}

const NA = 'n/a';
const n0 = (v) => (v == null || !Number.isFinite(v) ? NA : Math.round(v).toLocaleString('en-IN'));
const n1 = (v) => (v == null || !Number.isFinite(v) ? NA : String(round(v, 1)));
const n2 = (v) => (v == null || !Number.isFinite(v) ? NA : String(round(v, 2)));
const pct = (v) => (v == null || !Number.isFinite(v) ? NA : round(v, 1) + '%');
const xx = (v) => (v == null || !Number.isFinite(v) ? NA : round(v, 2) + 'x');
function money(v, cur = 'INR') {
  if (v == null || !Number.isFinite(v)) return NA;
  if (cur === 'INR') {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e7) return `${s}Rs ${round(a / 1e7, 2)}Cr`;
    if (a >= 1e5) return `${s}Rs ${round(a / 1e5, 2)}L`;
    return `${s}Rs ${Math.round(a).toLocaleString('en-IN')}`;
  }
  return `${cur} ${Math.round(v).toLocaleString('en-US')}`;
}

function windows(today) {
  const y = addDays(today, -1);
  const mtdStart = today.slice(0, 8) + '01';
  return {
    today: [today, today],
    yesterday: [y, y],
    last7: [addDays(y, -6), y],
    prev7: [addDays(y, -13), addDays(y, -7)],
    last30: [addDays(y, -29), y],
    mtd: [mtdStart, today],
  };
}
const inWin = (rows, [a, b]) => rows.filter((r) => r.date >= a && r.date <= b);
function daysIn(days, [a, b]) {
  const o = { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, leads: 0, installs: 0 };
  for (const d in days || {}) if (d >= a && d <= b) { const t = days[d]; o.spend += t[0] || 0; o.impressions += t[1] || 0; o.clicks += t[2] || 0; o.purchases += t[3] || 0; o.revenue += t[4] || 0; o.leads += t[5] || 0; o.installs += t[6] || 0; }
  return o;
}

const kpiLine = (c, a) => (c.type === 'ecom' ? `ROAS ${xx(a.roas)}` : c.type === 'app' ? `CPI ${money(a.cpi, c.currency)}` : `CPL ${money(a.cpl, c.currency)}`);
const kpiTarget = (c) => (c.type === 'ecom' ? c.target?.roas : c.type === 'app' ? c.target?.cpi : c.target?.cpl);
const targetText = (c) => { const t = kpiTarget(c); return t ? (c.type === 'ecom' ? `${t}x ROAS` : `${money(t, c.currency)} ${c.type === 'app' ? 'CPI' : 'CPL'}`) : 'not set'; };

function pacing(c, mtdSpend, today) {
  const day = parseInt(today.slice(8), 10);
  const dim = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
  const projected = day ? mtdSpend / day * dim : 0;
  return { day, dim, projected, pctBudget: c.budget ? mtdSpend / c.budget * 100 : null, projPct: c.budget ? projected / c.budget * 100 : null };
}

const cache = new Map();
const TTL = 60 * 1000;
async function cached(key, fn) {
  const hitv = cache.get(key);
  if (hitv && Date.now() - hitv.at < TTL) return hitv.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return v;
}

async function loadClientDocs(store, id) {
  const [rollup, signals, site, syncs] = await Promise.all([store.get('rollup', id), store.get('signals', id), store.get('sitewatch', id), store.get('syncs', id)]);
  return { rows: rollup?.rows || [], signals, site, syncs };
}

// ---------- portfolio ----------
export async function portfolioContext(store, clients) {
  return cached('portfolio:' + clients.map((c) => c.id).join(','), async () => {
    const today = todayStr(), W = windows(today);
    const lines = [`PORTFOLIO as of ${today} (IST). ${clients.length} active clients. Spend is Meta plus Google. "7d" is the 7 full days ending yesterday. MTD includes today.`, ''];
    const docs = await Promise.all(clients.map(async (c) => ({ c, d: await loadClientDocs(store, c.id) })));
    let tot7 = 0, totMtd = 0;
    for (const { c, d } of docs) {
      const ad = d.rows.filter((r) => ADS.includes(r.platform));
      const a7 = agg(inWin(d.rows, W.last7)), p7 = agg(inWin(d.rows, W.prev7)), mtd = agg(inWin(d.rows, W.mtd)), yst = agg(inWin(d.rows, W.yesterday));
      const pc = pacing(c, mtd.spend, today);
      const sigs = (d.signals?.items || []);
      const crit = sigs.filter((i) => i.severity === 'critical'), warn = sigs.filter((i) => i.severity === 'warning');
      const parts = [
        `${c.name} [id ${c.id}] ${c.type}, ${c.currency}`,
        `budget ${c.budget ? money(c.budget, c.currency) : 'not set'}`,
        `MTD spend ${money(mtd.spend, c.currency)}${pc.pctBudget != null ? ` (${n0(pc.pctBudget)}% of budget, projected ${n0(pc.projPct)}%)` : ''}`,
        `7d spend ${money(a7.spend, c.currency)} (prev 7d ${money(p7.spend, c.currency)})`,
        `7d ${kpiLine(c, a7)} vs target ${targetText(c)} (prev 7d ${c.type === 'ecom' ? xx(p7.roas) : c.type === 'app' ? money(p7.cpi, c.currency) : money(p7.cpl, c.currency)})`,
      ];
      if (c.type === 'ecom') parts.push(a7.hasShop ? `7d orders ${n0(a7.orders)}, net sales ${money(a7.netSales, c.currency)}, MER ${xx(a7.mer)}` : '7d store data n/a');
      else if (c.type === 'lead') parts.push(`7d leads ${n0(a7.leads)}`);
      else parts.push(`7d installs ${n0(a7.installs)}`);
      parts.push(`yesterday spend ${money(yst.spend, c.currency)}`);
      if (!ad.length) parts.push('NO AD DATA YET');
      parts.push(crit.length ? `CRITICAL: ${crit.map((i) => i.message).join(' | ')}` : warn.length ? `warnings: ${warn.slice(0, 2).map((i) => i.message).join(' | ')}` : 'no active alerts');
      if (d.site && d.site.ok === false) parts.push('SITE CHECK FAILING');
      const bad = Object.entries(d.syncs || {}).filter(([k, v]) => v && typeof v === 'object' && v.ok === false && v.mode === 'error').map(([k]) => k);
      if (bad.length) parts.push(`sync errors: ${bad.join(', ')}`);
      lines.push('- ' + parts.join('; '));
      if (c.currency === 'INR') { tot7 += a7.spend; totMtd += mtd.spend; }
    }
    lines.push('', `Combined INR clients: 7d spend ${money(tot7)}, MTD spend ${money(totMtd)}.`);
    return lines.join('\n');
  });
}

// ---------- one client ----------
export async function clientContext(store, client, notes) {
  return cached('client:' + client.id + ':' + notes.length, async () => {
    const c = client, cur = c.currency || 'INR', today = todayStr(), W = windows(today);
    const [d, ent] = await Promise.all([loadClientDocs(store, c.id), store.get('entities', c.id)]);
    const E = ent || {};
    const L = [];
    if (notes.length) {
      L.push(`--- CLIENT NOTES FROM THE TEAM (${notes.length}). These override anything you infer from the numbers. ---`);
      notes.forEach((n, i) => L.push(`### Note ${i + 1}: ${n.title}\n${n.content}`));
      L.push('');
    }
    L.push(`--- CLIENT: ${c.name} [id ${c.id}] ---`);
    L.push(`Type: ${c.type === 'ecom' ? 'Ecommerce (Shopify)' : c.type === 'app' ? 'App installs' : 'Lead generation'}. Currency ${cur}. Monthly ads budget ${c.budget ? money(c.budget, cur) : 'not set'}. Target: ${targetText(c)}. Account manager: ${c.am || 'n/a'}. Site: ${c.site?.url || 'n/a'}.`);
    const src = [c.accounts?.meta && 'Meta', c.accounts?.google && 'Google Ads', c.accounts?.shopify && 'Shopify', c.accounts?.ga4 && 'GA4'].filter(Boolean);
    L.push(`Connected sources: ${src.join(', ') || 'none'}.`);
    const syncText = Object.entries(d.syncs || {}).filter(([k, v]) => v && typeof v === 'object' && v.at).map(([k, v]) => `${k}: ${v.ok === false ? 'FAILING (' + String(v.error || '').slice(0, 120) + ')' : 'ok'} at ${String(v.at).slice(0, 16).replace('T', ' ')} UTC`);
    if (syncText.length) L.push('Sync status: ' + syncText.join('; ') + '.');
    if (E.account) L.push(`Meta account: ${E.account.name || ''}, status ${E.account.status || 'n/a'}, timezone ${E.account.timezone || 'n/a'}.`);
    L.push('');

    // Period totals
    const names = [['Today so far', W.today], ['Yesterday', W.yesterday], ['Last 7d', W.last7], ['Prev 7d', W.prev7], ['Last 30d', W.last30], ['Month to date', W.mtd]];
    L.push(`PERIOD TOTALS (today is ${today}; 7d and 30d end yesterday):`);
    for (const [label, w] of names) {
      const rows = inWin(d.rows, w), a = agg(rows.filter((r) => ADS.includes(r.platform) || r.platform === 'shopify' || r.platform === 'ga4'));
      const me = agg(rows.filter((r) => r.platform === 'meta')), go = agg(rows.filter((r) => r.platform === 'google'));
      const bits = [`spend ${money(a.spend, cur)} (Meta ${money(me.spend, cur)}, Google ${money(go.spend, cur)})`];
      if (c.type === 'ecom') {
        bits.push(`platform revenue ${money(a.revenue, cur)}, ROAS ${xx(a.roas)}`);
        bits.push(a.hasShop ? `Shopify orders ${n0(a.orders)}, net sales ${money(a.netSales, cur)}, MER ${xx(a.mer)}, AOV ${money(a.aov, cur)}, new-customer orders ${n0(a.newCustomerOrders)} (${pct(a.newShare)}), CAC ${money(a.cac, cur)}, refunds ${money(a.refunds, cur)}` : 'Shopify data n/a');
      } else if (c.type === 'app') {
        bits.push(`installs ${n0(a.installs)}, CPI ${money(a.cpi, cur)}`);
        if (a.purchases) bits.push(`in-app purchases ${n0(a.purchases)}`);
      } else {
        bits.push(`leads ${n0(a.leads)}, CPL ${money(a.cpl, cur)}`);
      }
      bits.push(`CTR ${pct(a.ctr)}, CPM ${money(a.cpm, cur)}, CPC ${money(a.cpc, cur)}`);
      if (c.type === 'ecom') bits.push(`funnel: landing page views ${n0(a.lpv)}, add to cart ${n0(a.atc)}, initiate checkout ${n0(a.ic)}, Shopify checkouts started ${n0(a.checkoutsStarted)}, abandoned ${n0(a.abandoned)}, platform purchases ${n0(a.purchases)}, tracking coverage ${pct(a.coverage != null ? a.coverage * 100 : null)}`);
      if (a.hasGa) bits.push(`GA4 sessions ${n0(a.sessions)}`);
      L.push(`- ${label} (${w[0]}${w[0] === w[1] ? '' : ' to ' + w[1]}): ` + bits.join('; '));
    }
    L.push('Per platform, last 30d: ' + ['meta', 'google'].map((p) => { const a = agg(inWin(d.rows, W.last30).filter((r) => r.platform === p)); return `${p} spend ${money(a.spend, cur)}, ${c.type === 'ecom' ? 'ROAS ' + xx(a.roas) : c.type === 'app' ? 'CPI ' + money(a.cpi, cur) : 'CPL ' + money(a.cpl, cur)}, CTR ${pct(a.ctr)}`; }).join(' | '));
    const m = agg(inWin(d.rows, W.mtd)), pc = pacing(c, m.spend, today);
    L.push(`PACING: month to date spend ${money(m.spend, cur)} on day ${pc.day} of ${pc.dim}. Projected month end ${money(pc.projected, cur)}${pc.projPct != null ? ` = ${n0(pc.projPct)}% of budget` : ' (budget not set)'}.`);
    L.push('');

    // Daily
    const dates = []; for (let i = 14; i >= 0; i--) dates.push(addDays(today, -i));
    L.push('DAILY, last 15 days (date | spend | ' + (c.type === 'ecom' ? 'platform ROAS | Shopify orders | net sales' : c.type === 'app' ? 'installs | CPI' : 'leads | CPL') + '):');
    for (const dt of dates) {
      const rows = d.rows.filter((r) => r.date === dt); if (!rows.length) continue;
      const a = agg(rows);
      L.push(`${dt}${dt === today ? ' (partial day)' : ''} | ${money(a.spend, cur)} | ` + (c.type === 'ecom' ? `${xx(a.roas)} | ${a.hasShop ? n0(a.orders) : NA} | ${a.hasShop ? money(a.netSales, cur) : NA}` : c.type === 'app' ? `${n0(a.installs)} | ${money(a.cpi, cur)}` : `${n0(a.leads)} | ${money(a.cpl, cur)}`));
    }
    L.push('');

    // Campaigns
    const isE = c.type === 'ecom';
    const res = (x) => (isE ? `ROAS ${xx(x.spend ? x.revenue / x.spend : null)}, purchases ${n0(x.purchases)}` : c.type === 'app' ? `installs ${n0(x.installs)}, CPI ${money(x.installs ? x.spend / x.installs : null, cur)}` : `leads ${n0(x.leads)}, CPL ${money(x.leads ? x.spend / x.leads : null, cur)}`);
    const camps = (E.campaigns || []).slice().sort((a, b) => (b.spend || 0) - (a.spend || 0)).slice(0, 12);
    if (camps.length) {
      L.push('CAMPAIGNS (30 day totals from the entity tree, top by spend; "today" and "7d" from per-day data):');
      for (const x of camps) {
        const t = daysIn(x.days, W.today), s7 = daysIn(x.days, W.last7);
        L.push(`- ${x.name} [${x.platform}, ${String(x.status || 'n/a').toLowerCase()}${x.dailyBudget ? ', daily budget ' + money(x.dailyBudget, cur) : ''}]: 30d spend ${money(x.spend, cur)}, ${res(x)}, CTR ${pct(x.ctr)}; 7d spend ${money(s7.spend, cur)}, ${res(s7)}; today ${money(t.spend, cur)}`);
      }
      L.push('');
    }
    const lim = (E.adsets || []).filter((s) => /FAIL|LIMITED/i.test(s.learning || '') && /ACTIVE/i.test(s.status || ''));
    if (lim.length) L.push('AD SETS LEARNING LIMITED: ' + lim.slice(0, 8).map((s) => s.name).join('; ') + '\n');

    // Ads
    const ads = (E.ads || []).slice().sort((a, b) => (b.spend || 0) - (a.spend || 0)).slice(0, 16);
    if (ads.length) {
      L.push('ADS (30 day totals, top by spend). Use the [[ad:id]] marker exactly as written when you name an ad. hook = 3s views / impressions, hold = thruplays / 3s views (video only).');
      for (const x of ads) {
        const t = daysIn(x.days, W.today), s7 = daysIn(x.days, W.last7);
        const dCtr = x.last7 && x.prev7 && x.prev7.ctr ? ((x.last7.ctr - x.prev7.ctr) / x.prev7.ctr * 100) : null;
        L.push(`- [[ad:${x.id}]] "${x.name}" [${x.format || 'n/a'}, ${String(x.status || 'n/a').toLowerCase()}${x.daysLive ? ', live ' + x.daysLive + 'd' : ''}]: 30d spend ${money(x.spend, cur)}, ${res(x)}, CTR ${pct(x.ctr)}, hook ${pct(x.hookRate)}, hold ${pct(x.holdRate)}, frequency ${n2(x.freq)}; 7d spend ${money(s7.spend, cur)}, 7d CTR ${pct(x.last7?.ctr)}, prev 7d CTR ${pct(x.prev7?.ctr)}${dCtr != null ? ` (${dCtr >= 0 ? '+' : ''}${n0(dCtr)}%)` : ''}, last7 frequency ${n2(x.last7?.freq)}; today ${money(t.spend, cur)}${(x.issues || []).length ? '; ISSUES: ' + x.issues.join(', ') : ''}`);
      }
      const zero = (E.ads || []).filter((x) => String(x.status || '').toUpperCase() === 'ACTIVE' && !(x.spend > 0)).length;
      if (zero) L.push(`(${zero} more active ads had no spend in the last 30 days.)`);
      L.push('');
    }
    const dis = (E.issues || []).slice(0, 8);
    if (dis.length) L.push('ACCOUNT ISSUES: ' + dis.map((i) => i.text).join(' | ') + '\n');

    // Products
    const prods = (E.products || []).slice(0, 10);
    if (prods.length) {
      L.push('TOP PRODUCTS (30 days): ' + prods.map((p) => `${p.title} (revenue ${money(p.revenue, cur)}, units ${n0(p.units)}, stock ${p.inventory == null ? NA : p.inventory})`).join('; ') + '\n');
    }

    // Signals + site
    const items = d.signals?.items || [];
    L.push('ACTIVE ALERTS: ' + (items.length ? items.map((i) => `[${i.severity}] ${i.message}`).join(' | ') : 'none') + '.');
    if (d.site) {
      const failed = (d.site.checks || []).filter((k) => !k.ok).map((k) => k.name + (k.detail ? ' (' + String(k.detail).slice(0, 80) + ')' : ''));
      L.push(`SITE WATCH: ${d.site.ok === false ? 'FAILING' : 'passing'} at ${String(d.site.at || '').slice(0, 16).replace('T', ' ')} UTC${failed.length ? '; failed checks: ' + failed.join(', ') : ''}.`);
    } else L.push('SITE WATCH: no check recorded.');
    L.push('', 'The extra detail not carried in this block (and so n/a): per-city or state results, audience age and gender, placement split, creative-level add to cart, page speed, CLV, and revenue by product before 30 days.');
    return L.join('\n');
  });
}

export function clearChatCache() { cache.clear(); }
