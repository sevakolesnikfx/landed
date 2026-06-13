/* =============================================================================
   Landed — backend
   Serves the static app AND a Claude-powered chat that interviews the user
   (per the ENTITLED logic flow), storing the answers it learns — the ones NOT
   already on their uploaded documents — in a per-user markdown file.

   Endpoints:
     POST   /api/chat                 { user, messages } -> { message, done }
     GET    /api/profile?user=        -> { documents, info, known }
     DELETE /api/profile/info?user=&index=
     DELETE /api/profile/doc?user=&id=
   Plus static files (index.html, assets/...).

   The Anthropic API key is read from .env (ANTHROPIC_API_KEY) — never committed.
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = process.env.PORT || 8000;

/* ---- tiny .env loader (no dependency) ---- */
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    txt.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
})();

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LANDED_MODEL || 'claude-opus-4-8';

/* ---- the 5 ENTITLED questions, canonical values ---- */
const FIELDS = {
  basis:  { label: 'How they came to be in the UK',
    values: 'eu (EU/EEA/Swiss) | visa (non-EU visa) | settled (ILR or British) | unsure' },
  status: { label: 'Current immigration status',
    values: 'EU branch: presettled | settledstatus | noeuss ;  Visa branch: student | worker | spouse | other ;  Settled branch: ilr | british ;  or unsure' },
  years:  { label: 'Years lived in the UK',
    values: 'u1 (<1yr) | 1-3 | 3-5 | 5-10 | 10+' },
  kids:   { label: 'Children born in the UK',
    values: 'born (UK-born, under 18) | born10 (UK-born, lived here 10+ yrs) | no' },
  money:  { label: 'Household money situation',
    values: 'pension (someone 66+) | low (low income / tight) | student (student household) | ok (managing fine)' }
};
const FIELD_KEYS = Object.keys(FIELDS);

/* ---- structured-output schema: forces valid JSON from Claude ---- */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          key:   { type: 'string', enum: FIELD_KEYS },
          label: { type: 'string' },
          value: { type: 'string' }
        },
        required: ['key', 'label', 'value']
      }
    },
    done: { type: 'boolean' }
  },
  required: ['message', 'facts', 'done']
};

/* ----------------------------- storage helpers ---------------------------- */
function safeUser(u) {
  return (u || 'guest').toLowerCase().replace(/[^a-z0-9._@-]/g, '_').slice(0, 80) || 'guest';
}
function userDir(u) {
  const d = path.join(DATA, safeUser(u));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function docsPath(u) { return path.join(userDir(u), 'documents.json'); }
function infoPath(u) { return path.join(userDir(u), 'info.md'); }

function readDocs(u) {
  try { return JSON.parse(fs.readFileSync(docsPath(u), 'utf8')); }
  catch (_) {
    // seed the documents the Scan screen "detected" for the demo persona
    const seed = [
      { id: 'brp', name: 'BRP / Visa card', type: 'Identity',
        summary: 'Visa conditions read — "No Recourse to Public Funds"', facts: { basis: 'visa' } },
      { id: 'cas', name: 'CAS / Enrolment letter', type: 'Education',
        summary: 'Full-time student confirmed', facts: { status: 'student' } }
    ];
    fs.writeFileSync(docsPath(u), JSON.stringify(seed, null, 2));
    return seed;
  }
}
function writeDocs(u, docs) { fs.writeFileSync(docsPath(u), JSON.stringify(docs, null, 2)); }

function readInfoLines(u) {
  try { return fs.readFileSync(infoPath(u), 'utf8').split(/\r?\n/); }
  catch (_) { return []; }
}
function writeInfoLines(u, lines) {
  fs.writeFileSync(infoPath(u), lines.join('\n').replace(/\n+$/, '') + '\n');
}
// parsed bullets: [{ index, key, label, value, raw }]
function parseInfo(u) {
  const out = [];
  readInfoLines(u).forEach((line, i) => {
    const m = line.match(/^- \*\*(.+?):\*\*\s*(.*)$/);
    if (m) out.push({ index: i, label: m[1], value: m[2], raw: line });
  });
  return out;
}
// add or replace a fact (dedupe by key, stored in an HTML comment marker)
function upsertFact(u, fact) {
  const lines = readInfoLines(u);
  const marker = `<!--${fact.key}-->`;
  const newLine = `- **${fact.label}:** ${fact.value} ${marker}`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) { lines[i] = newLine; replaced = true; break; }
  }
  if (!replaced) {
    if (!lines.length) lines.push('# What you told Landed', '');
    lines.push(newLine);
  }
  writeInfoLines(u, lines);
}
// strip the dedupe marker for display
function publicInfo(u) {
  return parseInfo(u).map(b => ({
    index: b.index,
    label: b.label,
    value: b.value.replace(/\s*<!--[a-z]+-->\s*$/i, '').trim()
  }));
}
function deleteInfoLine(u, index) {
  const lines = readInfoLines(u);
  if (index >= 0 && index < lines.length) { lines.splice(index, 1); writeInfoLines(u, lines); }
}

/* ----------------------------- the Claude call ---------------------------- */
function buildSystemPrompt(docs, info) {
  const knownFromDocs = {};
  docs.forEach(d => Object.assign(knownFromDocs, d.facts || {}));
  const collected = {};
  parseInfo('').length; // noop
  info.forEach(b => { const k = guessKey(b.label); if (k) collected[k] = b.value; });

  const knownKeys = new Set([...Object.keys(knownFromDocs), ...Object.keys(collected)]);
  const needed = FIELD_KEYS.filter(k => !knownKeys.has(k));

  const fieldList = FIELD_KEYS.map(k => `  - ${k} — ${FIELDS[k].label}. Allowed: ${FIELDS[k].values}`).join('\n');
  const docFacts = Object.keys(knownFromDocs).length
    ? Object.entries(knownFromDocs).map(([k, v]) => `  - ${k} = ${v}`).join('\n')
    : '  (none)';
  const collectedList = Object.keys(collected).length
    ? Object.entries(collected).map(([k, v]) => `  - ${k}`).join('\n')
    : '  (none yet)';

  return `You are Landed, a warm, plain-spoken assistant that helps a UK newcomer discover what support and immigration routes they may be entitled to. You speak in friendly UK English, no jargon, lower-case-casual but clear.

Your job in this chat is to gently collect FIVE pieces of information about the user — but ONLY the ones that aren't already known from their uploaded documents. Ask about one thing at a time.

The five fields (canonical key — meaning — allowed canonical values):
${fieldList}

Already known from the user's uploaded documents (do NOT ask about these):
${docFacts}

Already collected earlier in this chat (do not re-ask):
${collectedList}

Still needed: ${needed.length ? needed.join(', ') : '(nothing — you have everything)'}

How to behave:
- The app has already greeted the user, so don't re-introduce yourself at length — just keep the conversation moving.
- Ask for ONE still-needed field per turn, in a natural, reassuring way. Offer examples of the kinds of answers so they know what you mean.
- When the user answers, map their reply to the closest canonical value and record it as a fact. Use a friendly human-readable "value" (e.g. "On a visa from outside the EU", "5–10 years", "Low income / money is tight"), and the matching canonical "key".
- Information only — you are NOT giving legal advice. UK immigration advice is regulated. If the user asks what they should DO, give general information and gently point them to gov.uk and a regulated adviser (gov.uk/find-an-immigration-adviser), then continue.
- When all five fields are known, set "done": true and give a short, encouraging wrap-up: tell them you've saved their answers and they can review or delete any of them on the Settings page, and that Landed will use this to surface what they may be entitled to.

Respond ONLY as JSON matching the required schema: { "message": string, "facts": [{ "key", "label", "value" }], "done": boolean }. "facts" holds any NEW canonical facts you learned THIS turn (empty array if none).`;
}

// best-effort: map a stored label back to a field key
function guessKey(label) {
  const l = (label || '').toLowerCase();
  if (l.includes('basis') || l.includes('came to')) return 'basis';
  if (l.includes('status')) return 'status';
  if (l.includes('year')) return 'years';
  if (l.includes('child') || l.includes('kid')) return 'kids';
  if (l.includes('money') || l.includes('income') || l.includes('household')) return 'money';
  return null;
}

async function callClaude(system, messages) {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: messages.slice(-20).map(m => ({ role: m.role, content: String(m.content || '') })),
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } }
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.type === 'error') throw new Error(data.error && data.error.message || 'Claude API error');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

/* ------------------------------- http server ------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- API ----
  if (p === '/api/chat' && req.method === 'POST') {
    if (!API_KEY) return send(res, 500, { error: 'Server missing ANTHROPIC_API_KEY (.env).' });
    try {
      const { user, messages } = await readBody(req);
      const docs = readDocs(user);
      const info = publicInfo(user);
      const system = buildSystemPrompt(docs, info);
      const out = await callClaude(system, Array.isArray(messages) ? messages : []);
      (out.facts || []).forEach(f => { if (f && f.key && f.value) upsertFact(user, f); });
      return send(res, 200, { message: out.message || '', done: !!out.done });
    } catch (e) {
      return send(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/profile' && req.method === 'GET') {
    const user = url.searchParams.get('user');
    return send(res, 200, { documents: readDocs(user), info: publicInfo(user) });
  }

  if (p === '/api/profile/info' && req.method === 'DELETE') {
    const user = url.searchParams.get('user');
    deleteInfoLine(user, parseInt(url.searchParams.get('index'), 10));
    return send(res, 200, { ok: true, info: publicInfo(user) });
  }

  if (p === '/api/profile/doc' && req.method === 'DELETE') {
    const user = url.searchParams.get('user');
    const id = url.searchParams.get('id');
    const docs = readDocs(user).filter(d => d.id !== id);
    writeDocs(user, docs);
    return send(res, 200, { ok: true, documents: docs });
  }

  // ---- static ----
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Landed running on http://localhost:${PORT}`);
  console.log(API_KEY ? `Claude model: ${MODEL}` : 'WARNING: no ANTHROPIC_API_KEY found in .env — chat will 500.');
});
