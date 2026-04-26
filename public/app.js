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

  async function fbDisconnect() {
    if (!confirm('ยกเลิกการเชื่อมต่อ Facebook?')) return;
    await sendExt({ type: 'CLEAR_FB' });
    state.fb = { token: null, expires: null, user: null, pages: [] };
    renderConnections();
    renderPageList();
  }

  // ───────── YouTube OAuth (popup → window.opener.postMessage)
  function ytConnect() {
    const CLIENT_ID = window.__GOOGLE_CLIENT_ID;
    if (!CLIENT_ID) {
      alert('ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID — ดู deployment instructions');
      return;
    }
    const redirect = encodeURIComponent(location.origin + '/api/yt-callback');
    const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    const url =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${CLIENT_ID}` +
      `&redirect_uri=${redirect}` +
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

  // Handle the callback message
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

    const items = [
      ...pages.map(p => ({ label: `Facebook · ${p.name}`, kind: 'fb', page: p })),
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
  async function loadScheduled() {
    const r = await sendExt({ type: 'GET_STATE' });
    if (!r.ok) return;
    const jobs = (r.state.scheduledJobs || []).slice().sort((a, b) => b.createdAt - a.createdAt);
    const wrap = $('scheduledList');
    if (!jobs.length) {
      wrap.innerHTML = '<div class="muted-sm">ยังไม่มีรายการ</div>';
      return;
    }
    const now = Date.now();
    wrap.innerHTML = jobs.map(j => {
      let statusLabel, statusCls;
      const hasErr = (j.results || []).some(x => !x.ok);
      if (j.status === 'done' || !j.fireAt) {
        statusLabel = hasErr ? 'มี error' : 'สำเร็จ';
        statusCls = hasErr ? 'sched-status--error' : 'sched-status--done';
      } else if (now > j.fireAt + 60000) {
        statusLabel = 'ถึงเวลาแล้ว';
        statusCls = 'sched-status--done';
      } else {
        statusLabel = 'ตั้งเวลา';
        statusCls = 'sched-status--scheduled';
      }
      const platforms = [];
      if (j.fbPages && j.fbPages.length) platforms.push(`FB × ${j.fbPages.length}`);
      if (j.ytEnabled) platforms.push('YouTube');
      return `
        <div class="sched-row">
          <div class="sched-info">
            <div class="sched-title">${escHtml(j.fileName || '(no file)')}</div>
            <div class="sched-meta">
              ${platforms.join(' · ')} ·
              ${j.fireAt ? 'ยิงเวลา ' + fmtTime(j.fireAt) : 'โพสทันที'} ·
              สร้าง ${fmtTime(j.createdAt)}
            </div>
          </div>
          <span class="sched-status ${statusCls}">${escHtml(statusLabel)}</span>
          <button class="btn btn-ghost btn-sm" data-del="${escHtml(j.id)}" type="button">ลบ</button>
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
    $('fbManualCancel').addEventListener('click', () => {
      $('fbManualBox').hidden = true;
      $('fbManualToken').value = '';
    });
    $('fbManualSubmit').addEventListener('click', fbManualConnect);
    $('ytConnect').addEventListener('click', ytConnect);
    $('ytDisconnect').addEventListener('click', ytDisconnect);

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
