// Netlify Function: /.netlify/functions/chat
// Handles AI chat with RAG context from GitHub.
// Primary: OpenCode Zen free-model auto-select (same as terminal).
// Fallback: Mistral (MISTRAL_API_KEY env var).

const ZEN_BASE = 'https://opencode.ai/zen/v1';
const FREE_MODELS = [
    'ling-3.0-flash-fin-free',
    'mimo-v2.5-free',
    'big-pickle',
    'nemotron-3.5-lightning-free',
    'nemotron-3-ultra-free',
    'muse-spark-1.3-contributor-free',
];

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
async function zenChat(key, model, messages) {
    const r = await fetch(`${ZEN_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 2048 }),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
}
function extractText(data) {
    const msg = data.choices?.[0]?.message;
    if (!msg) return '';
    return msg.content || msg.reasoning || '';
}
async function aiSummary(key, text, words = 12) {
    if (!key || !text?.trim()) return '';
    const msgs = [
        { role: 'system', content: `Summarize the note in ${words} words or fewer. Plain text, no quotes, no prefix.` },
        { role: 'user', content: text.slice(0, 1000) },
    ];
    for (const model of FREE_MODELS) {
        try {
            const { status, data } = await zenChat(key, model, msgs);
            const t = status === 200 ? extractText(data).trim().replace(/\n/g, ' ') : '';
            if (t) return t.slice(0, 140);
            if (status === 401 || status === 403) break;
        } catch { /* try next */ }
    }
    return '';
}
const { actJournal, actContact, parseSavePrefix, cleanNote } = require('./gh-helpers');

exports.handler = async (event) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({error: 'Method not allowed'}) };
    }

    try {
        const { message, history = [], context = '' } = JSON.parse(event.body);

        if (!message) {
            return { statusCode: 400, headers, body: JSON.stringify({error: 'No message'}) };
        }

        // Build system prompt
        const systemPrompt = `You are Subash's Second Brain AI assistant. You have access to his entire Obsidian knowledge base.

RULES:
1. Answer ONLY based on the provided context. If the data doesn't contain the answer, say so.
2. Be concise and direct. Use bullet points when helpful.
3. When referencing data, mention the source file name.
4. You can synthesize information across multiple pages.
5. Use markdown formatting for readability.
6. If the user wants to REMEMBER, NOTE, LOG or SAVE something to the journal, start your reply with exactly [SAVE-JOURNAL] on the first line, then the note text.
7. If the user wants to ADD or UPDATE a contact/person, start your reply with exactly [SAVE-CONTACT: Full Name] on the first line, then what is known.
8. Otherwise reply normally with no prefix.
9. TONE: warm and friendly, like a helpful friend chatting — simple everyday words, no jargon, no lectures, no robotic bullet dumps unless a list truly helps.

You know about Subash's interests: AI automation, content creation, Nepal history (Mahispal dynasty), video production, and building systems.`;

        // Build messages array
        const messages = [
            { role: 'system', content: systemPrompt + '\n\n--- SECOND BRAIN DATA ---\n' + context }
        ];
        for (const h of history.slice(-6)) {
            messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
        }
        messages.push({ role: 'user', content: message });

        // Primary: OpenCode Zen free-model auto-select (same as terminal)
        // Race the first 3 free models — first good reply wins (failures are fast,
        // sequential fallback would blow the function time limit).
        const ZEN_KEY = process.env.OPENCODE_ZEN_KEY;
        let responseText = '';
        let lastErr = '';
        if (ZEN_KEY) {
            const candidates = await liveFreeModels(ZEN_KEY);
            const tryOne = async (model) => {
                const { status, data } = await zenChat(ZEN_KEY, model, messages);
                if (status === 200) {
                    const t = extractText(data);
                    if (t) return t;
                    throw new Error(`${model}: empty reply`);
                }
                throw new Error(`${model}: ${data?.error?.message || data?.error || status}`);
            };
            try {
                responseText = await Promise.any(candidates.slice(0, 3).map(tryOne));
            } catch (e) {
                lastErr = (e.errors || [e]).map((x) => x.message).join(' | ');
            }
        } else {
            lastErr = 'OPENCODE_ZEN_KEY not set';
        }

        // Fallback: Mistral (env key)
        if (!responseText) {
            try {
                const MISTRAL_KEY = process.env.MISTRAL_API_KEY;
                if (!MISTRAL_KEY) throw new Error('no mistral key');
                const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MISTRAL_KEY}` },
                    body: JSON.stringify({ model: 'open-mistral-7b', messages, temperature: 0.7, max_tokens: 2048 }),
                });
                const mdata = await res.json();
                if (mdata.error) throw new Error(mdata.error.message || JSON.stringify(mdata.error));
                responseText = mdata.choices?.[0]?.message?.content || '';
            } catch (e) {
                lastErr += ` | mistral: ${e.message}`;
            }
        }

        if (!responseText) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ response: `AI busy right now (${lastErr}). Try again in a minute.`, sources: [] })
            };
        }

        // Execute AI-requested saves ([SAVE-JOURNAL] / [SAVE-CONTACT: Name])
        // Guard: only when the CURRENT message is itself a save request (stops
        // follow-up questions re-saving history content as duplicates).
        const isSaveReq = /remember|note (it |that |down|to self)|jot (it |that |down)|log (it |that |this)|save (it |that |this|to my)|add (a |new )?contact|new contact|met .*today|phone number/i.test(message);
        const save = parseSavePrefix(responseText);
        if (save && process.env.GITHUB_TOKEN && isSaveReq) {
            try {
                let info;
                if (save.kind === 'journal') {
                    const cn = await cleanNote(zenChat, ZEN_KEY, save.body, 'journal note');
                    info = await actJournal(cn.clean, cn.summary);
                    responseText = `${cn.clean}\n\n✓ ${info}`;
                } else {
                    const cn = await cleanNote(zenChat, ZEN_KEY, save.body, 'contact details');
                    info = await actContact(save.name, cn.clean, cn.summary);
                    responseText = `${cn.clean}\n\n✓ ${info}`;
                }
            } catch (e) {
                responseText += `\n\n(save failed: ${e.message})`;
            }
        } else if (save) {
            responseText = responseText.replace(/^\[(SAVE-JOURNAL|SAVE-CONTACT:[^\]]+)\]\s*/, '');
        }

        // Extract source references from context
        const sources = [];
        const sourceMatches = context.match(/=== (.+?) ===/g);
        if (sourceMatches) {
            for (const m of sourceMatches.slice(0, 5)) {
                sources.push(m.replace(/===/g, '').trim());
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ response: responseText, sources })
        };

    } catch (error) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                response: `Error: ${error.message}`,
                sources: []
            })
        };
    }
};
