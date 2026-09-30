// Copy this file to config.js and fill in the values from Firebase console > Project settings > Your apps.
// Without config.js the dashboard runs in demo mode with sample data.
window.DESK_CONFIG = {
  firebase: {
    apiKey: "",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project",
    appId: ""
  },
  // Who can sign in. Firestore rules enforce the same list server-side (see firestore.rules).
  allowedDomains: ["per4mance.guru"],
  allowedEmails: [],
  timezone: "Asia/Kolkata",
  // Only if this shares a Firebase project with another app. Must match DESK_COLLECTION_PREFIX
  // on the backend. Leave "" on a Firebase project of its own.
  collectionPrefix: "",
  // Optional: the desk-api service url, which enables the "Sync now" button.
  //
  // There is deliberately no key here. This file is served by a static host to anyone who opens
  // /config.js, logged in or not, so anything written in it is public. The sync key used to sit
  // here, which meant any visitor could start a weekly run and spend the workspace's Gamma
  // credits, or loop a backfill until Meta rate limited every account.
  //
  // "Sync now" authorises with the signed-in user's own Firebase ID token instead. Keep
  // DESK_SYNC_KEY on the backend only, for schedulers and curl.
  syncUrl: ""
};
