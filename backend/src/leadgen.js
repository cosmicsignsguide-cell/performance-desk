// Lead gen view for a services client (Berkowits Services + Grow): the same data object the
// "Berkowits Lead Gen" page was built on, refreshed live and stored at leadgen/{clientId}.
//   Meta: campaigns and ad sets whose name contains the match text ("Service"), month to date,
//         with leads, WhatsApp conversations and reply depth, and the Salesmax stage events the
//         CRM sends back through the Conversion API (offsite_conversion.fb_pixel_custom.<STAGE>).
//   Google: the same campaigns by name, with conversions split into WhatsApp, calls and forms.
// Objective, service and region come from the naming conventions, as on the original page.
import { config } from './config.js';
import { gaql } from './fetchers/google.js';
import { addDays, todayStr, log } from './util.js';

const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;
const pick = (arr, types) => { if (!Array.isArray(arr)) return 0; let t = 0; for (const x of arr) if (types.includes(x.action_type)) t += num(x.value); return t; };
const STAGE_PREFIX = 'offsite_conversion.fb_pixel_custom.';

export const objectiveOf = (n) => /ctwa/i.test(n) ? 'CTWA' : /volume/i.test(n) ? 'VOLUME' : /capi/i.test(n) ? 'CAPI' : 'CAPI';
const norm = (n) => ' ' + String(n || '').replace(/[_|\-\/.,()]+/g, ' ').replace(/\s+/g, ' ') + ' ';
export const serviceOf = (n) => {
  const s = norm(n);
  if (/\bbrand\b/i.test(s)) return 'BRAND';
  if (/\bLHR\b|laser/i.test(s)) return 'LHR';
  if (/\bHT\b|transplant/i.test(s)) return 'HT';
  if (/\bHP\b|hair\s*patch|\bpatch\b/i.test(s)) return 'HP';
  return 'OTHER';
};
export const regionOf = (n) => {
  const s = norm(n);
  if (/\bROI\b|rest\s*of\s*india|\brest\b/i.test(s)) return 'ROI';
  if (/delhi|\bNCR\b|\bDEL\b|gurgaon|gurugram|noida/i.test(s)) return 'DEL';
  if (/mumbai|\bMUM\b|\bBOM\b/i.test(s)) return 'MUM';
  if (/hyderabad|\bHYD\b|\bHYB\b/i.test(s)) return 'HYD';
  if (/bangalore|bengaluru|\bBLR\b|\bBLO\b/i.test(s)) return 'BLR';
  return 'OTHER';
};

async function metaRows(accountId, params) {
  const out = [];
  let next = `https://graph.facebook.com/${config.meta.apiVersion}/act_${accountId}/insights?${new URLSearchParams({ access_token: config.meta.token, limit: '200', ...params })}`;
  let tries = 0;
  while (next) {
    const r = await fetch(next); const body = await r.json().catch(() => ({}));
    if (body.error) { if (tries++ < 4) { await new Promise((ok) => setTimeout(ok, 20000 * tries)); continue; } throw new Error('meta: ' + String(body.error.message).slice(0, 120)); }
    out.push(...(body.data || [])); next = body.paging?.next || ''; tries = 0;
  }
  return out;
}

function metaMetrics(r) {
  const a = r.actions || [];
  const stages = {};
  for (const x of [...a, ...(r.conversions || [])]) if (String(x.action_type).startsWith(STAGE_PREFIX)) { const k = String(x.action_type).slice(STAGE_PREFIX.length); if (k && !/^\d+$/.test(k)) stages[k] = (stages[k] || 0) + num(x.value); }
  return {
    spend: r2(num(r.spend)), impressions: num(r.impressions), reach: num(r.reach), link_clicks: num(r.inline_link_clicks),
    leads: pick(a, ['lead']) || pick(a, ['onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
    convos: pick(a, ['onsite_conversion.messaging_conversation_started_7d']),
    depth2: pick(a, ['onsite_conversion.messaging_user_depth_2_message_send']),
    depth3: pick(a, ['onsite_conversion.messaging_user_depth_3_message_send']),
    first_reply: pick(a, ['onsite_conversion.messaging_first_reply']),
    frequency: num(r.frequency), stages,
  };
}

// Day-by-day store, so the dashboard's range bar (today, 7d, 14d, 30d, MTD, last month) can slice it.
// Kept from the start of last month (or 31 days back, if earlier). A refresh re-pulls only the last
// 7 days and merges them over what is stored; a full pull runs only the first time or after a gap.
//   meta:  adsets[] + rows [date, adsetIdx, spend, impr, clicks, leads, convos, d2, d3, firstReply, stages|0]
//   google: camps[] + rows [date, campIdx, spend, impr, clicks, conv, wa, calls, form, other]
export async function buildLeadgen(client, prev) {
  const today = todayStr();
  const lmStart = addDays(today.slice(0, 8) + '01', -1).slice(0, 8) + '01';
  let since = addDays(today, -31) < lmStart ? addDays(today, -31) : lmStart;
  // Nothing before the date the naming format started (Berkowits: 1 Nov 2026, the "Service" campaigns).
  if (client.leadgen?.since && client.leadgen.since > since) since = client.leadgen.since;
  const match = client.leadgen?.match || 'Service';
  // Campaigns whose name contains the main text or any of the extra ones (CTWA campaigns named before "Service" was added).
  const terms = [match, ...(client.leadgen?.also || [])];
  const matchKey = terms.join('+');
  const old = prev && prev.v === 2 && prev.since <= since && (prev.matchKey || prev.match) === matchKey ? prev : null;
  const from = old ? addDays(today, -7) : since;
  const adsets = old ? old.meta.adsets.map((a) => ({ ...a })) : [], aIdx = new Map(adsets.map((a, i) => [a.id, i]));
  let mrows = old ? old.meta.rows.filter((r) => r[0] >= since && r[0] < from) : [];
  const seen = {};
  for (const acc of String(client.accounts?.meta || '').split(',').filter(Boolean)) {
    const got = new Set();
    for (const term of terms) for (let a = from; a <= today; a = addDays(a, 7)) {
      const b = addDays(a, 6) < today ? addDays(a, 6) : today;
      const filtering = JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: term }]);
      const rows = await metaRows(acc, { level: 'adset', time_increment: '1', fields: 'spend,impressions,inline_link_clicks,actions,conversions,adset_id,adset_name,campaign_id,campaign_name', time_range: JSON.stringify({ since: a, until: b }), filtering });
      for (const r of rows) {
        if (got.has(r.date_start + '|' + r.adset_id)) continue; got.add(r.date_start + '|' + r.adset_id);
        let k = aIdx.get(r.adset_id);
        const info = { id: r.adset_id, name: r.adset_name, campaign_id: r.campaign_id, campaign: r.campaign_name, objective: objectiveOf(r.campaign_name), service: serviceOf(r.campaign_name), region: regionOf(r.adset_name) !== 'OTHER' ? regionOf(r.adset_name) : regionOf(r.campaign_name) };
        if (k === undefined) { k = adsets.length; adsets.push(info); aIdx.set(r.adset_id, k); } else adsets[k] = info;
        const m = metaMetrics(r);
        for (const [st, v] of Object.entries(m.stages)) seen[st] = (seen[st] || 0) + v;
        if (!m.spend && !m.impressions && !m.leads && !m.convos && !Object.keys(m.stages).length) continue;
        mrows.push([r.date_start, k, m.spend, m.impressions, m.link_clicks, m.leads, m.convos, m.depth2, m.depth3, m.first_reply, Object.keys(m.stages).length ? m.stages : 0]);
      }
    }
  }
  mrows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
  const G = { customer_id: client.accounts?.google || '', camps: old ? old.google.camps.map((c) => ({ ...c })) : [], rows: old ? old.google.rows.filter((r) => r[0] >= since && r[0] < from) : [] };
  if (client.accounts?.google) {
    try {
      const like = match.replace(/'/g, '');
      const cIdx = new Map(G.camps.map((c, i) => [c.id, i]));
      const key = (d, id) => d + '|' + id, acc = {};
      const base = await gaql(client.accounts.google, `SELECT segments.date, campaign.id, campaign.name, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.name LIKE '%${like}%' AND segments.date BETWEEN '${from}' AND '${today}'`);
      for (const x of base) {
        const id = String(x.campaign.id);
        const info = { id, name: x.campaign.name, channel: x.campaign.advertisingChannelType, service: serviceOf(x.campaign.name), region: /\bbrand\b/i.test(x.campaign.name) ? 'ALL' : regionOf(x.campaign.name) };
        let k = cIdx.get(id); if (k === undefined) { k = G.camps.length; G.camps.push(info); cIdx.set(id, k); } else G.camps[k] = info;
        const t = acc[key(x.segments.date, id)] || (acc[key(x.segments.date, id)] = [x.segments.date, k, 0, 0, 0, 0, 0, 0, 0, 0]);
        t[2] += num(x.metrics.costMicros) / 1e6; t[3] += num(x.metrics.impressions); t[4] += num(x.metrics.clicks); t[5] += num(x.metrics.conversions);
      }
      const split = await gaql(client.accounts.google, `SELECT segments.date, campaign.id, segments.conversion_action_name, metrics.conversions FROM campaign WHERE campaign.name LIKE '%${like}%' AND segments.date BETWEEN '${from}' AND '${today}'`);
      for (const x of split) {
        const t = acc[key(x.segments.date, String(x.campaign.id))]; if (!t) continue;
        const n = String(x.segments.conversionActionName || ''), v = num(x.metrics.conversions);
        if (/whats\s*app/i.test(n)) t[6] += v; else if (/call/i.test(n)) t[7] += v; else if (/form/i.test(n)) t[8] += v; else t[9] += v;
      }
      for (const t of Object.values(acc)) if (t[2] || t[5]) G.rows.push(t.map((v, i) => (i >= 2 ? r2(v) : v)));
      G.rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    } catch (e) { G.error = String(e.message || e).slice(0, 200); log(`${client.id}/leadgen google failed: ${G.error}`); }
  }
  const unk = adsets.filter((a) => a.region === 'OTHER');
  if (unk.length) log(`${client.id}/leadgen ad sets with no region: ${unk.slice(0, 10).map((x) => `"${x.name}"`).join(' | ')}`);
  log(`${client.id}/leadgen: kept ${since}..${today} (pulled ${from}..${today}), meta ${adsets.length} ad sets ${mrows.length} day rows, google ${G.camps.length} campaigns ${G.rows.length} day rows; stages ${Object.entries(seen).filter(([k]) => /PROSPECT$/.test(k)).map(([k, v]) => k + ' ' + Math.round(v)).join(', ') || 'none'}`);
  return { v: 2, since, until: today, match, matchKey, generated: new Date().toISOString(), meta: { adsets, rows: mrows }, google: G,
    notes: unk.length ? [`${unk.length} Meta ad set${unk.length > 1 ? 's' : ''} carry no region in the name (${unk.slice(0, 3).map((a) => a.name).join(', ')}); they count in totals but not in the region grid.`] : [] };
}

export async function diagCampaigns(client, since, until) {
  for (const acc of String(client.accounts?.meta || '').split(',').filter(Boolean)) {
    const rows = await metaRows(acc, { level: 'campaign', fields: 'spend,actions,campaign_name', time_range: JSON.stringify({ since, until }) });
    rows.sort((a, b) => num(b.spend) - num(a.spend));
    const match = client.leadgen?.match || 'Service';
    for (const r of rows.slice(0, 30)) log(`${client.id}/diag ${since.slice(0, 7)} ${String(r.campaign_name).includes(match) ? 'IN ' : 'OUT'} ${serviceOf(r.campaign_name).padEnd(5)} spend ${Math.round(num(r.spend))} leads ${Math.round(pick(r.actions, ['lead']))} | ${r.campaign_name}`);
  }
}
