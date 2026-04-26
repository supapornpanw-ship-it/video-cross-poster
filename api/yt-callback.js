// GET /api/yt-callback — Google OAuth callback for YouTube.
// Exchanges code → access_token + refresh_token, fetches channel info, then
// returns an HTML page that posts the result to window.opener and closes itself.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, error, state } = req.query;
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).send('Server missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars.');
  }
  if (error) return sendResultPage(res, { ok: false, error });
  if (!code) return sendResultPage(res, { ok: false, error: 'no_code' });

  const REDIRECT_URI = `https://${req.headers.host}/api/yt-callback`;

  try {
    // 1. Exchange code → tokens
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const td = await tr.json();
    if (!tr.ok || td.error) {
      return sendResultPage(res, { ok: false, error: td.error_description || td.error || `token_http_${tr.status}` });
    }

    const accessToken = td.access_token;
    const refreshToken = td.refresh_token; // only present on first grant; user must consent to receive again
    const expiresIn = td.expires_in || 3600;

    // 2. Fetch channel info (needs youtube.readonly scope OR youtube.upload returns own channel via mine=true)
    let channel = null;
    try {
      const chR = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const chD = await chR.json();
      if (chR.ok && chD.items && chD.items[0]) {
        channel = {
          id: chD.items[0].id,
          title: chD.items[0].snippet.title,
          thumb: chD.items[0].snippet.thumbnails && chD.items[0].snippet.thumbnails.default
            ? chD.items[0].snippet.thumbnails.default.url
            : null
        };
      }
    } catch (_) { /* non-fatal */ }

    // 3. Fetch user email (best effort, requires userinfo via id_token or open id scope)
    // Skipped — channel.title is enough identification.

    return sendResultPage(res, {
      ok: true,
      accessToken,
      refreshToken: refreshToken || null,
      expiresIn,
      channel,
      state: state || null
    });
  } catch (err) {
    return sendResultPage(res, { ok: false, error: err.message });
  }
}

function sendResultPage(res, payload) {
  const json = JSON.stringify(payload);
  // Escape closing script tags inside JSON to prevent breaking out of the script element.
  const safeJson = json.replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>YouTube connected</title>
<style>body{font-family:system-ui,sans-serif;padding:32px;text-align:center;color:#333}</style>
</head><body>
<h2>${payload.ok ? '✅ YouTube connected' : '❌ YouTube auth failed'}</h2>
<p>${payload.ok ? 'You can close this window.' : (payload.error || 'Unknown error')}</p>
<script>
  (function(){
    var data = ${safeJson};
    try {
      if (window.opener) {
        window.opener.postMessage({ source: 'vp-yt-oauth', payload: data }, '*');
      } else {
        // Fallback — pass result via URL hash on parent
        var qs = new URLSearchParams();
        qs.set('yt_result', encodeURIComponent(JSON.stringify(data)));
        window.location.replace('/#' + qs.toString());
        return;
      }
    } catch(e) {}
    setTimeout(function(){ try { window.close(); } catch(e){} }, 800);
  })();
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
