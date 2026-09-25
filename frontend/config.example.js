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
  // Optional: the desk-api service url + its DESK_SYNC_KEY, enables the "Sync now" button
  syncUrl: "",
  syncKey: ""
};
