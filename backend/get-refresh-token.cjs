// One-time helper: get a Google Ads API refresh token.
// Needs Node 18 or newer.
// Usage:  node get-refresh-token.cjs CLIENT_ID CLIENT_SECRET
// Then open the printed URL, log in with the Google account that has MCC access, click Allow.

const [, , CLIENT_ID, CLIENT_SECRET] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('Usage: node get-refresh-token.cjs CLIENT_ID CLIENT_SECRET');
  process.exit(1);
}

const http = require('http');
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/`;
// Google Ads + GA4 read scope in one token, so the same refresh token serves both fetchers.
const SCOPE = 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/analytics.readonly';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  '&response_type=code' +
  `&scope=${encodeURIComponent(SCOPE)}` +
  '&access_type=offline' +
  '&prompt=consent';

console.log('\nOpen this URL in your browser and log in with the account that has MCC access:\n');
console.log(authUrl + '\n');
console.log('Waiting for Google to redirect back...');

http
  .createServer(async (req, res) => {
    const code = new URL(req.url, REDIRECT).searchParams.get('code');
    if (!code) {
      res.end('No code received. Go back to the terminal and try again.');
      return;
    }
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT,
          grant_type: 'authorization_code',
        }),
      });
      const j = await r.json();
      if (!j.refresh_token) {
        res.end('Google did not return a refresh token. Check the terminal.');
        console.log('\nNo refresh_token in response:', JSON.stringify(j, null, 2));
        console.log('If you have authorised this app before, remove it at myaccount.google.com/permissions and run again.');
        process.exit(1);
      }
      res.end('Done. You can close this tab and go back to the terminal.');
      console.log('\nREFRESH TOKEN (save this as GOOGLE_OAUTH_REFRESH_TOKEN):\n');
      console.log(j.refresh_token + '\n');
      process.exit(0);
    } catch (e) {
      res.end('Error. Check the terminal.');
      console.error(e);
      process.exit(1);
    }
  })
  .listen(PORT);
