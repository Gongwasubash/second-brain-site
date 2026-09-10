export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history, context } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const API_KEY = process.env.MISTRAL_API_KEY || 'Oi6B0dDAou2UUEs2uO9UoL5n2Hh0YSpu';
  const MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';

  const systemPrompt = `You are Subash's Life OS assistant. You have access to his journal, tasks, projects, people, habits, wheel of life scores, and life theme. Be concise, helpful, and personal. Use the context provided to answer questions about his life data. If asked to do something with the data, suggest what to do.`;

  const messages = [
    { role: 'system', content: systemPrompt + '\n\nContext:\n' + (context || '') },
    ...(history || []).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 1024 })
    });
    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || 'No response from AI.';
    return res.status(200).json({ response: reply });
  } catch (e) {
    return res.status(200).json({ response: 'Error: ' + e.message });
  }
}
