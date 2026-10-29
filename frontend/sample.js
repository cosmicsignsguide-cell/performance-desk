/* Sample data generator, shared by the backend (`seed`, and any source without a token)
   and by the dashboard's demo mode. Deterministic per client id, so numbers do not jump
   between runs. Produces exactly the shapes the real fetchers write. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeskSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function addDays(str, n) { const d = new Date(str + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const r2 = (v) => Math.round(v * 100) / 100;

  // Profiles keyed by client id give each sample client a personality. Unknown ids get a default.
  const PROFILES = {
    default: { cpm: 230, ctr: 1.6, pace: 1.0, aov: 1900, funnel: 1.0, drift: 0.0, orgShare: 0.22 },
    'sample-ecom': { cpm: 240, ctr: 1.5, pace: 1.06, aov: 1850, funnel: 1.0, drift: -0.18, orgShare: 0.22, outageDays: 0, fatigue: true },
    'sample-lead': { cpm: 170, ctr: 1.3, pace: 0.96, lcvr: 8.5, qual: 40, drift: 0.02, orgShare: 0 },
  };

  const CAMPAIGNS = {
    ecom: { meta: ['Prospecting | Advantage+ Shopping', 'Prospecting | Interest stack', 'Retargeting | Visitors + engagers 30d', 'Catalog | DPA cross-sell'], google: ['Search | Brand', 'Search | Category terms', 'Performance Max | Full catalog'] },
    lead: { meta: ['Leads | Broad | Instant form', 'Leads | Lookalike 2% | Landing page', 'Retargeting | Page visitors 14d'], google: ['Search | High intent', 'Search | Brand', 'Performance Max | Leads'] },
  };
  const ADSETS = ['Advantage+ audience', 'Broad 25 to 45, all placements', 'Interest stack A', 'Lookalike 2%', 'Visitors 30d', 'Engagers 60d', 'Broad 30 to 55, feeds only', 'Interest stack B'];
  const ADS = {
    ecom: [['Static | Before and after', 'Static'], ['Video | 30 day test | 15s', 'Video'], ['UGC | Unboxing | 22s', 'UGC'], ['Carousel | Top 4 SKUs', 'Carousel'], ['Static | Founder note', 'Static'], ['Video | Problem to reveal | 30s', 'Video'], ['Static | Price comparison', 'Static'], ['UGC | Gift reaction | 18s', 'UGC'], ['Static | Review wall', 'Static'], ['Video | How it is made | 20s', 'Video']],
    lead: [['Static | Fee comparison', 'Static'], ['Video | Walkthrough | 25s', 'Video'], ['UGC | Customer testimonial | 20s', 'UGC'], ['Static | Enquiries open', 'Static'], ['Carousel | Why us in 4 slides', 'Carousel'], ['Video | Founder explains | 30s', 'Video'], ['Static | Limited slots', 'Static'], ['Video | A day inside | 18s', 'Video']],
  };
  const PRODUCTS = ['Anti-tarnish Layered Necklace', 'Everyday Hoops (Gold)', 'Pearl Drop Earrings', 'Minimal Chain Bracelet', 'Zodiac Pendant', 'Stacking Rings Set of 3', 'Evil Eye Anklet', 'Statement Cuff', 'Gift Box Trio', 'Initial Necklace'];

  function empty(clientId, date, platform) {
    return { clientId, date, platform, spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, leads: 0, lpv: 0, atc: 0, ic: 0, orders: 0, grossSales: 0, netSales: 0, refunds: 0, newCustomerOrders: 0, units: 0, checkoutsStarted: 0, sessions: 0, ga4Atc: 0, ga4Checkouts: 0, ga4Purchases: 0, sample: true };
  }

  // Which platforms a client runs on: taken from accounts if present, else meta + google.
  function platformsOf(client) {
    const out = {};
    const a = client.accounts || {};
    const any = a.meta || a.google;
    if (!any || a.meta) out.meta = a.google || !any ? 0.7 : 1;
    if (!any || a.google) out.google = a.meta || !any ? 0.3 : 1;
    return out;
  }

  function buildDaily(client, endDate, days) {
    const p = Object.assign({}, PROFILES.default, PROFILES[client.id] || (client.type === 'lead' ? PROFILES['sample-lead'] : PROFILES['sample-ecom']));
    const rnd = mulberry32(hash(client.id + ':daily'));
    const pf = platformsOf(client);
    const isE = client.type !== 'lead';
    const target = isE ? (client.target?.roas || 3) : (client.target?.cpl || 500);
    const budget = client.budget || 300000;
    const rows = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = addDays(endDate, -d);
      const dow = new Date(date + 'T12:00:00Z').getUTCDay();
      const wk = (dow === 0 || dow === 6) ? 1.1 : 1;
      const prog = 1 - d / Math.max(1, days - 1);
      const driftMul = 1 + (p.drift || 0) * prog;             // conversion drift over the period
      const worsening = Math.max(0, -(p.drift || 0) * prog);
      const dayRows = {};
      let adsClicks = 0, adsSpend = 0;
      for (const plat of Object.keys(pf)) {
        const row = empty(client.id, date, plat);
        let spend = budget / 30 * pf[plat] * p.pace * wk * (0.85 + rnd() * 0.3);
        if (p.outageDays && d < p.outageDays && plat === 'meta') spend = 0;
        const cpm = p.cpm * (plat === 'google' ? 1.9 : 1) * (0.9 + rnd() * 0.2) * (1 + 0.5 * worsening);
        const ctr = p.ctr * (plat === 'google' ? 2 : 1) * (0.85 + rnd() * 0.3) * (1 - 0.35 * worsening);
        row.spend = Math.round(spend);
        row.impressions = Math.round(spend / cpm * 1000);
        row.clicks = Math.round(row.impressions * ctr / 100);
        adsClicks += row.clicks; adsSpend += row.spend;
        dayRows[plat] = row;
      }
      if (isE) {
        // Store funnel first, then platform attribution on top of it.
        const sessions = Math.round(adsClicks * (1 + p.orgShare * 2.5) * (0.9 + rnd() * 0.2));
        const atcRate = 0.085 * p.funnel * driftMul, coRate = 0.45, purRate = 0.55 * (0.9 + rnd() * 0.2);
        const atc = Math.round(sessions * atcRate);
        const checkouts = Math.round(atc * coRate);
        const orders = Math.round(checkouts * purRate);
        const aov = p.aov * (0.92 + rnd() * 0.16);
        const gross = Math.round(orders * aov);
        const refunds = Math.round(gross * (0.02 + rnd() * 0.02));
        const sh = empty(client.id, date, 'shopify');
        Object.assign(sh, { orders, units: Math.round(orders * 1.35), grossSales: gross, netSales: gross - refunds, refunds, newCustomerOrders: Math.round(orders * (0.62 + rnd() * 0.1)), checkoutsStarted: checkouts });
        const ga = empty(client.id, date, 'ga4');
        Object.assign(ga, { sessions, ga4Atc: atc, ga4Checkouts: checkouts, ga4Purchases: Math.round(orders * 0.93) });
        dayRows.shopify = sh; dayRows.ga4 = ga;
        // Platform-reported: over-attribute by ~18% in total, split by spend share.
        const platRev = (gross - refunds) * (1 - p.orgShare) * 1.18;
        const platPur = orders * (1 - p.orgShare) * 1.18;
        for (const plat of Object.keys(pf)) {
          const row = dayRows[plat]; const share = adsSpend ? row.spend / adsSpend : 0;
          const eff = plat === 'google' ? 1.25 : 1;
          row.revenue = Math.round(platRev * share * eff);
          row.purchases = Math.round(platPur * share * eff);
          if (plat === 'meta') { row.lpv = Math.round(row.clicks * 0.8); row.atc = Math.round(row.clicks * 0.11 * driftMul); row.ic = Math.round(row.atc * 0.45); }
          if (plat === 'google') { row.gLpv = Math.round(row.clicks * 0.78); row.gAtc = Math.round(row.clicks * 0.09 * driftMul); row.gIc = Math.round(row.gAtc * 0.5); }
        }
      } else {
        for (const plat of Object.keys(pf)) {
          const row = dayRows[plat];
          const lcvr = (p.lcvr || 8) * (plat === 'google' ? 1.4 : 1) * driftMul * (0.85 + rnd() * 0.3) / 100;
          row.leads = Math.round(row.clicks * lcvr);
          if (plat === 'meta') { row.lpv = Math.round(row.clicks * 0.85); }
        }
      }
      Object.values(dayRows).forEach((r) => rows.push(r));
    }
    // Nudge totals so the sample lands near target: scale revenue/leads by a constant.
    const ads = rows.filter((r) => r.platform === 'meta' || r.platform === 'google');
    const spend = ads.reduce((s, r) => s + r.spend, 0);
    if (isE) {
      const rev = ads.reduce((s, r) => s + r.revenue, 0);
      const k = spend && rev ? (target * (p.ratio || 1.02)) / (rev / spend) : 1;
      rows.forEach((r) => { r.revenue = Math.round(r.revenue * k); r.grossSales = Math.round(r.grossSales * k); r.netSales = Math.round(r.netSales * k); r.refunds = Math.round(r.refunds * k); });
    } else {
      const leads = ads.reduce((s, r) => s + r.leads, 0);
      const k = leads ? (spend / leads) / (target * (p.ratio || 0.98)) : 1;
      rows.forEach((r) => { r.leads = Math.round(r.leads * k); });
    }
    return rows;
  }

  function sum(rows, keys) { const o = {}; keys.forEach((k) => { o[k] = 0; }); rows.forEach((r) => keys.forEach((k) => { o[k] += r[k] || 0; })); return o; }
  const KEYS = ['spend', 'impressions', 'clicks', 'purchases', 'revenue', 'leads'];

  // Split a set of daily rows across items by weight (spend) and weight x efficiency (results), with a little
  // day-to-day noise so each entity has its own curve. Returns items with `days` and 30 day totals.
  function allocateDays(rows, items, rnd, since, until) {
    const sw = items.reduce((s, i) => s + i.w, 0) || 1, swe = items.reduce((s, i) => s + i.w * i.e, 0) || 1;
    const out = items.map((i) => Object.assign({}, i, { days: {}, spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, leads: 0 }));
    rows.forEach((r) => {
      const noise = out.map(() => 0.8 + rnd() * 0.4); const nsum = noise.reduce((s, x) => s + x, 0) / noise.length || 1;
      out.forEach((o, k) => {
        const ws = o.w / sw * noise[k] / nsum, rs = (o.w * o.e) / swe * noise[k] / nsum;
        const t = o.pausedFrom && r.date >= o.pausedFrom ? [0, 0, 0, 0, 0, 0] : [Math.round(r.spend * ws), Math.round(r.impressions * ws), Math.round(r.clicks * ws * (o.ctrMul || 1)), Math.round(r.purchases * rs), Math.round(r.revenue * rs), Math.round(r.leads * rs)];
        o.days[r.date] = t;
        if (r.date >= since && r.date <= until) { o.spend += t[0]; o.impressions += t[1]; o.clicks += t[2]; o.purchases += t[3]; o.revenue += t[4]; o.leads += t[5]; }
      });
    });
    out.forEach((o) => { delete o.w; delete o.e; delete o.ctrMul; delete o.pausedFrom; });
    return out;
  }
  function rowsFromDays(items, parentRows) { // turn a parent's per-day tuples back into row objects for the next level
    return Object.entries(items.days).map(([date, t]) => ({ date, spend: t[0], impressions: t[1], clicks: t[2], purchases: t[3], revenue: t[4], leads: t[5] }));
  }

  function buildEntities(client, daily, endDate) {
    const rnd = mulberry32(hash(client.id + ':entities'));
    const p = Object.assign({}, PROFILES.default, PROFILES[client.id] || (client.type === 'lead' ? PROFILES['sample-lead'] : PROFILES['sample-ecom']));
    const isE = client.type !== 'lead';
    const since = addDays(endDate, -29);
    const inRange = (r) => r.date >= since && r.date <= endDate;
    const last7 = (r) => r.date > addDays(endDate, -7) && r.date <= endDate;
    const prev7 = (r) => r.date > addDays(endDate, -14) && r.date <= addDays(endDate, -7);
    const names = CAMPAIGNS[isE ? 'ecom' : 'lead'];
    const pf = platformsOf(client);
    const campaigns = [], adsets = [], ads = [];
    const dayWindow = (r) => r.date > addDays(endDate, -36) && r.date <= endDate;
    for (const plat of Object.keys(pf)) {
      const rows = daily.filter((r) => r.platform === plat && dayWindow(r));
      const defs = (names[plat] || []).map((n, i) => {
        const budget = Math.round((client.budget || 300000) / 30 * (pf[plat] || 1) * (0.15 + rnd() * 0.35) / 100) * 100;
        return { id: `${client.id}-${plat}-c${i}`, name: n, platform: plat, status: 'ACTIVE', objective: isE ? 'OUTCOME_SALES' : 'OUTCOME_LEADS', dailyBudget: budget, budgetLevel: 'campaign', w: 0.4 + rnd() * 1.2, e: (/Retargeting|Brand|DPA/.test(n) ? 1.1 : 0.75) + rnd() * 0.5, ctrMul: 0.8 + rnd() * 0.5 };
      });
      if (plat === 'meta' && defs[1]) { defs[1].status = 'PAUSED'; defs[1].w *= 0.5; defs[1].pausedFrom = addDays(endDate, -2); }
      allocateDays(rows, defs, rnd, since, endDate).forEach((c) => campaigns.push(c));
    }
    campaigns.filter((c) => c.platform === 'meta').forEach((camp, ci) => {
      const defs = [0, 1].map((k) => {
        let status = camp.status, learning = 'SUCCESS';
        const s = rnd(); if (s > 0.9) learning = 'FAIL'; else if (s > 0.8) learning = 'LEARNING';
        if (client.id === 'sample-lead' && ci === 1 && k === 1) learning = 'FAIL';
        return { id: `${camp.id}-s${k}`, name: ADSETS[(ci * 2 + k) % ADSETS.length], campaignId: camp.id, campaignName: camp.name, status, learning, optimization: isE ? 'OFFSITE_CONVERSIONS' : 'LEAD_GENERATION', freq: r2(1.4 + rnd() * 2.2), w: 0.5 + rnd(), e: 0.8 + rnd() * 0.4, ctrMul: 0.85 + rnd() * 0.35 };
      });
      allocateDays(rowsFromDays(camp), defs, rnd, since, endDate).forEach((s) => adsets.push(s));
    });
    const pool = ADS[isE ? 'ecom' : 'lead'].slice();
    const n = Math.min(pool.length, 7 + Math.floor(rnd() * 3));
    const defs = [];
    for (let k = 0; k < n; k++) {
      const pick = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const set = adsets[k % Math.max(1, adsets.length)];
      const isVideo = pick[1] === 'Video' || pick[1] === 'UGC';
      const daysLive = 2 + Math.floor(rnd() * 44);
      defs.push({ id: `${client.id}-a${k}`, name: pick[0], format: pick[1], isVideo, adsetId: set?.id, adsetName: set?.name, campaignId: set?.campaignId, campaignName: set?.campaignName, status: set?.status || 'ACTIVE', issues: [], createdDate: addDays(endDate, -daysLive), daysLive, freq: r2(1.3 + rnd() * 2.4), hookRate: isVideo ? r2(22 + rnd() * 20) : null, holdRate: isVideo ? r2(8 + rnd() * 14) : null, ctrTrend: r2(0.75 + rnd() * 0.45), cpmTrend: r2(0.92 + rnd() * 0.3), w: 0.3 + rnd() * 1.4, e: 0.6 + rnd() * 0.8, ctrMul: 0.8 + rnd() * 0.5, thumb: '', previewUrl: k % 4 === 3 ? '' : `https://fb.me/sample-${k}` });
    }
    if (p.fatigue && defs[0]) Object.assign(defs[0], { freq: 3.9, ctrTrend: 0.66, cpmTrend: 1.31, daysLive: 40, createdDate: addDays(endDate, -40), w: 1.9 });
    if (client.id === 'sample-lead' && defs[1]) Object.assign(defs[1], { freq: 4.2, ctrTrend: 0.71, cpmTrend: 1.28, daysLive: 33, createdDate: addDays(endDate, -33) });
    if (client.id === 'sample-ecom' && defs[5]) Object.assign(defs[5], { status: 'DISAPPROVED', issues: ['Ad text may violate personal attributes policy'], w: 0.05 });
    // ads are allocated within their ad set so the tree adds up
    const bySet = {};
    defs.forEach((d) => { (bySet[d.adsetId] = bySet[d.adsetId] || []).push(d); });
    const m7 = sum(daily.filter((r) => r.platform === 'meta' && last7(r)), KEYS), m14 = sum(daily.filter((r) => r.platform === 'meta' && prev7(r)), KEYS);
    const metaTot = sum(daily.filter((r) => r.platform === 'meta' && inRange(r)), KEYS);
    adsets.forEach((set) => {
      const mine = bySet[set.id] || []; if (!mine.length) return;
      allocateDays(rowsFromDays(set), mine, rnd, since, endDate).forEach((a) => {
        const share = metaTot.spend ? a.spend / metaTot.spend : 0;
        const ctr30 = a.impressions ? a.clicks / a.impressions * 100 : 0, cpm30 = a.impressions ? a.spend / a.impressions * 1000 : 0;
        a.last7 = { spend: Math.round(m7.spend * share), ctr: r2(ctr30 * a.ctrTrend), cpm: r2(cpm30 * a.cpmTrend), freq: a.freq };
        a.prev7 = { spend: Math.round(m14.spend * share), ctr: r2(ctr30), cpm: r2(cpm30), freq: r2(Math.max(1, a.freq - 0.6)) };
        delete a.ctrTrend; delete a.cpmTrend;
        ads.push(a);
      });
    });
    // Delivery issues and account, as the Meta fetcher writes them
    const issues = [];
    ads.filter((a) => a.status === 'DISAPPROVED').forEach((a) => issues.push({ level: 'ad', id: a.id, severity: 'warning', text: `${a.name}: disapproved, ${a.issues.join('; ')}` }));
    adsets.filter((a) => a.learning === 'FAIL').forEach((a) => issues.push({ level: 'adset', id: a.id, severity: 'info', text: `${a.name}: learning limited` }));
    const account = { platform: 'meta', name: client.name, status: 'Active', statusCode: 1, currency: client.currency || 'INR', amountSpent: 0, spendCap: 0, timezone: 'Asia/Kolkata' };
    // Products (ecom only)
    const products = [];
    if (isE) {
      const sh = sum(daily.filter((r) => r.platform === 'shopify' && inRange(r)), ['units', 'netSales', 'orders']);
      const sh7 = sum(daily.filter((r) => r.platform === 'shopify' && last7(r)), ['units']);
      const w = PRODUCTS.map(() => 0.3 + rnd() * 1.5); const sw = w.reduce((s, x) => s + x, 0);
      PRODUCTS.forEach((title, i) => {
        const share = w[i] / sw; const units = Math.round(sh.units * share); const units7 = Math.round(sh7.units * share * (0.7 + rnd() * 0.6));
        const inv = i === 1 ? 9 : Math.round(units * (0.4 + rnd() * 2.5));
        products.push({ id: `${client.id}-p${i}`, title, units, units7, revenue: Math.round(sh.netSales * share * (0.9 + rnd() * 0.2)), orders: Math.round(sh.orders * share), inventory: inv, price: Math.round(p.aov * (0.5 + rnd())), image: '', url: i % 5 === 4 ? '' : `https://example-store.in/products/sample-${i}` });
      });
      products.sort((a, b) => b.revenue - a.revenue);
    }
    const recentOrders = isE ? buildOrders(client, daily, endDate, products, rnd) : [];
    return { clientId: client.id, since, until: endDate, campaigns, adsets, ads, products, issues, account, recentOrders, sample: true, updatedAt: new Date().toISOString() };
  }

  const FIRST = ['Priya', 'Aman', 'Neha', 'Rohit', 'Sana', 'Karan', 'Divya', 'Arjun', 'Meera', 'Vikram', 'Ishita', 'Rahul'];
  const SOURCES = ['facebook', 'instagram', 'google', 'direct', 'instagram', 'facebook', 'whatsapp', 'google'];
  function buildOrders(client, daily, endDate, products, rnd) {
    const out = []; let seq = 4820;
    [addDays(endDate, -1), endDate].forEach((date, di) => {
      const row = daily.find((r) => r.platform === 'shopify' && r.date === date); if (!row) return;
      const n = di === 1 ? Math.round(row.orders * 0.55) : row.orders; // today is partial
      for (let i = 0; i < n; i++) {
        const items = 1 + (rnd() < 0.3 ? 1 : 0); const picks = [];
        for (let k = 0; k < items; k++) picks.push(products[Math.floor(rnd() * products.length)]);
        const hour = di === 1 ? Math.floor(rnd() * 13) : Math.floor(rnd() * 24);
        const at = `${date}T${String(hour).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00+05:30`;
        out.push({ id: `sample-o${seq}`, name: '#' + (seq++), at, total: picks.reduce((s, p) => s + p.price, 0), items: picks.map((p) => `1 x ${p.title}`).join(', '), units: items, newCustomer: rnd() < 0.65, status: rnd() < 0.94 ? 'paid' : 'pending', source: SOURCES[Math.floor(rnd() * SOURCES.length)], discount: rnd() < 0.3 ? 'WELCOME10' : '', customer: FIRST[Math.floor(rnd() * FIRST.length)] });
      }
    });
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  // Cumulative hourly snapshots for today and the same weekday last week, as the hourly cron writes them.
  function buildIntraday(client, endDate) {
    const rnd = mulberry32(hash(client.id + ':intra'));
    const isE = client.type !== 'lead';
    const dayBudget = (client.budget || 300000) / 30;
    const curve = [0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.11, 0.15, 0.2, 0.26, 0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.68, 0.75, 0.82, 0.88, 0.93, 0.97, 1];
    const docs = [];
    [[addDays(endDate, -7), 24, 1.0], [endDate, 14, 0.94]].forEach(([date, upto, mul]) => {
      const hours = {}; const dayOrders = Math.round(dayBudget / 620 * mul), dayLeads = Math.round(dayBudget / 380 * mul);
      for (let h = 0; h <= upto - 1; h++) {
        const f = curve[h] * (0.95 + rnd() * 0.1);
        hours[String(h).padStart(2, '0')] = { spend: Math.round(dayBudget * mul * f), purchases: Math.round(dayOrders * 0.9 * f), revenue: Math.round(dayOrders * 0.9 * f * 1900 * 1.15), leads: isE ? 0 : Math.round(dayLeads * f), orders: isE ? Math.round(dayOrders * f) : 0, netSales: isE ? Math.round(dayOrders * f * 1900) : 0, checkoutsStarted: isE ? Math.round(dayOrders * f * 1.9) : 0 };
      }
      docs.push({ clientId: client.id, date, hours, sample: true });
    });
    return docs;
  }

  function buildSitewatch(client, endDate) {
    const rnd = mulberry32(hash(client.id + ':site'));
    const isE = client.type !== 'lead';
    const url = client.site?.url || `https://${client.id}.example.com`;
    const checks = [
      { name: 'Homepage loads', ok: true, ms: 900 + Math.round(rnd() * 900), detail: '200 OK' },
      { name: 'SSL certificate', ok: true, ms: 0, detail: 'expires in 61 days' },
      { name: 'Meta pixel fires', ok: true, ms: 0, detail: 'pixel request seen on page load' },
      { name: 'GA4 tag fires', ok: true, ms: 0, detail: 'GA request seen on page load' },
    ];
    if (isE) checks.push(
      { name: 'Product page loads', ok: true, ms: 1100 + Math.round(rnd() * 900), detail: '200 OK, variant available' },
      { name: 'Add to cart', ok: true, ms: 500 + Math.round(rnd() * 500), detail: 'cart has 1 item' },
      { name: 'Checkout page loads', ok: true, ms: 1800 + Math.round(rnd() * 1200), detail: 'contact + shipping form visible' },
    ); else checks.push({ name: 'Landing page form present', ok: true, ms: 1200, detail: 'form with 4 fields' });
    const history = [];
    for (let i = 47; i >= 0; i--) {
      const at = new Date(new Date(endDate + 'T18:00:00+05:30').getTime() - i * 1800000).toISOString();
      const fail = client.id === 'sample-ecom' && i >= 20 && i <= 23 ? ['Checkout page loads'] : [];
      history.push({ at, ok: !fail.length, failed: fail, ms: 900 + Math.round(rnd() * 1200) });
    }
    return { clientId: client.id, url, at: history[history.length - 1].at, ok: true, checks, history, sample: true };
  }

  function build(client, endDate, days) {
    days = days || 45;
    const daily = buildDaily(client, endDate, days);
    const entities = buildEntities(client, daily, endDate);
    const sitewatch = buildSitewatch(client, endDate);
    return { daily, entities, sitewatch };
  }

  const SAMPLE_CLIENTS = [
    { id: 'sample-ecom', name: 'Aurelia Jewels (sample)', type: 'ecom', currency: 'INR', budget: 600000, target: { roas: 3.5 }, am: 'Meera', accounts: {}, site: { url: 'https://aurelia-jewels.example.com' }, sample: true, active: true },
    { id: 'sample-lead', name: 'Bright Meadow School (sample)', type: 'lead', currency: 'INR', budget: 150000, target: { cpl: 350 }, am: 'Dev', accounts: {}, site: { url: 'https://brightmeadow.example.com', leadFormPath: '/admissions' }, sample: true, active: true },
  ];

  return { build, buildDaily, buildEntities, buildSitewatch, buildIntraday, SAMPLE_CLIENTS, platformsOf };
});
