// One tiny adapter over the two providers the team might have a key for. Anthropic is preferred if
// ANTHROPIC_API_KEY is set, otherwise Gemini (GEMINI_API_KEY or GOOGLE_AI_API_KEY). CHAT_MODEL
// overrides the model for whichever provider is used. The only tool is render_chart, which the
// server does not execute: it validates the shape, hands it to the page to draw, and answers the
// model "Chart rendered." so it can carry on writing.

const key = (k) => (process.env[k] || '').trim();

export function provider() {
  if (key('ANTHROPIC_API_KEY')) return { name: 'anthropic', model: key('CHAT_MODEL') || 'claude-haiku-4-5-20251001' };
  const g = key('GEMINI_API_KEY') || key('GOOGLE_AI_API_KEY');
  if (g) return { name: 'gemini', model: key('CHAT_MODEL') || 'gemini-2.5-flash', key: g };
  return null;
}

const CHART_DESC = 'Draw a small inline chart in the chat. Use it for a trend over days, a comparison across a few items, or a share of a whole. Do not use it for a single number or a yes/no. At most 3 per answer.';
const CHART_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
    title: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
    datasets: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, data: { type: 'array', items: { type: 'number' } } }, required: ['label', 'data'] } },
    y_label: { type: 'string' },
  },
  required: ['type', 'title', 'labels', 'datasets'],
};

function validChart(s) {
  return s && ['bar', 'line', 'pie', 'doughnut'].includes(s.type) && Array.isArray(s.labels) && s.labels.length && s.labels.length <= 40
    && Array.isArray(s.datasets) && s.datasets.length && s.datasets.length <= 6
    && s.datasets.every((d) => d && Array.isArray(d.data) && d.data.length === s.labels.length && d.data.every((v) => typeof v === 'number' && Number.isFinite(v)));
}
const cleanChart = (s) => ({ type: s.type, title: String(s.title || '').slice(0, 120), labels: s.labels.map((l) => String(l).slice(0, 40)), datasets: s.datasets.map((d) => ({ label: String(d.label || '').slice(0, 40), data: d.data })), y_label: s.y_label ? String(s.y_label).slice(0, 40) : '' });

const MAX_ROUNDS = 3;

async function post(url, headers, body, timeoutMs = 90000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
    if (!r.ok) { const e = new Error(`LLM ${r.status}: ${String(j?.error?.message || j?.error || j.raw || '').slice(0, 200)}`); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

// system = { stable, dynamic }: stable (rules) is cached by Anthropic, dynamic is this turn's data.
export async function run({ system, history, message }) {
  const p = provider();
  if (!p) { const e = new Error('no-llm-key'); e.code = 'NO_KEY'; throw e; }
  return p.name === 'anthropic' ? anthropic(p, system, history, message) : gemini(p, system, history, message);
}

async function anthropic(p, system, history, message) {
  const blocks = []; let inTok = 0, outTok = 0;
  const messages = [...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })), { role: 'user', content: message }];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': key('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      { model: p.model, max_tokens: 4096, temperature: 0.3,
        system: [{ type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } }, { type: 'text', text: system.dynamic }],
        tools: [{ name: 'render_chart', description: CHART_DESC, input_schema: CHART_SCHEMA }],
        messages });
    inTok += j.usage?.input_tokens || 0; outTok += j.usage?.output_tokens || 0;
    const content = j.content || [];
    for (const b of content) if (b.type === 'text' && b.text) blocks.push({ type: 'text', content: b.text });
    const uses = content.filter((b) => b.type === 'tool_use');
    if (!uses.length || j.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: uses.map((u) => {
      if (u.name === 'render_chart' && validChart(u.input)) { blocks.push({ type: 'chart', spec: cleanChart(u.input) }); return { type: 'tool_result', tool_use_id: u.id, content: 'Chart rendered.' }; }
      return { type: 'tool_result', tool_use_id: u.id, content: 'Invalid chart spec. Continue with text only.', is_error: true };
    }) });
  }
  return { blocks, inTok, outTok, model: p.model };
}

const gTool = { functionDeclarations: [{ name: 'render_chart', description: CHART_DESC, parameters: {
  type: 'OBJECT', properties: {
    type: { type: 'STRING', enum: ['bar', 'line', 'pie', 'doughnut'] }, title: { type: 'STRING' },
    labels: { type: 'ARRAY', items: { type: 'STRING' } },
    datasets: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, data: { type: 'ARRAY', items: { type: 'NUMBER' } } }, required: ['label', 'data'] } },
    y_label: { type: 'STRING' } }, required: ['type', 'title', 'labels', 'datasets'] } }] };

async function gemini(p, system, history, message) {
  const blocks = []; let inTok = 0, outTok = 0;
  const contents = [...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })), { role: 'user', parts: [{ text: message }] }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`;
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const j = await post(url, { 'x-goog-api-key': p.key },
      { systemInstruction: { parts: [{ text: system.stable + '\n' + system.dynamic }] }, contents, tools: [gTool], generationConfig: { maxOutputTokens: 8192, temperature: 0.3 } });
    inTok += j.usageMetadata?.promptTokenCount || 0; outTok += j.usageMetadata?.candidatesTokenCount || 0;
    const parts = j.candidates?.[0]?.content?.parts || [];
    for (const x of parts) if (x.text && !x.thought) blocks.push({ type: 'text', content: x.text });
    const calls = parts.filter((x) => x.functionCall);
    if (!calls.length) break;
    contents.push({ role: 'model', parts });
    contents.push({ role: 'user', parts: calls.map((c) => {
      let ok = false;
      if (c.functionCall.name === 'render_chart' && validChart(c.functionCall.args)) { blocks.push({ type: 'chart', spec: cleanChart(c.functionCall.args) }); ok = true; }
      return { functionResponse: { name: c.functionCall.name, response: { result: ok ? 'Chart rendered.' : 'Invalid chart spec. Continue with text only.' } } };
    }) });
  }
  return { blocks, inTok, outTok, model: p.model };
}
