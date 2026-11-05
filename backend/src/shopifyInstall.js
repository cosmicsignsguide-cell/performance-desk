// Connecting a Shopify store with one click.
//
// Shopify stopped letting stores make their own custom apps on 1 Jan 2026, so a store can no
// longer hand us an access token the old way. Instead we have one app of our own, made in the
// Shopify Dev Dashboard with custom distribution. For each store the Dev Dashboard gives an
// install link; the store owner opens it and approves, and Shopify runs the standard OAuth
// authorization code grant against the two routes below:
//
//   GET /shopify/install   the app URL. Shopify (or we) send the store here; we check the request
//                          really came from Shopify and send the owner on to approve the scopes.
//   GET /shopify/callback  the redirect URL. Shopify comes back with a one-time code, which we
//                          trade for the store's offline access token and save in Firestore.
//
// The token is saved under the store's myshopify domain in the shopTokens collection and is never
// written to a log or sent to a browser, and is stored encrypted. Custom apps get non-expiring offline tokens, so nothing
// needs refreshing; the token stops working only when the store uninstalls the app.

import crypto from 'node:crypto';
import { config, installedShopTokens } from './config.js';
import { log, nowIso } from './util.js';

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const STATE_TTL_MS = 15 * 60 * 1000;

// The team can read Firestore from the dashboard, so the token is stored encrypted (AES-256-GCM,
// key derived from the app secret, which lives only in the server's environment). Anyone reading
// the collection sees ciphertext; only this server can turn it back into a working token.
const encKey = () => crypto.createHash('sha256').update('shopTokens|' + config.shopify.app.clientSecret).digest();
function seal(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv); const out = Buffer.concat([c.update(text, 'utf8'), c.final()]); return [iv, c.getAuthTag(), out].map((b) => b.toString('base64')).join('.'); }
function unseal(blob) { const [iv, tag, data] = String(blob).split('.').map((x) => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString('utf8'); }

const enabled = () => !!(config.shopify.app.clientId && config.shopify.app.clientSecret);
const hmacHex = (msg) => crypto.createHmac('sha256', config.shopify.app.clientSecret).update(msg).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Shopify signs its redirects: every query parameter except hmac, sorted and joined as a=b&c=d,
// HMAC-SHA256 with the app secret, in hex.
function shopifySigned(params) {
  const h = params.get('hmac'); if (!h) return false;
  const msg = [...params.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  return safeEq(hmacHex(msg), h);
}

// The state we send to Shopify and expect back: issued time plus a signature over the shop, so a
// callback can only complete an install that this server started, for that same store, recently.
const makeState = (shop) => { const t = Date.now().toString(36), n = crypto.randomBytes(8).toString('hex'); return `${t}.${n}.${hmacHex(`state|${shop}|${t}|${n}`).slice(0, 32)}`; };
function stateOk(state, shop) {
  const [t, n, sig] = String(state || '').split('.'); if (!t || !n || !sig) return false;
  if (Date.now() - parseInt(t, 36) > STATE_TTL_MS) return false;
  return safeEq(hmacHex(`state|${shop}|${t}|${n}`).slice(0, 32), sig);
}

export async function loadShopTokens(store) {
  try {
    const rows = await store.list('shopTokens');
    installedShopTokens.clear();
    if (!enabled()) return 0;
    for (const r of rows) {
      if (!r.shop || !r.sealed) continue;
      try { installedShopTokens.set(String(r.shop).toLowerCase(), unseal(r.sealed)); } catch { log(`shopTokens: ${r.shop} could not be unlocked (app secret changed?), reconnect the store`); }
    }
  } catch (e) { log(`shopTokens: could not load (${String(e.message || e).slice(0, 120)})`); }
  return installedShopTokens.size;
}

const page = (res, code, title, body) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#FAF9F7;color:#171717;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<div style="max-width:440px;background:#fff;border:1px solid #eee;border-radius:14px;padding:28px"><h1 style="font-size:20px;margin:0 0 10px">${title}</h1><p style="line-height:1.5;margin:0;color:#444">${body}</p></div></body>`);
};

// Returns true when it handled the request.
export async function handleShopifyInstall(store, req, res, url, publicBase) {
  if (url.pathname !== '/shopify/install' && url.pathname !== '/shopify/callback') return false;
  if (!enabled()) { page(res, 503, 'Not set up yet', 'The store connection app is not configured on this server yet.'); return true; }
  const p = url.searchParams; const shop = String(p.get('shop') || '').toLowerCase();
  if (!SHOP_RE.test(shop)) { page(res, 400, 'Store not recognised', 'Open the install link from Shopify again.'); return true; }

  if (url.pathname === '/shopify/install') {
    // Opened from the Dev Dashboard install link, Shopify signs the request. We also accept a plain
    // ?shop= so the team can start a reconnect by hand; the scopes screen and the signed callback
    // still stand between that and any token.
    if (p.has('hmac') && !shopifySigned(p)) { page(res, 400, 'Link not valid', 'This link was not signed by Shopify. Open the install link again.'); return true; }
    const q = new URLSearchParams({ client_id: config.shopify.app.clientId, scope: config.shopify.app.scopes, redirect_uri: `${publicBase}/shopify/callback`, state: makeState(shop) });
    res.writeHead(302, { Location: `https://${shop}/admin/oauth/authorize?${q}`, 'Cache-Control': 'no-store' }); res.end();
    return true;
  }

  // Callback: Shopify's signature, our own state, then trade the code for the token.
  if (!shopifySigned(p) || !stateOk(p.get('state'), shop) || !p.get('code')) {
    log(`shopify install: rejected callback for ${shop} (signature or state did not match)`);
    page(res, 400, 'Could not connect', 'The approval did not check out. Open the install link and try once more.'); return true;
  }
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: config.shopify.app.clientId, client_secret: config.shopify.app.clientSecret, code: p.get('code') }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`HTTP ${r.status}${j.error ? ' ' + j.error : ''}`);
    await store.set('shopTokens', shop, { shop, sealed: seal(j.access_token), scope: j.scope || '', installedAt: nowIso() });
    installedShopTokens.set(shop, j.access_token);
    const want = config.shopify.app.scopes.split(','), got = String(j.scope || '').split(',');
    const missing = want.filter((s) => !got.includes(s) && !(s === 'read_orders' && got.includes('read_all_orders')));
    log(`shopify install: ${shop} connected (scopes: ${j.scope || 'none reported'}${missing.length ? '; missing ' + missing.join(',') : ''})`);
    page(res, 200, 'Store connected', 'Thank you. Your store is now connected to the Per4mance Guru dashboard. You can close this page.');
  } catch (e) {
    log(`shopify install: token exchange failed for ${shop} (${String(e.message || e).slice(0, 120)})`);
    page(res, 502, 'Could not connect', 'Shopify did not return access. Please try the install link again in a minute.');
  }
  return true;
}
