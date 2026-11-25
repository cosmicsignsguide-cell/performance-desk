// Read-only data audit over a window (default 60 days): for one client, compares what the
// dashboard stored with what Meta, Google and Shopify report right now, and checks how much of the
// stored Meta spend the creatives tree (campaigns and ads) covers. Nothing is written. Details go
// to the server log only (the Actions log that triggers it is public); the answer carries counts.
import { dailyIdRange } from './db.js';
import { shopifyTokenFor } from './config.js';
import { salesByDay } from './fetchers/shopify.js';
import { addDays, todayStr, log } from './util.js';

const R = Math.round;
const close = (a, b, tolAbs, tolPct) => Math.abs(a - b) <= Math.max(tolAbs, Math.abs(b) * tolPct);
const pick = (v, types) => { if (!Array.isArray(v)) return 0; for (const t of types) { const h = v.find((x) => x.action_type === t); if (h) return parseFloat(h.value) || 0; } return 0; };
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function auditClient(store, c, { days = 60 } = {}) {
  const { config } = await import('./config.js');
  const today = todayStr(), since = addDays(today, -days), until = addDays(today, -1);
  const tag = `audit ${c.id} ${since}..${until}`;
  const rows = (await store.list('daily', dailyIdRange(c.id, since, until))).filter((r) => r.clientId === c.id && !r.sample);
  const by = (pf) => Object.fromEntries(rows.filter((r) => r.platform === pf).map((r) => [r.date, r]));
  const res = { client: c.id, meta: 'n/a', google: 'n/a', shopify: 'n/a', creatives: 'n/a' };
  const dates = []; for (let d = since; d <= until; d = addDays(d, 1)) dates.push(d);

  // Meta: account level, per day.
  if (c.accounts?.meta && config.meta.token) {
    try {
      const pt = Array.isArray(c.metaPurchaseTypes) && c.metaPurchaseTypes.length ? c.metaPurchaseTypes : ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
      const truth = {}; let failed = '';
      for (const id of String(c.accounts.meta).split(/[\s,]+/).map((x) => x.replace(/^act_/, '')).filter(Boolean)) {
        let next = `https://graph.facebook.com/${config.meta.apiVersion}/act_${id}/insights?${new URLSearchParams({ access_token: config.meta.token, level: 'account', time_increment: '1', fields: 'spend,clicks,actions,action_values', time_range: JSON.stringify({ since, until }), limit: '100' })}`;
        while (next) {
          const r = await fetch(next); const body = await r.json();
          if (!r.ok || body.error) { failed = body?.error?.message?.slice(0, 90) || String(r.status); break; }
          for (const x of body.data || []) {
            const t = truth[x.date_start] || (truth[x.date_start] = { spend: 0, clicks: 0, pur: 0, rev: 0, lead: 0 });
            t.spend += parseFloat(x.spend) || 0; t.clicks += parseFloat(x.clicks) || 0; t.pur += pick(x.actions, pt); t.rev += pick(x.action_values, pt);
            t.lead += pick(x.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
          }
          next = body.paging?.next || '';
        }
        if (failed) break;
      }
      if (failed) { res.meta = 'no-access'; log(`${tag} meta: could not read (${failed})`); }
      else {
        const s = by('meta'); let bad = 0, missing = 0; const T = { sp: 0, pu: 0, rv: 0, ld: 0 }, S = { sp: 0, pu: 0, rv: 0, ld: 0 }; const ex = [];
        for (const d of dates) { const t = truth[d] || { spend: 0, pur: 0, rev: 0, lead: 0 }, x = s[d];
          T.sp += t.spend; T.pu += t.pur; T.rv += t.rev; T.ld += t.lead;
          if (x) { S.sp += x.spend || 0; S.pu += x.purchases || 0; S.rv += x.revenue || 0; S.ld += x.leads || 0; }
          if (!x && t.spend > 1) { missing++; if (ex.length < 4) ex.push(`${d} missing (Meta ${R(t.spend)})`); }
          else if (!close((x && x.spend) || 0, t.spend, 1, 0.01)) { bad++; if (ex.length < 4) ex.push(`${d} ${R((x && x.spend) || 0)} vs ${R(t.spend)}`); } }
        res.meta = bad || missing ? 'mismatch' : 'ok';
        log(`${tag} meta: ${res.meta} | spend stored ${R(S.sp)} vs Meta ${R(T.sp)} (${pctOf(S.sp, T.sp)}%) | days off ${bad}, days missing ${missing} | purchases ${R(S.pu)} vs ${R(T.pu)} | value ${R(S.rv)} vs ${R(T.rv)} | leads ${R(S.ld)} vs ${R(T.ld)}${ex.length ? ' | e.g. ' + ex.join('; ') : ''}`);
      }
    } catch (e) { res.meta = 'error'; log(`${tag} meta: error ${String(e.message || e).slice(0, 100)}`); }
  }

  // Google: same query the sync uses.
  if (c.accounts?.google) {
    try {
      const google = await import('./fetchers/google.js');
      const live = await google.fetchDaily(c, since, until);
      const truth = {}; for (const r of live) { const t = truth[r.date] || (truth[r.date] = { spend: 0, conv: 0, rev: 0, leads: 0 }); t.spend += r.spend || 0; t.conv += r.purchases || 0; t.rev += r.revenue || 0; t.leads += r.leads || 0; }
      const s = by('google'); let bad = 0, missing = 0; const T = { sp: 0, cv: 0, rv: 0, ld: 0 }, S = { sp: 0, cv: 0, rv: 0, ld: 0 }; const ex = [];
      for (const d of dates) { const t = truth[d] || { spend: 0, conv: 0, rev: 0, leads: 0 }, x = s[d];
        T.sp += t.spend; T.cv += t.conv; T.rv += t.rev; T.ld += t.leads;
        if (x) { S.sp += x.spend || 0; S.cv += x.purchases || 0; S.rv += x.revenue || 0; S.ld += x.leads || 0; }
        if (!x && t.spend > 1) { missing++; if (ex.length < 4) ex.push(`${d} missing (Google ${R(t.spend)})`); }
        else if (!close((x && x.spend) || 0, t.spend, 1, 0.01)) { bad++; if (ex.length < 4) ex.push(`${d} ${R((x && x.spend) || 0)} vs ${R(t.spend)}`); } }
      res.google = bad || missing ? 'mismatch' : 'ok';
      log(`${tag} google: ${res.google} | spend stored ${R(S.sp)} vs Google ${R(T.sp)} (${pctOf(S.sp, T.sp)}%) | days off ${bad}, days missing ${missing} | conversions ${R(S.cv)} vs ${R(T.cv)} | value ${R(S.rv)} vs ${R(T.rv)} | leads ${R(S.ld)} vs ${R(T.ld)}${ex.length ? ' | e.g. ' + ex.join('; ') : ''}`);
    } catch (e) { res.google = 'error'; log(`${tag} google: error ${String(e.message || e).slice(0, 100)}`); }
  }

  // Shopify: orders and net sales per day.
  if (c.accounts?.shopify?.shop && shopifyTokenFor(c)) {
    try {
      const truth = await salesByDay(c, since, until);
      if (!truth) { res.shopify = 'no-reports'; log(`${tag} shopify: reports not available for this token`); }
      else {
        const s = by('shopify'); let bad = 0, missing = 0; const T = { o: 0, n: 0 }, S = { o: 0, n: 0 }; const ex = [];
        for (const d of dates) { const t = truth[d] || { orders: 0, netSales: 0 }, x = s[d];
          T.o += t.orders || 0; T.n += t.netSales || 0; if (x) { S.o += x.orders || 0; S.n += x.netSales || 0; }
          if (!x && (t.orders || 0) > 0) { missing++; if (ex.length < 4) ex.push(`${d} missing (${t.orders} orders)`); }
          else if (((x && x.orders) || 0) !== (t.orders || 0) || !close((x && x.netSales) || 0, t.netSales || 0, 1, 0.005)) { bad++; if (ex.length < 4) ex.push(`${d} ${(x && x.orders) || 0}/${R((x && x.netSales) || 0)} vs ${t.orders || 0}/${R(t.netSales || 0)}`); } }
        res.shopify = bad || missing ? 'mismatch' : 'ok';
        log(`${tag} shopify: ${res.shopify} | orders stored ${S.o} vs Shopify ${T.o} | net sales ${R(S.n)} vs ${R(T.n)} (${pctOf(S.n, T.n)}%) | days off ${bad}, days missing ${missing}${ex.length ? ' | e.g. ' + ex.join('; ') : ''}`);
      }
    } catch (e) { res.shopify = 'error'; log(`${tag} shopify: error ${String(e.message || e).slice(0, 100)}`); }
  }

  // Creatives: how much of the stored Meta spend the campaign tree and the ads carry, and how far back.
  if (c.accounts?.meta) {
    try {
      const e = await store.get('entities', c.id);
      if (!e) { res.creatives = 'none'; log(`${tag} creatives: no entities stored`); }
      else {
        const inWin = (days0) => { let s = 0, first = ''; for (const d in days0 || {}) { if (d >= since && d <= until) { const v = (days0[d] || [])[0] || 0; s += v; if (v > 0 && (!first || d < first)) first = d; } } return { s, first }; };
        const mc = (e.campaigns || []).filter((x) => x.platform === 'meta'), ads = e.ads || [];
        let cs = 0, cFirst = '', as = 0, aFirst = ''; let adsSpending = 0, adsThumb = 0;
        for (const x of mc) { const w = inWin(x.days); cs += w.s; if (w.first && (!cFirst || w.first < cFirst)) cFirst = w.first; }
        for (const x of ads) { const w = inWin(x.days); as += w.s; if (w.s > 0) { adsSpending++; if (x.thumb) adsThumb++; } if (w.first && (!aFirst || w.first < aFirst)) aFirst = w.first; }
        const metaStored = rows.filter((r) => r.platform === 'meta').reduce((a, r) => a + (r.spend || 0), 0);
        const cc = pctOf(cs, metaStored), ac = pctOf(as, metaStored);
        res.creatives = !ads.length ? 'none' : (ac != null && ac >= 95 && aFirst && aFirst <= addDays(since, 3)) ? 'ok' : 'partial';
        log(`${tag} creatives: ${res.creatives} | campaigns ${mc.length} cover ${R(cs)} of ${R(metaStored)} Meta spend (${cc}%) from ${cFirst || '-'} | ads ${ads.length} (${adsSpending} spent, ${adsThumb} with image) cover ${R(as)} (${ac}%) from ${aFirst || '-'} | tree ${e.since || '?'}..${e.until || '?'} updated ${e.updatedAt || '?'}${e.trimmed ? ' trimmed' : ''}`);
      }
    } catch (e2) { res.creatives = 'error'; log(`${tag} creatives: error ${String(e2.message || e2).slice(0, 100)}`); }
  }
  log(`${tag} summary: meta ${res.meta}, google ${res.google}, shopify ${res.shopify}, creatives ${res.creatives}`);
  return res;
}
