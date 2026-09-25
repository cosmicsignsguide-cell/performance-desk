# Performance Desk

Internal dashboard for the Per4mance Guru performance marketing team. One place for every client's Meta Ads, Google Ads and Shopify numbers, creative ranking, funnel leakage, and a 30-minute site check that catches cart, checkout and tracking failures before the client does.

Built the same way as the SEO Command Center: a backend on Render writes to Firestore, a static dashboard reads from it.

```
Meta API ─┐
Google ───┼─► backend (Render cron) ─► Firestore ─► frontend (Render static site, Google sign-in)
Shopify ──┤                             ▲
GA4 ──────┘                             │
Site Watch (headless browser, every 30 min) ─► Firestore + Slack alerts
```

## What is in this repo

| Path | What it is |
|---|---|
| `backend/src/index.js` | Commands: `daily`, `hourly`, `sitewatch`, `seed`, `test-tokens`, `status`, `serve` (HTTP endpoint for the Sync now button) |
| `backend/src/fetchers/` | One file per source: `meta.js`, `google.js`, `shopify.js`, `ga4.js`. Read-only. |
| `backend/src/sitewatch.js` | Playwright checks: homepage, SSL, pixel + GA4 firing, product page, add to cart, checkout renders (ecom) or lead form present (lead gen) |
| `backend/src/signals.js` | Leakage signals against each client's own baseline: no spend, checkout stuck, order drop, tracking drop, low stock, lead drop, pacing, KPI miss, fatigue, learning limited |
| `backend/src/alerts.js` | Slack webhook + optional generic webhook, 6 hour cooldown per client per alert type |
| `backend/src/sample.cjs` | Sample data generator, shared with the dashboard's demo mode |
| `backend/clients.json` | Client registry: accounts, budget, target, site url. Edit + redeploy = client added |
| `backend/get-refresh-token.js` | One-time helper to get the Google OAuth refresh token |
| `backend/shopify-install.js` | One-time helper per store: installs the Dev Dashboard app and prints its permanent Admin API token |
| `frontend/index.html` | The dashboard. Runs in demo mode until `config.js` exists |
| `frontend/config.example.js` | Copy to `config.js` with the Firebase web config |
| `firestore.rules` | Read allowed only for verified `@per4mance.guru` Google accounts, no browser writes |
| `render.yaml` | Render blueprint: 3 cron jobs + 1 static site |

## What the dashboard shows

- **Overview**: every client on one screen for Today, Yesterday, 7d, 14d, 30d or MTD, with deltas against the comparable period, a "Needs attention" list (worst first) and pacing bars.
- **Client page**: KPI strip (spend, platform ROAS, Shopify orders, net sales, MER, CPA, CAC, AOV, abandoned checkouts), what to fix, "Today so far" against the same weekday last week (hourly snapshots), spend and ROAS by day, store funnel next to the Meta pixel funnel with leakage highlighting.
- **Campaigns tab**: Ads Manager style tree, campaign > ad set > ad, with status, budget, spend, results, CPA, ROAS, CTR, CPM for the selected range and deltas against the previous one. Both platforms.
- **Creatives tab**: every ad with hook rate, hold rate, CTR trend, frequency, days live and a call (Scale, Steady, Watch, Fatiguing, Pause, Testing) with the reason.
- **Orders tab**: today's and yesterday's Shopify orders (time, items, value, new or returning, first-visit source, discount code, status), abandoned checkouts and refunds.
- **Products tab**: 30 day best sellers with units, revenue, current stock and days of stock left.
- **Site Watch tab**: the latest synthetic check and the last 96 runs.
- **Copy client update**: a WhatsApp-ready summary of yesterday, the week, pacing and open issues.

## Data contract (Firestore collections)

```
clients/{clientId}                        name, type (ecom|lead), currency, budget, target {roas|cpl}, am, accounts {meta, google, shopify {shop, tokenEnv}, ga4}, site {url, productPath, leadFormPath}
daily/{clientId}_{yyyy-mm-dd}_{platform}  platform = meta | google | shopify | ga4
                                          ads:     spend, impressions, clicks, purchases, revenue, leads, lpv, atc, ic (pixel funnel)
                                          shopify: orders, grossSales, netSales, refunds, newCustomerOrders, units, checkoutsStarted
                                          ga4:     sessions, ga4Atc, ga4Checkouts, ga4Purchases
entities/{clientId}                       campaigns[], adsets[], ads[] each with 30d totals + days {date: [spend, impressions, clicks, purchases, revenue, leads]} for 35 days,
                                          status, budgets, learning stage; ads also hookRate, holdRate, last7/prev7, thumb, issues; products[]; recentOrders[]; issues[]; account
intraday/{clientId}_{date}                hours {"13": {spend, purchases, revenue, leads, orders, netSales, checkoutsStarted}} cumulative, written by the hourly run
signals/{clientId}                        items[] {type, severity, message, value, baseline}
sitewatch/{clientId}                      checks[], history[] (last 96 runs)
syncs/{clientId}                          per source: {at, ok, mode: live|sample|waiting|error, error}
alerts/{autoId}                           log of everything sent
```

Metric definitions the dashboard uses:

- Platform ROAS = platform-reported revenue / spend. MER = Shopify net sales / total ad spend.
- Net sales = order subtotal after discounts and refunded items, before shipping and tax.
- CPA = spend / Shopify orders (platform purchases if no Shopify). CAC = spend / first-time-customer orders (Shopify's `customerOrderIndex == 1`).
- Attribution coverage = platform purchases / Shopify orders. A sudden drop with steady orders = tracking broke.
- Hook rate = 3 second plays / impressions. Hold rate = ThruPlays / 3 second plays.
- Fatiguing = frequency past 3.2 and CTR down 15%+ and CPM up 12%+, last 7 days vs the 7 before.
- Checkout stuck = today's orders / checkouts started under 35% of the 14 day norm, with 15+ checkouts.

## Setup, in order

### 1. Firebase (5 min)
1. console.firebase.google.com, Add project, name it (for example `per4mance-desk`), Analytics off.
2. Build, Firestore Database, Create, location `asia-south1`, production mode.
3. Build, Authentication, Sign-in method, enable Google.
4. Firestore, Rules tab: paste `firestore.rules`, Publish.
5. Project settings, Service accounts, Generate new private key. Keep the JSON file safe. This is `FIREBASE_SERVICE_ACCOUNT_JSON` (paste the whole file as one line).
6. Project settings, General, Your apps, Add web app, name `desk`. Copy the config block into `frontend/config.js` (copy `config.example.js` first).
7. Authentication, Settings, Authorized domains: add the Render dashboard domain once you have it (step 4).

### 2. Client registry
Edit `backend/clients.json`. For the first client fill `name`, `type`, `budget`, `target`, `accounts.meta` (digits only, no `act_`), `accounts.google` (digits only), `accounts.shopify.shop` (`store.myshopify.com`), `site.url` (the live domain), and set `"active": true`.

### 3. Tokens (all read-only)
| Env var | Where it comes from |
|---|---|
| `META_ACCESS_TOKEN` | Business Settings, System Users, your system user, Generate New Token, app Per4mance Desk, permissions `ads_read` + `read_insights`, expiry Never |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | MCC, Tools and Settings, API Center. Needs Basic access (apply from the same page if it says Test) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | The MCC id, digits only |
| `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` | Google Cloud, APIs and Services, Credentials, OAuth client, type Desktop app. Enable "Google Ads API" and "Google Analytics Data API" in the Library first |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | `node backend/get-refresh-token.js CLIENT_ID CLIENT_SECRET`, open the URL, log in with the account that is on the MCC |
| `SHOPIFY_TOKEN_CLIENT_ONE` | Since Jan 2026 Shopify no longer creates custom apps inside the store admin. Make the app once in the Dev Dashboard (dev.shopify.com): Create app, name `Per4mance Desk`, App URL `http://localhost:53683/`, Redirect URL `http://localhost:53683/callback`, Admin API scopes `read_orders read_products read_inventory read_customers`, request Protected customer data access (orders + customers), Release a version, Distribution: Custom, enter the store domain. Then `node backend/shopify-install.js CLIENT_ID CLIENT_SECRET store.myshopify.com`, open the URL, log in to the store, Install. The printed token is permanent. Same app, one install per store. Variable name must match `accounts.shopify.tokenEnv` in clients.json |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps, create app, Incoming Webhooks on, add to `#desk-alerts` |

Check them before deploying: `cd backend && node --env-file=.env src/index.js test-tokens`

### 4. Render
1. Push this repo to GitHub.
2. Render, New, Blueprint, pick the repo. It creates `desk-daily` (06:00 IST), `desk-hourly` (every hour at :15), `desk-sitewatch` (every 30 min, Docker), `desk-api` (Sync now endpoint) and `desk-dashboard` (static).
   For the Sync now button, put the `desk-api` url and its `DESK_SYNC_KEY` into `frontend/config.js` as `syncUrl` (`https://desk-api.onrender.com/sync`) and `syncKey`.
3. Open each cron job, Environment, paste the tokens. Same values in all three (or use a Render Environment Group).
4. Run `desk-daily` once manually (Trigger Run). Check its logs: every source should say `synced` or `waiting`.
5. Open the dashboard URL, sign in with a per4mance.guru Google account. Add that URL to Firebase authorized domains if sign-in complains.

### 5. Adding the next client
Add a block to `clients.json`, add its Shopify token as a new env var (`SHOPIFY_TOKEN_<ID>`), push. Meta and Google need nothing new: one token covers every account in the BM and MCC.

## Running locally
```
cd backend
npm install
npm run install-browser        # only for sitewatch
cp .env.example .env           # fill what you have
node --env-file=.env src/index.js seed         # sample clients, writes JSON files to backend/data when Firebase is not set
node --env-file=.env src/index.js daily
node --env-file=.env src/index.js sitewatch
```
Open `frontend/index.html` from any static server (`npx serve frontend`) to see the dashboard in demo mode.

## Behaviour worth knowing
- Every daily run re-pulls the last 7 days, because Meta's attribution keeps changing yesterday's numbers for a week and Shopify refunds land late. Without this the dashboard drifts away from Ads Manager and the team stops trusting it.
- A missing token never breaks a run. That source shows "waiting for token" on the dashboard and everything else stays live.
- Site Watch alerts only on the second consecutive failure of the same check (30 minutes apart), so one network blip does not page anyone. It never places an order.
- `DESK_SAMPLE_FALLBACK=true` fills sample data for real clients whose token is missing, clearly labelled "sample" on the dashboard. Useful for a demo, switch off after.
- Signals need history. Checkout stuck and order drop use a 14 day baseline, so they go quiet for the first two weeks on a new client.
