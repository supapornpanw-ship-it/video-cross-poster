// Service worker — token storage, YT access-token refresh, scheduled-job storage,
// and scheduled Facebook Story uploads (FB Stories don't support native scheduling
// so we hold the file in IndexedDB and fire the upload via chrome.alarms).

// ───────── IndexedDB helpers (for Story payloads — videos can be tens of MB)
const IDB_NAME = 'vp_blobs';
const IDB_STORE = 'blobs';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbReq(mode, fn) {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openIdb();
      const tx = db.transaction(IDB_STORE, mode);
      const store = tx.objectStore(IDB_STORE);
      const r = fn(store);
      tx.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
      tx.onerror = () => reject(tx.error);
    } catch (e) { reject(e); }
  });
}
const idbPut = (key, value) => idbReq('readwrite', s => s.put(value, key));
const idbGet = (key) => idbReq('readonly', s => s.get(key));
const idbDel = (key) => idbReq('readwrite', s => s.delete(key));

function dataURLtoBlob(dataURL) {
  const idx = dataURL.indexOf(',');
  const header = dataURL.slice(0, idx);
  const b64 = dataURL.slice(idx + 1);
  const mime = (header.match(/:(.+?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ───────── Background-side Story upload (3 phase: start → upload → finish)
async function bgUploadStory(page, blob) {
  const base = `https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/video_stories`;
  const tokParam = `access_token=${encodeURIComponent(page.pageToken)}`;

  const startR = await fetch(`${base}?upload_phase=start&${tokParam}`, { method: 'POST' });
  const startD = await startR.json().catch(() => ({}));
  if (!startR.ok || startD.error) {
    throw new Error('story_start: ' + ((startD.error && startD.error.message) || `HTTP ${startR.status}`));
  }
  const { video_id, upload_url } = startD;
  if (!video_id || !upload_url) throw new Error('story_start: missing video_id/upload_url');

  const upR = await fetch(upload_url, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${page.pageToken}`,
      'offset': '0',
      'file_size': String(blob.size),
    },
    body: blob,
  });
  const upD = await upR.json().catch(() => ({}));
  if (!upR.ok || upD.error || upD.success !== true) {
    throw new Error('story_upload: ' + ((upD.error && upD.error.message) || JSON.stringify(upD).slice(0, 200)));
  }

  const finR = await fetch(
    `${base}?upload_phase=finish&video_id=${encodeURIComponent(video_id)}&video_state=PUBLISHED&${tokParam}`,
    { method: 'POST' }
  );
  const finD = await finR.json().catch(() => ({}));
  if (!finR.ok || finD.error) {
    throw new Error('story_finish: ' + ((finD.error && finD.error.message) || `HTTP ${finR.status}`));
  }
  return { id: video_id };
}

// ───────── Alarm handler — fires when scheduled story time arrives
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name || !alarm.name.startsWith('story_')) return;
  const jobId = alarm.name.slice('story_'.length);
  console.log('[VP] story alarm fired:', jobId);
  try {
    const rec = await idbGet(`story_${jobId}`);
    if (!rec || !rec.blob || !Array.isArray(rec.pages)) {
      console.warn('[VP] no IDB record for', jobId);
      return;
    }
    const results = [];
    for (const p of rec.pages) {
      try {
        const out = await bgUploadStory(p, rec.blob);
        results.push({ kind: 'story', pageId: p.id, pageName: p.name, ok: true, id: out.id });
      } catch (e) {
        results.push({ kind: 'story', pageId: p.id, pageName: p.name, ok: false, error: e.message });
      }
    }
    // Merge into scheduled_jobs
    const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
    const next = cur.map(j => {
      if (j.id !== jobId) return j;
      const merged = { ...j };
      merged.results = [...(merged.results || []), ...results];
      const allOk = merged.results.every(x => x.ok);
      merged.status = allOk ? 'done' : 'partial';
      merged.storyFiredAt = Date.now();
      return merged;
    });
    await chrome.storage.local.set({ scheduled_jobs: next });
    await idbDel(`story_${jobId}`);
    console.log('[VP] story alarm complete:', jobId, results);
  } catch (e) {
    console.error('[VP] story alarm error:', e);
  }
});

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
          // Best-effort: clean up any pending story alarm + blob
          try { await chrome.alarms.clear(`story_${req.id}`); } catch (_) {}
          try { await idbDel(`story_${req.id}`); } catch (_) {}
          sendResponse({ ok: true });
          break;
        }

        case 'SCHEDULE_STORY': {
          const { jobId, pages, dataURL, fileName, fireAt } = req;
          if (!jobId || !pages || !dataURL || !fireAt) {
            sendResponse({ ok: false, error: 'missing_fields' });
            break;
          }
          if (fireAt - Date.now() < 30000) {
            sendResponse({ ok: false, error: 'fireAt must be at least 30s in the future' });
            break;
          }
          const blob = dataURLtoBlob(dataURL);
          await idbPut(`story_${jobId}`, { blob, pages, fileName, fireAt, createdAt: Date.now() });
          await chrome.alarms.create(`story_${jobId}`, { when: fireAt });
          sendResponse({ ok: true, blobSize: blob.size });
          break;
        }

        case 'CANCEL_STORY': {
          try { await chrome.alarms.clear(`story_${req.id}`); } catch (_) {}
          try { await idbDel(`story_${req.id}`); } catch (_) {}
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
