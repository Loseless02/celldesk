// Compact streaming SHA-256 used when WebCrypto is unavailable (plain-HTTP
// LAN and Tailscale pages are not a "secure context", so crypto.subtle is
// missing there) and for files too big to hash in one piece.
(function () {
  'use strict';
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));

  function Sha256() {
    this.H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.W = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
  }

  Sha256.prototype.block = function (b, o) {
    const W = this.W, H = this.H;
    for (let i = 0; i < 16; i++) {
      const j = o + i * 4;
      W[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ror(w15, 7) ^ ror(w15, 18) ^ (w15 >>> 3);
      const s1 = ror(w2, 17) ^ ror(w2, 19) ^ (w2 >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    let a = H[0], b2 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b2; b2 = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b2; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };

  Sha256.prototype.update = function (bytes) {
    let o = 0;
    const len = bytes.length;
    this.total += len;
    if (this.bufLen > 0) {
      const n = Math.min(64 - this.bufLen, len);
      this.buf.set(bytes.subarray(0, n), this.bufLen);
      this.bufLen += n;
      o = n;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; o + 64 <= len; o += 64) this.block(bytes, o);
    if (o < len) {
      this.buf.set(bytes.subarray(o), 0);
      this.bufLen = len - o;
    }
    return this;
  };

  Sha256.prototype.hex = function () {
    const rem = this.bufLen;
    const tail = new Uint8Array(rem < 56 ? 64 : 128);
    tail.set(this.buf.subarray(0, rem));
    tail[rem] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, Math.floor(this.total / 0x20000000));
    dv.setUint32(tail.length - 4, (this.total * 8) >>> 0);
    for (let t = 0; t < tail.length; t += 64) this.block(tail, t);
    let out = '';
    for (let i = 0; i < 8; i++) out += this.H[i].toString(16).padStart(8, '0');
    return out;
  };

  const sha256hex = (bytes) => new Sha256().update(bytes).hex();

  if (typeof window !== 'undefined') { window.sha256hex = sha256hex; window.Sha256 = Sha256; }
  if (typeof module !== 'undefined') module.exports = { sha256hex, Sha256 };
})();
