// One-time helper: get a client store's permanent Admin API access token.
//
//   node shopify-install.js link  CLIENT_ID store.myshopify.com
//   node shopify-install.js token CLIENT_ID CLIENT_SECRET "<the whole callback URL you landed on>"
//
// Why it is split in two, and why there is no local server any more:
//
// The old version ran a listener on http://localhost:53683 and had Shopify redirect back to it.
// Shopify's current Dev Dashboard refuses to save a localhost redirect URL at all ("Not a valid
// HTTP URL"), so that flow cannot even be configured on a newly created app. What works is a
// public HTTPS redirect. The desk API already has one, so the app points there, the browser lands
// on a URL carrying ?code=..., and `token` trades that code for the real token.
//
// The other thing this fixes: the old scope list left out read_reports. Without it Shopify will
// not answer ShopifyQL, the fetcher silently falls back to adding up raw orders, and net sales
// come out roughly 10% too HIGH (tax sits inside the subtotal and refunds land on the order's
// date rather than the refund's). Every store needs read_reports or its numbers flatter us.

const crypto = require('crypto');

const SCOPES = 'read_orders,read_products,read_inventory,read_customers,read_reports';
const REDIRECT = process.env.DESK_SHOPIFY_REDIRECT || 'https://desk-api-si2w.onrender.com/shopify/callback';

const [, , cmd, ...rest] = process.argv;
const die = (m) => { console.error(m); process.exit(1); };

if (cmd === 'link') {
  const [clientId, shopRaw] = rest;
  if (!clientId || !shopRaw) die('Usage: node shopify-install.js link CLIENT_ID store.myshopify.com');
  const shop = shopRaw.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const state = crypto.randomBytes(8).toString('hex');
  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}`
    + `&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}`;
  console.log(`\nIn the Dev Dashboard this app must have, on the RELEASED version:`);
  console.log(`  Redirect URL           ${REDIRECT}`);
  console.log(`  Custom distribution    ${shop}     (permanent, cannot be changed later)`);
  console.log(`  Use legacy install flow  ticked    (without it Shopify returns no code)`);
  console.log(`  Embed in Shopify admin   off\n`);
  console.log('Open this while logged in to THAT store, then copy the whole URL you land on:\n');
  console.log(url + '\n');
  process.exit(0);
}

if (cmd === 'token') {
  const [clientId, clientSecret, callbackUrl] = rest;
  if (!clientId || !clientSecret || !callbackUrl) die('Usage: node shopify-install.js token CLIENT_ID CLIENT_SECRET "<callback URL>"');
  let u;
  try { u = new URL(callbackUrl); } catch { die('That does not look like a URL. Paste the whole thing in quotes.'); }
  const code = u.searchParams.get('code');
  const shop = u.searchParams.get('shop');
  if (!code) die('No ?code= in that URL. Shopify only sends a code when "Use legacy install flow" is ticked\non the released version of the app. An hmac and host with no code means managed install.');
  if (!shop) die('No ?shop= in that URL.');

  // Shopify signs the callback, so check it before spending the code. A mismatch almost always
  // means the client secret belongs to a different app than the one that produced this URL.
  const params = [...u.searchParams.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  const digest = crypto.createHmac('sha256', clientSecret).update(params).digest('hex');
  const given = u.searchParams.get('hmac') || '';
  const ok = given.length === digest.length
    && crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(given, 'utf8'));
  if (!ok) die('HMAC check failed. The client secret does not match the app that made this link.');

  fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  })
    .then((r) => r.json())
    .then((j) => {
      if (!j.access_token) die('No token returned:\n' + JSON.stringify(j, null, 2)
        + '\n\nA code can only be spent once. If this says invalid_request, open the authorize link again for a fresh one.');
      const granted = String(j.scope || '');
      console.log(`\nADMIN API ACCESS TOKEN for ${shop}\n`);
      console.log(j.access_token + '\n');
      console.log('Granted scopes:', granted || '(none reported)');
      if (!granted.includes('read_reports')) {
        console.log('\nWARNING: read_reports was NOT granted. Sales figures from this store will be');
        console.log('computed from raw orders instead of Shopify’s own reports, which reads about 10%');
        console.log('too high. Add read_reports to the app’s scopes, release a new version, and redo this.');
      }
      console.log(`\nAdd it on Render as:  SHOPIFY_TOKEN_<CLIENTID>`);
    })
    .catch((e) => die(String(e)));
} else {
  console.log('Usage:');
  console.log('  node shopify-install.js link  CLIENT_ID store.myshopify.com');
  console.log('  node shopify-install.js token CLIENT_ID CLIENT_SECRET "<callback URL>"');
  process.exit(1);
}
