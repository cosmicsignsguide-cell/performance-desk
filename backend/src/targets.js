// Monthly targets: one form per client per month, filled on the Monthly targets page.
//
// Each filled form is a document targets/<clientId>_<YYYY-MM> holding
//   totalSpend, metaSpend, googleSpend, then by client type: ecom roas + sales, lead gen cpl +
//   leads, app cpi + installs; filledBy/filledAt (first save), updatedBy/updatedAt (last save) and a
//   short history of who changed it
// and, for the month it names, it replaces the client's budget and target ROAS everywhere they are
// used: pacing on the dashboard and the client link, the overpacing and underpacing signals, and
// the ROAS colours. Meta and Google spend and the sales target show in the pacing panel. A month
// with no form keeps the budget and target from clients.json, so nothing breaks before the first
// form is filled.
//
// On the 25th the keeper calls POST /targets/remind, which emails the people in
// TARGETS_REMIND_EMAILS the clients still missing next month's form, with a link to the page.
// Email goes out over SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) and is sent
// once per month however many times the reminder is called.

import { log, nowIso } from './util.js';
import { config } from './config.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FIELDS = ['totalSpend', 'metaSpend', 'googleSpend', 'roas', 'sales', 'cpl', 'leads', 'cpi', 'installs'];
// The result fields each kind of client fills; the others are stored as 0 so an old value never lingers.
const BY_TYPE = { ecom: ['roas', 'sales'], lead: ['cpl', 'leads'], app: ['cpi', 'installs'] };
const kindOf = (c) => (c?.type === 'lead' ? 'lead' : c?.type === 'app' ? 'app' : 'ecom');

export const monthOf = (dateStr) => String(dateStr).slice(0, 7);
export function nextMonth(month) { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
const todayIn = () => new Date().toLocaleDateString('en-CA', { timeZone: config.tz });

// The client as it stands this month: its own budget and ROAS target, replaced by the month's form.
export function applyTargets(client, t) {
  if (!client || !t) return client;
  const out = { ...client, target: { ...(client.target || {}) } };
  if (t.totalSpend > 0) out.budget = t.totalSpend;
  const k = kindOf(client);
  if (k === 'ecom' && t.roas > 0) out.target.roas = t.roas;
  if (k === 'lead' && t.cpl > 0) out.target.cpl = t.cpl;
  if (k === 'app' && t.cpi > 0) out.target.cpi = t.cpi;
  out.monthTargets = { month: t.month, totalSpend: t.totalSpend || 0, metaSpend: t.metaSpend || 0, googleSpend: t.googleSpend || 0, roas: t.roas || 0, sales: t.sales || 0, cpl: t.cpl || 0, leads: t.leads || 0, cpi: t.cpi || 0, installs: t.installs || 0,
    filledBy: t.filledBy || '', filledAt: t.filledAt || '', updatedBy: t.updatedBy || t.filledBy || '', updatedAt: t.updatedAt || t.filledAt || '' };
  return out;
}

export async function withMonthTargets(store, clients, month = monthOf(todayIn())) {
  let rows = [];
  try { rows = await store.list('targets', [['month', '==', month]]); } catch (e) { log(`targets: could not load ${month} (${String(e.message || e).slice(0, 100)})`); }
  const by = Object.fromEntries(rows.map((t) => [t.clientId, t]));
  return clients.map((c) => applyTargets(c, by[c.id]));
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) && n >= 0 ? n : null; };

// POST /targets  { clientId, month, totalSpend, metaSpend, googleSpend, roas, sales }
export async function saveTarget(store, who, body, clients) {
  const clientId = String(body.clientId || ''), month = String(body.month || '');
  const client = clients.find((c) => c.id === clientId);
  if (!client) return { status: 400, body: 'unknown client' };
  const kind = kindOf(client);
  if (!MONTH_RE.test(month)) return { status: 400, body: 'month must be YYYY-MM' };
  const doc = { clientId, month };
  for (const k of FIELDS) {
    const v = num(body[k]);
    if (v === null && body[k] !== '' && body[k] != null) return { status: 400, body: `${k} must be a number` };
    doc[k] = v || 0;
  }
  // Total spend is the Meta and Google projections added up when it is left empty.
  if (!doc.totalSpend && (doc.metaSpend || doc.googleSpend)) doc.totalSpend = doc.metaSpend + doc.googleSpend;
  if (!doc.totalSpend) return { status: 400, body: 'total spend is needed' };
  for (const k of ['roas', 'sales', 'cpl', 'leads', 'cpi', 'installs']) if (!BY_TYPE[kind].includes(k)) doc[k] = 0;
  if (doc.metaSpend + doc.googleSpend > doc.totalSpend * 1.01) return { status: 400, body: 'Meta and Google spend add up to more than total spend' };
  if (doc.roas > 100) return { status: 400, body: 'target ROAS looks wrong (above 100x)' };
  // Lead gen: CPL and leads go together; one is worked out from the other and the spend.
  if (kind === 'lead') { if (!doc.cpl && doc.leads) doc.cpl = Math.round(doc.totalSpend / doc.leads); if (!doc.leads && doc.cpl) doc.leads = Math.round(doc.totalSpend / doc.cpl); if (doc.cpl > doc.totalSpend) return { status: 400, body: 'target CPL is more than the whole spend' }; }
  if (kind === 'app') { if (!doc.cpi && doc.installs) doc.cpi = Math.round(doc.totalSpend / doc.installs * 100) / 100; if (!doc.installs && doc.cpi) doc.installs = Math.round(doc.totalSpend / doc.cpi); }
  // Who filled it first stays; every save after that is recorded as an update, with a short history.
  const prev = await store.get('targets', `${clientId}_${month}`).catch(() => null);
  const at = nowIso();
  doc.filledBy = prev?.filledBy || who; doc.filledAt = prev?.filledAt || at;
  doc.updatedBy = who; doc.updatedAt = at;
  doc.history = [...(prev?.history || (prev ? [{ by: prev.filledBy, at: prev.filledAt }] : [])), { by: who, at }].slice(-10);
  await store.set('targets', `${clientId}_${month}`, doc);
  log(`targets: ${clientId} ${month} saved by ${who}`);
  return { status: 200, body: doc };
}

// POST /targets/remind (sync key). Emails the pending list for next month, once a month.
export async function remind(store, clients, { force = false, dashboardUrl = '' } = {}) {
  const today = todayIn(), month = nextMonth(monthOf(today));
  const to = String(process.env.TARGETS_REMIND_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { status: 503, body: 'TARGETS_REMIND_EMAILS is not set' };
  const flagId = `remind_${month}`;
  const flag = await store.get('targetsMeta', flagId).catch(() => null);
  if (flag && flag.sentAt && !force) return { status: 200, body: { skipped: 'already sent', month, sentAt: flag.sentAt } };
  const done = new Set((await store.list('targets', [['month', '==', month]]).catch(() => [])).map((t) => t.clientId));
  const live = clients.filter((c) => c.active !== false && !c.sample);
  const pending = live.filter((c) => !done.has(c.id));
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const link = `${dashboardUrl.replace(/\/$/, '')}/#targets/${month}`;
  const subject = pending.length ? `Monthly targets for ${label}: ${pending.length} of ${live.length} clients to fill` : `Monthly targets for ${label}: all ${live.length} clients filled`;
  const text = [`Hi,`, ``, pending.length
    ? `Please fill the ${label} targets (total spend, projected Meta spend, projected Google spend, target ROAS and target sales) for these clients:`
    : `Every client already has its ${label} targets. Nothing to do.`, ``,
    ...pending.map((c) => `- ${c.name || c.id}`), ``, `Form: ${link}`, ``, `Each form updates that client's budget, pacing and ROAS target on the dashboard from 1 ${label.split(' ')[0]}.`, ``, `Garuda, Per4mance Guru`].join('\n');
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#171717">
<p>Hi,</p><p>${pending.length ? `Please fill the <b>${label}</b> targets (total spend, projected Meta spend, projected Google spend, target ROAS and target sales) for these clients:` : `Every client already has its <b>${label}</b> targets. Nothing to do.`}</p>
${pending.length ? `<ul>${pending.map((c) => `<li>${String(c.name || c.id).replace(/[<>&]/g, '')}</li>`).join('')}</ul>` : ''}
<p><a href="${link}" style="display:inline-block;background:#FF5A1F;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open the targets form</a></p>
<p style="color:#666">Each form updates that client's budget, pacing and ROAS target on the dashboard for that month.</p><p>Garuda, Per4mance Guru</p></div>`;
  const sent = await sendMail({ to, subject, text, html });
  if (!sent.ok) return { status: 502, body: `email not sent: ${sent.error}` };
  await store.set('targetsMeta', flagId, { month, sentAt: nowIso(), to, pending: pending.map((c) => c.id) });
  log(`targets: reminder for ${month} sent to ${to.length} people, ${pending.length} clients pending`);
  return { status: 200, body: { month, sentTo: to.length, pending: pending.map((c) => c.id) } };
}

async function sendMail({ to, subject, text, html }) {
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return { ok: false, error: 'SMTP_HOST, SMTP_USER and SMTP_PASS are not all set' };
  try {
    const nodemailer = (await import('nodemailer')).default;
    const port = Number(process.env.SMTP_PORT || 465);
    const tx = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    await tx.sendMail({ from: process.env.SMTP_FROM || user, to: to.join(', '), subject, text, html });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; }
}
