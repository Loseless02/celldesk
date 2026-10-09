// Document scanner: photo -> detect the page -> adjust corners -> straighten
// -> pick a style per page -> more pages -> one PDF handed to the sender.
// Everything runs on the phone; no libraries.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_SRC = 3000;  // longest side kept from the camera photo
  const MAX_OUT = 2400;  // longest side of a straightened page
  const FILTERS = [['color', 'Color'], ['gray', 'Grayscale'], ['bw', 'B&W'], ['photo', 'Original']];
  const LOUPE = 128;     // magnifier size in CSS pixels
  const ZOOM = 2.5;      // magnifier zoom relative to the on-screen photo

  let send = null;       // callback(files)
  let src = null;        // canvas holding the photo being cropped
  let quad = null;       // page corners in src pixels: TL, TR, BR, BL
  let pages = [];        // { warped, filter, blob, w, h, url }
  let current = -1;      // page shown in review
  let lastFilter = 'color';
  let view = null;       // { scale, ox, oy } src -> stage pixels
  let active = null;     // handle being dragged

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

  // Two guesses at the page, keeping the bigger valid one:
  //  A. the largest bright blob (Otsu threshold): paper on a darker desk;
  //  B. everything not connected to the photo border in the desk's colour:
  //     also catches dark headers, stamps and photos printed on the page.
  // Corners are the blob's extreme points along the two diagonals.
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

    const stack = new Int32Array(n);
    // Flood fill over mask[] from start, marking seen[]; returns pixel count.
    const flood = (mask, seen, start, visit) => {
      let sp = 0, size = 0;
      stack[sp++] = start;
      seen[start] = 1;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w, y = (p / w) | 0;
        if (visit) visit(x, y);
        if (x > 0 && !seen[p - 1] && mask[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && !seen[p + 1] && mask[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && !seen[p - w] && mask[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && !seen[p + w] && mask[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      return size;
    };
    const blobQuad = (mask) => {
      let seen = new Uint8Array(n);
      let start = -1, size = 0;
      for (let i = 0; i < n; i++) {
        if (seen[i] || !mask[i]) continue;
        const s = flood(mask, seen, i, null);
        if (s > size) { size = s; start = i; }
      }
      if (start < 0 || size < n * 0.12 || size > n * 0.97) return null;
      seen = new Uint8Array(n);
      let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
      flood(mask, seen, start, (x, y) => {
        const s = x + y, df = x - y;
        if (s < tl[2]) tl = [x, y, s];
        if (s > br[2]) br = [x, y, s];
        if (df > tr[2]) tr = [x, y, df];
        if (df < bl[2]) bl = [x, y, df];
      });
      const q = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / k, (y + 0.5) / k]);
      return quadArea(q) < W * H * 0.1 ? null : q;
    };

    // A: bright blob.
    const bright = new Uint8Array(n);
    for (let i = 0; i < n; i++) bright[i] = gray[i] > th ? 1 : 0;
    const qa = blobQuad(bright);

    // B: the desk is whatever touches the border and looks like the border.
    const border = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
    const mean = [0, 0, 0];
    border.forEach((p) => { for (let ch = 0; ch < 3; ch++) mean[ch] += d[p * 4 + ch]; });
    for (let ch = 0; ch < 3; ch++) mean[ch] /= border.length;
    let spread = 0;
    const dist = (p) => Math.hypot(d[p * 4] - mean[0], d[p * 4 + 1] - mean[1], d[p * 4 + 2] - mean[2]);
    border.forEach((p) => { spread += dist(p) * dist(p); });
    const tol = Math.min(90, Math.max(28, 2.2 * Math.sqrt(spread / border.length)));
    const deskLike = new Uint8Array(n);
    for (let i = 0; i < n; i++) deskLike[i] = dist(i) < tol ? 1 : 0;
    const desk = new Uint8Array(n);
    border.forEach((p) => { if (deskLike[p] && !desk[p]) flood(deskLike, desk, p, null); });
    const notDesk = new Uint8Array(n);
    for (let i = 0; i < n; i++) notDesk[i] = desk[i] ? 0 : 1;
    const qb = blobQuad(notDesk);

    // B wins when it adds a dark band to A; much bigger usually means it
    // swallowed a shadow or clutter on the desk.
    if (qa && qb) {
      const a = quadArea(qa), b = quadArea(qb);
      return b >= a && b <= a * 1.6 ? qb : qa;
    }
    return qb || qa || insetQuad(W, H);
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


  // ---------- styles ----------

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

  // Paper brightness at every pixel: the brightest value per 8x8 block,
  // smoothed and interpolated back up. Dividing by it removes shadows and
  // uneven light while leaving the ink alone.
  function paperLevels(gray, W, H) {
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
    // Shadows rarely darken paper below ~60% of its usual brightness; anything
    // darker is a coloured area (header, photo) that must not be "lightened".
    const sorted = Float32Array.from(bg).sort();
    const floor = 0.6 * sorted[Math.floor(sorted.length * 0.9)];
    for (let i = 0; i < bg.length; i++) if (bg[i] < floor) bg[i] = floor;
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const by = Math.min(bh - 1, Math.max(0, (y + 0.5) / s - 0.5));
      const y0 = by | 0, y1 = Math.min(bh - 1, y0 + 1), fy = by - y0;
      for (let x = 0; x < W; x++) {
        const bx = Math.min(bw - 1, Math.max(0, (x + 0.5) / s - 0.5));
        const x0 = bx | 0, x1 = Math.min(bw - 1, x0 + 1), fx = bx - x0;
        const top = bg[y0 * bw + x0] + (bg[y0 * bw + x1] - bg[y0 * bw + x0]) * fx;
        const bot = bg[y1 * bw + x0] + (bg[y1 * bw + x1] - bg[y1 * bw + x0]) * fx;
        out[y * W + x] = Math.max(24, top + (bot - top) * fy);
      }
    }
    return out;
  }

  // Gamma curve as a lookup table: deepens ink after the paper went white.
  function gammaLUT(g) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, g);
    return lut;
  }

  function applyFilter(c, f) {
    if (f === 'photo') return c;
    const W = c.width, H = c.height, n = W * H;
    const ctx = c.getContext('2d');
    const id = ctx.getImageData(0, 0, W, H);
    const D = id.data;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) gray[i] = (D[i * 4] * 77 + D[i * 4 + 1] * 150 + D[i * 4 + 2] * 29) >> 8;
    const paper = paperLevels(gray, W, H);

    if (f === 'color') {
      // White paper, true colours: scale each channel by the local paper level.
      const lut = gammaLUT(1.25);
      for (let i = 0; i < n; i++) {
        const k = 255 / (paper[i] * 0.95);
        for (let ch = 0; ch < 3; ch++) {
          const v = D[i * 4 + ch] * k;
          D[i * 4 + ch] = lut[v > 255 ? 255 : v | 0];
        }
      }
    } else if (f === 'gray') {
      const lut = gammaLUT(1.35);
      for (let i = 0; i < n; i++) {
        const v = gray[i] * 255 / (paper[i] * 0.95);
        D[i * 4] = D[i * 4 + 1] = D[i * 4 + 2] = lut[v > 255 ? 255 : v | 0];
      }
    } else {
      // Black & white: paper to pure white, ink to black, soft edges kept.
      for (let i = 0; i < n; i++) {
        const t = (gray[i] / paper[i] - 0.45) / (0.88 - 0.45);
        D[i * 4] = D[i * 4 + 1] = D[i * 4 + 2] = t >= 1 ? 255 : t <= 0 ? 0 : 255 * t * t * (3 - 2 * t);
      }
    }
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
  const toJpeg = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function busy(text) {
    $('scan-busy').hidden = !text;
    $('scan-busy').textContent = text || '';
  }

  function setMode(mode) {
    const crop = mode === 'crop';
    const page = pages[current];
    $('scanner').hidden = false;
    $('scan-canvas').hidden = !crop;
    $('scan-svg').style.display = crop ? '' : 'none';
    $('scan-loupe').hidden = true;
    $('scan-retake').hidden = !crop;
    $('scan-keep').hidden = !crop;
    $('scan-preview').hidden = crop || !page;
    $('scan-filters').hidden = crop || !page;
    $('scan-add').hidden = crop;
    $('scan-send').hidden = crop;
    $('scan-title').textContent = crop ? 'Drag near a corner or edge'
      : page ? 'Page ' + (current + 1) + ' of ' + pages.length : 'No pages';
    $('scan-send').textContent = 'Send PDF (' + pages.length + ')';
    $('scan-send').disabled = pages.length === 0;
    if (!crop && page) $('scan-preview').src = page.url;
    renderFilters();
    renderPages();
  }

  // ----- corner adjusting -----

  function layout() {
    if (!src) return;
    const stage = $('scan-stage');
    const sw = stage.clientWidth, sh = stage.clientHeight, pad = 22;
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

  // Corners 0-3, then the midpoints of the edges (edge i joins corners i and i+1).
  function handles() {
    const list = quad.map((p, i) => ({ kind: 'corner', i, p }));
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      list.push({ kind: 'edge', i, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    }
    return list;
  }

  function drawQuad() {
    const pts = quad.map(toStage);
    let html = '<polygon class="scan-quad" points="' + pts.map((p) => p.join(',')).join(' ') + '"/>';
    handles().forEach((h) => {
      const [x, y] = toStage(h.p);
      const on = active && active.kind === h.kind && active.i === h.i;
      html += h.kind === 'corner'
        ? '<circle class="scan-handle' + (on ? ' on' : '') + '" cx="' + x + '" cy="' + y + '" r="' + (on ? 13 : 10) + '"/>'
        : '<circle class="scan-mid' + (on ? ' on' : '') + '" cx="' + x + '" cy="' + y + '" r="' + (on ? 8 : 6) + '"/>';
    });
    $('scan-svg').innerHTML = html;
  }

  // Magnifier in the top corner away from the finger, so the exact corner
  // stays visible while the finger covers it.
  function showLoupe() {
    if (!active || !src) return;
    const lp = $('scan-loupe');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.round(LOUPE * dpr);
    if (lp.width !== size) {
      lp.width = lp.height = size;
      lp.style.width = lp.style.height = LOUPE + 'px';
    }
    const focus = active.kind === 'corner' ? quad[active.i]
      : [(quad[active.i][0] + quad[(active.i + 1) % 4][0]) / 2, (quad[active.i][1] + quad[(active.i + 1) % 4][1]) / 2];
    const stageW = $('scan-stage').clientWidth;
    lp.style.left = (toStage(focus)[0] < stageW / 2 ? stageW - LOUPE - 14 : 14) + 'px';
    lp.style.top = '14px';
    lp.hidden = false;

    const g = lp.getContext('2d');
    const k = view.scale * ZOOM * dpr;  // loupe pixels per photo pixel
    const half = size / 2 / k;
    const sx0 = focus[0] - half, sy0 = focus[1] - half;
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    // Clip the source rectangle to the photo: Safari draws nothing otherwise.
    const cx0 = Math.max(0, sx0), cy0 = Math.max(0, sy0);
    const cx1 = Math.min(src.width, sx0 + 2 * half), cy1 = Math.min(src.height, sy0 + 2 * half);
    if (cx1 > cx0 && cy1 > cy0) {
      g.drawImage(src, cx0, cy0, cx1 - cx0, cy1 - cy0, (cx0 - sx0) * k, (cy0 - sy0) * k, (cx1 - cx0) * k, (cy1 - cy0) * k);
    }
    g.strokeStyle = '#22d3ee';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    quad.forEach((p, i) => {
      const x = (p[0] - sx0) * k, y = (p[1] - sy0) * k;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.closePath();
    g.stroke();
    const c = size / 2, arm = 9 * dpr;
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(c - arm, c); g.lineTo(c + arm, c);
    g.moveTo(c, c - arm); g.lineTo(c, c + arm);
    g.stroke();
  }

  // Touch anywhere: the nearest corner (or edge) is grabbed and follows the
  // finger's movement, not its position, so it never jumps under the finger.
  function bindDrag() {
    const stage = $('scan-stage');
    let drag = null;
    const pos = (e) => {
      const r = stage.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    stage.addEventListener('pointerdown', (e) => {
      if (!src || !view || $('scan-canvas').hidden) return;
      const f = pos(e);
      let best = null, bestD = Infinity;
      handles().forEach((h) => {
        const [x, y] = toStage(h.p);
        // Corners win when a corner and an edge midpoint are about as close.
        const d = Math.hypot(x - f[0], y - f[1]) * (h.kind === 'edge' ? 1.25 : 1);
        if (d < bestD) { bestD = d; best = h; }
      });
      drag = { h: best, start: f, orig: quad.map((p) => p.slice()) };
      active = best;
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      e.preventDefault();
      drawQuad();
      showLoupe();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const f = pos(e);
      const dx = (f[0] - drag.start[0]) / view.scale, dy = (f[1] - drag.start[1]) / view.scale;
      const move = (i) => {
        quad[i] = [clamp(drag.orig[i][0] + dx, 0, src.width), clamp(drag.orig[i][1] + dy, 0, src.height)];
      };
      move(drag.h.i);
      if (drag.h.kind === 'edge') move((drag.h.i + 1) % 4);
      drawQuad();
      showLoupe();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      active = null;
      $('scan-loupe').hidden = true;
      if (src) drawQuad();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  // ----- pages and styles -----

  function renderFilters() {
    const box = $('scan-filters');
    box.textContent = '';
    const page = pages[current];
    FILTERS.forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(!!page && page.filter === key));
      b.onclick = () => setFilter(key);
      box.appendChild(b);
    });
  }

  // Re-renders a page in its style from the straightened colour original.
  async function renderPage(p) {
    const c = await loadImage(p.warped);
    const out = applyFilter(c, p.filter);
    const blob = await toJpeg(out, 0.9);
    if (p.url) URL.revokeObjectURL(p.url);
    Object.assign(p, { blob, w: out.width, h: out.height, url: URL.createObjectURL(blob) });
  }

  async function setFilter(key) {
    const p = pages[current];
    if (!p || p.filter === key) return;
    p.filter = key;
    lastFilter = key;
    renderFilters();
    busy('Applying…');
    await nextFrame();
    try {
      await renderPage(p);
    } catch (e) {
      alert(e.message);
    } finally {
      busy('');
    }
    setMode('review');
  }

  function renderPages() {
    const strip = $('scan-pages');
    strip.textContent = '';
    pages.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'pg' + (!src && i === current ? ' sel' : '');
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = 'Page ' + (i + 1);
      img.onclick = () => {
        if (src) return;
        current = i;
        setMode('review');
      };
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.textContent = '×';
      rm.setAttribute('aria-label', 'Remove page ' + (i + 1));
      rm.onclick = () => {
        URL.revokeObjectURL(p.url);
        pages.splice(i, 1);
        if (i < current || current >= pages.length) current--;
        if (src) renderPages(); else setMode('review');
      };
      el.append(img, rm);
      strip.appendChild(el);
    });
    strip.hidden = pages.length === 0;
  }

  // ----- flow -----

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
      const flat = warp(src, quad);
      const p = { warped: await toJpeg(flat, 0.95), filter: lastFilter };
      const out = applyFilter(flat, p.filter);
      p.blob = await toJpeg(out, 0.9);
      p.w = out.width;
      p.h = out.height;
      p.url = URL.createObjectURL(p.blob);
      pages.push(p);
      current = pages.length - 1;
      src = null;
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
    current = -1;
    src = null;
    quad = null;
    active = null;
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
    $('scan-keep').onclick = keep;
    $('scan-send').onclick = finish;
    $('scan-cancel').onclick = () => {
      if (pages.length && !confirm('Discard ' + pages.length + ' scanned page(s)?')) return;
      close();
    };
    bindDrag();
    window.addEventListener('resize', () => { if (src) layout(); });
  }

  window.CellDeskScanner = { init, onPhoto, detectQuad, warp, applyFilter, buildPDF, setFilter };
})();
