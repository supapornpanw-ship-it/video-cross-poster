// POST /api/yt-refresh — Exchange a refresh_token for a new access_token.
// Body: { refresh_token: string }
// Returns: { access_token, expires_in }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'server_missing_env' });
  }

  // Vercel auto-parses JSON for Content-Type: application/json
  const refreshToken = req.body && req.body.refresh_token;
  if (!refreshToken) return res.status(400).json({ error: 'missing_refresh_token' });

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const d = await r.json();
    if (!r.ok || d.error) {
      return res.status(r.status || 400).json({ error: d.error_description || d.error || `http_${r.status}` });
    }
    return res.status(200).json({
      access_token: d.access_token,
      expires_in: d.expires_in || 3600
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
