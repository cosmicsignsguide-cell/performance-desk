// POST /chat  { message, clientId?, history? }  ->  { blocks, reply, usage }
// GET  /chat/notes?client=<id|*>, POST /chat/notes, POST /chat/notes/delete   per client knowledge
//
// Auth is done by the caller in index.js (a signed-in team member). The client id is checked
// against the real client list, never trusted as a collection name.

import { loadClients } from '../clients.js';
import { todayStr, log, nowIso } from '../util.js';
import { CORE, select, render } from './knowledge.js';
import { portfolioContext, clientContext, clearChatCache } from './context.js';
import { run, provider } from './llm.js';

const hits = new Map();   // per person, per minute
function limited(who) {
  const now = Date.now(); const arr = (hits.get(who) || []).filter((t) => now - t < 60000);
  if (arr.length >= 12) { hits.set(who, arr); return true; }
  arr.push(now); hits.set(who, arr); return false;
}

const GROUNDING = `GROUNDING (this overrides everything else)
- Every number, ad name, ad id, campaign, product or date you state MUST appear in the data block below. Never invent, estimate, extrapolate or fill in.
- "n/a", 0 where a value should exist, or a section that says nothing recorded all mean UNAVAILABLE. Say it is not available in the dashboard instead of guessing. A correct "not available" beats a confident wrong number.
- You may derive a figure only by simple arithmetic on numbers that are present, and you show the inputs.
- Never fabricate ad ids, creative, campaign, product or city names.
- Sub-ranges such as "last 3 days" can be computed from the daily table, so compute them directly. If the rows are not there, say so.
- There is no per-city, per-state, age, gender or placement data in this dashboard. If asked, say so once, plainly, and offer what exists. Do not claim a tracking failure because of it.
- If the data block says there is no data for a client, quote nothing and say so.
- Platform numbers (Meta and Google ROAS) are platform-reported. Shopify net sales and orders are the store's truth. MER is Shopify net sales divided by ad spend.`;

const STYLE = `HOW TO ANSWER
- The accounts are already connected and synced. NEVER ask for an ad account id, customer id, store domain, property id, token or login. Answer from the data.
- Reply in the same register the person writes in. If they write Hinglish, reply in Hinglish. Keep it direct and practical, like a senior strategist talking to a colleague.
- NEVER use em dashes anywhere in your reply. Use commas, full stops, colons or brackets instead.
- Use rupees as "Rs" with lakh and crore style (Rs 1.5L, Rs 1.2Cr) for INR clients, and the client's own currency code otherwise.
- Be specific: cite the actual numbers, say whether they are good or bad against the benchmarks, compare 7 days with the previous 7, and flag problems with a severity (high, medium, low).
- Explain WHY something matters and WHAT to do next. Rank recommendations. End with the one action that matters most.
- When you name an ad, use its [[ad:id]] marker exactly as given in the data (one marker per mention) so the page can show the creative. Only use ids that appear in the data. Refer to ads by their name in quotes too.
- When asked about fatigued or weak creatives, list ALL that apply by full name, not three.
- Use markdown sparingly: short headers, bullets, and tables only when comparing several items.
- Use the render_chart tool only when a picture clearly helps (a trend over days, a comparison of a few items). Never for one number. Maximum 3 per answer. Always also give the written answer.
- You are read-only. You cannot change budgets, pause ads or edit anything in an ad account. If asked to, give the exact change the person should make and say they must do it themselves.
- If no client is selected you are looking at the whole portfolio. For a deep question about one client, answer from the portfolio line if enough, otherwise tell the person to open that client or name it so you can load its full data.`;

function nameMatch(message, clients) {
  const m = ' ' + message.toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
  let best = null;
  for (const c of clients) {
    const nm = c.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    const id = c.id.replace(/-/g, ' ');
    for (const t of [nm, id]) {
      if (t.length >= 4 && m.includes(' ' + t + ' ')) { if (!best || t.length > best.len) best = { c, len: t.length }; }
    }
  }
  return best ? best.c : null;
}

export async function loadNotes(store, clientId) {
  const [mine, shared] = await Promise.all([
    clientId ? store.list('chatNotes', [['clientId', '==', clientId]]) : [],
    store.list('chatNotes', [['clientId', '==', '*']]),
  ]);
  return [...shared, ...mine].filter((n) => n.enabled !== false).sort((a, b) => String(a.createdAt) < String(b.createdAt) ? 1 : -1).slice(0, 12);
}

export async function handleChat(store, who, payload) {
  const p = provider();
  if (!p) return { status: 503, body: { ok: false, code: 'no-key', error: 'The chatbot has no AI key yet. Add ANTHROPIC_API_KEY (or GEMINI_API_KEY) to the desk-api service on Render.' } };
  if (limited(who)) return { status: 429, body: { ok: false, error: 'Too many questions in a minute. Wait a few seconds.' } };
  const message = String(payload?.message || '').trim().slice(0, 2000);
  if (!message) return { status: 400, body: { ok: false, error: 'empty message' } };
  const history = (Array.isArray(payload?.history) ? payload.history : []).slice(-10)
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));

  const clients = (await loadClients()).filter((c) => !c.sample);
  let client = payload?.clientId ? clients.find((c) => c.id === String(payload.clientId)) : null;
  let auto = null;
  if (!client) { auto = nameMatch(message, clients); if (auto) client = auto; }

  const notes = await loadNotes(store, client ? client.id : '');
  let data;
  if (client) data = await clientContext(store, client, notes);
  else {
    data = await portfolioContext(store, clients);
    if (notes.length) data = '--- TEAM NOTES FOR ALL CLIENTS ---\n' + notes.map((n) => `### ${n.title}\n${n.content}`).join('\n') + '\n\n' + data;
  }

  const sel = select(message, history);
  const stable = [CORE, GROUNDING, STYLE].join('\n\n');
  const dynamic = `TODAY: ${todayStr()} (IST).\nSCOPE: ${client ? `one client, ${client.name}${auto ? ' (picked from the question)' : ''}` : 'whole portfolio, no client selected'}.\n\nCURRENT DATA\n${data}\n${render(sel)}`;

  const t0 = Date.now();
  let out;
  try { out = await run({ system: { stable, dynamic }, history, message }); }
  catch (e) {
    const msg = String(e.message || e);
    log(`chat: LLM failed for ${who}: ${msg.slice(0, 200)}`);
    const friendly = /credit|billing|quota|insufficient/i.test(msg) ? 'The AI account is out of credit.' : /429|rate|overloaded|503/i.test(msg) ? 'The AI service is busy. Try again in a moment.' : /401|403|api key|invalid x-api-key/i.test(msg) ? 'The AI key on the server was rejected. Check it on Render.' : 'The chatbot could not answer. Try again.';
    return { status: 502, body: { ok: false, error: friendly } };
  }
  const reply = out.blocks.filter((b) => b.type === 'text').map((b) => b.content).join('\n\n').trim();
  log(`chat: ${who} ${client ? client.id : 'portfolio'} ${out.inTok}+${out.outTok} tok ${Date.now() - t0}ms (${out.model})`);
  try { await store.add('aiUsage', { at: nowIso(), who, clientId: client ? client.id : '', model: out.model, inputTokens: out.inTok, outputTokens: out.outTok, feature: 'chat' }); } catch { /* usage log is best effort */ }
  if (!reply && !out.blocks.length) return { status: 200, body: { ok: true, blocks: [{ type: 'text', content: 'I could not form an answer from the data. Try asking again, more specifically.' }], reply: '', clientId: client ? client.id : '' } };
  return { status: 200, body: { ok: true, blocks: out.blocks, reply, clientId: client ? client.id : '', usage: { input: out.inTok, output: out.outTok } } };
}

export async function notesApi(store, who, method, path, query, payload) {
  const clients = await loadClients();
  const okClient = (id) => id === '*' || clients.some((c) => c.id === id);
  if (method === 'GET') {
    const id = String(query.get('client') || '*');
    if (!okClient(id)) return { status: 400, body: 'unknown client' };
    const rows = await store.list('chatNotes', [['clientId', '==', id]]);
    return { status: 200, body: rows.map((n) => ({ id: n.id, clientId: n.clientId, title: n.title, content: n.content, enabled: n.enabled !== false, by: n.by, createdAt: n.createdAt })).sort((a, b) => String(a.createdAt) < String(b.createdAt) ? 1 : -1) };
  }
  if (path === '/chat/notes' && method === 'POST') {
    const id = String(payload?.clientId || '*');
    if (!okClient(id)) return { status: 400, body: 'unknown client' };
    const title = String(payload?.title || '').trim().slice(0, 120);
    const content = String(payload?.content || '').trim().slice(0, 6000);
    if (!title || !content) return { status: 400, body: 'title and content are required' };
    const existing = (await store.list('chatNotes', [['clientId', '==', id]])).filter((n) => n.enabled !== false);
    if (existing.length >= 20) return { status: 400, body: 'too many notes for this client (max 20). Delete one first.' };
    const nid = await store.add('chatNotes', { clientId: id, title, content, enabled: true, by: who, createdAt: nowIso() });
    clearChatCache();
    return { status: 200, body: { ok: true, id: nid } };
  }
  if (path === '/chat/notes/delete' && method === 'POST') {
    const nid = String(payload?.id || '');
    if (!nid) return { status: 400, body: 'id required' };
    const doc = await store.get('chatNotes', nid);
    if (!doc) return { status: 404, body: 'not found' };
    await store.merge('chatNotes', nid, { enabled: false, deletedBy: who, deletedAt: nowIso() });
    clearChatCache();
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: 'not found' };
}
