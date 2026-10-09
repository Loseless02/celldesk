// Document scanner: photo -> detect the page -> adjust corners -> straighten
// and clean up -> repeat for more pages -> one PDF handed to the sender.
// Everything runs on the phone; no libraries.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_SRC = 3000;  // longest side kept from the camera photo
  const MAX_OUT = 2400;  // longest side of a straightened page
  const FILTERS = ['clean', 'gray', 'color'];
  const FILTER_LABEL = { clean: 'Clean', gray: 'Gray', color: 'Color' };

  let send = null;     // callback(files)
  let src = null;      // canvas holding the current photo
  let quad = null;     // page corners in src pixels: TL, TR, BR, BL
  let pages = [];      // { blob, w, h, url }
  let filter = 'clean';
  let view = null;     // { scale, ox, oy } src -> stage pixels

  // ---------- image loading ----------

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        // <img> applies the EXIF orientation, so drawing it gives an upright photo.
        const k = Math.min(1, MAX_SRC / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
      img.src = url;
    });
  }

  // ---------- page detection ----------

  function insetQuad(W, H) {
    const m = 0.06;
    return [[W * m, H * m], [W * (1 - m), H * m], [W * (1 - m), H * (1 - m)], [W * m, H * (1 - m)]];
  }

  function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  // Paper is usually the largest bright region: threshold with Otsu, take the
  // biggest connected bright blob and use its extreme points as corners.
  function detectQuad(c) {
    const W = c.width, H = c.height;
    const k = 256 / Math.max(W, H);
    const w = Math.max(2, Math.round(W * k)), h = Math.max(2, Math.round(H * k));
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const g = t.getContext('2d');
    g.drawImage(c, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const n = w * h;
    const gray = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
      gray[i] = v;
      hist[v]++;
    }
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = -1, th = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const diff = sumB / wB - (sum - sumB) / wF;
      const between = wB * wF * diff * diff;
      if (between > best) { best = between; th = v; }
    }

    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const flood = (start, visit) => {
      let sp = 0, size = 0;
      stack[sp++] = start;
      seen[start] = 1;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w, y = (p / w) | 0;
        if (visit) visit(x, y);
        if (x > 0 && !seen[p - 1] && gray[p - 1] > th) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && !seen[p + 1] && gray[p + 1] > th) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && !seen[p - w] && gray[p - w] > th) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && !seen[p + w] && gray[p + w] > th) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      return size;
    };
    let bestStart = -1, bestSize = 0;
    for (let i = 0; i < n; i++) {
      if (seen[i] || gray[i] <= th) continue;
      const size = flood(i, null);
      if (size > bestSize) { bestSize = size; bestStart = i; }
    }
    if (bestStart < 0 || bestSize < n * 0.12 || bestSize > n * 0.97) return insetQuad(W, H);

    seen.fill(0);
    let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
    flood(bestStart, (x, y) => {
      const s = x + y, df = x - y;
      if (s < tl[2]) tl = [x, y, s];
      if (s > br[2]) br = [x, y, s];
      if (df > tr[2]) tr = [x, y, df];
      if (df < bl[2]) bl = [x, y, df];
    });
    const q = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / k, (y + 0.5) / k]);
    return quadArea(q) < W * H * 0.1 ? insetQuad(W, H) : q;
  }

  // ---------- straightening ----------

  // Solves the 8 unknowns of the homography mapping `from` onto `to`.
  function homography(from, to) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = from[i], [x, y] = to[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let c2 = col; c2 < 9; c2++) A[r][c2] -= f * A[col][c2];
      }
    }
    return A.map((row, i) => row[8] / row[i]);
  }

  function warp(c, q) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, MAX_OUT / Math.max(w, h));
    w = Math.max(2, Math.round(w * k));
    h = Math.max(2, Math.round(h * k));
    const M = homography([[0, 0], [w, 0], [w, h], [0, h]], q);

    const SW = c.width, SH = c.height;
    const S = c.getContext('2d').getImageData(0, 0, SW, SH).data;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const od = octx.createImageData(w, h);
    const O = od.data;
    const maxX = SW - 1.001, maxY = SH - 1.001;
    let o = 0;
    for (let y = 0; y < h; y++) {
      const v = y + 0.5;
      for (let x = 0; x < w; x++, o += 4) {
        const u = x + 0.5;
        const den = M[6] * u + M[7] * v + 1;
        let sx = (M[0] * u + M[1] * v + M[2]) / den - 0.5;
        let sy = (M[3] * u + M[4] * v + M[5]) / den - 0.5;
        sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
        sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = S[i00 + ch] + (S[i10 + ch] - S[i00 + ch]) * fx;
          const bot = S[i01 + ch] + (S[i11 + ch] - S[i01 + ch]) * fx;
          O[o + ch] = top + (bot - top) * fy;
        }
        O[o + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  // ---------- clean-up filters ----------

  function boxBlur(a, w, h, r) {
    const tmp = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[y * w + xx]; c++; } }
        tmp[y * w + x] = s / c;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; } }
        a[y * w + x] = s / c;
      }
    }
  }

  function applyFilter(c, f) {
    if (f === 'color') return c;
    const W = c.width, H = c.height;
    const ctx = c.getContext('2d');
    const id = ctx.getImageData(0, 0, W, H);
    const D = id.data;
    const n = W * H;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) gray[i] = (D[i * 4] * 77 + D[i * 4 + 1] * 150 + D[i * 4 + 2] * 29) >> 8;

    if (f === 'clean') {
      // Estimate the paper brightness everywhere (brightest pixel per 8x8 block,
      // smoothed), divide it out to remove shadows, then push paper to white.
      const s = 8, bw = Math.ceil(W / s), bh = Math.ceil(H / s);
      const bg = new Float32Array(bw * bh);
      for (let y = 0; y < H; y++) {
        const row = ((y / s) | 0) * bw;
        for (let x = 0; x < W; x++) {
          const bi = row + ((x / s) | 0), v = gray[y * W + x];
          if (v > bg[bi]) bg[bi] = v;
        }
      }
      boxBlur(bg, bw, bh, 3);
      for (let y = 0; y < H; y++) {
        const by = Math.min(bh - 1, Math.max(0, (y + 0.5) / s - 0.5));
        const y0 = by | 0, y1 = Math.min(bh - 1, y0 + 1), fy = by - y0;
        for (let x = 0; x < W; x++) {
          const bx = Math.min(bw - 1, Math.max(0, (x + 0.5) / s - 0.5));
          const x0 = bx | 0, x1 = Math.min(bw - 1, x0 + 1), fx = bx - x0;
          const top = bg[y0 * bw + x0] + (bg[y0 * bw + x1] - bg[y0 * bw + x0]) * fx;
          const bot = bg[y1 * bw + x0] + (bg[y1 * bw + x1] - bg[y1 * bw + x0]) * fx;
          const paper = Math.max(24, top + (bot - top) * fy);
          const ratio = gray[y * W + x] / paper;
          const t = (ratio - 0.45) / (0.88 - 0.45);
          gray[y * W + x] = t >= 1 ? 255 : t <= 0 ? 0 : 255 * t * t * (3 - 2 * t);
        }
      }
    }
    for (let i = 0; i < n; i++) { D[i * 4] = D[i * 4 + 1] = D[i * 4 + 2] = gray[i]; }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  // ---------- PDF ----------

  async function buildPDF(list) {
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (num, write) => { offsets[num] = len; push(num + ' 0 obj\n'); write(); push('\nendobj\n'); };

    const jpgs = await Promise.all(list.map(async (p) => new Uint8Array(await p.blob.arrayBuffer())));
    push('%PDF-1.4\n%âãÏÓ\n');
    const kids = list.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [' + kids + '] /Count ' + list.length + ' >>'));
    list.forEach((p, i) => {
      const pageNo = 3 + i * 3, contentNo = pageNo + 1, imageNo = pageNo + 2;
      const pw = 595.28; // A4 width in points; height follows the page
      const ph = Math.round(pw * p.h / p.w * 100) / 100;
      obj(pageNo, () => push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] ' +
        '/Resources << /XObject << /Im0 ' + imageNo + ' 0 R >> >> /Contents ' + contentNo + ' 0 R >>'));
      const content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
      obj(contentNo, () => { push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'); });
      obj(imageNo, () => {
        push('<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpgs[i].length + ' >>\nstream\n');
        push(jpgs[i]);
        push('\nendstream');
      });
    });
    const count = 3 + list.length * 3;
    const xref = len;
    push('xref\n0 ' + count + '\n0000000000 65535 f \n');
    for (let k = 1; k < count; k++) push(String(offsets[k]).padStart(10, '0') + ' 00000 n \n');
    push('trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---------- UI ----------

  // Lets the "busy" overlay paint before heavy work. A timer, not
  // requestAnimationFrame, which never fires while the page is hidden.
  const nextFrame = () => new Promise((r) => setTimeout(r, 40));

  function busy(text) {
    $('scan-busy').hidden = !text;
    $('scan-busy').textContent = text || '';
  }

  function setMode(mode) {
    const crop = mode === 'crop';
    $('scanner').hidden = false;
    $('scan-canvas').hidden = !crop;
    $('scan-svg').style.display = crop ? '' : 'none';
    $('scan-filter').hidden = !crop;
    $('scan-retake').hidden = !crop;
    $('scan-keep').hidden = !crop;
    $('scan-preview').hidden = crop || pages.length === 0;
    $('scan-add').hidden = crop;
    $('scan-send').hidden = crop;
    $('scan-title').textContent = crop ? 'Page ' + (pages.length + 1) + ' · drag the corners' : pages.length + (pages.length === 1 ? ' page' : ' pages');
    $('scan-send').textContent = 'Send PDF (' + pages.length + ')';
    $('scan-send').disabled = pages.length === 0;
    renderPages();
  }

  function layout() {
    if (!src) return;
    const stage = $('scan-stage');
    const sw = stage.clientWidth, sh = stage.clientHeight, pad = 18;
    const scale = Math.min((sw - pad * 2) / src.width, (sh - pad * 2) / src.height);
    const dw = src.width * scale, dh = src.height * scale;
    view = { scale, ox: (sw - dw) / 2, oy: (sh - dh) / 2 };
    const cv = $('scan-canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(dw * dpr);
    cv.height = Math.round(dh * dpr);
    Object.assign(cv.style, { left: view.ox + 'px', top: view.oy + 'px', width: dw + 'px', height: dh + 'px' });
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    $('scan-svg').setAttribute('viewBox', '0 0 ' + sw + ' ' + sh);
    drawQuad();
  }

  const toStage = ([x, y]) => [view.ox + x * view.scale, view.oy + y * view.scale];

  function drawQuad() {
    const svg = $('scan-svg');
    const pts = quad.map(toStage);
    let html = '<polygon class="scan-quad" points="' + pts.map((p) => p.join(',')).join(' ') + '"/>';
    pts.forEach((p, i) => {
      html += '<circle class="scan-handle" cx="' + p[0] + '" cy="' + p[1] + '" r="11"/>' +
        '<circle class="scan-hit" data-i="' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="28"/>';
    });
    svg.innerHTML = html;
  }

  function bindHandles() {
    const svg = $('scan-svg');
    let drag = -1;
    svg.addEventListener('pointerdown', (e) => {
      const i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i === null || i === undefined) return;
      drag = +i;
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag < 0 || !view) return;
      const r = $('scan-stage').getBoundingClientRect();
      const x = (e.clientX - r.left - view.ox) / view.scale;
      const y = (e.clientY - r.top - view.oy) / view.scale;
      quad[drag] = [Math.max(0, Math.min(src.width, x)), Math.max(0, Math.min(src.height, y))];
      drawQuad();
    });
    const end = () => { drag = -1; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  function renderPages() {
    const strip = $('scan-pages');
    strip.textContent = '';
    pages.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'pg';
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = 'Page ' + (i + 1);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.textContent = '×';
      rm.setAttribute('aria-label', 'Remove page ' + (i + 1));
      rm.onclick = () => {
        URL.revokeObjectURL(p.url);
        pages.splice(i, 1);
        if (!src) {
          $('scan-preview').src = pages.length ? pages[pages.length - 1].url : '';
          setMode('review');
        } else renderPages();
      };
      el.append(img, rm);
      strip.appendChild(el);
    });
    strip.hidden = pages.length === 0;
  }

  async function onPhoto(file) {
    $('scanner').hidden = false;
    busy('Finding the page…');
    await nextFrame();
    try {
      src = await loadImage(file);
      quad = detectQuad(src);
      setMode('crop');
      await nextFrame();
      layout();
    } catch (e) {
      alert(e.message);
      if (!pages.length) close();
    } finally {
      busy('');
    }
  }

  async function keep() {
    busy('Straightening…');
    await nextFrame();
    try {
      const out = applyFilter(warp(src, quad), filter);
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
      pages.push({ blob, w: out.width, h: out.height, url: URL.createObjectURL(blob) });
      src = null;
      $('scan-preview').src = pages[pages.length - 1].url;
      setMode('review');
    } finally {
      busy('');
    }
  }

  async function finish() {
    busy('Making PDF…');
    await nextFrame();
    try {
      const pdf = await buildPDF(pages);
      const d = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      const name = 'Scan ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + '.' + pad(d.getMinutes()) + '.' + pad(d.getSeconds()) + '.pdf';
      const file = new File([pdf], name, { type: 'application/pdf', lastModified: Date.now() });
      close();
      send([file]);
    } finally {
      busy('');
    }
  }

  function close() {
    pages.forEach((p) => URL.revokeObjectURL(p.url));
    pages = [];
    src = null;
    quad = null;
    $('scanner').hidden = true;
  }

  function init(onFiles) {
    send = onFiles;
    document.querySelectorAll('input[data-scan]').forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        input.value = '';
        if (f) onPhoto(f);
      });
    });
    $('scan-filter').textContent = FILTER_LABEL[filter];
    $('scan-filter').onclick = () => {
      filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length];
      $('scan-filter').textContent = FILTER_LABEL[filter];
    };
    $('scan-keep').onclick = keep;
    $('scan-send').onclick = finish;
    $('scan-cancel').onclick = () => {
      if (pages.length && !confirm('Discard ' + pages.length + ' scanned page(s)?')) return;
      close();
    };
    bindHandles();
    window.addEventListener('resize', () => { if (src) layout(); });
  }

  window.CellDeskScanner = { init, onPhoto, detectQuad, warp, applyFilter, buildPDF };
})();
