// Creative team incentive scoring. No API calls here — reads the same entities/{client} that
// the daily sync already pulls from Meta, so this runs at zero extra cost against the rate
// limit and needs no new token or permission.
//
// Design, per the agency's brief:
//   * NO fixed quantity target. A target just teaches the team to hit the number and stop, so
//     quantity is reported as a raw count and scored relative to the team's own rolling
//     average (the sqrt-vs-average taper lives in the dashboard, not here — this module hands
//     over the raw facts: who made how many, and how each one performed).
//   * Quality outranks quantity. One creative that performs very well should be able to win
//     the week even if that person made only one of them. So effectiveness is computed per ad
//     and rolled up spend-weighted, not just counted.
//   * Effectiveness is relative to the SAME client account's own baseline CTR in the same
//     window, never a global number. A school's normal CTR and a D2C brand's normal CTR are
//     not the same scale, and judging a creator's ad against the wrong one would be judging
//     the account, not the work.
//   * An ad with too little reach to read (under MIN_IMPRESSIONS) is counted toward quantity
//     (it was made) but left out of the effectiveness average until it has enough signal,
//     scored neutral rather than zero so a brand-new creative does not drag its creator down
//     the day it goes live.

import { addDays, todayStr, log, nowIso, round } from './util.js';
import { extractCreatorTag } from './report.js';

const MIN_IMPRESSIONS = 1000;       // below this, an ad's own CTR is too noisy to score on
const EFFECTIVENESS_NEUTRAL = 100;  // "performed exactly like the account's own average"
const EFFECTIVENESS_CAP = 250;      // one outlier ad cannot carry a creator past this index

// Monday-start week containing a YYYY-MM-DD date string, so payout periods line up with a
// normal work week rather than a rolling 7 days that quietly shifts its own boundary daily.
function weekBounds(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();                       // 0=Sun..6=Sat
  const start = addDays(dateStr, dow === 0 ? -6 : 1 - dow);
  return { start, end: addDays(start, 6) };
}
function weekId(startDate) {
  const d = new Date(startDate + 'T00:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// A per-ad window total from its stored day tuples: [spend, impressions, clicks, purchases, revenue, leads, installs]
function windowTotals(ad, start, end) {
  let spend = 0, impr = 0, clicks = 0;
  for (const [date, t] of Object.entries(ad.days || {})) {
    if (date < start || date > end) continue;
    spend += t[0] || 0; impr += t[1] || 0; clicks += t[2] || 0;
  }
  return { spend: round(spend), impr, clicks };
}

export async function computeCreatorScores(store, clients, { since, until } = {}) {
  const today = todayStr();
  const { start, end } = since && until ? { start: since, end: until } : weekBounds(today);
  const wid = weekId(start);

  const perCreator = new Map();   // tag -> { tag, ads: [...], clientIds: Set }
  let untaggedSeen = 0;
  let clientsConsidered = 0;

  for (const client of clients) {
    if (client.type !== 'ecom' || client.sample) continue;
    const ent = await store.get('entities', client.id);
    const ads = ent?.ads || [];
    if (!ads.length) continue;
    clientsConsidered += 1;

    // This account's own baseline CTR for the window: spend-weighted, i.e. computed straight
    // from total clicks / total impressions across every ad of this account in the window, so
    // one high-spend ad naturally outweighs a dozen barely-run tests the same way it would in
    // a plain CTR calculation.
    let baseImpr = 0, baseClicks = 0;
    for (const ad of ads) { const w = windowTotals(ad, start, end); baseImpr += w.impr; baseClicks += w.clicks; }
    const baselineCtr = baseImpr > 0 ? (baseClicks / baseImpr) * 100 : 0;

    for (const ad of ads) {
      const tag = extractCreatorTag(ad.name);
      const created = ad.createdDate || '';
      const createdInWindow = !!created && created >= start && created <= end;
      const w = windowTotals(ad, start, end);
      if (!tag) { if (createdInWindow || w.spend > 0) untaggedSeen += 1; continue; }
      if (!createdInWindow && w.spend === 0 && w.impr === 0) continue;   // nothing to say about this ad this week

      const ctr = w.impr > 0 ? (w.clicks / w.impr) * 100 : null;
      const effIndex = ctr !== null && w.impr >= MIN_IMPRESSIONS && baselineCtr > 0
        ? Math.min(EFFECTIVENESS_CAP, round((ctr / baselineCtr) * 100, 1))
        : null;   // not enough reach yet to read — scored neutral at rollup, not zero

      const rec = perCreator.get(tag) || { tag, ads: [], clientIds: new Set() };
      rec.ads.push({
        clientId: client.id, clientName: client.name, adId: ad.id, adName: ad.name,
        format: ad.format || (ad.isVideo ? 'Video' : 'Static'),
        createdInWindow, createdDate: created,
        spend: w.spend, impressions: w.impr, clicks: w.clicks,
        ctr: ctr !== null ? round(ctr, 2) : null, effIndex,
      });
      rec.clientIds.add(client.id);
      perCreator.set(tag, rec);
    }
  }

  // Weight by whichever is bigger, real spend or real reach, so a winning ad that hasn't had
  // budget pushed into it yet (impressions from organic reach in-feed, or a tiny test spend)
  // still counts on its performance rather than being drowned out by ads that just cost more.
  const weightOf = (a) => Math.max(a.spend, a.impressions / 1000);

  const creators = [...perCreator.values()].map((rec) => {
    const qty = rec.ads.filter((a) => a.createdInWindow).length;
    const scored = rec.ads.filter((a) => a.effIndex !== null);
    const totalWeight = scored.reduce((s, a) => s + weightOf(a), 0);
    const effectiveness = totalWeight > 0
      ? round(scored.reduce((s, a) => s + a.effIndex * weightOf(a), 0) / totalWeight, 1)
      : EFFECTIVENESS_NEUTRAL;
    return {
      tag: rec.tag, qty, effectiveness,
      scoredAds: scored.length, unscoredAds: rec.ads.length - scored.length,
      clients: [...rec.clientIds],
      ads: rec.ads.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
    };
  }).sort((a, b) => b.qty - a.qty);

  const teamAvgQty = creators.length ? round(creators.reduce((s, c) => s + c.qty, 0) / creators.length, 2) : 0;
  const doc = {
    weekId: wid, start, end, computedAt: nowIso(),
    clientsConsidered, teamAvgQty, untaggedAdsSeen: untaggedSeen,
    creators,
  };
  await store.set('creatorScores', wid, doc);
  await store.set('creatorScores', 'current', doc);
  log(`creators ${wid}: ${creators.length} creator(s) tagged, team avg qty ${teamAvgQty}, ${untaggedSeen} untagged ad(s) seen this window`);
  return doc;
}
