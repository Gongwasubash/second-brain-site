export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'No path' });
  
  const TOKEN = process.env.GITHUB_TOKEN || '';
  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (TOKEN) headers['Authorization'] = 'token ' + TOKEN;
  
  try {
    const r = await fetch('https://api.github.com/repos/Gongwasubash/ai/contents/' + path, { headers });
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error' });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
