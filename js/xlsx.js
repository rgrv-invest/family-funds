// Reads an Excel .xlsx file in the browser, including one locked with a password (Excel's
// "Standard" encryption, as Axis Direct uses). No libraries: a compound-file reader, SHA-1 and
// AES-128 for the decryption, the browser's DecompressionStream to unzip, and a small sheet reader.
// Returns each sheet as rows of cell values (strings or numbers; empty cells undefined).

// ---------- compound file (the container a password-protected .xlsx is wrapped in) ----------
function readCfb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const sec = 1 << dv.getUint16(30, true), mini = 1 << dv.getUint16(32, true);
  const at = (s) => (s + 1) * sec; // the header takes the first sector's worth of bytes
  // FAT sectors: 109 listed in the header, more in the DIFAT chain.
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const s = u32(76 + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
  for (let d = u32(68), n = u32(72); n-- > 0 && d < 0xfffffffa;) {
    for (let i = 0; i < sec / 4 - 1; i++) { const s = u32(at(d) + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
    d = u32(at(d) + sec - 4);
  }
  const fat = []; for (const s of fatSecs) for (let i = 0; i < sec / 4; i++) fat.push(u32(at(s) + i * 4));
  const chain = (start, table) => { const out = []; for (let s = start; s < 0xfffffffa && out.length <= table.length; s = table[s]) out.push(s); return out; };
  const readChain = (start) => { const parts = chain(start, fat).map((s) => buf.subarray(at(s), at(s) + sec)); const out = new Uint8Array(parts.length * sec); parts.forEach((p, i) => out.set(p, i * sec)); return out; };
  const dir = readChain(u32(48));
  const ddv = new DataView(dir.buffer);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = ddv.getUint16(o + 64, true);
    entries.push({
      name: String.fromCharCode(...new Uint16Array(dir.buffer.slice(o, o + Math.max(0, len - 2)))),
      type: dir[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true),
    });
  }
  const root = entries[0];
  const miniFat = []; if (u32(60) < 0xfffffffa) { const m = readChain(u32(60)); const mdv = new DataView(m.buffer); for (let i = 0; i < m.length; i += 4) miniFat.push(mdv.getUint32(i, true)); }
  const miniData = root.start < 0xfffffffa ? readChain(root.start) : new Uint8Array();
  return (name) => {
    const e = entries.find((x) => x.name === name && x.type === 2);
    if (!e) return null;
    if (e.size < u32(56)) { // small streams live in the mini stream
      const out = new Uint8Array(e.size); let o = 0;
      for (const s of chain(e.start, miniFat)) { const n = Math.min(mini, e.size - o); out.set(miniData.subarray(s * mini, s * mini + n), o); o += n; if (o >= e.size) break; }
      return out;
    }
    return readChain(e.start).subarray(0, e.size);
  };
}

// ---------- SHA-1 ----------
function sha1(bytes) {
  const ml = bytes.length, words = new Uint32Array((((ml + 8) >> 6) + 1) * 16);
  for (let i = 0; i < ml; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
  words[words.length - 1] = ml * 8;
  let [a, b, c, d, e] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[i + t] : ((x) => (x << 1) | (x >>> 31))(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]);
    let [A, B, C, D, E] = [a, b, c, d, e];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (B & C) | (~B & D) : t < 40 ? B ^ C ^ D : t < 60 ? (B & C) | (B & D) | (C & D) : B ^ C ^ D;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (((A << 5) | (A >>> 27)) + f + E + k + w[t]) >>> 0;
      E = D; D = C; C = (B << 30) | (B >>> 2); B = A; A = tmp;
    }
    a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0; e = (e + E) >>> 0;
  }
  const out = new Uint8Array(20);
  [a, b, c, d, e].forEach((v, i) => { out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v; });
  return out;
}
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

// ---------- AES-128 decryption (ECB, block by block) ----------
const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();
const xt = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (x, y) => { let r = 0; while (y) { if (y & 1) r ^= x; x = xt(x); y >>= 1; } return r; };
function expandKey(key) {
  const w = new Uint8Array(176); w.set(key);
  for (let i = 16, rc = 1; i < 176; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % 16 === 0) { t = new Uint8Array([SBOX[t[1]] ^ rc, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rc = xt(rc); }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}
function aesDecryptEcb(data, key) {
  const w = expandKey(key), out = new Uint8Array(data.length - (data.length % 16)), s = new Uint8Array(16), t = new Uint8Array(16);
  for (let o = 0; o < out.length; o += 16) {
    for (let i = 0; i < 16; i++) s[i] = data[o + i] ^ w[160 + i];
    for (let round = 9; round >= 0; round--) {
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = s[c * 4 + r]; // inverse shift rows
      for (let i = 0; i < 16; i++) s[i] = INV[t[i]] ^ w[round * 16 + i];
      if (round) for (let c = 0; c < 4; c++) { // inverse mix columns
        const [a0, a1, a2, a3] = s.slice(c * 4, c * 4 + 4);
        s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    }
    out.set(s, o);
  }
  return out;
}

// ECMA-376 Standard encryption: key from SHA-1 of salt + password, 50,000 rounds.
export function decryptStandard(cfbBytes, password) {
  const stream = readCfb(cfbBytes);
  const info = stream('EncryptionInfo'), pkg = stream('EncryptedPackage');
  if (!info || !pkg) throw new Error('This file isn’t a password-protected Excel workbook.');
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const [vmaj, vmin] = [dv.getUint16(0, true), dv.getUint16(2, true)];
  if (vmin !== 2 || (vmaj !== 3 && vmaj !== 4)) throw new Error('This workbook uses a newer kind of Excel password protection the app can’t open yet. Save a copy without the password and import that.');
  const hsize = dv.getUint32(8, true), keyBits = dv.getUint32(12 + 16, true);
  const v = 12 + hsize, salt = info.subarray(v + 4, v + 20), encVerifier = info.subarray(v + 20, v + 36), encHash = info.subarray(v + 40, v + 72);
  const pw = new Uint8Array([...password].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]));
  let h = sha1(concat(salt, pw));
  for (let i = 0; i < 50000; i++) h = sha1(concat(le32(i), h));
  h = sha1(concat(h, le32(0)));
  const x1 = new Uint8Array(64).fill(0x36), x2 = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < 20; i++) { x1[i] ^= h[i]; x2[i] ^= h[i]; }
  const key = concat(sha1(x1), sha1(x2)).subarray(0, keyBits / 8);
  const verifier = aesDecryptEcb(encVerifier, key), vh = aesDecryptEcb(encHash, key).subarray(0, 20), check = sha1(verifier);
  if (!check.every((b, i) => b === vh[i])) throw new Error('That password didn’t open the file. For Axis Direct reports it’s usually the PAN in capital letters.');
  const size = new DataView(pkg.buffer, pkg.byteOffset, 8).getUint32(0, true);
  return aesDecryptEcb(pkg.subarray(8), key).subarray(0, size);
}

// ---------- zip + sheets ----------
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22; while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Couldn’t read this file as an Excel workbook (.xlsx).');
  const files = {};
  for (let o = dv.getUint32(eocd + 16, true), n = dv.getUint16(eocd + 10, true); n-- > 0;) {
    const method = dv.getUint16(o + 10, true), csize = dv.getUint32(o + 20, true), nlen = dv.getUint16(o + 28, true);
    const elen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true), local = dv.getUint32(o + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nlen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    files[name] = { method, data: bytes.subarray(start, start + csize) };
    o += 46 + nlen + elen + clen;
  }
  return async (name) => {
    const f = files[name];
    if (!f) return null;
    if (f.method === 0) return new TextDecoder().decode(f.data);
    const out = new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
    return out.text();
  };
}
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');
const colIndex = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export async function readXlsx(bytes, password = '') {
  let data = bytes;
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) { // compound file: a password-protected workbook
    if (!password) throw new Error('This file is password-protected. Enter its password (for Axis Direct, usually the PAN in capital letters).');
    data = decryptStandard(bytes, password);
  }
  const get = await unzip(data);
  const shared = [...((await get('xl/sharedStrings.xml')) || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const book = (await get('xl/workbook.xml')) || '';
  const rels = (await get('xl/_rels/workbook.xml.rels')) || '';
  const sheets = [];
  for (const m of book.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)) {
    const target = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`))?.[1] || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`))?.[1];
    const xml = target && (await get(target.startsWith('/') ? target.slice(1) : `xl/${target}`));
    const rows = [];
    for (const r of (xml || '').matchAll(/<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+\d+)"/)?.[1], type = c[1].match(/t="(\w+)"/)?.[1], body = c[2] || '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const val = type === 's' ? shared[+v] : type === 'inlineStr' ? texts(body) : type === 'str' ? unescape(v ?? '') : v == null ? undefined : isNaN(+v) ? unescape(v) : +v;
        if (ref && val !== undefined && val !== '') row[colIndex(ref)] = val;
      }
      rows[+r[1] - 1] = row;
    }
    sheets.push({ name: unescape(m[1]), rows: Array.from(rows, (r) => r || []) });
  }
  return sheets;
}
