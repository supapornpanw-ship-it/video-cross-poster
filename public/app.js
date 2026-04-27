// Video Cross-Poster — web app logic.
// Talks to the extension via window.postMessage (content.js bridge).
// Performs FB OAuth + YT OAuth, then uploads video files directly from the
// browser to graph-video.facebook.com and googleapis.com (resumable).

(() => {
  // ───────── State
  const state = {
    extReady: false,
    fb: { token: null, expires: null, user: null, pages: [] },
    yt: { connected: false, channel: null, email: null },
    selectedFile: null,
    uploading: false,
  };

  // ───────── Utility
  const $ = (id) => document.getElementById(id);
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtSize = (b) => {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };
  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const uid = () => 'j_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('file_read_failed'));
      r.readAsDataURL(file);
    });
  }

  // ArrayBuffer → base64 (handles large buffers in slices to avoid call-stack limit).
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const SUB = 0x8000;
    for (let i = 0; i < bytes.length; i += SUB) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SUB));
    }
    return btoa(binary);
  }

  // Send a File/Blob to the extension in 16MB chunks (sendMessage caps at 64MB).
  // Returns { sessionId, size } once finished. onProgress(0..1) optional.
  async function uploadBlobToExtensionChunked(file, onProgress) {
    const CHUNK_RAW = 16 * 1024 * 1024; // 16MB raw → ~21MB base64 (well under 64MB)
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_RAW));
    const sessionId = uid();

    let r = await sendExt({
      type: 'STORY_BLOB_INIT',
      sessionId,
      mimeType: file.type || 'video/mp4',
      totalSize: file.size,
      totalChunks,
    }, 30000);
    if (!r || !r.ok) throw new Error('init_fail: ' + (r && r.error));

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_RAW;
      const end = Math.min(start + CHUNK_RAW, file.size);
      const buf = await file.slice(start, end).arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      r = await sendExt({
        type: 'STORY_BLOB_CHUNK',
        sessionId,
        index: i,
        data: b64,
      }, 90000);
      if (!r || !r.ok) throw new Error(`chunk ${i + 1}/${totalChunks} fail: ` + (r && r.error));
      if (typeof onProgress === 'function') onProgress((i + 1) / totalChunks);
    }

    r = await sendExt({ type: 'STORY_BLOB_FINISH', sessionId }, 30000);
    if (!r || !r.ok) throw new Error('finish_fail: ' + (r && r.error));
    return { sessionId, size: r.size };
  }

  // ───────── Extension bridge
  const pending = new Map();
  let extReadyResolve;
  const extReadyPromise = new Promise(r => { extReadyResolve = r; });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'vp-ext') return;
    if (d.type === 'READY') {
      state.extReady = true;
      updateExtState();
      extReadyResolve();
      return;
    }
    if (d.reqId && pending.has(d.reqId)) {
      const { resolve } = pending.get(d.reqId);
      pending.delete(d.reqId);
      if (d.lastError) resolve({ ok: false, error: d.lastError });
      else resolve(d.response || { ok: false, error: 'no_response' });
    }
  });

  function sendExt(payload, timeoutMs = 30000) {
    // Always try sending; if no response within timeout, treat as not-loaded.
    // We can't rely on the READY message because content.js runs at
    // document_start and may post READY before app.js's listener attaches.
    return new Promise((resolve) => {
      const reqId = uid();
      pending.set(reqId, {
        resolve: (v) => {
          // Any response = extension is loaded.
          if (!state.extReady) {
            state.extReady = true;
            updateExtState();
          }
          resolve(v);
        }
      });
      window.postMessage({ source: 'vp-web', reqId, payload }, '*');
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          resolve({ ok: false, error: 'extension_not_loaded' });
        }
      }, timeoutMs);
    });
  }

  // Periodic ping to detect when extension loads (in case it loads after page).
  async function pingExtensionLoop() {
    while (!state.extReady) {
      await sleep(1500);
      if (state.extReady) break;
      const r = await new Promise((resolve) => {
        const reqId = uid();
        pending.set(reqId, { resolve });
        window.postMessage({ source: 'vp-web', reqId, payload: { type: 'PING' } }, '*');
        setTimeout(() => {
          if (pending.has(reqId)) { pending.delete(reqId); resolve({ ok: false }); }
        }, 1200);
      });
      if (r && r.ok) {
        state.extReady = true;
        updateExtState();
        break;
      }
    }
  }

  function updateExtState() {
    const el = $('extState');
    if (state.extReady) {
      el.className = 'ext-state ext-state--ok';
      el.textContent = 'Extension: เชื่อมต่อแล้ว';
    } else {
      el.className = 'ext-state ext-state--off';
      el.textContent = 'Extension: ยังไม่ได้โหลด';
    }
  }

  // ───────── FB OAuth (user-triggered popup → /api/fb-callback → redirect with hash)
  // The callback redirects back to "/" with #fb_token=...&fb_expires=...
  // We parse on load.
  function readFbHash() {
    if (!location.hash) return null;
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has('fb_token')) return null;
    const token = params.get('fb_token');
    const expires = parseInt(params.get('fb_expires') || '0', 10);
    history.replaceState(null, '', location.pathname + location.search);
    return { token, expires };
  }

  async function fbConnect() {
    const FB_APP_ID = window.__FB_APP_ID || '721475520495705';
    const redirect = encodeURIComponent(location.origin + '/api/fb-callback');
    const scopes = encodeURIComponent('pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content');
    const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${redirect}&scope=${scopes}&response_type=code`;
    location.href = url; // full-page redirect (more reliable than popup)
  }

  async function fbFetchUserAndPages(token) {
    // /me, /me/permissions, /me/accounts
    const meR = await fetch(`https://graph.facebook.com/v20.0/me?access_token=${encodeURIComponent(token)}`);
    const me = await meR.json();
    if (me.error) throw new Error(me.error.message);

    // Check granted permissions
    const permR = await fetch(`https://graph.facebook.com/v20.0/me/permissions?access_token=${encodeURIComponent(token)}`);
    const permD = await permR.json();
    const granted = new Set();
    const declined = new Set();
    if (Array.isArray(permD.data)) {
      for (const p of permD.data) {
        if (p.status === 'granted') granted.add(p.permission);
        else declined.add(p.permission);
      }
    }
    console.log('[FB perms] granted:', [...granted], 'declined/missing:', [...declined]);
    const required = ['pages_show_list', 'pages_manage_posts'];
    const missing = required.filter(p => !granted.has(p));

    let pages = [];
    let next = `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,category&limit=100&access_token=${encodeURIComponent(token)}`;
    while (next) {
      const r = await fetch(next);
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      if (Array.isArray(d.data)) {
        pages = pages.concat(d.data.map(p => ({
          id: p.id, name: p.name, pageToken: p.access_token, category: p.category || null
        })));
      }
      next = (d.paging && d.paging.next) || null;
    }

    if (pages.length === 0 && missing.length > 0) {
      throw new Error(
        `FB App ขาดสิทธิ์: ${missing.join(', ')} — ` +
        `ตอน OAuth dialog ต้องติ๊กให้ครบ หรือเพิ่มตัวเองใน App Roles แล้วเปลี่ยน App เป็น Development mode`
      );
    }
    return { user: { id: me.id, name: me.name }, pages };
  }

  async function fbManualConnect() {
    const tokenRaw = $('fbManualToken').value.trim();
    if (!tokenRaw) return alert('กรุณาวาง User Access Token');
    // Strip any leading "Bearer " or whitespace
    const token = tokenRaw.replace(/^Bearer\s+/i, '').trim();
    const btn = $('fbManualSubmit');
    btn.disabled = true;
    btn.textContent = 'กำลังตรวจ token...';
    try {
      const { user, pages } = await fbFetchUserAndPages(token);
      // Try to find token expiry via debug_token (best effort).
      let expiresIn = null;
      try {
        const dtR = await fetch(
          `https://graph.facebook.com/v20.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
        );
        const dtD = await dtR.json();
        if (dtD.data && dtD.data.expires_at) {
          const left = dtD.data.expires_at - Math.floor(Date.now() / 1000);
          if (left > 0) expiresIn = left;
        }
      } catch (_) {}

      await sendExt({
        type: 'SAVE_FB',
        token,
        expires: expiresIn,
        user, pages,
      });
      state.fb = { token, expires: expiresIn, user, pages };
      $('fbManualToken').value = '';
      $('fbManualBox').hidden = true;
      renderConnections();
      renderPageList();
      alert(`เชื่อมต่อสำเร็จ — โหลด ${pages.length} เพจ`);
    } catch (err) {
      alert('Token ใช้ไม่ได้: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'ใช้ token นี้';
    }
  }

  async function fbAddPageManual() {
    const pageId = $('fbPageIdInput').value.trim();
    const pageNameRaw = $('fbPageNameInput').value.trim();
    const pageTokenRaw = $('fbPageTokenInput').value.trim();
    if (!pageId || !pageTokenRaw) {
      return alert('ต้องใส่ทั้ง Page ID และ Page Token');
    }
    const pageToken = pageTokenRaw.replace(/^Bearer\s+/i, '').trim();

    const btn = $('fbAddPageBtn');
    btn.disabled = true;
    btn.textContent = 'กำลังตรวจ...';
    try {
      // Verify by calling /{page_id}?fields=id,name with page token
      const r = await fetch(
        `https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}?fields=id,name,category&access_token=${encodeURIComponent(pageToken)}`
      );
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      if (!d.id) throw new Error('ไม่พบ page id ที่ตรงกัน');

      const name = pageNameRaw || d.name || `Page ${pageId}`;
      const category = d.category || null;

      // Append (or replace if exists) into state.fb.pages
      const existing = state.fb.pages.filter(p => p.id !== d.id);
      const newPages = [...existing, { id: d.id, name, pageToken, category }];

      // Make sure SAVE_FB has a "user" + dummy "token" so connection counts as connected.
      const fbToken = state.fb.token || '__manual__';
      await sendExt({
        type: 'SAVE_FB',
        token: fbToken,
        expires: state.fb.expires || null,
        user: state.fb.user || { id: 'manual', name: 'Manual paste' },
        pages: newPages,
      });
      state.fb = { token: fbToken, expires: state.fb.expires, user: state.fb.user || { id: 'manual', name: 'Manual paste' }, pages: newPages };

      $('fbPageIdInput').value = '';
      $('fbPageNameInput').value = '';
      $('fbPageTokenInput').value = '';
      renderConnections();
      renderPageList();
      alert(`เพิ่มเพจ "${name}" สำเร็จ — ตอนนี้มี ${newPages.length} เพจ`);
    } catch (err) {
      alert('เพิ่มเพจไม่สำเร็จ: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '+ เพิ่มเพจ';
    }
  }

  async function fbDisconnect() {
    if (!confirm('ยกเลิกการเชื่อมต่อ Facebook?')) return;
    await sendExt({ type: 'CLEAR_FB' });
    state.fb = { token: null, expires: null, user: null, pages: [] };
    renderConnections();
    renderPageList();
  }

  // ───────── YouTube OAuth (popup → window.opener.postMessage)
  // If user pasted own creds → use static /yt-callback.html and exchange in extension.
  // Otherwise → use shared app creds via /api/yt-callback.
  async function ytConnect() {
    const credsR = await sendExt({ type: 'GET_YT_CREDS' });
    const useOwn = credsR && credsR.ok && credsR.hasCreds;

    let clientId, redirectUri;
    if (useOwn) {
      clientId = credsR.clientId;
      redirectUri = location.origin + '/yt-callback.html';
    } else {
      clientId = window.__GOOGLE_CLIENT_ID;
      if (!clientId) {
        alert('ยังไม่ได้ตั้งค่า Client ID — กดปุ่ม "ใช้ Client ID ของฉัน" เพื่อใส่ creds ของตัวเอง');
        return;
      }
      redirectUri = location.origin + '/api/yt-callback';
    }

    const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    const url =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&include_granted_scopes=true`;
    const w = 520, h = 640;
    const left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    window.open(url, 'yt-oauth', `width=${w},height=${h},left=${left},top=${top}`);
  }

  async function ytDisconnect() {
    if (!confirm('ยกเลิกการเชื่อมต่อ YouTube?')) return;
    await sendExt({ type: 'CLEAR_YT' });
    state.yt = { connected: false, channel: null, email: null };
    renderConnections();
  }

  // Handle the SHARED-creds callback (server-side exchange via /api/yt-callback)
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== 'vp-yt-oauth') return;
    const p = e.data.payload || {};
    if (!p.ok) {
      alert('YouTube auth failed: ' + (p.error || 'unknown'));
      return;
    }
    if (!p.refreshToken) {
      alert('YouTube ไม่ได้ส่ง refresh_token — ลอง revoke แอปใน https://myaccount.google.com/permissions แล้วเชื่อมใหม่');
      return;
    }
    const r = await sendExt({
      type: 'SAVE_YT',
      refreshToken: p.refreshToken,
      accessToken: p.accessToken,
      accessTokenExpires: Date.now() + (p.expiresIn || 3600) * 1000,
      channel: p.channel || null,
    });
    if (!r.ok) {
      alert('บันทึก token ไม่สำเร็จ: ' + (r.error || ''));
      return;
    }
    state.yt = { connected: true, channel: p.channel, email: null };
    renderConnections();
  });

  // Handle the OWN-creds callback (static /yt-callback.html → exchange in extension).
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== 'vp-yt-oauth-code') return;
    const { code, error, errorDescription } = e.data;
    if (error) {
      alert('YouTube auth failed: ' + (errorDescription || error));
      return;
    }
    if (!code) return;
    const redirectUri = location.origin + '/yt-callback.html';
    const ex = await sendExt({ type: 'YT_EXCHANGE_CODE', code, redirectUri }, 30000);
    if (!ex || !ex.ok) {
      alert('แลก code → token ไม่สำเร็จ: ' + ((ex && ex.error) || 'unknown'));
      return;
    }
    if (!ex.refreshToken) {
      alert('YouTube ไม่ได้ส่ง refresh_token — revoke แอปที่ https://myaccount.google.com/permissions แล้วลองใหม่');
      return;
    }
    const sr = await sendExt({
      type: 'SAVE_YT',
      refreshToken: ex.refreshToken,
      accessToken: ex.accessToken,
      accessTokenExpires: Date.now() + (ex.expiresIn || 3600) * 1000,
      channel: ex.channel || null,
    });
    if (!sr.ok) {
      alert('บันทึก token ไม่สำเร็จ: ' + (sr.error || ''));
      return;
    }
    state.yt = { connected: true, channel: ex.channel, email: null };
    renderConnections();
    alert('✅ เชื่อมต่อ YouTube สำเร็จ (ใช้ creds ของคุณเอง)');
  });

  // ───────── Render: connections
  function renderConnections() {
    if (state.fb.token) {
      const u = state.fb.user;
      $('fbDetail').className = 'conn-detail conn-detail--ok';
      $('fbDetail').textContent =
        `${u ? u.name : '(unknown)'} · ${state.fb.pages.length} เพจ` +
        (state.fb.expires ? ` · token หมดอายุ ${fmtTime(Date.now() + state.fb.expires * 1000)}` : '');
      $('fbConnect').textContent = 'เชื่อมใหม่';
      $('fbDisconnect').hidden = false;
    } else {
      $('fbDetail').className = 'conn-detail';
      $('fbDetail').textContent = 'ยังไม่ได้เชื่อมต่อ';
      $('fbConnect').textContent = 'เชื่อมต่อ Facebook';
      $('fbDisconnect').hidden = true;
    }

    if (state.yt.connected) {
      const ch = state.yt.channel;
      $('ytDetail').className = 'conn-detail conn-detail--ok';
      $('ytDetail').textContent = ch ? `Channel: ${ch.title}` : 'เชื่อมต่อแล้ว';
      $('ytConnect').textContent = 'เชื่อมใหม่';
      $('ytDisconnect').hidden = false;
    } else {
      $('ytDetail').className = 'conn-detail';
      $('ytDetail').textContent = 'ยังไม่ได้เชื่อมต่อ';
      $('ytConnect').textContent = 'เชื่อมต่อ YouTube';
      $('ytDisconnect').hidden = true;
    }
  }

  // ───────── Render: page list
  function renderPageList() {
    const wrap = $('pageList');
    const acts = $('pageListActions');
    if (!state.fb.pages.length) {
      wrap.innerHTML = '<div class="muted-sm">เชื่อมต่อ Facebook ก่อนเพื่อดูรายการเพจ</div>';
      acts.hidden = true;
      return;
    }
    wrap.innerHTML = state.fb.pages.map(p => `
      <label class="page-row">
        <input type="checkbox" data-pid="${escHtml(p.id)}" checked />
        <span class="page-name">${escHtml(p.name)}</span>
        <span class="page-id">${escHtml(p.category || '')}</span>
      </label>
    `).join('');
    acts.hidden = false;
  }

  function selectedPages() {
    const checks = document.querySelectorAll('#pageList input[type="checkbox"]');
    const ids = new Set();
    checks.forEach(c => { if (c.checked) ids.add(c.dataset.pid); });
    return state.fb.pages.filter(p => ids.has(p.id));
  }

  // ───────── File handling
  function setFile(file) {
    if (!file) {
      state.selectedFile = null;
      $('fileZoneEmpty').hidden = false;
      $('fileZoneFilled').hidden = true;
      return;
    }
    if (!file.type.startsWith('video/')) {
      alert('กรุณาเลือกไฟล์วิดีโอ');
      return;
    }
    state.selectedFile = file;
    $('fileZoneEmpty').hidden = true;
    $('fileZoneFilled').hidden = false;
    $('fileName').textContent = file.name;
    $('fileSize').textContent = fmtSize(file.size);
    if (!$('ytTitle').value) {
      $('ytTitle').value = file.name.replace(/\.[^.]+$/, '');
    }
  }

  // ───────── Schedule helpers
  function getScheduleTimestamp() {
    if (!$('schedEnable').checked) return null;
    const v = $('schedTime').value;
    if (!v) return null;
    const ts = new Date(v).getTime();
    if (isNaN(ts)) return null;
    return ts; // ms
  }

  // ───────── Progress UI
  function progressInit(items) {
    const box = $('progressBox');
    const list = $('progressList');
    box.hidden = false;
    list.innerHTML = items.map((it, i) => `
      <div class="progress-row pending" id="prog_${i}">
        <div>${escHtml(it.label)}</div>
        <div class="progress-status">รอคิว...</div>
      </div>
    `).join('');
  }
  function progressUpdate(i, status, cls) {
    const row = $(`prog_${i}`);
    if (!row) return;
    row.className = 'progress-row ' + (cls || 'pending');
    row.querySelector('.progress-status').className = 'progress-status ' + (cls || '');
    row.querySelector('.progress-status').textContent = status;
  }

  // ───────── FB upload
  async function uploadToFacebook(page, file, caption, scheduledTs) {
    const url = `https://graph-video.facebook.com/v20.0/${encodeURIComponent(page.id)}/videos`;
    const fd = new FormData();
    fd.append('access_token', page.pageToken);
    fd.append('source', file, file.name);
    if (caption) fd.append('description', caption);
    if (scheduledTs) {
      fd.append('published', 'false');
      fd.append('scheduled_publish_time', String(Math.floor(scheduledTs / 1000)));
    }
    const r = await fetch(url, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      throw new Error((d.error && d.error.message) || `HTTP ${r.status}`);
    }
    return { id: d.id, postId: d.post_id || null };
  }

  // ───────── FB Story upload (3-phase: start → upload binary → finish)
  // Stories require: vertical 9:16, ≤ 90s, MP4/MOV. No native scheduling.
  async function uploadStoryToFacebook(page, file) {
    const base = `https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/video_stories`;
    const tokParam = `access_token=${encodeURIComponent(page.pageToken)}`;

    // Phase 1: start
    const startR = await fetch(`${base}?upload_phase=start&${tokParam}`, { method: 'POST' });
    const startD = await startR.json().catch(() => ({}));
    if (!startR.ok || startD.error) {
      throw new Error('story_start: ' + ((startD.error && startD.error.message) || `HTTP ${startR.status}`));
    }
    const { video_id, upload_url } = startD;
    if (!video_id || !upload_url) throw new Error('story_start: missing video_id/upload_url');

    // Phase 2: upload binary to FB rupload endpoint
    const upR = await fetch(upload_url, {
      method: 'POST',
      headers: {
        'Authorization': `OAuth ${page.pageToken}`,
        'offset': '0',
        'file_size': String(file.size),
      },
      body: file
    });
    const upD = await upR.json().catch(() => ({}));
    if (!upR.ok || upD.error || upD.success !== true) {
      throw new Error('story_upload: ' + ((upD.error && upD.error.message) || JSON.stringify(upD).slice(0, 200)));
    }

    // Phase 3: finish (publish)
    const finR = await fetch(
      `${base}?upload_phase=finish&video_id=${encodeURIComponent(video_id)}&video_state=PUBLISHED&${tokParam}`,
      { method: 'POST' }
    );
    const finD = await finR.json().catch(() => ({}));
    if (!finR.ok || finD.error) {
      throw new Error('story_finish: ' + ((finD.error && finD.error.message) || `HTTP ${finR.status}`));
    }
    return { id: video_id, postId: finD.post_id || null };
  }

  // ───────── YouTube resumable upload
  async function uploadToYoutube(file, meta, scheduledTs) {
    // Step 1: get fresh access token via background
    const tokR = await sendExt({ type: 'YT_GET_ACCESS_TOKEN' }, 30000);
    if (!tokR.ok) throw new Error('yt_token: ' + (tokR.error || ''));
    const accessToken = tokR.accessToken;

    // Step 2: initiate resumable session
    const status = { privacyStatus: meta.privacy || 'private' };
    if (scheduledTs) {
      // YouTube schedule: privacyStatus must be 'private', publishAt = ISO 8601 UTC.
      status.privacyStatus = 'private';
      status.publishAt = new Date(scheduledTs).toISOString();
    }
    const body = {
      snippet: {
        title: meta.title || file.name,
        description: meta.description || '',
        categoryId: meta.categoryId || '22'
      },
      status
    };
    const initR = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': file.type || 'video/*',
          'X-Upload-Content-Length': String(file.size),
        },
        body: JSON.stringify(body)
      }
    );
    if (!initR.ok) {
      const errText = await initR.text().catch(() => '');
      throw new Error(`yt_init HTTP ${initR.status}: ${errText.slice(0, 200)}`);
    }
    const uploadUrl = initR.headers.get('Location') || initR.headers.get('location');
    if (!uploadUrl) throw new Error('yt_init: missing Location header');

    // Step 3: PUT the binary
    const putR = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'video/*',
      },
      body: file
    });
    if (!putR.ok) {
      const errText = await putR.text().catch(() => '');
      throw new Error(`yt_put HTTP ${putR.status}: ${errText.slice(0, 200)}`);
    }
    const ytData = await putR.json().catch(() => ({}));
    return { id: ytData.id || null, raw: ytData };
  }

  // ───────── Submit
  async function postClip() {
    if (state.uploading) return;
    if (!state.selectedFile) return alert('กรุณาเลือกไฟล์วิดีโอ');
    const pages = selectedPages();
    const ytEnable = $('ytEnable').checked;
    if (!pages.length && !ytEnable) return alert('ต้องเลือก FB อย่างน้อย 1 เพจ หรือเปิด YouTube');

    const caption = $('captionInput').value.trim();
    const ytTitle = $('ytTitle').value.trim();
    const ytDesc = $('ytDescription').value.trim();
    const ytPrivacy = $('ytPrivacy').value;
    const storyEnable = $('storyEnable').checked && pages.length > 0;

    if (ytEnable && !ytTitle) return alert('YouTube ต้องการ Title');

    const scheduledTs = getScheduleTimestamp();
    if (scheduledTs) {
      const minMs = 10 * 60 * 1000;
      if (scheduledTs - Date.now() < minMs) {
        return alert('เวลาที่ตั้งต้องห่างจากปัจจุบันอย่างน้อย 10 นาที');
      }
    }

    state.uploading = true;
    $('postBtn').disabled = true;

    // When scheduled + story enabled, group all stories into ONE scheduled item
    // (background uploads them all when alarm fires, sharing the stored blob).
    const items = [
      ...pages.map(p => ({ label: `Facebook Feed · ${p.name}`, kind: 'fb', page: p })),
      ...(storyEnable && !scheduledTs ? pages.map(p => ({ label: `Facebook Story · ${p.name}`, kind: 'story', page: p })) : []),
      ...(storyEnable && scheduledTs ? [{ label: `Facebook Story (ตั้งเวลา) · ${pages.length} เพจ`, kind: 'story_sched', pages }] : []),
      ...(ytEnable ? [{ label: `YouTube · ${state.yt.channel ? state.yt.channel.title : 'channel'}`, kind: 'yt' }] : [])
    ];
    progressInit(items);

    const jobId = uid();
    const results = [];

    // Run uploads in parallel (browser handles concurrency).
    await Promise.all(items.map(async (it, i) => {
      try {
        progressUpdate(i, 'กำลังอัปโหลด...', 'pending');
        if (it.kind === 'fb') {
          const out = await uploadToFacebook(it.page, state.selectedFile, caption, scheduledTs);
          progressUpdate(i, scheduledTs ? `ตั้งเวลาแล้ว · id ${out.id}` : `สำเร็จ · id ${out.id}`, 'success');
          results.push({ kind: 'fb', pageId: it.page.id, pageName: it.page.name, ok: true, id: out.id });
        } else if (it.kind === 'story') {
          // Immediate (no schedule)
          const out = await uploadStoryToFacebook(it.page, state.selectedFile);
          progressUpdate(i, `สำเร็จ · story id ${out.id}`, 'success');
          results.push({ kind: 'story', pageId: it.page.id, pageName: it.page.name, ok: true, id: out.id });
        } else if (it.kind === 'story_sched') {
          // Chunked transfer: split file into 16MB pieces, send each as a
          // separate message, then schedule the alarm.
          try {
            const upload = await uploadBlobToExtensionChunked(state.selectedFile, (frac) => {
              progressUpdate(i, `กำลังส่งไฟล์ให้ extension... ${Math.round(frac * 100)}%`, 'pending');
            });
            const r = await sendExt({
              type: 'SCHEDULE_STORY',
              jobId,
              pages: it.pages.map(p => ({ id: p.id, name: p.name, pageToken: p.pageToken })),
              sessionId: upload.sessionId,
              fileName: state.selectedFile.name,
              fireAt: scheduledTs,
            }, 30000);
            if (!r || !r.ok) {
              progressUpdate(i, 'ตั้งเวลาไม่สำเร็จ: ' + ((r && r.error) || 'unknown'), 'error');
              results.push({ kind: 'story_sched', ok: false, error: (r && r.error) || 'unknown' });
            } else {
              progressUpdate(i, `ตั้งเวลาแล้ว · ยิงเวลา ${fmtTime(scheduledTs)}`, 'success');
              results.push({ kind: 'story_sched', ok: true, scheduledFor: scheduledTs, pageCount: it.pages.length });
            }
          } catch (err) {
            progressUpdate(i, 'ส่งไฟล์ให้ extension ไม่สำเร็จ: ' + err.message, 'error');
            results.push({ kind: 'story_sched', ok: false, error: err.message });
          }
        } else {
          const out = await uploadToYoutube(state.selectedFile, {
            title: ytTitle,
            description: ytDesc || caption,
            privacy: ytPrivacy,
          }, scheduledTs);
          progressUpdate(i, scheduledTs ? `ตั้งเวลาแล้ว · id ${out.id}` : `สำเร็จ · id ${out.id}`, 'success');
          results.push({ kind: 'yt', ok: true, id: out.id });
        }
      } catch (err) {
        progressUpdate(i, 'ผิดพลาด: ' + err.message, 'error');
        results.push({ kind: it.kind, ok: false, error: err.message });
      }
    }));

    // Save scheduled job record (for tracking)
    if (scheduledTs) {
      await sendExt({
        type: 'ADD_JOB',
        job: {
          id: jobId,
          fileName: state.selectedFile.name,
          fileSize: state.selectedFile.size,
          caption,
          ytEnabled: ytEnable,
          ytTitle: ytEnable ? ytTitle : null,
          storyEnabled: storyEnable,
          fbPages: pages.map(p => ({ id: p.id, name: p.name })),
          fireAt: scheduledTs,
          createdAt: Date.now(),
          status: 'scheduled',
          results
        }
      });
    } else {
      await sendExt({
        type: 'ADD_JOB',
        job: {
          id: jobId,
          fileName: state.selectedFile.name,
          fileSize: state.selectedFile.size,
          caption,
          ytEnabled: ytEnable,
          ytTitle: ytEnable ? ytTitle : null,
          storyEnabled: storyEnable,
          fbPages: pages.map(p => ({ id: p.id, name: p.name })),
          fireAt: null,
          createdAt: Date.now(),
          status: 'done',
          results
        }
      });
    }

    state.uploading = false;
    $('postBtn').disabled = false;
    loadScheduled();
  }

  function resetForm() {
    setFile(null);
    $('fileInput').value = '';
    $('captionInput').value = '';
    $('ytTitle').value = '';
    $('ytDescription').value = '';
    $('schedEnable').checked = false;
    $('schedTime').value = '';
    $('schedTime').hidden = true;
    $('schedHint').hidden = true;
    $('progressBox').hidden = true;
    $('progressList').innerHTML = '';
  }

  // ───────── Scheduled list
  function fmtCountdown(targetMs) {
    const diff = targetMs - Date.now();
    const abs = Math.abs(diff);
    const d = Math.floor(abs / 86400000);
    const h = Math.floor((abs % 86400000) / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const s = Math.floor((abs % 60000) / 1000);
    let txt;
    if (d > 0) txt = `${d} วัน ${h} ชม`;
    else if (h > 0) txt = `${h} ชม ${m} นาที`;
    else if (m > 0) txt = `${m} นาที`;
    else txt = `${s} วินาที`;
    return diff > 0 ? `อีก ${txt}` : `เลยมา ${txt}`;
  }

  function statusIconForResult(result) {
    if (!result) return '⏳';
    if (result.ok) return '✅';
    return '❌';
  }

  function jobOverallStatus(j) {
    const now = Date.now();
    const results = j.results || [];
    const hasErr = results.some(r => !r.ok);

    // Story scheduled separately — pending until fired
    const hasPendingStory = j.storyEnabled && j.fireAt &&
      !results.some(r => r.kind === 'story' || r.kind === 'story_scheduled_done');
    const storyAlarmFired = j.storyFiredAt;

    if (!j.fireAt) {
      // Posted immediately
      return hasErr
        ? { label: 'มี error', cls: 'sched-status--error' }
        : { label: 'สำเร็จ', cls: 'sched-status--done' };
    }

    // Scheduled job
    if (now < j.fireAt - 1000) {
      return { label: 'รอเวลา', cls: 'sched-status--scheduled' };
    }
    if (j.storyEnabled && !storyAlarmFired && now < j.fireAt + 5 * 60000) {
      return { label: 'กำลังยิง...', cls: 'sched-status--scheduled' };
    }
    return hasErr
      ? { label: 'มี error', cls: 'sched-status--error' }
      : { label: 'สำเร็จ', cls: 'sched-status--done' };
  }

  function renderJobBreakdown(j) {
    const blocks = [];
    const results = j.results || [];
    const findResult = (kind, pageId) => results.find(r =>
      r.kind === kind && (pageId == null || r.pageId === pageId)
    );

    // Facebook Feed per page
    if (j.fbPages && j.fbPages.length) {
      const lines = j.fbPages.map(p => {
        const res = findResult('fb', p.id);
        let icon, hint;
        if (j.fireAt && !res) {
          icon = '🕐'; hint = 'รอ FB เผยแพร่ตามเวลา';
        } else {
          icon = statusIconForResult(res);
          hint = res ? (res.ok ? `id ${res.id}` : `error: ${res.error}`) : '';
        }
        return `<div class="bd-row">
          <span class="bd-icon">${icon}</span>
          <span class="bd-name">${escHtml(p.name)}</span>
          <span class="bd-hint muted-sm">${escHtml(hint)}</span>
        </div>`;
      }).join('');
      blocks.push(`
        <div class="bd-block">
          <div class="bd-platform">📘 Facebook Feed</div>
          ${lines}
        </div>
      `);
    }

    // Facebook Story
    if (j.storyEnabled && j.fbPages && j.fbPages.length) {
      const lines = j.fbPages.map(p => {
        const storyRes = findResult('story', p.id);
        const storySchedFail = results.find(r => r.kind === 'story_sched' && !r.ok);
        let icon, hint;
        if (storyRes) {
          icon = statusIconForResult(storyRes);
          hint = storyRes.ok ? `id ${storyRes.id}` : `error: ${storyRes.error}`;
        } else if (storySchedFail) {
          icon = '❌'; hint = `error: ${storySchedFail.error}`;
        } else if (j.fireAt) {
          icon = '🕐'; hint = 'รอเวลา → extension จะยิง';
        } else {
          icon = '⏳'; hint = '';
        }
        return `<div class="bd-row">
          <span class="bd-icon">${icon}</span>
          <span class="bd-name">${escHtml(p.name)}</span>
          <span class="bd-hint muted-sm">${escHtml(hint)}</span>
        </div>`;
      }).join('');
      blocks.push(`
        <div class="bd-block">
          <div class="bd-platform">📱 Facebook Story</div>
          ${lines}
        </div>
      `);
    }

    // YouTube
    if (j.ytEnabled) {
      const ytRes = findResult('yt');
      let icon, hint;
      if (ytRes) {
        icon = statusIconForResult(ytRes);
        hint = ytRes.ok ? `id ${ytRes.id}` : `error: ${ytRes.error}`;
      } else if (j.fireAt) {
        icon = '🕐'; hint = 'รอ YouTube เผยแพร่ตามเวลา';
      } else {
        icon = '⏳'; hint = '';
      }
      blocks.push(`
        <div class="bd-block">
          <div class="bd-platform">▶️ YouTube</div>
          <div class="bd-row">
            <span class="bd-icon">${icon}</span>
            <span class="bd-name">${escHtml(j.ytTitle || 'Untitled')}</span>
            <span class="bd-hint muted-sm">${escHtml(hint)}</span>
          </div>
        </div>
      `);
    }
    return blocks.join('');
  }

  async function loadScheduled() {
    const r = await sendExt({ type: 'GET_STATE' });
    if (!r.ok) return;
    const jobs = (r.state.scheduledJobs || []).slice().sort((a, b) => b.createdAt - a.createdAt);
    const wrap = $('scheduledList');
    if (!jobs.length) {
      wrap.innerHTML = '<div class="muted-sm">ยังไม่มีรายการ</div>';
      return;
    }
    wrap.innerHTML = jobs.map(j => {
      const status = jobOverallStatus(j);
      const fireLine = j.fireAt
        ? `<span class="job-when">⏰ ${escHtml(fmtTime(j.fireAt))}</span> <span class="job-countdown muted-sm">${escHtml(fmtCountdown(j.fireAt))}</span>`
        : `<span class="job-when">📤 โพสทันที</span>`;
      return `
        <div class="job-card">
          <div class="job-head">
            <div class="job-head-left">
              <div class="job-file">📹 ${escHtml(j.fileName || '(no file)')}</div>
              <div class="job-when-line">${fireLine}</div>
            </div>
            <div class="job-head-right">
              <span class="sched-status ${status.cls}">${escHtml(status.label)}</span>
              <button class="btn btn-ghost btn-sm" data-del="${escHtml(j.id)}" type="button">ลบ</button>
            </div>
          </div>
          <div class="job-body">
            ${renderJobBreakdown(j)}
          </div>
          <div class="job-foot muted-sm">สร้างเมื่อ ${escHtml(fmtTime(j.createdAt))}</div>
        </div>
      `;
    }).join('');
    wrap.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('ลบรายการนี้?')) return;
        await sendExt({ type: 'DEL_JOB', id: btn.dataset.del });
        loadScheduled();
      });
    });
  }

  // Refresh countdown every 30s while page is open
  setInterval(() => {
    const wrap = $('scheduledList');
    if (wrap && wrap.querySelector('.job-card')) loadScheduled();
  }, 30000);

  // ───────── Init
  async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      const d = await r.json();
      if (d.googleClientId) window.__GOOGLE_CLIENT_ID = d.googleClientId;
      if (d.fbAppId) window.__FB_APP_ID = d.fbAppId;
    } catch (_) {}
  }

  async function init() {
    await loadConfig();
    // 1) Pull existing state from extension (if loaded)
    const stateRes = await sendExt({ type: 'GET_STATE' }, 5000);
    if (stateRes && stateRes.ok && stateRes.state) {
      const s = stateRes.state;
      state.fb = s.fb;
      state.yt = s.yt;
    }

    // 2) Handle FB hash (callback redirect)
    const fbResult = readFbHash();
    if (fbResult) {
      try {
        const { user, pages } = await fbFetchUserAndPages(fbResult.token);
        await sendExt({
          type: 'SAVE_FB',
          token: fbResult.token,
          expires: fbResult.expires,
          user, pages,
        });
        state.fb = { token: fbResult.token, expires: fbResult.expires, user, pages };
      } catch (err) {
        alert('โหลดเพจไม่สำเร็จ: ' + err.message);
      }
    }

    renderConnections();
    renderPageList();
    loadScheduled();

    // Wire up handlers
    $('fbConnect').addEventListener('click', fbConnect);
    $('fbDisconnect').addEventListener('click', fbDisconnect);
    $('fbToggleManual').addEventListener('click', () => {
      const box = $('fbManualBox');
      box.hidden = !box.hidden;
      if (!box.hidden) $('fbManualToken').focus();
    });
    const closeManual = () => {
      $('fbManualBox').hidden = true;
      $('fbManualToken').value = '';
      $('fbPageIdInput').value = '';
      $('fbPageNameInput').value = '';
      $('fbPageTokenInput').value = '';
    };
    $('fbManualCancel').addEventListener('click', closeManual);
    $('fbManualCancel2').addEventListener('click', closeManual);
    $('fbManualSubmit').addEventListener('click', fbManualConnect);
    $('fbAddPageBtn').addEventListener('click', fbAddPageManual);

    // Tab switching
    document.querySelectorAll('.manual-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.manual-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        $('fbManualUserPanel').hidden = tab !== 'user';
        $('fbManualPagePanel').hidden = tab !== 'page';
      });
    });
    $('ytConnect').addEventListener('click', ytConnect);
    $('ytDisconnect').addEventListener('click', ytDisconnect);

    // ── YouTube own-credentials box
    async function refreshYtCredsStatus() {
      const r = await sendExt({ type: 'GET_YT_CREDS' });
      const status = $('ytCredsStatus');
      if (r && r.ok && r.hasCreds) {
        const masked = r.clientId ? r.clientId.slice(0, 24) + '…' : '(saved)';
        status.textContent = `✅ ใช้ creds ของคุณเอง — Client ID: ${masked}`;
        status.style.color = '#6ee7b7';
      } else {
        status.textContent = '⚠️ ใช้ Client ID ของแอป (โควต้ารวม ~6 อัปโหลด/วัน กับคนอื่น)';
        status.style.color = '';
      }
    }
    $('ytToggleCreds').addEventListener('click', () => {
      const box = $('ytCredsBox');
      box.hidden = !box.hidden;
      if (!box.hidden) {
        $('ytRedirectUri').textContent = location.origin + '/yt-callback.html';
        refreshYtCredsStatus();
      }
    });
    $('ytRedirectUri').addEventListener('click', async () => {
      const txt = $('ytRedirectUri').textContent;
      try {
        await navigator.clipboard.writeText(txt);
        const orig = $('ytRedirectUri').textContent;
        $('ytRedirectUri').textContent = '✓ คัดลอกแล้ว';
        setTimeout(() => { $('ytRedirectUri').textContent = orig; }, 1200);
      } catch (_) {
        alert('คัดลอกเอง: ' + txt);
      }
    });
    $('ytCredsSave').addEventListener('click', async () => {
      const clientId = $('ytClientIdInput').value.trim();
      const clientSecret = $('ytClientSecretInput').value.trim();
      if (!clientId || !clientSecret) return alert('ใส่ทั้ง Client ID และ Client Secret');
      if (!clientId.endsWith('.apps.googleusercontent.com')) {
        if (!confirm('Client ID ดูแปลก ๆ (ปกติลงท้ายด้วย .apps.googleusercontent.com) — บันทึกต่อหรือไม่?')) return;
      }
      const r = await sendExt({ type: 'SAVE_YT_CREDS', clientId, clientSecret });
      if (!r || !r.ok) return alert('บันทึกไม่สำเร็จ: ' + ((r && r.error) || 'unknown'));
      $('ytClientIdInput').value = '';
      $('ytClientSecretInput').value = '';
      await refreshYtCredsStatus();
      alert('✅ บันทึกแล้ว — กดปุ่ม "เชื่อมต่อ YouTube" อีกครั้งเพื่อ login ด้วย creds ของคุณ');
    });
    $('ytCredsClear').addEventListener('click', async () => {
      if (!confirm('ล้าง Client ID + Secret ของคุณ? จะกลับไปใช้ของแอป (โควต้ารวมกับคนอื่น)')) return;
      const r = await sendExt({ type: 'CLEAR_YT_CREDS' });
      if (!r || !r.ok) return alert('ล้างไม่สำเร็จ: ' + ((r && r.error) || 'unknown'));
      await refreshYtCredsStatus();
      alert('✅ ล้างแล้ว — ครั้งหน้าเชื่อมต่อจะใช้ creds ของแอปแทน');
    });
    $('ytCredsCancel').addEventListener('click', () => {
      $('ytCredsBox').hidden = true;
      $('ytClientIdInput').value = '';
      $('ytClientSecretInput').value = '';
    });

    const fileZone = $('fileZone');
    fileZone.addEventListener('click', (e) => {
      if (e.target.id === 'fileClear') return;
      $('fileInput').click();
    });
    $('fileInput').addEventListener('change', (e) => setFile(e.target.files[0] || null));
    $('fileClear').addEventListener('click', (e) => {
      e.stopPropagation();
      setFile(null);
      $('fileInput').value = '';
    });
    fileZone.addEventListener('dragover', (e) => { e.preventDefault(); fileZone.classList.add('dragover'); });
    fileZone.addEventListener('dragleave', () => fileZone.classList.remove('dragover'));
    fileZone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileZone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
    });

    $('ytEnable').addEventListener('change', (e) => {
      $('ytFields').hidden = !e.target.checked;
    });
    $('schedEnable').addEventListener('change', (e) => {
      $('schedTime').hidden = !e.target.checked;
      $('schedHint').hidden = !e.target.checked;
    });

    $('selectAll').addEventListener('click', () => {
      document.querySelectorAll('#pageList input[type="checkbox"]').forEach(c => c.checked = true);
    });
    $('selectNone').addEventListener('click', () => {
      document.querySelectorAll('#pageList input[type="checkbox"]').forEach(c => c.checked = false);
    });

    $('postBtn').addEventListener('click', postClip);
    $('resetBtn').addEventListener('click', resetForm);
    $('refreshSched').addEventListener('click', loadScheduled);
    $('clearSched').addEventListener('click', async () => {
      if (!confirm('ล้างรายการทั้งหมด?')) return;
      await sendExt({ type: 'CLEAR_JOBS' });
      loadScheduled();
    });
  }

  // Wait a tick for content script READY message before init.
  setTimeout(() => {
    init().catch(err => console.error('init error', err));
  }, 200);

  // Expose Google Client ID via meta tag at runtime (set by deployment).
  // Look for <meta name="google-client-id" content="..."> if present.
  const meta = document.querySelector('meta[name="google-client-id"]');
  if (meta) window.__GOOGLE_CLIENT_ID = meta.getAttribute('content');
  const fbMeta = document.querySelector('meta[name="fb-app-id"]');
  if (fbMeta) window.__FB_APP_ID = fbMeta.getAttribute('content');
})();
