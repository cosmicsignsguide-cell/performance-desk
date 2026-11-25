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
      { let a = 0, b = 0, n = 0; const liveSeg = {}; for (const r of live) if (r.seg) liveSeg[r.date] = (liveSeg[r.date] || 0) + (r.seg.spend || 0);
        if (Object.keys(liveSeg).length || Object.values(s).some((x) => x.seg)) { for (const d of dates) { const x = ((s[d] || {}).seg || {}).spend || 0, y = liveSeg[d] || 0; a += x; b += y; if (!close(x, y, 1, 0.01)) n++; }
          log(`${tag} google split: products spend stored ${R(a)} vs Google ${R(b)} | rest stored ${R(S.sp - a)} vs Google ${R(T.sp - b)} | days off ${n}`); } }
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
        const cc = pctOf(cs, metaStored);
        // Ads keep 35 days of history by design, so they are judged on the last 35 days.
        const w35 = addDays(until, -34);
        const meta35 = rows.filter((r) => r.platform === 'meta' && r.date >= w35).reduce((a, r) => a + (r.spend || 0), 0);
        let a35 = 0; for (const x of ads) a35 += inWin(x.days).s && Object.entries(x.days || {}).reduce((t, [d, v]) => t + (d >= w35 && d <= until ? ((v || [])[0] || 0) : 0), 0);
        const ac = pctOf(a35, meta35);
        res.creatives = !meta35 ? 'no-spend' : !ads.length ? 'none' : (ac != null && ac >= 95 && cc != null && cc >= 95) ? 'ok' : 'partial';
        log(`${tag} creatives: ${res.creatives} | campaigns ${mc.length} cover ${R(cs)} of ${R(metaStored)} Meta spend (${cc}%) from ${cFirst || '-'} | ads ${ads.length} (${adsSpending} spent, ${adsThumb} with image) last 35 days ${R(a35)} of ${R(meta35)} (${ac}%) from ${aFirst || '-'} | tree ${e.since || '?'}..${e.until || '?'} updated ${e.updatedAt || '?'}${e.trimmed ? ' trimmed' : ''}`);
      }
    } catch (e2) { res.creatives = 'error'; log(`${tag} creatives: error ${String(e2.message || e2).slice(0, 100)}`); }
  }
  // Segment pages (Berkowits Products / Services + Grow): the campaign-name split, day by day and
  // today included, plus the creatives checked against the page's own share of spend, campaign by campaign.
  const rule = c.segment?.match?.meta && c.segment.match.meta !== '*' ? String(c.segment.match.meta).toLowerCase() : '';
  const side = c.segment?.only;
  if (rule && ['seg', 'other'].includes(side) && c.accounts?.meta && config.meta.token) {
    try {
      const pt = Array.isArray(c.metaPurchaseTypes) && c.metaPurchaseTypes.length ? c.metaPurchaseTypes : ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
      const mine = (name) => { const hit = String(name || '').toLowerCase().includes(rule); return side === 'seg' ? hit : !hit; };
      const perDay = {}, perCamp = {};
      for (const id of String(c.accounts.meta).split(/[\s,]+/).map((x) => x.replace(/^act_/, '')).filter(Boolean)) {
        for (let a = since; a <= today; a = addDays(a, 7)) {
        const b = addDays(a, 6) < today ? addDays(a, 6) : today;
        let next = `https://graph.facebook.com/${config.meta.apiVersion}/act_${id}/insights?${new URLSearchParams({ access_token: config.meta.token, level: 'campaign', time_increment: '1', fields: 'campaign_id,campaign_name,spend,actions,action_values', time_range: JSON.stringify({ since: a, until: b }), limit: '200' })}`;
        let tries = 0;
        while (next) {
          const body = await (await fetch(next)).json();
          if (body.error && tries < 4) { tries++; await new Promise((r) => setTimeout(r, 15000 * tries)); continue; }
          if (body.error) throw new Error(`campaign rows ${a}: ` + String(body.error.message).slice(0, 80));
          for (const x of body.data || []) {
            if (!mine(x.campaign_name)) continue;
            const d = perDay[x.date_start] || (perDay[x.date_start] = { sp: 0, pu: 0, rv: 0, ld: 0, ch: 0 });
            const sp = parseFloat(x.spend) || 0; d.sp += sp; d.pu += pick(x.actions, pt); d.rv += pick(x.action_values, pt);
            d.ld += pick(x.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']); d.ch += pick(x.actions, ['onsite_conversion.messaging_conversation_started_7d']);
            if (x.date_start <= until) { const k = String(x.campaign_id); perCamp[k] = perCamp[k] || { name: x.campaign_name, sp: 0 }; perCamp[k].sp += sp; }
          }
          next = body.paging?.next || '';
        }
        }
      }
      const todayRows = (await store.list('daily', dailyIdRange(c.id, today, today))).filter((r) => r.clientId === c.id && r.platform === 'meta');
      const s = { ...by('meta') }; for (const r of todayRows) s[r.date] = r;
      const part = (r) => { if (!r) return null; const g = r.seg || {}; return side === 'seg' ? { sp: g.spend || 0, pu: g.purchases || 0, rv: g.revenue || 0, ld: g.leads || 0 } : { sp: (r.spend || 0) - (g.spend || 0), pu: (r.purchases || 0) - (g.purchases || 0), rv: (r.revenue || 0) - (g.revenue || 0), ld: (r.leads || 0) - (g.leads || 0) }; };
      const T = { sp: 0, pu: 0, rv: 0, ld: 0, ch: 0 }, S = { sp: 0, pu: 0, rv: 0, ld: 0 }; let bad = 0; const ex = [];
      for (const d of dates) { const t = perDay[d] || { sp: 0, pu: 0, rv: 0, ld: 0, ch: 0 }, x = part(s[d]) || { sp: 0, pu: 0, rv: 0, ld: 0 };
        T.sp += t.sp; T.pu += t.pu; T.rv += t.rv; T.ld += t.ld; T.ch += t.ch; S.sp += x.sp; S.pu += x.pu; S.rv += x.rv; S.ld += x.ld;
        if (!close(x.sp, t.sp, 1, 0.01)) { bad++; if (ex.length < 5) ex.push(`${d} ${R(x.sp)} vs ${R(t.sp)}`); } }
      log(`${tag} split ${side}: spend stored ${R(S.sp)} vs Meta ${R(T.sp)} (${pctOf(S.sp, T.sp)}%) | days off ${bad} | purchases ${R(S.pu)} vs ${R(T.pu)} | value ${R(S.rv)} vs ${R(T.rv)} | leads ${R(S.ld)} vs Meta leads ${R(T.ld)} + chats ${R(T.ch)}${ex.length ? ' | e.g. ' + ex.join('; ') : ''}`);
      const tt = perDay[today] || { sp: 0, pu: 0, rv: 0, ld: 0, ch: 0 }, ts = part(s[today]);
      log(`${tag} today ${today} ${side}: stored ${ts ? `spend ${R(ts.sp)} purchases ${R(ts.pu)} value ${R(ts.rv)} leads ${R(ts.ld)}` : 'no row yet'} | Meta now spend ${R(tt.sp)} purchases ${R(tt.pu)} value ${R(tt.rv)} leads ${R(tt.ld)} chats ${R(tt.ch)} | stored at ${s[today]?.updatedAt || s[today]?.syncedAt || '?'}`);
      // Creatives against this page's own spend.
      const e = await store.get('entities', c.id);
      if (e) {
        const w35 = addDays(until, -34);
        const sum = (days0, a) => { let v = 0, first = ''; for (const d in days0 || {}) if (d >= a && d <= until) { const y = (days0[d] || [])[0] || 0; v += y; if (y > 0 && (!first || d < first)) first = d; } return { v, first }; };
        const mc = (e.campaigns || []).filter((x) => x.platform === 'meta');
        let cs = 0; const off = [];
        for (const x of mc) { const w = sum(x.days, since); cs += w.v; const m = perCamp[String(x.id)]; if (m && !close(w.v, m.sp, 5, 0.02) && off.length < 5) off.push(`"${String(x.name).slice(0, 45)}" ${R(w.v)} vs ${R(m.sp)}`); }
        const missingCamps = Object.entries(perCamp).filter(([k, m]) => m.sp > 1 && !mc.some((x) => String(x.id) === k));
        let a35 = 0, aFirst = ''; for (const x of e.ads || []) { const w = sum(x.days, w35); a35 += w.v; if (w.first && (!aFirst || w.first < aFirst)) aFirst = w.first; }
        let t35 = 0; for (const d of dates) if (d >= w35) t35 += (perDay[d] || { sp: 0 }).sp;
        const top = Object.values(perCamp).sort((a, b) => b.sp - a.sp).slice(0, 6).map((m) => `"${String(m.name).slice(0, 40)}" ${R(m.sp)}`).join(' | ');
        log(`${tag} creatives ${side}: campaigns in tree ${mc.length}, Meta campaigns with spend ${Object.values(perCamp).filter((m) => m.sp > 1).length}, missing from tree ${missingCamps.length}${missingCamps.length ? ' (' + missingCamps.slice(0, 4).map(([, m]) => `"${String(m.name).slice(0, 40)}" ${R(m.sp)}`).join(', ') + ')' : ''} | tree 60d ${R(cs)} vs Meta ${R(T.sp)} (${pctOf(cs, T.sp)}%)${off.length ? ' | off: ' + off.join('; ') : ''} | ads ${(e.ads || []).length}, last 35d ${R(a35)} vs Meta ${R(t35)} (${pctOf(a35, t35)}%) from ${aFirst || '-'} | top: ${top}`);
      }
    } catch (e3) { log(`${tag} split: error ${String(e3.message || e3).slice(0, 120)}`); }
  }
  log(`${tag} summary: meta ${res.meta}, google ${res.google}, shopify ${res.shopify}, creatives ${res.creatives}`);
  return res;
}
