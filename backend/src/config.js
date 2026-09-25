// Central place for every environment variable the backend reads.
// Nothing here is required: a missing token means that source runs in sample mode
// and the sync status for it says "no token" on the dashboard.

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();

export const config = {
  tz: env('DESK_TIMEZONE', 'Asia/Kolkata'),
  historyDays: parseInt(env('DESK_HISTORY_DAYS', '45'), 10),   // how far back the first sync reaches
  restateDays: parseInt(env('DESK_RESTATE_DAYS', '7'), 10),    // how many past days are re-pulled every day
  dataDir: env('DESK_DATA_DIR', './data'),                     // local JSON store when Firebase is not configured

  firebase: {
    serviceAccountJson: env('FIREBASE_SERVICE_ACCOUNT_JSON'),  // the whole JSON file pasted as one line
    projectId: env('FIREBASE_PROJECT_ID'),
  },

  meta: {
    token: env('META_ACCESS_TOKEN'),
    apiVersion: env('META_API_VERSION', 'v23.0'),
    attribution: env('META_ATTRIBUTION', '7d_click,1d_view'),
  },

  google: {
    developerToken: env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    clientId: env('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_OAUTH_REFRESH_TOKEN'),
    loginCustomerId: env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/-/g, ''),  // the MCC id
    apiVersion: env('GOOGLE_ADS_API_VERSION', 'v23'),
  },

  shopify: {
    apiVersion: env('SHOPIFY_API_VERSION', '2026-01'),
    // Per-store tokens live in the client record as accounts.shopify.tokenEnv (name of an env var),
    // so one deployment can hold many stores: SHOPIFY_TOKEN_<CLIENTID>.
  },

  alerts: {
    slackWebhook: env('SLACK_WEBHOOK_URL'),
    genericWebhook: env('ALERT_WEBHOOK_URL'),   // optional: Make / n8n / WhatsApp provider webhook
    cooldownHours: parseFloat(env('ALERT_COOLDOWN_HOURS', '6')),
  },

  sitewatch: {
    timeoutMs: parseInt(env('SITEWATCH_TIMEOUT_MS', '30000'), 10),
    slowMs: parseInt(env('SITEWATCH_SLOW_MS', '4000'), 10),
  },
};

export function has(source) {
  switch (source) {
    case 'firebase': return !!config.firebase.serviceAccountJson;
    case 'meta': return !!config.meta.token;
    case 'google': return !!(config.google.developerToken && config.google.clientId && config.google.clientSecret && config.google.refreshToken);
    case 'ga4': return !!(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
    case 'slack': return !!config.alerts.slackWebhook;
    default: return false;
  }
}

export function shopifyTokenFor(client) {
  const name = client?.accounts?.shopify?.tokenEnv || `SHOPIFY_TOKEN_${(client?.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return env(name);
}
