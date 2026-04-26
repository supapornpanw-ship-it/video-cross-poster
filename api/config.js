// GET /api/config — returns public OAuth client IDs from server env vars.
// (Client IDs are not secret. Client SECRETS are never exposed here.)
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    fbAppId: process.env.FB_APP_ID || null,
  });
}
