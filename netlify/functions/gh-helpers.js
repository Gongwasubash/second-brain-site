// Shared GitHub second-brain helpers for Netlify functions.
// Requires GITHUB_TOKEN env var at call time. Bundled per-function by esbuild.

const GH_REPO = 'Gongwasubash/ai';
const GH_API = `https://api.github.com/repos/${GH_REPO}/contents`;

function ktmDate(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function ktmTime(d = new Date()) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', hour: '2-digit', minute: '2-digit' }).format(d);
}
function ghHeaders() {
    return {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'second-brain-terminal',
    };
}
function safePath(p) {
    p = (p || '').trim().replace(/^\/+/, '');
    if (!p || p.includes('..') || p.startsWith('.')) return null;
    if (!p.endsWith('.md')) p += '.md';
    return p;
}
async function ghRead(path) {
    const r = await fetch(`${GH_API}/${path}?ref=main`, { headers: ghHeaders() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub read failed: ${r.status}`);
    const d = await r.json();
    return { sha: d.sha, content: Buffer.from(d.content || '', 'base64').toString('utf8') };
}
async function ghWrite(path, content, sha, message) {
    const body = { message: message || `terminal: update ${path}`, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(`${GH_API}/${path}`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`GitHub write failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}
async function appendLog(text) {
    const idx = await ghRead('wiki/log.md');
    if (!idx) return;
    const content = idx.content.replace(/\s+$/, '') + `\n${text}\n`;
    await ghWrite('wiki/log.md', content, idx.sha, 'terminal: log entry');
}

// AGENTS.md journal workflow: entry + index + log
async function actJournal(text, summary) {
    const date = ktmDate();
    const path = `journal/${date} Terminal Captures.md`;
    const stamp = `## ${ktmTime()} NPT\n\n${text.trim()}\n`;
    const cur = await ghRead(path);
    let content;
    if (cur) {
        content = cur.content.replace(/\s+$/, '') + '\n\n' + stamp;
    } else {
        const slug = text.trim().split(/\s+/).slice(0, 4).join('-').replace(/[^\w\-]/g, '').slice(0, 40) || 'capture';
        content = `---\ndate: ${date}\ntags:\n  - journal\n  - terminal\n---\n\n# ${date} ${slug}\n\n${stamp}`;
    }
    await ghWrite(path, content, cur?.sha, `terminal: journal capture ${date}`);
    const title = path.split('/')[1].replace('.md', '');
    const line = `- [[${title}]] — ${summary || 'quick captures from web terminal.'}`;
    const idx = await ghRead('journal/index.md');
    if (idx && !idx.content.includes(title)) {
        let nc = idx.content;
        const sec = `## ${date}`;
        nc = nc.includes(sec) ? nc.replace(sec, `${sec}\n\n${line}`) : nc.replace(/\s+$/, '') + `\n\n${sec}\n\n${line}\n`;
        await ghWrite('journal/index.md', nc, idx.sha, `terminal: index journal ${date}`);
    } else if (idx && summary && idx.content.includes(`${title}]] — quick captures from web terminal.`)) {
        const nc = idx.content.replace(`${title}]] — quick captures from web terminal.`, `${title}]] — ${summary}`);
        await ghWrite('journal/index.md', nc, idx.sha, `terminal: index journal ${date}`);
    }
    await appendLog(`## [${date}] journal | ${title} — ${summary || text.trim().split(/\s+/).slice(0, 8).join(' ')}`);
    return `saved → ${path} + index + log`;
}

// AGENTS.md CRM workflow: page + alphabetical index + log
async function actContact(name, details, summary) {
    name = (name || '').trim();
    if (!name) throw new Error('contact name missing');
    const path = `crm/${name}.md`;
    const date = ktmDate();
    const cur = await ghRead(path);
    let content;
    if (cur) {
        content = cur.content.replace(/\s+$/, '') + `\n\n## Update ${date}\n\n${(details || '').trim() || '(no details given)'}\n`;
    } else {
        content = `# ${name}\n\n- Contact: ${(details || '').trim() || '—'}\n- Met: via chat, ${date}\n- Notes: ${(details || '').trim() || '—'}\n`;
    }
    await ghWrite(path, content, cur?.sha, `terminal: contact ${name}`);
    const idx = await ghRead('crm/index.md');
    if (idx && !idx.content.includes(`[[${name}]]`)) {
        const lines = idx.content.split('\n');
        const entry = `- [[${name}]] — ${summary || (details || '').trim().slice(0, 80) || 'added via chat'}`;
        let pos = lines.findIndex((l) => l.startsWith('- [[') && l.toLowerCase() > entry.toLowerCase());
        if (pos < 0) pos = lines.length;
        lines.splice(pos, 0, entry);
        await ghWrite('crm/index.md', lines.join('\n'), idx.sha, `terminal: index contact ${name}`);
    }
    await appendLog(`## [${date}] crm | ${name} — ${summary || (details || '').trim().slice(0, 80) || 'contact updated'}`);
    return `saved → ${path} + index + log`;
}

async function actAppend(path, text) {
    path = safePath(path);
    if (!path || !text?.trim()) throw new Error('path and text required');
    const cur = await ghRead(path);
    const stamp = `\n\n> terminal ${ktmDate()} ${ktmTime()} NPT\n\n${text.trim()}\n`;
    const content = cur ? cur.content.replace(/\s+$/, '') + stamp : `# ${path}\n` + stamp;
    await ghWrite(path, content, cur?.sha, `terminal: append ${path}`);
    return `saved → ${path}`;
}

async function actRead(path) {
    path = safePath(path);
    if (!path) throw new Error('path required');
    const cur = await ghRead(path);
    if (!cur) throw new Error(`not found: ${path}`);
    return cur.content.slice(0, 4000);
}

async function actLog(text) {
    await appendLog(`## [${ktmDate()}] terminal | ${text.trim()}`);
    return 'logged → wiki/log.md';
}

// Rewrite user-typed text into proper language + short summary in ONE model call.
// chatFn: async (key, model, messages) -> {status, data}
const CLEAN_MODELS = [
    'ling-3.0-flash-fin-free',
    'mimo-v2.5-free',
    'big-pickle',
    'nemotron-3.5-lightning-free',
    'nemotron-3-ultra-free',
    'muse-spark-1.3-contributor-free',
];
async function cleanNote(chatFn, key, text, kind = 'journal note') {
    const fallback = { clean: (text || '').trim(), summary: '' };
    if (!key || !text?.trim()) return fallback;
    const msgs = [
        { role: 'system', content: `Rewrite the ${kind} below in clear, proper English: fix grammar and spelling, keep first person, keep every fact, name and number exactly as given. 1-3 short sentences, plain text, no quotes. Then on its own new last line write SUMMARY: followed by a summary of 12 words or fewer. Reply with ONLY the rewritten note plus the SUMMARY line.` },
        { role: 'user', content: text.slice(0, 1000) },
    ];
    for (const model of CLEAN_MODELS) {
        try {
            const { status, data } = await chatFn(key, model, msgs);
            if (status !== 200) {
                if (status === 401 || status === 403) break;
                continue;
            }
            const raw = (data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning || '').trim();
            if (!raw) continue;
            const lines = raw.split('\n');
            const si = lines.findIndex((l) => /^summary\s*:/i.test(l.trim()));
            if (si >= 0) {
                return {
                    clean: lines.slice(0, si).join('\n').trim() || fallback.clean,
                    summary: lines[si].replace(/^summary\s*:/i, '').trim().slice(0, 140),
                };
            }
            return { clean: raw.slice(0, 1500), summary: '' };
        } catch { /* try next */ }
    }
    return fallback;
}

// Detect AI-emitted save intents: [SAVE-JOURNAL] ... / [SAVE-CONTACT: Name] ...
function parseSavePrefix(text) {
    if (!text) return null;
    let m = text.match(/^\[SAVE-JOURNAL\]\s*([\s\S]*)/);
    if (m) return { kind: 'journal', body: (m[1] || '').trim() };
    m = text.match(/^\[SAVE-CONTACT:\s*([^\]]+)\]\s*([\s\S]*)/);
    if (m) return { kind: 'contact', name: (m[1] || '').trim(), body: (m[2] || '').trim() };
    return null;
}

module.exports = { ktmDate, ktmTime, safePath, ghRead, ghWrite, appendLog, actJournal, actContact, actAppend, actRead, actLog, parseSavePrefix, cleanNote };
