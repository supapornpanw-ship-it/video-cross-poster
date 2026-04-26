// Service worker — token storage, YT access-token refresh, scheduled-job storage.
// All actual upload work happens in the web app (CORS-friendly direct fetch).

function deriveApiBase(sender) {
  try {
    if (sender && sender.url) return new URL(sender.url).origin;
  } catch (_) {}
  return null;
}

async function refreshYtAccessToken(apiBase) {
  const { yt_refresh_token, yt_access_token, yt_access_expires } =
    await chrome.storage.local.get(['yt_refresh_token', 'yt_access_token', 'yt_access_expires']);
  if (!yt_refresh_token) {
    return { ok: false, error: 'not_connected' };
  }
  const now = Date.now();
  if (yt_access_token && yt_access_expires && now < yt_access_expires - 60000) {
    return { ok: true, accessToken: yt_access_token, cached: true };
  }
  if (!apiBase) return { ok: false, error: 'no_api_base' };

  const r = await fetch(`${apiBase}/api/yt-refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: yt_refresh_token })
  });
  let d;
  try { d = await r.json(); } catch (_) { d = {}; }
  if (!r.ok || d.error) {
    return { ok: false, error: d.error || `HTTP ${r.status}` };
  }
  const newAccess = d.access_token;
  const expiresIn = d.expires_in || 3600;
  await chrome.storage.local.set({
    yt_access_token: newAccess,
    yt_access_expires: now + expiresIn * 1000
  });
  return { ok: true, accessToken: newAccess, cached: false };
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      const apiBase = deriveApiBase(sender);
      switch (req && req.type) {
        case 'PING':
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
          break;

        case 'GET_STATE': {
          const data = await chrome.storage.local.get([
            'fb_token', 'fb_token_expires', 'fb_user', 'fb_pages',
            'yt_refresh_token', 'yt_channel', 'yt_user_email',
            'scheduled_jobs'
          ]);
          // Don't ship raw refresh_token to the page; just signal connected state.
          const hasYt = !!data.yt_refresh_token;
          sendResponse({
            ok: true,
            state: {
              fb: {
                token: data.fb_token || null,
                expires: data.fb_token_expires || null,
                user: data.fb_user || null,
                pages: data.fb_pages || []
              },
              yt: {
                connected: hasYt,
                channel: data.yt_channel || null,
                email: data.yt_user_email || null
              },
              scheduledJobs: data.scheduled_jobs || []
            }
          });
          break;
        }

        case 'SAVE_FB': {
          await chrome.storage.local.set({
            fb_token: req.token,
            fb_token_expires: req.expires || null,
            fb_user: req.user || null,
            fb_pages: req.pages || []
          });
          sendResponse({ ok: true });
          break;
        }

        case 'SAVE_FB_PAGES': {
          await chrome.storage.local.set({ fb_pages: req.pages || [] });
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_FB': {
          await chrome.storage.local.remove(['fb_token', 'fb_token_expires', 'fb_user', 'fb_pages']);
          sendResponse({ ok: true });
          break;
        }

        case 'SAVE_YT': {
          await chrome.storage.local.set({
            yt_refresh_token: req.refreshToken,
            yt_channel: req.channel || null,
            yt_user_email: req.email || null,
            yt_access_token: req.accessToken || null,
            yt_access_expires: req.accessTokenExpires || null
          });
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_YT': {
          await chrome.storage.local.remove([
            'yt_refresh_token', 'yt_channel', 'yt_user_email',
            'yt_access_token', 'yt_access_expires'
          ]);
          sendResponse({ ok: true });
          break;
        }

        case 'YT_GET_ACCESS_TOKEN': {
          const out = await refreshYtAccessToken(apiBase);
          sendResponse(out);
          break;
        }

        case 'ADD_JOB': {
          const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
          cur.push(req.job);
          await chrome.storage.local.set({ scheduled_jobs: cur });
          sendResponse({ ok: true });
          break;
        }

        case 'UPDATE_JOB': {
          const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
          const next = cur.map(j => j.id === req.id ? { ...j, ...req.patch } : j);
          await chrome.storage.local.set({ scheduled_jobs: next });
          sendResponse({ ok: true });
          break;
        }

        case 'DEL_JOB': {
          const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
          const next = cur.filter(j => j.id !== req.id);
          await chrome.storage.local.set({ scheduled_jobs: next });
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_JOBS': {
          await chrome.storage.local.set({ scheduled_jobs: [] });
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown_type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});
