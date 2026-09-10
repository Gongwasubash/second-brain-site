// Netlify Function: /.netlify/functions/terminal
// VS Code-style terminal backend:
//  - OpenCode Zen chat with free-model auto-select (OPENCODE_ZEN_KEY env var)
//  - Second-brain writes via GitHub Contents API (GITHUB_TOKEN env var)
// Secrets MUST be Netlify env vars (never commit them).

const ZEN_BASE = 'https://opencode.ai/zen/v1';
const GH_REPO = 'Gongwasubash/ai';
const GH_API = `https://api.github.com/repos/${GH_REPO}/contents`;

// Preferred free models, in order. Function tries each until one answers
// (free tiers rate-limit, so fallback matters).
const FREE_MODELS = [
    'ling-3.0-flash-fin-free',
    'mimo-v2.5-free',
    'big-pickle',
    'nemotron-3.5-lightning-free',
    'nemotron-3-ultra-free',
    'muse-spark-1.3-contributor-free',
];

// Shared second-brain GitHub helpers (bundled by esbuild)
const { ktmDate, ktmTime, safePath, ghRead, ghWrite, appendLog, actJournal, actContact, actAppend, actRead, actLog, parseSavePrefix, cleanNote } = require('./gh-helpers');

// ---------- Write actions ----------
async function aiSummary(key, text, words = 12) {
    if (!key || !text?.trim()) return '';
    const msgs = [
        { role: 'system', content: `Summarize the note in ${words} words or fewer. Plain text, no quotes, no prefix.` },
        { role: 'user', content: text.slice(0, 1000) },
    ];
    for (const model of FREE_MODELS) {
        try {
            const { status, data } = await chat(key, model, msgs);
            const t = status === 200 ? extractText(data).trim().replace(/\n/g, ' ') : '';
            if (t) return t.slice(0, 140);
            if (status === 401 || status === 403) break;
        } catch { /* try next */ }
    }
    return '';
}
// ---------- Zen chat ----------
async function liveFreeModels(key) {
    try {
        const r = await fetch(`${ZEN_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) return FREE_MODELS;
        const d = await r.json();
        const ids = (d.data || []).map((m) => m.id || m);
        const live = FREE_MODELS.filter((m) => ids.includes(m));
        return live.length ? live : FREE_MODELS;
    } catch {
        return FREE_MODELS;
    }
}
async function chat(key, model, messages) {
    const r = await fetch(`${ZEN_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1500 }),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
}
function extractText(data) {
    const msg = data.choices?.[0]?.message;
    if (!msg) return '';
    return msg.content || msg.reasoning || '';
}

// Execute AI-requested saves ([SAVE-JOURNAL] / [SAVE-CONTACT: Name] prefix)
async function maybeSave(key, text, userMsg) {
    const s = parseSavePrefix(text);
    if (!s || !process.env.GITHUB_TOKEN) return text;
    const isSaveReq = /remember|note (it |that |down|to self)|jot (it |that |down)|log (it |that |this)|save (it |that |this|to my)|add (a |new )?contact|new contact|met .*today|phone number/i.test(userMsg || '');
    if (!isSaveReq) return text.replace(/^\[(SAVE-JOURNAL|SAVE-CONTACT:[^\]]+)\]\s*/, '');
    try {
        if (s.kind === 'journal') {
            const cn = await cleanNote(chat, key, s.body, 'journal note');
            const info = await actJournal(cn.clean, cn.summary);
            return `${cn.clean}\n\n✓ ${info}`;
        }
        const cn = await cleanNote(chat, key, s.body, 'contact details');
        const info = await actContact(s.name, cn.clean, cn.summary);
        return `${cn.clean}\n\n✓ ${info}`;
    } catch (e) {
        return `${text}\n\n(save failed: ${e.message})`;
    }
}

// ---------- Handler ----------
exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST')
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const { message, history = [], context = '', model: wantModel, action, args = {} } = JSON.parse(event.body || '{}');
        const KEY = process.env.OPENCODE_ZEN_KEY;

        // --- Write / read actions (need GITHUB_TOKEN) ---
        if (action) {
            if (!process.env.GITHUB_TOKEN)
                return { statusCode: 200, headers, body: JSON.stringify({ response: 'Server misconfigured: GITHUB_TOKEN not set.', model: null }) };
            try {
                let out;
                if (action === 'journal') {
                    const cn = await cleanNote(chat, KEY, args.text || '', 'journal note');
                    out = await actJournal(cn.clean, cn.summary);
                }
                else if (action === 'contact') {
                    const cn = await cleanNote(chat, KEY, args.details || '', 'contact details');
                    out = await actContact(args.name || '', cn.clean, cn.summary);
                }
                else if (action === 'append') out = await actAppend(args.path || '', args.text || '');
                else if (action === 'read') out = await actRead(args.path || '');
                else if (action === 'log') out = await actLog(args.text || '');
                else if (action === 'models') {
                    const KEY = process.env.OPENCODE_ZEN_KEY;
                    if (!KEY) throw new Error('OPENCODE_ZEN_KEY not set');
                    out = (await liveFreeModels(KEY)).join('\n');
                    return { statusCode: 200, headers, body: JSON.stringify({ models: out.split('\n') }) };
                } else throw new Error(`unknown action: ${action}`);
                return { statusCode: 200, headers, body: JSON.stringify({ response: out, model: 'github' }) };
            } catch (e) {
                return { statusCode: 200, headers, body: JSON.stringify({ response: `Error: ${e.message}`, model: null }) };
            }
        }

        // --- AI chat ---
        if (!KEY)
            return { statusCode: 200, headers, body: JSON.stringify({ response: 'Server misconfigured: OPENCODE_ZEN_KEY not set.', model: null }) };
        if (!message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No message' }) };

        const systemPrompt = `You are Subash's Second Brain terminal assistant, answering inside a VS Code-style terminal. RULES: 1. Answer ONLY from the provided context when context is given; if missing, say so briefly. 2. Be concise — short answers, plain text, no heavy markdown (terminal output). 3. Use bullet lines starting with "- " when listing. 4. If the user wants to REMEMBER, NOTE, LOG or SAVE something to the journal, start your reply with exactly [SAVE-JOURNAL] on the first line, then the note text. 5. If the user wants to ADD or UPDATE a contact/person, start with exactly [SAVE-CONTACT: Full Name] on the first line, then what is known. 6. Otherwise reply normally with no prefix. 7. TONE: warm and friendly like a helpful friend — simple everyday words, no jargon. You know Subash's interests: AI automation, content creation, Nepal history (Mahispal dynasty), video production, building systems.${
            context ? '\n\n--- SECOND BRAIN DATA ---\n' + context : ''
        }`;
        const messages = [{ role: 'system', content: systemPrompt }];
        for (const h of history.slice(-6)) messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
        messages.push({ role: 'user', content: message });

        const candidates = wantModel ? [wantModel, ...FREE_MODELS.filter((m) => m !== wantModel)] : await liveFreeModels(KEY);
        // Race first 3 — first good reply wins (sequential fallback blows the time limit)
        const tryOne = async (model) => {
            const { status, data } = await chat(KEY, model, messages);
            if (status === 200) {
                const text = extractText(data);
                if (text) return { response: text, model };
                throw new Error(`${model}: empty reply`);
            }
            throw new Error(`${model}: ${data?.error?.message || data?.error || status}`);
        };
        let lastErr = '';
        try {
            const win = await Promise.any(candidates.slice(0, 3).map(tryOne));
            win.response = await maybeSave(KEY, win.response, message);
            return { statusCode: 200, headers, body: JSON.stringify(win) };
        } catch (e) {
            lastErr = (e.errors || [e]).map((x) => x.message).join(' | ');
        }
        for (const model of candidates.slice(3)) {
            const { status, data } = await chat(KEY, model, messages);
            if (status === 200) {
                const text = extractText(data);
                if (text) return { statusCode: 200, headers, body: JSON.stringify({ response: await maybeSave(KEY, text, message), model }) };
                lastErr = `${model}: empty reply`;
                continue;
            }
            lastErr = `${model}: ${data?.error?.message || data?.error || status}`;
            if (status === 401 || status === 403) break;
        }
        return { statusCode: 200, headers, body: JSON.stringify({ response: `All free models busy right now (${lastErr}). Wait a minute and retry.`, model: null }) };
    } catch (error) {
        return { statusCode: 200, headers, body: JSON.stringify({ response: `Error: ${error.message}`, model: null }) };
    }
};
