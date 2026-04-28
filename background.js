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

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
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

// ───────── Toolbar icon click — open the web app
const APP_URL = 'https://video-cross-poster.vercel.app/';

chrome.action.onClicked.addListener(async () => {
  // If a tab with the app is already open, focus it; otherwise open a new tab.
  try {
    const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
    if (tabs && tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch (_) {}
  await chrome.tabs.create({ url: APP_URL });
});

// ───────── Event log (last 200 entries persisted for debugging)
async function logEvent(type, msg, extra) {
  try {
    const cur = (await chrome.storage.local.get('vp_event_log')).vp_event_log || [];
    cur.push({ ts: Date.now(), type, msg, extra: extra || null });
    while (cur.length > 200) cur.shift();
    await chrome.storage.local.set({ vp_event_log: cur });
  } catch (_) {}
}

// ───────── In-memory lock to prevent double-firing the same job
// (e.g. recoverMissedJobs racing with chrome.alarms.onAlarm).
const firingJobs = new Set();

// ───────── Push live state change to the web app tab so UI refreshes
// immediately instead of waiting for the 30 s poll.
async function broadcastStateChanged() {
  try {
    const APP_ORIGINS = ['https://video-cross-poster.vercel.app', 'http://localhost'];
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      if (!APP_ORIGINS.some(o => tab.url.startsWith(o))) continue;
      try { chrome.tabs.sendMessage(tab.id, { type: 'VP_STATE_CHANGED' }); } catch (_) {}
    }
  } catch (_) {}
}

// Append a single page result to a job atomically. Each call does a
// read-modify-write so partial progress survives even if SW is killed
// later in the run.
async function appendPageResult(jobId, pageResult, opts) {
  const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
  const next = cur.map(j => {
    if (j.id !== jobId) return j;
    // Skip duplicates (in case of retry firing same page twice)
    const dup = (j.results || []).some(r =>
      r.kind === 'story' && r.pageId === pageResult.pageId && r.ok === pageResult.ok
    );
    if (dup) return j;
    const merged = { ...j };
    merged.results = [...(merged.results || []), pageResult];
    if (opts && opts.markFired) {
      merged.storyFiredAt = Date.now();
      const allStoryOk = merged.results
        .filter(r => r.kind === 'story')
        .every(r => r.ok);
      merged.status = allStoryOk ? 'done' : 'partial';
    }
    return merged;
  });
  await chrome.storage.local.set({ scheduled_jobs: next });
  broadcastStateChanged();
}

// ───────── Story upload core — used by alarm + recovery + manual retry.
// Uploads ALL pages in parallel and saves each result as it completes.
// Survives SW termination mid-run because partial progress is persisted.
async function fireStoryJob(jobId) {
  if (firingJobs.has(jobId)) {
    await logEvent('story_fire', 'already_firing', { jobId });
    return { ok: false, error: 'already_firing' };
  }
  firingJobs.add(jobId);
  await logEvent('story_fire', 'start', { jobId });

  try {
    let rec;
    try {
      rec = await idbGet(`story_${jobId}`);
    } catch (e) {
      await logEvent('story_fire', 'idb_error', { jobId, err: e.message });
      return { ok: false, error: 'idb_error: ' + e.message };
    }
    if (!rec || !rec.blob || !Array.isArray(rec.pages)) {
      await logEvent('story_fire', 'no_record', { jobId });
      // Mark job as failed if no blob — so UI can show explicit error
      try {
        const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
        const next = cur.map(j => {
          if (j.id !== jobId) return j;
          if (j.storyFiredAt) return j;
          return {
            ...j,
            storyFiredAt: Date.now(),
            status: 'partial',
            results: [...(j.results || []), {
              kind: 'story_sched', ok: false,
              error: 'ไฟล์หายจาก IndexedDB — อาจถูก Chrome เคลียร์ storage'
            }]
          };
        });
        await chrome.storage.local.set({ scheduled_jobs: next });
      } catch (_) {}
      return { ok: false, error: 'no_record' };
    }

    // Identify pages that haven't been successfully posted yet (idempotent retry).
    const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
    const job = cur.find(j => j.id === jobId);
    const alreadyDone = new Set(
      ((job && job.results) || [])
        .filter(r => r.kind === 'story' && r.ok)
        .map(r => r.pageId)
    );
    const pagesToFire = rec.pages.filter(p => !alreadyDone.has(p.id));
    await logEvent('story_fire', 'pages_planned', {
      jobId, total: rec.pages.length, todo: pagesToFire.length, alreadyDone: alreadyDone.size
    });

    // Fire all pages in parallel. Each page persists its result individually
    // so SW death doesn't lose data.
    const results = await Promise.all(pagesToFire.map(async (p) => {
      const result = { kind: 'story', pageId: p.id, pageName: p.name };
      try {
        const out = await bgUploadStory(p, rec.blob);
        Object.assign(result, { ok: true, id: out.id });
        await logEvent('story_fire', 'page_ok', { jobId, page: p.name, id: out.id });
      } catch (e) {
        Object.assign(result, { ok: false, error: e.message });
        await logEvent('story_fire', 'page_err', { jobId, page: p.name, err: e.message });
      }
      // Persist immediately — survives SW kill
      try { await appendPageResult(jobId, result); } catch (_) {}
      return result;
    }));

    // Final pass: mark job as fired + cleanup blob
    try {
      const cur2 = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
      const next = cur2.map(j => {
        if (j.id !== jobId) return j;
        const allStoryOk = (j.results || [])
          .filter(r => r.kind === 'story')
          .every(r => r.ok);
        const totalStorySuccess = (j.results || [])
          .filter(r => r.kind === 'story' && r.ok).length;
        return {
          ...j,
          storyFiredAt: Date.now(),
          status: (allStoryOk && totalStorySuccess >= rec.pages.length) ? 'done' : 'partial'
        };
      });
      await chrome.storage.local.set({ scheduled_jobs: next });
      // Only delete blob if all pages succeeded — keep for retry otherwise
      const allOk = results.every(r => r.ok) && alreadyDone.size + results.length >= rec.pages.length;
      if (allOk) await idbDel(`story_${jobId}`);
      broadcastStateChanged();
    } catch (e) {
      await logEvent('story_fire', 'save_err', { jobId, err: e.message });
    }

    await logEvent('story_fire', 'done', { jobId, fired: results.length });
    return { ok: true, results };
  } finally {
    firingJobs.delete(jobId);
  }
}

// ───────── Recovery — runs on SW startup. If laptop slept past fireAt
// or alarm got dropped, this catches up jobs whose blob is still in IDB.
async function recoverMissedJobs() {
  try {
    const jobs = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
    const now = Date.now();
    let recovered = 0;
    for (const j of jobs) {
      if (!j.storyEnabled) continue;
      if (!j.fireAt) continue;
      if (j.storyFiredAt) continue;
      if (j.fireAt > now) continue; // not due yet — alarm will handle
      const alarm = await chrome.alarms.get(`story_${j.id}`);
      if (alarm && alarm.scheduledTime > now) continue; // alarm rescheduled future
      await logEvent('recover', 'firing_missed', {
        jobId: j.id, fireAt: j.fireAt, lateBySec: Math.floor((now - j.fireAt) / 1000)
      });
      await fireStoryJob(j.id);
      recovered++;
    }
    if (recovered > 0) {
      await logEvent('recover', 'completed', { recovered });
    }
  } catch (e) {
    await logEvent('recover', 'error', { err: e.message });
  }
}

// ───────── Heartbeat: fires every 1 minute to wake SW and scan for due jobs.
// This is the canonical MV3 pattern — single-shot `when:` alarms are unreliable
// because Chrome aggressively terminates idle SWs and macOS sleep/App Nap can
// drop scheduled wake-ups entirely.
const HEARTBEAT_NAME = 'vp_heartbeat';
async function ensureHeartbeat() {
  const existing = await chrome.alarms.get(HEARTBEAT_NAME);
  if (!existing) {
    await chrome.alarms.create(HEARTBEAT_NAME, {
      delayInMinutes: 1,
      periodInMinutes: 1
    });
    await logEvent('heartbeat', 'created');
  }
}

// ───────── Alarm handler — story_ alarms fire at scheduled time;
// vp_heartbeat fires every minute to catch anything missed.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === HEARTBEAT_NAME) {
    await recoverMissedJobs();
    return;
  }
  if (alarm.name.startsWith('story_')) {
    const jobId = alarm.name.slice('story_'.length);
    await logEvent('alarm', 'fired', {
      jobId, scheduledTime: alarm.scheduledTime,
      lateMs: Date.now() - alarm.scheduledTime
    });
    await fireStoryJob(jobId);
    // Also run a sweep — catches any other due jobs whose alarms were dropped.
    await recoverMissedJobs();
  }
});

// Set up heartbeat + run recovery on all SW lifecycle events.
chrome.runtime.onStartup.addListener(async () => {
  await ensureHeartbeat();
  await recoverMissedJobs();
});
chrome.runtime.onInstalled.addListener(async () => {
  await ensureHeartbeat();
  await recoverMissedJobs();
});
// Top-level: runs on every SW boot (alarm wake, message wake, etc.)
ensureHeartbeat();
recoverMissedJobs();

function deriveApiBase(sender) {
  try {
    if (sender && sender.url) return new URL(sender.url).origin;
  } catch (_) {}
  return null;
}

async function refreshYtAccessToken(apiBase) {
  const data = await chrome.storage.local.get([
    'yt_refresh_token', 'yt_access_token', 'yt_access_expires',
    'yt_client_id', 'yt_client_secret'
  ]);
  if (!data.yt_refresh_token) {
    return { ok: false, error: 'not_connected' };
  }
  const now = Date.now();
  if (data.yt_access_token && data.yt_access_expires && now < data.yt_access_expires - 60000) {
    return { ok: true, accessToken: data.yt_access_token, cached: true };
  }

  let newAccess, expiresIn;

  // If user pasted their own creds, refresh directly with Google.
  if (data.yt_client_id && data.yt_client_secret) {
    const body = new URLSearchParams({
      client_id: data.yt_client_id,
      client_secret: data.yt_client_secret,
      refresh_token: data.yt_refresh_token,
      grant_type: 'refresh_token'
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    let d; try { d = await r.json(); } catch (_) { d = {}; }
    if (!r.ok || d.error) {
      return { ok: false, error: d.error_description || d.error || `HTTP ${r.status}` };
    }
    newAccess = d.access_token;
    expiresIn = d.expires_in || 3600;
  } else {
    // Fallback: server-side refresh (uses app's default secret on Vercel)
    if (!apiBase) return { ok: false, error: 'no_api_base' };
    const r = await fetch(`${apiBase}/api/yt-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: data.yt_refresh_token })
    });
    let d; try { d = await r.json(); } catch (_) { d = {}; }
    if (!r.ok || d.error) {
      return { ok: false, error: d.error || `HTTP ${r.status}` };
    }
    newAccess = d.access_token;
    expiresIn = d.expires_in || 3600;
  }

  await chrome.storage.local.set({
    yt_access_token: newAccess,
    yt_access_expires: now + expiresIn * 1000
  });
  return { ok: true, accessToken: newAccess, cached: false };
}

// Exchange authorization code → tokens using user-pasted creds.
async function exchangeYtCode(code, redirectUri) {
  const data = await chrome.storage.local.get(['yt_client_id', 'yt_client_secret']);
  if (!data.yt_client_id || !data.yt_client_secret) {
    return { ok: false, error: 'no_creds_saved' };
  }
  const body = new URLSearchParams({
    code,
    client_id: data.yt_client_id,
    client_secret: data.yt_client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  let d; try { d = await r.json(); } catch (_) { d = {}; }
  if (!r.ok || d.error) {
    return { ok: false, error: d.error_description || d.error || `HTTP ${r.status}` };
  }
  // Fetch channel info with the new access token (best-effort).
  let channel = null;
  try {
    const chR = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${d.access_token}` } }
    );
    const chD = await chR.json();
    if (chD.items && chD.items[0]) {
      channel = { id: chD.items[0].id, title: chD.items[0].snippet && chD.items[0].snippet.title };
    }
  } catch (_) {}
  return {
    ok: true,
    accessToken: d.access_token,
    refreshToken: d.refresh_token || null,
    expiresIn: d.expires_in || 3600,
    channel
  };
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

        case 'YT_EXCHANGE_CODE': {
          const out = await exchangeYtCode(req.code, req.redirectUri);
          sendResponse(out);
          break;
        }

        case 'SAVE_YT_CREDS': {
          await chrome.storage.local.set({
            yt_client_id: req.clientId || null,
            yt_client_secret: req.clientSecret || null
          });
          // Invalidate cached access token so next request refreshes with new creds.
          await chrome.storage.local.remove(['yt_access_token', 'yt_access_expires']);
          sendResponse({ ok: true });
          break;
        }

        case 'GET_YT_CREDS': {
          const d = await chrome.storage.local.get(['yt_client_id', 'yt_client_secret']);
          sendResponse({
            ok: true,
            hasCreds: !!(d.yt_client_id && d.yt_client_secret),
            clientId: d.yt_client_id || null
            // never return secret to the page
          });
          break;
        }

        case 'CLEAR_YT_CREDS': {
          await chrome.storage.local.remove([
            'yt_client_id', 'yt_client_secret',
            'yt_access_token', 'yt_access_expires'
          ]);
          sendResponse({ ok: true });
          break;
        }

        case 'ADD_JOB': {
          const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
          cur.push(req.job);
          await chrome.storage.local.set({ scheduled_jobs: cur });
          broadcastStateChanged();
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
          broadcastStateChanged();
          sendResponse({ ok: true });
          break;
        }

        // ─── Chunked file transfer (chrome.runtime.sendMessage caps at 64MB)
        case 'STORY_BLOB_INIT': {
          const { sessionId, mimeType, totalSize, totalChunks } = req;
          if (!sessionId) { sendResponse({ ok: false, error: 'missing_sessionId' }); break; }
          await idbPut(`session_${sessionId}`, {
            mimeType: mimeType || 'video/mp4',
            totalSize: totalSize || 0,
            totalChunks: totalChunks || 0,
            received: 0,
            createdAt: Date.now(),
          });
          sendResponse({ ok: true });
          break;
        }

        case 'STORY_BLOB_CHUNK': {
          const { sessionId, index, data } = req;
          const sess = await idbGet(`session_${sessionId}`);
          if (!sess) { sendResponse({ ok: false, error: 'no_session' }); break; }
          const arr = base64ToUint8Array(data);
          await idbPut(`chunk_${sessionId}_${index}`, arr);
          sess.received = (sess.received || 0) + 1;
          await idbPut(`session_${sessionId}`, sess);
          sendResponse({ ok: true, received: sess.received, total: sess.totalChunks });
          break;
        }

        case 'STORY_BLOB_FINISH': {
          const { sessionId } = req;
          const sess = await idbGet(`session_${sessionId}`);
          if (!sess) { sendResponse({ ok: false, error: 'no_session' }); break; }
          const parts = [];
          for (let i = 0; i < sess.totalChunks; i++) {
            const c = await idbGet(`chunk_${sessionId}_${i}`);
            if (!c) { sendResponse({ ok: false, error: `missing_chunk_${i}` }); return; }
            parts.push(c);
          }
          const blob = new Blob(parts, { type: sess.mimeType });
          // cleanup chunks + session
          for (let i = 0; i < sess.totalChunks; i++) await idbDel(`chunk_${sessionId}_${i}`);
          await idbDel(`session_${sessionId}`);
          // stash blob for SCHEDULE_STORY
          await idbPut(`pending_${sessionId}`, blob);
          sendResponse({ ok: true, size: blob.size });
          break;
        }

        case 'SCHEDULE_STORY': {
          const { jobId, pages, sessionId, dataURL, fileName, fireAt } = req;
          if (!jobId || !pages || !fireAt) {
            sendResponse({ ok: false, error: 'missing_fields' });
            break;
          }
          if (fireAt - Date.now() < 30000) {
            sendResponse({ ok: false, error: 'fireAt must be at least 30s in the future' });
            break;
          }
          let blob;
          if (sessionId) {
            // Pull pre-uploaded blob from IDB (chunked path)
            blob = await idbGet(`pending_${sessionId}`);
            if (!blob) { sendResponse({ ok: false, error: 'no_pending_blob' }); break; }
            await idbDel(`pending_${sessionId}`);
          } else if (dataURL) {
            // Legacy single-message path (only works if file < ~48MB)
            blob = dataURLtoBlob(dataURL);
          } else {
            sendResponse({ ok: false, error: 'no_blob_source' });
            break;
          }
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
          // Wipe scheduled_jobs array, all story_ alarms, and ALL story_ blobs
          // (including orphans from previous incomplete clears).
          const cur = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
          await chrome.storage.local.set({ scheduled_jobs: [] });
          // Clear per-job alarms
          for (const j of cur) {
            try { await chrome.alarms.clear(`story_${j.id}`); } catch (_) {}
          }
          // Sweep ALL story_ keys from IDB (catches orphans too)
          let cleared = 0;
          try {
            const db = await openIdb();
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const keys = await new Promise((resolve, reject) => {
              const r = store.getAllKeys();
              r.onsuccess = () => resolve(r.result || []);
              r.onerror = () => reject(r.error);
            });
            for (const k of keys) {
              if (typeof k === 'string' && k.startsWith('story_')) {
                store.delete(k);
                cleared++;
              }
            }
          } catch (e) {
            await logEvent('clear_jobs', 'idb_error', { err: e.message });
          }
          await logEvent('clear_jobs', 'done', { jobsCleared: cur.length, blobsCleared: cleared });
          broadcastStateChanged();
          sendResponse({ ok: true, jobsCleared: cur.length, blobsCleared: cleared });
          break;
        }

        case 'CLEAN_ORPHAN_BLOBS': {
          // Delete IDB story_ blobs whose jobId is no longer in scheduled_jobs.
          const jobs = (await chrome.storage.local.get('scheduled_jobs')).scheduled_jobs || [];
          const validIds = new Set(jobs.map(j => `story_${j.id}`));
          let cleared = 0;
          try {
            const db = await openIdb();
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const keys = await new Promise((resolve, reject) => {
              const r = store.getAllKeys();
              r.onsuccess = () => resolve(r.result || []);
              r.onerror = () => reject(r.error);
            });
            for (const k of keys) {
              if (typeof k === 'string' && k.startsWith('story_') && !validIds.has(k)) {
                store.delete(k);
                cleared++;
              }
            }
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
            break;
          }
          await logEvent('clean_orphans', 'done', { cleared });
          sendResponse({ ok: true, cleared });
          break;
        }

        case 'DEBUG_DUMP': {
          const alarms = await chrome.alarms.getAll();
          const data = await chrome.storage.local.get(['scheduled_jobs', 'vp_event_log']);
          // List IDB story_ keys
          let idbKeys = [];
          try {
            const db = await openIdb();
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            idbKeys = await new Promise((resolve, reject) => {
              const req = store.getAllKeys();
              req.onsuccess = () => resolve(req.result || []);
              req.onerror = () => reject(req.error);
            });
          } catch (_) {}
          sendResponse({
            ok: true,
            now: Date.now(),
            alarms: alarms.map(a => ({
              name: a.name,
              scheduledTime: a.scheduledTime,
              minsFromNow: Math.round((a.scheduledTime - Date.now()) / 60000)
            })),
            jobCount: (data.scheduled_jobs || []).length,
            idbKeys,
            eventLog: data.vp_event_log || []
          });
          break;
        }

        case 'RETRY_STORY_JOB': {
          // Manually re-fire a story job (uses IDB blob if still present).
          const out = await fireStoryJob(req.jobId);
          sendResponse(out);
          break;
        }

        case 'RECOVER_NOW': {
          await recoverMissedJobs();
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_EVENT_LOG': {
          await chrome.storage.local.set({ vp_event_log: [] });
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
