// Alerts go to Slack (incoming webhook) and optionally a generic webhook (Make, n8n, a WhatsApp provider).
// Every alert is logged in the `alerts` collection so the dashboard shows it too.
// The same alert type for the same client is not re-sent within ALERT_COOLDOWN_HOURS.

import { config, has } from './config.js';
import { db } from './db.js';
import { log, nowIso } from './util.js';

const EMOJI = { critical: ':red_circle:', warning: ':large_orange_circle:', info: ':large_green_circle:' };

export async function raise(client, type, severity, message, extra = {}) {
  const store = await db();
  const key = `${client.id}_${type}`;
  const last = await store.get('alertstate', key);
  const cooldownMs = config.alerts.cooldownHours * 3600000;
  if (last?.at && severity !== 'info' && Date.now() - new Date(last.at).getTime() < cooldownMs) {
    log(`alert suppressed (cooldown): ${key}`);
    return false;
  }
  const alert = { clientId: client.id, clientName: client.name, type, severity, message, at: nowIso(), ...extra };
  await store.add('alerts', alert);
  await store.set('alertstate', key, { at: alert.at, severity });
  let sent = [];
  if (has('slack')) {
    try {
      await fetch(config.alerts.slackWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `${EMOJI[severity] || ''} *${client.name}* ${message}` }) });
      sent.push('slack');
    } catch (e) { log('slack failed', e.message); }
  }
  if (config.alerts.genericWebhook) {
    try { await fetch(config.alerts.genericWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alert) }); sent.push('webhook'); }
    catch (e) { log('webhook failed', e.message); }
  }
  log(`ALERT [${severity}] ${client.id}/${type}: ${message} ${sent.length ? '-> ' + sent.join(', ') : '(no channel configured)'}`);
  return true;
}
