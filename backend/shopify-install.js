// One-time helper: install a Dev Dashboard (custom distribution) app on a client's Shopify store and get its
// permanent Admin API access token. Needs Node 18 or newer.
//
// Usage:  node shopify-install.js CLIENT_ID CLIENT_SECRET store.myshopify.com
// Then open the printed URL, log in to that store (collaborator access works), click Install.
//
// In the Dev Dashboard the app must have:  App URL = http://localhost:53683/   Redirect URL = http://localhost:53683/callback

const [, , CLIENT_ID, CLIENT_SECRET, SHOP_RAW] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET || !SHOP_RAW) {
  console.log('Usage: node shopify-install.js CLIENT_ID CLIENT_SECRET store.myshopify.com');
  process.exit(1);
}
const http = require('http');
const crypto = require('crypto');
const SHOP = SHOP_RAW.replace(/^https?:\/\//, '').replace(/\/$/, '');
const PORT = 53683;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = 'read_orders,read_products,read_inventory,read_customers';
const state = crypto.randomBytes(8).toString('hex');

const installUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}`;
console.log('\nOpen this URL in your browser, log in to the store, and click Install:\n');
console.log(installUrl + '\n');
console.log('Waiting for Shopify to redirect back...');

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.end('Per4mance Desk install helper is running. Use the URL printed in the terminal.'); return; }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state || url.searchParams.get('shop') !== SHOP) { res.end('Bad callback. Go back to the terminal and run again.'); return; }
  // Verify Shopify's HMAC so nobody can hand us a fake code
  const params = [...url.searchParams.entries()].filter(([k]) => k !== 'hmac').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(params).digest('hex');
  if (digest !== url.searchParams.get('hmac')) { res.end('HMAC check failed.'); console.log('HMAC mismatch, check the client secret.'); return; }
  try {
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const j = await r.json();
    if (!j.access_token) { res.end('No token returned. Check the terminal.'); console.log('Response:', JSON.stringify(j, null, 2)); process.exit(1); }
    res.end('Done. You can close this tab and go back to the terminal.');
    console.log(`\nADMIN API ACCESS TOKEN for ${SHOP} (save as SHOPIFY_TOKEN_<CLIENTID>):\n`);
    console.log(j.access_token + '\n');
    console.log('Granted scopes:', j.scope);
    process.exit(0);
  } catch (e) { res.end('Error, check the terminal.'); console.error(e); process.exit(1); }
}).listen(PORT);
