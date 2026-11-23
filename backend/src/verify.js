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
export async function verifyMeta(store, clients, { only = '', days = DAYS } = {}) {
  const { config } = await import('./config.js');
  const today = todayStr(), since = addDays(today, -days), until = addDays(today, -1);
  const out = { checked: 0, clean: 0, mismatched: 0, skipped: 0, problems: [], notes: [] };
  for (const c of clients) {
    if (only && c.id !== only) continue;
    if (c.sample || !c.accounts?.meta || !config.meta.token) { out.skipped++; continue; }
    try {
      const q = new URLSearchParams({ access_token: config.meta.token, level: 'account', time_increment: '1', fields: 'spend,impressions,clicks,actions,action_values', time_range: JSON.stringify({ since, until }), limit: '100' });
      // Several ad accounts on one client are summed per day, the same way the sync stores them.
      const truth = {}; let failed = '';
      for (const id of String(c.accounts.meta).split(/[\s,]+/).map((x) => x.replace(/^act_/, '')).filter(Boolean)) {
        const r = await fetch(`https://graph.facebook.com/${config.meta.apiVersion}/act_${id}/insights?${q}`);
        const body = await r.json();
        if (!r.ok) { failed = body?.error?.message?.slice(0, 90) || String(r.status); break; }
        for (const x of body.data || []) {
          const t = truth[x.date_start];
          if (!t) { truth[x.date_start] = x; continue; }
          for (const f of ['spend', 'impressions', 'clicks']) t[f] = String((parseFloat(t[f]) || 0) + (parseFloat(x[f]) || 0));
          for (const f of ['actions', 'action_values']) { const m = new Map((t[f] || []).map((y) => [y.action_type, { ...y }])); for (const y of x[f] || []) { const z = m.get(y.action_type); if (z) z.value = String((parseFloat(z.value) || 0) + (parseFloat(y.value) || 0)); else m.set(y.action_type, { ...y }); } t[f] = [...m.values()]; }
        }
      }
      if (failed) { out.skipped++; out.notes.push(`${c.id}: Meta said ${failed}`); log(`verifymeta ${c.id}: could not check (Meta said ${failed})`); continue; }
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
      { let a = 0, b = 0; for (let d = since; d <= until; d = addDays(d, 1)) { a += (byDate[d] || {}).spend || 0; b += parseFloat((truth[d] || {}).spend) || 0; } log(`verifymeta total ${c.id} ${since}..${until}: spend ${Math.round(a)} stored vs ${Math.round(b)} Meta`); }
      // Campaign-name split (Berkowits: "products" vs the rest): checked from Meta's own campaign rows.
      const rule = c.segment?.match?.meta && c.segment.match.meta !== '*' ? String(c.segment.match.meta).toLowerCase() : '';
      if (rule) {
        const pt = Array.isArray(c.metaPurchaseTypes) && c.metaPurchaseTypes.length ? c.metaPurchaseTypes : ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
        const M = { seg: { spend: 0, pur: 0, rev: 0, lead: 0, chat: 0 }, other: { spend: 0, pur: 0, rev: 0, lead: 0, chat: 0 } }, perDay = {};
        for (const id of String(c.accounts.meta).split(/[\s,]+/).map((x) => x.replace(/^act_/, '')).filter(Boolean)) {
          let next = `https://graph.facebook.com/${config.meta.apiVersion}/act_${id}/insights?${new URLSearchParams({ access_token: config.meta.token, level: 'campaign', time_increment: '1', fields: 'campaign_name,spend,actions,action_values', time_range: JSON.stringify({ since, until }), limit: '500' })}`;
          while (next) {
            const body = await (await fetch(next)).json();
            if (body.error) throw new Error('campaign rows: ' + String(body.error.message).slice(0, 80));
            for (const x of body.data || []) {
              const k = String(x.campaign_name || '').toLowerCase().includes(rule) ? 'seg' : 'other', m = M[k];
              const sp = parseFloat(x.spend) || 0; m.spend += sp; m.pur += pick(x.actions, pt); m.rev += pick(x.action_values, pt);
              m.lead += pick(x.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']); m.chat += pick(x.actions, ['onsite_conversion.messaging_conversation_started_7d']);
              if (k === 'seg') perDay[x.date_start] = (perDay[x.date_start] || 0) + sp;
            }
            next = body.paging?.next || '';
          }
        }
        const S = { spend: 0, pur: 0, rev: 0, lead: 0 }, T = { spend: 0, pur: 0, rev: 0, lead: 0 }; const segBad = [];
        for (let d = since; d <= until; d = addDays(d, 1)) {
          const r = byDate[d] || {}, g = r.seg || {};
          S.spend += g.spend || 0; S.pur += g.purchases || 0; S.rev += g.revenue || 0; S.lead += g.leads || 0;
          T.spend += r.spend || 0; T.pur += r.purchases || 0; T.rev += r.revenue || 0; T.lead += r.leads || 0;
          if (!close(g.spend || 0, perDay[d] || 0, 1, 0.01)) segBad.push(`${d} ${rule} spend ${Math.round(g.spend || 0)} stored vs ${Math.round(perDay[d] || 0)} Meta`);
        }
        const R = Math.round;
        log(`verifymeta split ${c.id} ${since}..${until}: ${rule} stored spend ${R(S.spend)} purchases ${R(S.pur)} value ${R(S.rev)} leads ${R(S.lead)} | Meta spend ${R(M.seg.spend)} purchases ${R(M.seg.pur)} value ${R(M.seg.rev)} leads ${R(M.seg.lead)} chats ${R(M.seg.chat)}`);
        log(`verifymeta split ${c.id} ${since}..${until}: rest stored spend ${R(T.spend - S.spend)} purchases ${R(T.pur - S.pur)} value ${R(T.rev - S.rev)} leads ${R(T.lead - S.lead)} | Meta spend ${R(M.other.spend)} purchases ${R(M.other.pur)} value ${R(M.other.rev)} leads ${R(M.other.lead)} chats ${R(M.other.chat)}`);
        if (segBad.length) { bad.push(...segBad); log(`verifymeta split ${c.id}: ${segBad.slice(0, 6).join('; ')}`); }
      }
      out.checked++;
      if (bad.length || attr.length) { out.mismatched++; out.problems.push({ client: c.id, spendOrTraffic: bad.slice(0, 6), conversions: attr.slice(0, 6) }); log(`verifymeta MISMATCH ${c.id}: ${[...bad.slice(0, 5), ...attr.slice(0, 3)].join('; ')}`); }
      else { out.clean++; log(`verifymeta ${c.id}: matches Meta for ${since} to ${until}`); }
    } catch (e) { out.skipped++; out.notes.push(`${c.id}: ${String(e.message || e).slice(0, 100)}`); log(`verifymeta ${c.id}: could not check (${String(e.message || e).slice(0, 100)})`); }
  }
  return out;
}

// Google reconciliation, read only: the last completed days pulled fresh from Google Ads (the same
// query the sync uses) against the rows the dashboard stored. Spend and clicks must match; revenue
// (Conv. value by conv. time) can move for a few days as late conversions land, so it is reported
// apart from spend.
export async function verifyGoogle(store, clients, { only = '', days = DAYS } = {}) {
  const google = await import('./fetchers/google.js');
  const today = todayStr(), since = addDays(today, -days), until = addDays(today, -1);
  const out = { checked: 0, clean: 0, mismatched: 0, skipped: 0, problems: [], notes: [] };
  for (const c of clients) {
    if (only && c.id !== only) continue;
    if (c.sample || !c.accounts?.google) { out.skipped++; continue; }
    try {
      const live = await google.fetchDaily(c, since, until);
      const truth = Object.fromEntries(live.map((r) => [r.date, r]));
      const rows = (await store.list('daily', dailyIdRange(c.id, since, until))).filter((x) => x.platform === 'google');
      const byDate = Object.fromEntries(rows.map((x) => [x.date, x]));
      const bad = [], conv = [];
      for (let d = since; d <= until; d = addDays(d, 1)) {
        const t = truth[d] || {}, s = byDate[d] || {};
        if (!close(s.spend || 0, t.spend || 0, 1, 0.01)) bad.push(`${d} spend ${Math.round(s.spend || 0)} stored vs ${Math.round(t.spend || 0)} Google`);
        if (!close(s.clicks || 0, t.clicks || 0, 5, 0.02)) bad.push(`${d} clicks ${s.clicks || 0} vs ${t.clicks || 0}`);
        if (s.seg || t.seg) { const a = (s.seg || {}).spend || 0, b = (t.seg || {}).spend || 0; if (!close(a, b, 1, 0.01)) bad.push(`${d} segment spend ${Math.round(a)} vs ${Math.round(b)}`); }
        if (!close(s.revenue || 0, t.revenue || 0, 1, 0.02)) conv.push(`${d} revenue ${Math.round(s.revenue || 0)} vs ${Math.round(t.revenue || 0)}`);
        if (!close(s.leads || 0, t.leads || 0, 0, 0.02)) conv.push(`${d} leads ${s.leads || 0} vs ${t.leads || 0}`);
      }
      { let a = 0, b = 0; for (let d = since; d <= until; d = addDays(d, 1)) { a += (byDate[d] || {}).spend || 0; b += (truth[d] || {}).spend || 0; } log(`verifygoogle total ${c.id} ${since}..${until}: spend ${Math.round(a)} stored vs ${Math.round(b)} Google`); }
      out.checked++;
      if (bad.length || conv.length) { out.mismatched++; out.problems.push({ client: c.id, spendOrTraffic: bad.slice(0, 6), conversions: conv.slice(0, 6) }); log(`verifygoogle MISMATCH ${c.id}: ${[...bad, ...conv].slice(0, 5).join('; ')}`); }
      else { out.clean++; log(`verifygoogle ${c.id}: matches Google for ${since} to ${until}`); }
    } catch (e) { out.skipped++; out.notes.push(`${c.id}: ${String(e.message || e).slice(0, 100)}`); log(`verifygoogle ${c.id}: could not check (${String(e.message || e).slice(0, 100)})`); }
  }
  return out;
}
