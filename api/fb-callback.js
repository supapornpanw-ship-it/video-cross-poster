// GET /api/fb-callback — Facebook OAuth callback.
// Exchanges code → long-lived (60-day) user token, then redirects back to the app
// with the token in the URL hash so it never hits server logs.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, error, error_description, state } = req.query;
  const FB_APP_ID = process.env.FB_APP_ID;
  const FB_APP_SECRET = process.env.FB_APP_SECRET;

  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.status(500).send('Server missing FB_APP_ID / FB_APP_SECRET env vars.');
  }
  if (error) {
    return res.redirect(`/?fb_error=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) {
    return res.redirect('/?fb_error=no_code');
  }

  const REDIRECT_URI = `https://${req.headers.host}/api/fb-callback`;
  try {
    // 1. code → short-lived user token
    const r1 = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
      `client_id=${FB_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&client_secret=${FB_APP_SECRET}` +
      `&code=${encodeURIComponent(code)}`
    );
    const d1 = await r1.json();
    if (d1.error) return res.redirect(`/?fb_error=${encodeURIComponent(d1.error.message)}`);

    // 2. short-lived → long-lived (60 days)
    const r2 = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
      `grant_type=fb_exchange_token` +
      `&client_id=${FB_APP_ID}` +
      `&client_secret=${FB_APP_SECRET}` +
      `&fb_exchange_token=${encodeURIComponent(d1.access_token)}`
    );
    const d2 = await r2.json();

    const finalToken = d2.access_token || d1.access_token;
    const expiresIn = d2.expires_in || d1.expires_in || 5184000;

    // Use URL hash so token isn't sent to server in the redirect.
    const stateParam = state ? `&state=${encodeURIComponent(state)}` : '';
    return res.redirect(`/#fb_token=${encodeURIComponent(finalToken)}&fb_expires=${expiresIn}${stateParam}`);
  } catch (err) {
    return res.redirect(`/?fb_error=${encodeURIComponent(err.message)}`);
  }
}
