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

export async function buildLeadgen(client) {
  const until = todayStr(), since = until.slice(0, 8) + '01';
  const match = client.leadgen?.match || 'Service';
  const D = { meta: { period: { from: since, to: until }, generated: new Date().toISOString(), match }, meta_campaigns: [], meta_adsets: [], meta_daily: [], google: { customer_id: client.accounts?.google || '', campaigns: [], dg_daily: [] }, notes: [] };
  const filtering = JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: match }]);
  const range = JSON.stringify({ since, until });
  const F = 'spend,impressions,reach,frequency,inline_link_clicks,actions,conversions,campaign_id,campaign_name';
  for (const acc of String(client.accounts?.meta || '').split(',').filter(Boolean)) {
    const camps = await metaRows(acc, { level: 'campaign', fields: F, time_range: range, filtering });
    { const seen = {}; for (const r of camps) for (const x of [...(r.actions || []), ...(r.conversions || [])]) if (/custom|prospect|qualif/i.test(x.action_type)) seen[x.action_type] = (seen[x.action_type] || 0) + num(x.value);
      log(`${client.id}/leadgen custom events: ${Object.entries(seen).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ') || 'none'}`); }
    for (const r of camps) D.meta_campaigns.push({ campaign_id: r.campaign_id, campaign: r.campaign_name, objective: objectiveOf(r.campaign_name), service: serviceOf(r.campaign_name), ...metaMetrics(r) });
    const sets = await metaRows(acc, { level: 'adset', fields: F + ',adset_id,adset_name', time_range: range, filtering });
    for (const r of sets) D.meta_adsets.push({ campaign_id: r.campaign_id, campaign: r.campaign_name, adset_id: r.adset_id, adset: r.adset_name, objective: objectiveOf(r.campaign_name), service: serviceOf(r.campaign_name), region: regionOf(r.adset_name) !== 'OTHER' ? regionOf(r.adset_name) : regionOf(r.campaign_name), ...metaMetrics(r) });
    const daily = await metaRows(acc, { level: 'campaign', fields: 'spend,impressions,inline_link_clicks,actions,campaign_name', time_range: range, time_increment: '1', filtering });
    const by = {};
    for (const r of daily) { const k = r.date_start + '|' + objectiveOf(r.campaign_name); const m = metaMetrics(r); const t = by[k] || (by[k] = { date: r.date_start, objective: objectiveOf(r.campaign_name), spend: 0, impressions: 0, link_clicks: 0, leads: 0, convos: 0 }); for (const f of ['spend', 'impressions', 'link_clicks', 'leads', 'convos']) t[f] += m[f]; }
    // Every day of the month, so a day the account delivered nothing shows as zero, not a gap.
    for (let d = since; d <= until; d = addDays(d, 1)) for (const o of ['CAPI', 'VOLUME', 'CTWA']) if (!by[d + '|' + o]) by[d + '|' + o] = { date: d, objective: o, spend: 0, impressions: 0, link_clicks: 0, leads: 0, convos: 0 };
    D.meta_daily.push(...Object.values(by).map((x) => ({ ...x, spend: r2(x.spend) })));
  }
  if (client.accounts?.google) {
    try {
      const like = match.replace(/'/g, '');
      const base = await gaql(client.accounts.google, `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.name LIKE '%${like}%' AND segments.date BETWEEN '${since}' AND '${until}'`);
      const camps = {};
      for (const x of base) {
        const id = String(x.campaign.id), c = camps[id] || (camps[id] = { id, name: x.campaign.name, channel: x.campaign.advertisingChannelType, service: serviceOf(x.campaign.name), region: /\bbrand\b/i.test(x.campaign.name) ? 'ALL' : regionOf(x.campaign.name), spend: 0, impressions: 0, clicks: 0, conv: 0, wa: 0, calls: 0, form: 0, other: 0 });
        c.spend += num(x.metrics.costMicros) / 1e6; c.impressions += num(x.metrics.impressions); c.clicks += num(x.metrics.clicks); c.conv += num(x.metrics.conversions);
      }
      const split = await gaql(client.accounts.google, `SELECT campaign.id, segments.conversion_action_name, metrics.conversions FROM campaign WHERE campaign.name LIKE '%${like}%' AND segments.date BETWEEN '${since}' AND '${until}'`);
      for (const x of split) { const c = camps[String(x.campaign.id)]; if (!c) continue; const n = String(x.segments.conversionActionName || ''), v = num(x.metrics.conversions); if (/whats\s*app/i.test(n)) c.wa += v; else if (/call/i.test(n)) c.calls += v; else if (/form/i.test(n)) c.form += v; else c.other += v; }
      D.google.campaigns = Object.values(camps).filter((c) => c.spend > 0 || c.conv > 0).map((c) => ({ ...c, spend: r2(c.spend), conv: r2(c.conv), wa: r2(c.wa), calls: r2(c.calls), form: r2(c.form), other: r2(c.other) }));
      // Demand Gen, conversions per day for the last 7 days: the quality check on the original page.
      const s7 = addDays(until, -6) < since ? since : addDays(until, -6);
      const dg = await gaql(client.accounts.google, `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.name LIKE '%${like}%' AND campaign.advertising_channel_type = 'DEMAND_GEN' AND segments.date BETWEEN '${s7}' AND '${until}'`);
      const dd = {}; for (const x of dg) { const d = x.segments.date, t = dd[d] || (dd[d] = { date: d, spend: 0, clicks: 0, conv: 0 }); t.spend += num(x.metrics.costMicros) / 1e6; t.clicks += num(x.metrics.clicks); t.conv += num(x.metrics.conversions); }
      D.google.dg_daily = Object.values(dd).sort((a, b) => (a.date < b.date ? -1 : 1)).map((x) => ({ ...x, spend: r2(x.spend), conv: r2(x.conv) }));
    } catch (e) { D.google.error = String(e.message || e).slice(0, 200); log(`${client.id}/leadgen google failed: ${D.google.error}`); }
  }
  const unk = D.meta_adsets.filter((a) => a.region === 'OTHER');
  if (unk.length) log(`${client.id}/leadgen ad sets with no region: ${unk.map((x) => `"${x.adset}" (${x.campaign.slice(0, 40)})`).slice(0, 12).join(' | ')}`);
  if (unk.length) D.notes.push(`${unk.length} Meta ad set${unk.length > 1 ? 's' : ''} carry no region in the name (${unk.slice(0, 3).map((a) => a.adset).join(', ')}); they count in totals but not in the region grid.`);
  const sp = D.meta_campaigns.reduce((a, c) => a + c.spend, 0), gs = D.google.campaigns.reduce((a, c) => a + c.spend, 0);
  log(`${client.id}/leadgen: ${since}..${until} meta ${D.meta_campaigns.length} campaigns ${D.meta_adsets.length} ad sets spend ${Math.round(sp)}, google ${D.google.campaigns.length} campaigns spend ${Math.round(gs)}`);
  return D;
}
