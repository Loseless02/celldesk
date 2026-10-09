// CellDesk phone app. Sends files byte-for-byte to the paired computer,
// either directly on the local network or through a relay (end-to-end
// encrypted). Unsent files wait in IndexedDB and go out when the PC is back.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAGIC = new TextEncoder().encode('CellDesk1');      // phone -> PC frames
  const DOWN_MAGIC = new TextEncoder().encode('CellDesk2'); // PC -> phone frames
  const DIRECT_MIN = 300 * 1024 * 1024; // bigger PC files download natively (no in-page check)
  const CHUNK = 1 << 20;
  const RELAY_MAX = 95 * 1024 * 1024;
  const STORE_KEY = 'celldesk.pairing';

  // ---------- pairing ----------

  function readPairing() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    let p = null;
    if (hash.get('r') && hash.get('k')) {
      p = { mode: 'relay', room: hash.get('r'), key: hash.get('k'), name: hash.get('n') || '' };
    } else if (query.get('t')) {
      p = { mode: 'lan', token: query.get('t') };
    }
    try {
      if (p) localStorage.setItem(STORE_KEY, JSON.stringify(p));
      else p = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch (e) { /* storage blocked: rely on the URL */ }
    return p;
  }

  // ---------- helpers ----------

  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toHex(buf) {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256Hex(bytes) {
    if (window.isSecureContext && window.crypto && crypto.subtle) {
      return toHex(await crypto.subtle.digest('SHA-256', bytes));
    }
    return window.sha256hex(bytes);
  }

  // Hashes a file in slices so large videos or documents never sit in memory whole.
  async function hashFile(file) {
    if (window.isSecureContext && window.crypto && crypto.subtle && file.size <= 256 * 1024 * 1024) {
      return toHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    }
    const h = new window.Sha256();
    const step = 4 * 1024 * 1024;
    for (let o = 0; o < file.size; o += step) {
      h.update(new Uint8Array(await file.slice(o, o + step).arrayBuffer()));
    }
    return h.hex();
  }

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function rid() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return toHex(a);
  }

  function xhrPost(url, headers, body, onProgress) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      for (const k of Object.keys(headers)) x.setRequestHeader(k, headers[k]);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
        resolve({ status: x.status, data });
      };
      x.onerror = x.onabort = x.ontimeout = () => resolve({ status: 0, data: null });
      x.send(body);
    });
  }

  // GET with download progress. expected is used when the server streams
  // without a Content-Length (the relay).
  function xhrGet(url, type, onProgress, expected) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = type;
      x.onprogress = (e) => {
        const total = e.lengthComputable ? e.total : expected;
        if (total) onProgress(Math.min(1, e.loaded / total));
      };
      x.onload = () => {
        if (x.status === 200) resolve(x.response);
        else reject(new Error(x.status === 404 ? 'No longer on the PC' : x.status === 503 ? 'PC offline' : 'Error ' + x.status));
      };
      x.onerror = x.ontimeout = () => reject(new Error('PC not reachable'));
      x.send();
    });
  }

  // ---------- transports ----------

  // Tailscale gives devices 100.64.0.0/10 addresses.
  function isTailnetHost(host) {
    const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
    return !!m && +m[1] >= 64 && +m[1] <= 127;
  }

  function lanTransport(p) {
    const tailnet = isTailnetHost(location.hostname);
    return {
      label: tailnet ? 'Private' : 'Wi-Fi',
      offlineText: tailnet ? 'PC not reachable — is Tailscale on?' : 'PC not reachable',
      maxSize: Infinity,
      async hello() {
        const r = await fetch('/api/hello?t=' + encodeURIComponent(p.token), { cache: 'no-store' });
        if (r.status === 401) return { online: false, unpaired: true };
        const j = await r.json();
        return { online: !!j.ok, name: j.name, outbox: j.outbox };
      },
      async listOutbox() {
        const r = await fetch('/api/outbox?t=' + encodeURIComponent(p.token), { cache: 'no-store' });
        if (!r.ok) throw new Error('Error ' + r.status);
        return (await r.json()).items || [];
      },
      download(item, onProgress) {
        return xhrGet('/api/outbox/' + item.id + '?t=' + encodeURIComponent(p.token), 'blob', onProgress);
      },
      // Very large files skip the in-page download and go straight to the browser.
      directUrl(item) {
        return '/api/outbox/' + item.id + '?dl=1&t=' + encodeURIComponent(p.token);
      },
      needsBytes: false,
      send(job, bytes, hash, onProgress) {
        return xhrPost('/api/upload', {
          'X-CellDesk-Token': p.token,
          'X-File-Name': encodeURIComponent(job.name),
          'X-File-Modified': String(job.modified),
          'X-File-SHA256': hash,
          'Content-Type': job.type || 'application/octet-stream',
        }, job.file, onProgress);
      },
    };
  }

  function relayTransport(p) {
    let keyPromise = null;
    const key = () => keyPromise || (keyPromise = crypto.subtle.importKey(
      'raw', b64urlDecode(p.key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));

    // Reverses the PC's frames (see docs/PROTOCOL.md); returns meta + data.
    async function decrypt(buf) {
      const k = await key();
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      let off = 0, index = 0, meta = null, final = false;
      const parts = [];
      while (off < buf.length) {
        if (final || off + 4 > buf.length) throw new Error('Corrupt download');
        const len = dv.getUint32(off);
        if (len < 29 || off + 4 + len > buf.length) throw new Error('Corrupt download');
        const flags = buf[off + 4];
        const aad = new Uint8Array(DOWN_MAGIC.length + 5);
        aad.set(DOWN_MAGIC);
        new DataView(aad.buffer).setUint32(DOWN_MAGIC.length, index);
        aad[aad.length - 1] = flags;
        let plain;
        try {
          plain = new Uint8Array(await crypto.subtle.decrypt({
            name: 'AES-GCM', iv: buf.subarray(off + 5, off + 17), additionalData: aad, tagLength: 128,
          }, k, buf.subarray(off + 17, off + 4 + len)));
        } catch (e) {
          throw new Error('Could not decrypt: scan the QR code again');
        }
        if (index === 0) meta = JSON.parse(new TextDecoder().decode(plain));
        else parts.push(plain);
        final = (flags & 1) === 1;
        off += 4 + len;
        index++;
      }
      if (!final || !meta) throw new Error('Download incomplete');
      return { meta, parts };
    }

    async function encrypt(bytes, meta) {
      const k = await key();
      const parts = [];
      let index = 0;
      async function frame(plain, final) {
        const flags = final ? 1 : 0;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const aad = new Uint8Array(MAGIC.length + 5);
        aad.set(MAGIC);
        new DataView(aad.buffer).setUint32(MAGIC.length, index);
        aad[aad.length - 1] = flags;
        const ct = new Uint8Array(await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, plain));
        const head = new Uint8Array(4 + 1 + 12);
        new DataView(head.buffer).setUint32(0, 1 + 12 + ct.length);
        head[4] = flags;
        head.set(iv, 5);
        parts.push(head, ct);
        index++;
      }
      await frame(new TextEncoder().encode(JSON.stringify(meta)), false);
      if (bytes.length === 0) await frame(new Uint8Array(0), true);
      for (let o = 0; o < bytes.length; o += CHUNK) {
        const end = Math.min(o + CHUNK, bytes.length);
        await frame(bytes.subarray(o, end), end === bytes.length);
      }
      return new Blob(parts, { type: 'application/octet-stream' });
    }

    return {
      label: 'Anywhere',
      offlineText: 'PC offline — photos will queue',
      needsBytes: true, // the whole file is encrypted before upload
      maxSize: RELAY_MAX,
      async hello() {
        const r = await fetch('/s/' + p.room, { cache: 'no-store' });
        const j = await r.json();
        return { online: !!j.online, name: j.name || p.name, outbox: j.outbox };
      },
      async listOutbox() {
        const buf = await xhrGet('/l/' + p.room, 'arraybuffer', () => {});
        return (await decrypt(new Uint8Array(buf))).meta.items || [];
      },
      async download(item, onProgress) {
        const buf = await xhrGet('/d/' + p.room + '/' + item.id, 'arraybuffer', onProgress, item.size);
        const { meta, parts } = await decrypt(new Uint8Array(buf));
        if (meta.id !== item.id) throw new Error('Wrong file received');
        return new Blob(parts, { type: item.type || 'application/octet-stream' });
      },
      directUrl: null,
      async send(job, bytes, hash, onProgress) {
        const body = await encrypt(bytes, {
          name: job.name, size: bytes.length, type: job.type, modified: job.modified, sha256: hash,
        });
        return xhrPost('/u/' + p.room, { 'Content-Type': 'application/octet-stream' }, body, onProgress);
      },
    };
  }

  // ---------- persistent queue (IndexedDB) ----------

  let dbPromise = null;
  function db() {
    return dbPromise || (dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('celldesk', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('queue', mode);
      const req = fn(tx.objectStore('queue'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const persist = (job) => idb('readwrite', (s) => s.put({
    id: job.id, file: job.file, name: job.name, type: job.type, modified: job.modified, size: job.size,
  })).catch(() => {});
  const unpersist = (job) => idb('readwrite', (s) => s.delete(job.id)).catch(() => {});

  // ---------- UI ----------

  const jobs = [];
  let transport = null;
  let online = false;
  let busy = false;

  function setStatus(state, text) {
    $('status').dataset.state = state;
    $('status-text').textContent = text;
  }

  function render(job) {
    if (!job.el) {
      const el = document.createElement('article');
      el.className = 'item';
      el.innerHTML = '<div class="thumb"></div><div class="meta"><div class="name"></div>' +
        '<div class="sub"></div><div class="progress"><span></span></div></div>';
      el.querySelector('.name').textContent = job.name;
      if (/^image\//.test(job.type)) {
        const img = document.createElement('img');
        img.alt = '';
        img.onerror = () => img.remove();
        img.src = URL.createObjectURL(job.file);
        el.querySelector('.thumb').appendChild(img);
      } else {
        const ext = (job.name.split('.').pop() || '').slice(0, 4).toUpperCase();
        el.querySelector('.thumb').textContent = /^video\//.test(job.type) ? '▶' : (ext || 'FILE');
      }
      el.addEventListener('click', () => {
        if (job.state === 'failed') { job.state = 'waiting'; render(job); pump(); }
      });
      job.el = el;
      $('list').prepend(el);
      $('empty').hidden = true;
    }
    const el = job.el;
    el.dataset.state = job.state;
    el.querySelector('.progress span').style.width = Math.round(job.progress * 100) + '%';
    const size = formatSize(job.size);
    let sub = size;
    switch (job.state) {
      case 'waiting': sub += online ? ' · Waiting…' : ' · Queued, sends when the PC is reachable'; break;
      case 'preparing': sub += ' · Preparing…'; break;
      case 'sending': sub += ' · Sending ' + Math.round(job.progress * 100) + '%'; break;
      case 'done': sub += ' · Saved' + (job.result && job.result.verified ? ' ✓ verified' : ''); break;
      case 'failed': sub += ' · ' + job.error + ' — tap to retry'; break;
    }
    el.querySelector('.sub').textContent = sub;
    if (job.state === 'done' && job.result && job.result.name) el.title = job.result.name;
    updateQueueInfo();
  }

  function updateQueueInfo() {
    const n = jobs.filter((j) => j.state === 'waiting' || j.state === 'failed').length;
    $('queue-count').textContent = String(n);
    $('queue-info').dataset.active = n > 0 ? 'true' : 'false';
  }

  function addJob(file, id) {
    const job = {
      id: id || rid(),
      file,
      name: file.name || 'photo.jpg',
      type: file.type || '',
      size: file.size,
      modified: file.lastModified || Date.now(),
      state: 'waiting',
      progress: 0,
    };
    jobs.push(job);
    render(job);
    return job;
  }

  async function addFiles(files) {
    for (const f of Array.from(files)) {
      const job = addJob(f);
      await persist(job);
    }
    pump();
  }

  // ---------- sending ----------

  async function runJob(job) {
    if (job.size > transport.maxSize) {
      job.state = 'failed';
      job.error = 'Too big for the relay (max ' + formatSize(transport.maxSize) + ')';
      render(job);
      return true;
    }
    job.state = 'preparing'; job.progress = 0; render(job);
    let res;
    try {
      let bytes = null, hash;
      if (transport.needsBytes) {
        bytes = new Uint8Array(await job.file.arrayBuffer());
        hash = await sha256Hex(bytes);
      } else {
        hash = await hashFile(job.file);
      }
      job.state = 'sending'; render(job);
      res = await transport.send(job, bytes, hash, (f) => { job.progress = f; render(job); });
    } catch (e) {
      res = { status: -1, data: { error: (e && e.message) || String(e) } };
    }
    if (res.status === 200 && res.data && res.data.ok) {
      job.state = 'done'; job.progress = 1; job.result = res.data;
      render(job);
      unpersist(job);
      return true;
    }
    if (res.status === 0 || res.status >= 500) {
      // PC or network unreachable: keep it queued and try again later.
      job.state = 'waiting'; job.progress = 0;
      online = false;
      render(job);
      check();
      return false;
    }
    job.state = 'failed';
    job.error = (res.data && res.data.error) || ('Error ' + res.status);
    if (res.status === 401) showUnpaired();
    render(job);
    return true;
  }

  async function pump() {
    if (busy || !transport) return;
    busy = true;
    try {
      for (;;) {
        const job = jobs.find((j) => j.state === 'waiting');
        if (!job) break;
        if (!(await runJob(job))) break;
      }
    } finally {
      busy = false;
      updateQueueInfo();
    }
  }

  async function check() {
    if (!transport) return;
    let h;
    try { h = await transport.hello(); } catch (e) { h = { online: false }; }
    if (h.unpaired) { showUnpaired(); return; }
    online = h.online;
    if (online) setStatus('online', h.name || 'Connected');
    else setStatus('offline', transport.offlineText);
    jobs.forEach((j) => { if (j.state === 'waiting') render(j); });
    if (online) pump();
    if (online && h.outbox != null && h.outbox !== outboxVersion) {
      outboxVersion = h.outbox;
      refreshInbox();
    }
  }

  function showUnpaired() {
    $('unpaired').hidden = false;
    $('controls').hidden = true;
    $('list').hidden = true;
    setStatus('offline', 'Not paired');
  }

  // ---------- files from the PC ----------

  const SAVED_KEY = 'celldesk.saved';
  let inbox = [];
  let outboxVersion = null;
  const fetched = new Map(); // id -> { state, progress, file, error }

  function savedIds() {
    try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')); } catch (e) { return new Set(); }
  }
  function markSaved(id) {
    const s = savedIds();
    s.add(id);
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(Array.from(s).slice(-500))); } catch (e) { /* ignore */ }
  }

  async function refreshInbox() {
    try { inbox = await transport.listOutbox(); } catch (e) { return; }
    updateBadge();
    if (!$('inbox').hidden) renderInbox();
  }

  function updateBadge() {
    const saved = savedIds();
    const fresh = inbox.filter((i) => !saved.has(i.id)).length;
    $('inbox-btn').hidden = inbox.length === 0;
    $('inbox-badge').hidden = fresh === 0;
    $('inbox-badge').textContent = String(fresh);
  }

  function buttonLabel(st) {
    switch (st.state) {
      case 'loading': return Math.round((st.progress || 0) * 100) + '%';
      case 'ready': return 'Save';
      case 'saved': return 'Saved ✓';
      case 'error': return 'Retry';
      default: return 'Get';
    }
  }

  function renderInbox() {
    const list = $('inbox-list');
    list.textContent = '';
    if (!inbox.length) {
      const p = document.createElement('p');
      p.className = 'inbox-empty';
      p.textContent = 'Nothing here. Drop files on "Send to phone" in CellDesk on your PC.';
      list.appendChild(p);
      return;
    }
    const saved = savedIds();
    inbox.forEach((item) => {
      const st = fetched.get(item.id) || { state: saved.has(item.id) ? 'saved' : 'idle' };
      const el = document.createElement('article');
      el.className = 'item';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (st.file && /^image\//.test(item.type)) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = st.url || (st.url = URL.createObjectURL(st.file));
        thumb.appendChild(img);
      } else {
        thumb.textContent = (item.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = formatSize(item.size) + (st.state === 'error' ? ' · ' + st.error : st.state === 'ready' ? ' · ✓ verified' : '');
      meta.append(name, sub);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'get-btn';
      btn.dataset.state = st.state;
      btn.textContent = buttonLabel(st);
      btn.onclick = () => onGet(item);
      el.append(thumb, meta, btn);
      list.appendChild(el);
    });
  }

  function downloadBlob(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Two taps on purpose: "Get" downloads and verifies, "Save" opens the share
  // sheet, which browsers only allow straight after a tap.
  async function onGet(item) {
    const st = fetched.get(item.id) || { state: 'idle' };
    fetched.set(item.id, st);
    if (st.state === 'loading') return;
    if (st.file) {
      const file = st.file;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); } catch (e) {
          if (e && e.name === 'AbortError') return;
          downloadBlob(file);
        }
      } else {
        downloadBlob(file);
      }
      st.state = 'saved';
      markSaved(item.id);
      updateBadge();
      renderInbox();
      return;
    }
    if (transport.directUrl && item.size >= DIRECT_MIN) {
      location.href = transport.directUrl(item);
      st.state = 'saved';
      markSaved(item.id);
      updateBadge();
      renderInbox();
      return;
    }
    if (item.size > transport.maxSize) {
      st.state = 'error';
      st.error = 'Too big for the relay, use Wi-Fi';
      renderInbox();
      return;
    }
    st.state = 'loading';
    st.progress = 0;
    renderInbox();
    try {
      const blob = await transport.download(item, (f) => {
        st.progress = f;
        const btn = Array.from(document.querySelectorAll('#inbox-list .get-btn'))[inbox.indexOf(item)];
        if (btn) btn.textContent = buttonLabel(st);
      });
      if ((await hashFile(blob)) !== item.sha256) throw new Error('Checksum mismatch, try again');
      st.file = new File([blob], item.name, { type: item.type || 'application/octet-stream' });
      st.state = 'ready';
    } catch (e) {
      st.state = 'error';
      st.error = (e && e.message) || 'Failed';
    }
    renderInbox();
  }

  // ---------- start ----------

  function bindInput(id) {
    const input = $(id);
    input.addEventListener('change', () => {
      if (input.files && input.files.length) addFiles(input.files);
      input.value = '';
    });
  }

  async function start() {
    const pairing = readPairing();
    if (!pairing || (pairing.mode === 'relay' && !(window.crypto && crypto.subtle))) {
      showUnpaired();
      return;
    }
    transport = pairing.mode === 'relay' ? relayTransport(pairing) : lanTransport(pairing);
    $('mode').textContent = transport.label;
    bindInput('shoot');
    bindInput('pick');
    bindInput('files');
    window.CellDeskScanner.init(addFiles);
    $('inbox-btn').onclick = () => { $('inbox').hidden = false; renderInbox(); refreshInbox(); };
    $('inbox-close').onclick = () => { $('inbox').hidden = true; };
    $('queue-info').addEventListener('click', () => {
      jobs.forEach((j) => { if (j.state === 'failed') { j.state = 'waiting'; render(j); } });
      check();
    });

    try {
      const rows = await idb('readonly', (s) => s.getAll());
      (rows || []).forEach((r) => {
        const job = addJob(r.file, r.id);
        job.name = r.name; job.type = r.type; job.modified = r.modified;
        render(job);
      });
    } catch (e) { /* IndexedDB unavailable: queue lives in memory only */ }

    check();
    setInterval(check, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('online', check);

    if (pairing.mode === 'relay' && 'serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  window.CellDesk = { addFiles, jobs, check, inbox: () => inbox, onGet };
  start();
})();
