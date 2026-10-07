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
//   * Attribution runs through the Creator Portal, not bare initials in the ad name. Each
//     upload there gets a short code (creatorPortal.js); the creator pastes that code, not
//     their own initials, into the ad name once it goes live. That means this module never
//     has to trust a hand-typed name match — it reads creatorUploads/{code} to find out who
//     actually made the thing, and flips that upload from "pending" to "linked" the first
//     time the code is seen on a real ad, which is also how each creator's own portal page
//     knows their upload went live.

import { addDays, todayStr, log, nowIso, round } from './util.js';
import { extractCreatorCode } from './report.js';

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

  // One read for every code ever issued, not per-ad. A code resolves to the person who
  // actually uploaded it (not whatever anyone typed into Ads Manager), and the first time a
  // code shows up on a real ad, that upload flips from "pending" to "linked" right here — the
  // same write a creator's own portal page reads to show them "this went live".
  const uploads = await store.list('creatorUploads');
  const byCode = new Map(uploads.map((u) => [u.id, u]));
  const linkWrites = [];

  const perCreator = new Map();   // creatorEmail -> { creatorEmail, creatorName, ads: [...], clientIds: Set }
  let unresolvedCodes = 0;
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
      const code = extractCreatorCode(ad.name);
      const created = ad.createdDate || '';
      const createdInWindow = !!created && created >= start && created <= end;
      const w = windowTotals(ad, start, end);
      if (!code) { if (createdInWindow || w.spend > 0) untaggedSeen += 1; continue; }
      const upload = byCode.get(code);
      if (!upload) { unresolvedCodes += 1; continue; }   // a code that doesn't match any upload we issued
      if (!createdInWindow && w.spend === 0 && w.impr === 0) continue;   // nothing to say about this ad this week

      if (upload.status !== 'linked') {
        linkWrites.push(store.merge('creatorUploads', code, {
          status: 'linked', linkedAdId: ad.id, linkedAdName: ad.name,
          linkedClientId: client.id, linkedAt: nowIso(),
        }));
        upload.status = 'linked';   // so the rest of this same run already treats it as linked
      }

      const ctr = w.impr > 0 ? (w.clicks / w.impr) * 100 : null;
      const effIndex = ctr !== null && w.impr >= MIN_IMPRESSIONS && baselineCtr > 0
        ? Math.min(EFFECTIVENESS_CAP, round((ctr / baselineCtr) * 100, 1))
        : null;   // not enough reach yet to read — scored neutral at rollup, not zero

      const email = upload.creatorEmail;
      const rec = perCreator.get(email) || { creatorEmail: email, creatorName: upload.creatorName || email, ads: [], clientIds: new Set() };
      rec.ads.push({
        clientId: client.id, clientName: client.name, adId: ad.id, adName: ad.name, code,
        format: ad.format || (ad.isVideo ? 'Video' : 'Static'),
        createdInWindow, createdDate: created,
        spend: w.spend, impressions: w.impr, clicks: w.clicks,
        ctr: ctr !== null ? round(ctr, 2) : null, effIndex,
      });
      rec.clientIds.add(client.id);
      perCreator.set(email, rec);
    }
  }
  if (linkWrites.length) await Promise.all(linkWrites);

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
      creatorEmail: rec.creatorEmail, creatorName: rec.creatorName, qty, effectiveness,
      scoredAds: scored.length, unscoredAds: rec.ads.length - scored.length,
      clients: [...rec.clientIds],
      ads: rec.ads.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
    };
  }).sort((a, b) => b.qty - a.qty);

  const teamAvgQty = creators.length ? round(creators.reduce((s, c) => s + c.qty, 0) / creators.length, 2) : 0;
  const doc = {
    weekId: wid, start, end, computedAt: nowIso(),
    clientsConsidered, teamAvgQty, untaggedAdsSeen: untaggedSeen, unresolvedCodes,
    creators,
  };
  await store.set('creatorScores', wid, doc);
  await store.set('creatorScores', 'current', doc);
  log(`creators ${wid}: ${creators.length} creator(s), team avg qty ${teamAvgQty}, ${untaggedSeen} untagged ad(s), ${unresolvedCodes} unresolved code(s)`);
  return doc;
}
