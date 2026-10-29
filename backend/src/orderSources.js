// Order sources: which visit each Shopify order came from, sorted into Platform > Channel > Campaign.
//
// Attribution is the LAST visit before the order (Shopify's customerJourneySummary.lastVisit), by
// decision. It is what the customer actually clicked right before buying, it is what UTM reports and
// most checkout apps record, and it gives one answer per order so the totals add up to the store's
// own order count. Platforms each claim the orders they touched inside their own window, so their
// numbers overlap; this view never double counts.
//
// The order of evidence for one order, strongest first:
//   1. UTM parameters on the last visit, as Shopify recorded them
//   2. UTM keys a checkout app wrote into the order's note attributes (GoKwik, Shopflo and similar
//      carry utm_source and friends there, and Shopify's own journey can be empty for those orders)
//   3. UTM or click IDs in the landing page URL (gclid, gbraid, wbraid, srsltid, fbclid)
//   4. The referrer and Shopify's own source label
// Nothing is guessed past that. An order with none of it is "Direct", and the Direct bucket keeps
// what little it had (a click ID, a referrer) so the team can see what Direct is hiding.
//
// Test orders are removed before anything is counted: Shopify's own test flag (bogus gateway or a
// payment provider in test mode), plus anything under TEST_BELOW in store currency, which catches the
// one and two rupee orders people place to check a checkout. They are counted on the side and the
// pages say how many were dropped, so nothing disappears silently.

export const TEST_BELOW = 10;

const lc = (v) => String(v ?? '').trim().toLowerCase();
const clean = (v) => String(v ?? '').trim();

function paramsOf(url) {
  try { return new URL(String(url), 'https://x.invalid').searchParams; } catch { return new URLSearchParams(); }
}
function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// Note attributes come in every spelling: utm_source, _utm_source, UTM Source, utmSource.
function utmFromAttributes(attrs) {
  const out = {};
  for (const a of attrs || []) {
    const k = lc(a?.key).replace(/[^a-z]/g, '');
    const m = k.match(/utm(source|medium|campaign|content|term)$/);
    if (m && clean(a.value) && !out[m[1]]) out[m[1]] = clean(a.value);
  }
  return out;
}

const META_SRC = /(^|[^a-z])(facebook|fb|ig|instagram|meta|messenger|an|audience_network|threads)([^a-z]|$)/;
const GOOGLE_SRC = /(^|[^a-z])(google|youtube|yt|gmail|gads|adwords|pmax|dv360)([^a-z]|$)/;
const PAID_MED = /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|paidsearch|paid_search|cpm|display|ads?|social_paid|retargeting|shopping_ads?)$/;
const AI_REF = /(chatgpt\.com|chat\.openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai)/;

// Returns { p, c, s, m, ca, te, co, rk } for one order.
//   p  platform: Meta | Google | Other
//   c  channel inside the platform
//   s m ca te co  the UTM values as found (source, medium, campaign, term, content), lowercased
//               for source and medium so "Google" and "google" group together
//   rk what the evidence was, in words, for the Direct bucket and the method notes
export function classifyOrder(o) {
  const cj = o.customerJourneySummary || {};
  const visit = cj.lastVisit || cj.firstVisit || null;
  const landing = visit?.landingPage || '';
  const referrer = visit?.referrerUrl || '';
  const lp = paramsOf(landing);
  const fromVisit = visit?.utmParameters || {};
  const fromAttr = utmFromAttributes(o.customAttributes);
  const fromUrl = { source: lp.get('utm_source'), medium: lp.get('utm_medium'), campaign: lp.get('utm_campaign'), term: lp.get('utm_term'), content: lp.get('utm_content') };
  const pick = (k) => clean(fromVisit[k]) || clean(fromAttr[k]) || clean(fromUrl[k]) || '';
  const rawSource = pick('source');
  let s = lc(rawSource), m = lc(pick('medium'));
  let ca = pick('campaign');
  const te = pick('term'), co = pick('content');
  // A URL template filled the wrong way round (seen on live accounts): utm_source carries the
  // campaign name, "PG | HP | ABO | Testing | 17.09.26". A pipe never appears in a real source
  // name, only in an agency campaign name, so this is a paid Meta campaign with its name in the
  // source field. Read it as that, keep the raw value as the campaign.
  const nameInSource = rawSource.includes('|');
  const has = (k) => lp.has(k) || paramsOf(referrer).has(k);
  const gclid = has('gclid') || has('gbraid') || has('wbraid') || has('gad_source');
  const srsltid = has('srsltid');
  const fbclid = has('fbclid');
  const refHost = hostOf(referrer);
  const vsrc = lc(visit?.source);

  let rk = '';
  if (gclid) rk = 'Google Ads click ID (gclid)';
  else if (srsltid) rk = 'Google Shopping click ID (srsltid)';
  else if (fbclid) rk = 'Meta click ID (fbclid)';
  else if (refHost) rk = 'Referrer ' + refHost;
  else if (visit) rk = 'Own site (no ad ID)';
  else rk = 'No visit recorded';

  if (!s) {
    // No UTM anywhere. Fall back to click IDs, then the referrer, then Shopify's label.
    if (gclid) s = 'google', m = m || 'cpc';
    else if (fbclid) s = 'facebook', m = m || 'paid';
    else if (srsltid) s = 'google', m = m || 'product_sync';
    else if (refHost) s = refHost;
    else if (vsrc && vsrc !== 'unknown') s = vsrc;
    else s = 'direct';
  }

  let p = 'Other', c = 'Other referral';
  // Meta organic only when nothing on the visit looks like an ad: no click ID, no campaign, and a
  // medium that is empty or plainly organic. Anything else from Meta is an ad, however the URL
  // template happened to fill the fields (an ad name in utm_medium is still an ad).
  const ORGANIC_MED = /^(|social|organic|referral|bio|profile|story|post|link_in_bio|igshopping)$/;
  if (nameInSource && !gclid) {
    p = 'Meta'; c = 'Meta Ads (paid)'; ca = rawSource;
    s = 'meta (campaign name in source)';
  } else if (META_SRC.test(s) || refHost.match(/(facebook|instagram|fb)\.com$/) || fbclid) {
    p = 'Meta';
    c = (fbclid || PAID_MED.test(m) || /^\d{6,}$/.test(ca) || ca || !ORGANIC_MED.test(m)) ? 'Meta Ads (paid)' : 'Meta organic';
  } else if (GOOGLE_SRC.test(s) || /(^|\.)google\.[a-z.]+$/.test(refHost) || gclid || srsltid) {
    p = 'Google';
    if (m === 'product_sync' || (srsltid && !gclid && !PAID_MED.test(m))) c = 'Google free listings';
    else if (PAID_MED.test(m) || gclid || /^\d{8,}$/.test(ca)) c = 'Google Ads (paid)';
    else if (/youtube|yt/.test(s)) c = 'YouTube';
    else c = 'Google organic search';
  } else if (s === 'direct' || s === '(direct)') {
    c = 'Direct';
  } else if (AI_REF.test(s) || AI_REF.test(refHost)) {
    c = 'AI assistants';
  } else if (/email|newsletter|klaviyo|mailchimp|shopify_email|brevo/.test(s + ' ' + m)) {
    c = 'Email';
  } else if (/whatsapp|wa|sms|kwikengage|interakt|wati|gupshup|automation|push/.test(s + ' ' + m)) {
    c = 'WhatsApp, SMS and automation';
  } else if (/influencer|affiliate|creator|collab/.test(s + ' ' + m)) {
    c = 'Influencers and affiliates';
  } else if (/bing|yahoo|duckduckgo|ecosia|yandex/.test(s)) {
    c = 'Other search';
  }
  return { p, c, s, m, ca, te, co, rk };
}

export function isTestOrder(o, value) {
  return o.test === true || (value > 0 && value < TEST_BELOW) || /bogus/i.test((o.paymentGatewayNames || []).join(' '));
}

export function payOf(o) {
  const g = (o.paymentGatewayNames || []).join(' ').toLowerCase();
  if (/cash on delivery|cod\b|\bcod/.test(g)) return 'COD';
  if (!g || /manual/.test(g)) return o.displayFinancialStatus === 'PAID' ? 'Prepaid' : 'Other';
  return 'Prepaid';
}

// Group one day's orders into compact rows: [p, c, s, m, ca, te, co, rk, orders, value, newCustomers, cod]
// Value is what the customer paid after refunds (current total, the store's own headline figure),
// so a campaign's order value here lines up with total sales on the store side.
export function groupDay(list) {
  const map = new Map();
  for (const x of list) {
    const k = [x.p, x.c, x.s, x.m, x.ca, x.te, x.co, x.rk].join('\u0001');
    const g = map.get(k) || [x.p, x.c, x.s, x.m, x.ca, x.te, x.co, x.rk, 0, 0, 0, 0];
    g[8] += 1; g[9] = Math.round((g[9] + x.v) * 100) / 100; g[10] += x.nc ? 1 : 0; g[11] += x.cod ? 1 : 0;
    map.set(k, g);
  }
  return [...map.values()];
}

// The id the UTM campaign points at on the ad platform, if any. Google auto-tagging and most Meta
// URL templates put the numeric id in utm_campaign; otherwise the campaign name is there.
export const normName = (v) => lc(v).replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// The feed both pages read, built on the server from orderdays/{clientId}_{date}.
//
// Each order group is tied to an ad platform campaign where the UTM campaign points at one: by id
// first (Google auto-tagging and most Meta URL templates put the numeric id there), then by name.
// That is what lets a campaign show its own spend and a store ROAS = order value the store recorded
// from that campaign / what the campaign cost in the same days. Campaigns that spent but brought no
// recorded order are listed too, with ROAS 0, because hiding them would flatter every table.
//
// opts.internal  true for the team's dashboard: raw names, the full UTM ledger and the Direct
//                bucket evidence. false for the client report: cleaned names, no raw UTM strings.
// opts.clean     the report's name cleaner (passed in to keep this module free of report.js).
// opts.entities  the client's entity tree (campaigns, ad sets, ads). Many URL templates put the ad
//                set or ad id in utm_campaign instead of the campaign id; the tree maps those back to
//                their campaign, and also names campaigns that had no spend inside the window.
export function buildSourceFeed(docs, { internal = false, clean = (n) => n, clientName = '', entities = null } = {}) {
  const days = [], rows = [], ledger = [], spend = [], camps = {};
  const idx = { Meta: { byId: new Map(), byName: new Map() }, Google: { byId: new Map(), byName: new Map() } };
  const sorted = docs.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const doc of sorted) {
    for (const [p, arr] of [['Meta', doc.spendMeta], ['Google', doc.spendGoogle]]) {
      const a = arr || [];
      for (let i = 0; i + 2 < a.length; i += 3) { const id = String(a[i]), name = String(a[i + 1] || ''); idx[p].byId.set(id, name); if (name) idx[p].byName.set(normName(name), id); }
    }
  }
  // A short UTM name ("pg_search_recliner") against the full campaign name ("PG | Search | Recliner |
  // Max Conv | 25/03"): tie them only when every word of the UTM value is in exactly ONE campaign name
  // of that platform. Two candidates means it is ambiguous, and an ambiguous match is left unmatched.
  const tokCache = new Map();
  const tokenMatch = (p, ca) => {
    const want = normName(ca).split(' ').filter((t) => t.length > 1 && !/^\d{1,2}$/.test(t));
    if (want.length < 2) return '';
    const key = p + '|' + want.join(' ');
    if (tokCache.has(key)) return tokCache.get(key);
    let hit = '', count = 0;
    for (const [id, name] of idx[p].byId) { const have = new Set(normName(name).split(' ')); if (want.every((t) => have.has(t))) { hit = id; count += 1; } }
    const out = count === 1 ? hit : '';
    tokCache.set(key, out); return out;
  };
  const alias = new Map();   // ad set or ad id -> campaign id (Meta)
  if (entities) {
    for (const c of entities.campaigns || []) {
      const p = c.platform === 'google' ? 'Google' : 'Meta';
      const id = String(c.id || ''); if (!id) continue;
      if (!idx[p].byId.has(id)) idx[p].byId.set(id, c.name || '');
      if (c.name && !idx[p].byName.has(normName(c.name))) idx[p].byName.set(normName(c.name), id);
    }
    for (const x of [...(entities.adsets || []), ...(entities.ads || [])]) {
      if (!x?.id || !x.campaignId) continue;
      alias.set(String(x.id), String(x.campaignId));
      if (!idx.Meta.byId.has(String(x.campaignId)) && x.campaignName) idx.Meta.byId.set(String(x.campaignId), x.campaignName);
    }
  }
  const label = (p, id, raw) => {
    if (internal) return id ? `${idx[p].byId.get(id) || raw}` : (raw || '(no campaign tag)');
    if (id) return clean(idx[p].byId.get(id) || raw, clientName, 'campaign');
    if (!raw) return 'Untagged';
    if (/\{\{.*\}\}/.test(raw)) return 'Untagged (link template not filled)';
    if (/^\d{6,}$/.test(raw)) return 'Campaign ending ' + raw.slice(-4);
    return clean(raw, clientName, 'campaign');
  };
  const keyOf = (p, c, ca) => {
    if (idx[p]) {
      const id = idx[p].byId.has(String(ca)) ? String(ca) : (p === 'Meta' && alias.has(String(ca)) ? alias.get(String(ca)) : '') || idx[p].byName.get(normName(ca)) || tokenMatch(p, ca);
      if (id) { const k = `${p}:${id}`; if (!camps[k]) camps[k] = { p, c: p === 'Meta' ? 'Meta Ads (paid)' : 'Google Ads (paid)', name: label(p, id, ca), id: internal ? id : undefined }; return k; }
    }
    const k = `${p}:${c}:${normName(ca)}`;
    if (!camps[k]) camps[k] = { p, c, name: idx[p] ? label(p, '', ca) : (ca ? (internal ? ca : clean(ca, clientName, 'campaign')) : '') };
    return k;
  };
  for (const doc of sorted) {
    const d = doc.date;
    days.push([d, doc.test?.n || 0, doc.test?.v || 0, doc.cancelled?.n || 0, doc.g ? 1 : 0]);
    const g = doc.g || [], w = doc.gw || 12;
    const agg = new Map();
    for (let i = 0; i + w - 1 < g.length; i += w) {
      const [p, c, s, m, ca, te, co, rk, n, v, nc, cod] = g.slice(i, i + w);
      const k = keyOf(p, c, ca);
      const r = agg.get(k) || [d, p, c, k, 0, 0, 0, 0];
      r[4] += n; r[5] = Math.round((r[5] + v) * 100) / 100; r[6] += nc; r[7] += cod;
      agg.set(k, r);
      if (internal) ledger.push([d, p, c, s, m, ca, te, co, rk, n, v]);
    }
    rows.push(...agg.values());
    for (const [p, arr] of [['Meta', doc.spendMeta], ['Google', doc.spendGoogle]]) {
      const a = arr || [];
      for (let i = 0; i + 2 < a.length; i += 3) {
        const id = String(a[i]), k = `${p}:${id}`;
        if (!camps[k]) camps[k] = { p, c: p === 'Meta' ? 'Meta Ads (paid)' : 'Google Ads (paid)', name: label(p, id, String(a[i + 1] || '')), id: internal ? id : undefined };
        spend.push([d, k, a[i + 2]]);
      }
    }
  }
  return { testBelow: TEST_BELOW, days, rows, spend, camps, ...(internal ? { ledger } : {}) };
}
