// Zero-dependency QR Code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1 to 20, automatic mask selection by penalty score. Plus a terminal renderer that
// draws two module rows per text line with Unicode half blocks.

// Error correction level M per version: EC codewords per block, and block groups [count, data codewords].
const VERSIONS = [
  null,
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
  { ec: 30, groups: [[1, 50], [4, 51]] },
  { ec: 22, groups: [[6, 36], [2, 37]] },
  { ec: 22, groups: [[8, 37], [1, 38]] },
  { ec: 24, groups: [[4, 40], [5, 41]] },
  { ec: 24, groups: [[5, 41], [5, 42]] },
  { ec: 28, groups: [[7, 45], [3, 46]] },
  { ec: 28, groups: [[10, 46], [1, 47]] },
  { ec: 26, groups: [[9, 43], [4, 44]] },
  { ec: 26, groups: [[3, 44], [11, 45]] },
  { ec: 26, groups: [[3, 41], [13, 42]] },
];
// Alignment pattern centre coordinates per version.
const ALIGNMENT = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

export const MAX_VERSION = 20; // SPEC 12.4 (was 10 in 11.3)
const ECC_M_FORMAT_BITS = 0b00; // L=01, M=00, Q=11, H=10

// Mask conditions, (row, col). A module is flipped when the condition is true.
export const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ---------------------------------------------------------------- GF(256) and Reed-Solomon

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

export function gfPow2(i) {
  return EXP[i % 255];
}

/** Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power first. */
export function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Error correction codewords for one block: the remainder of data(x) * x^degree / g(x). */
export function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---------------------------------------------------------------- data codewords

export function dataCodewordCount(version) {
  return VERSIONS[version].groups.reduce((n, [count, data]) => n + count * data, 0);
}

function countBits(version) {
  return version <= 9 ? 8 : 16;
}

/** Bytes that fit in byte mode at level M. */
export function byteCapacity(version) {
  return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits(version)) / 8);
}

export const MAX_BYTES = byteCapacity(MAX_VERSION);
export const MAX_BYTES_V10 = byteCapacity(10);

/** Mode indicator, count, data, terminator, bit padding and pad codewords (0xEC, 0x11). */
export function encodeData(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewordCount(version) * 8;
  if (bits.length > capacityBits) throw new Error('data does not fit this version');
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCodewordCount(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add Reed-Solomon codewords, interleave data then EC codewords. */
export function buildCodewords(data, version) {
  const { ec, groups } = VERSIONS[version];
  const blocks = [];
  let k = 0;
  for (const [count, n] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + n);
      k += n;
      blocks.push({ data: d, ec: rsEncode(d, ec) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

export function blockLayout(version) {
  return VERSIONS[version];
}

// ---------------------------------------------------------------- format and version information

/** 15-bit format information for level M and a mask (BCH(15,5), XOR 0x5412). */
export function formatBits(mask) {
  const data = (ECC_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (BCH(18,6)), versions 7 and up. */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// Positions of the 15 format bits, bit i at index i: [first copy, second copy] as [row, col].
export function formatPositions(size) {
  const first = [];
  for (let i = 0; i <= 5; i++) first.push([i, 8]);
  first.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) first.push([8, 14 - i]);
  const second = [];
  for (let i = 0; i < 8; i++) second.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i++) second.push([size - 15 + i, 8]);
  return { first, second };
}

// Positions of the 18 version bits, bit i at index i: [top-right block, bottom-left block] as [row, col].
export function versionPositions(size) {
  const a = [];
  const b = [];
  for (let i = 0; i < 18; i++) {
    const x = size - 11 + (i % 3);
    const y = Math.floor(i / 3);
    a.push([y, x]);
    b.push([x, y]);
  }
  return { topRight: a, bottomLeft: b };
}

// ---------------------------------------------------------------- matrix

function grid(size, fill = 0) {
  return Array.from({ length: size }, () => new Uint8Array(size).fill(fill));
}

/** Function patterns for a version: { modules, isFunction }. Format bits are drawn for mask 0. */
export function functionPatterns(version) {
  const size = 17 + 4 * version;
  const modules = grid(size);
  const isFunction = grid(size);
  const set = (r, c, dark) => {
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = cr + dr;
        const c = cc + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(r, c, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = ALIGNMENT[version];
  const last = align.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) set(align[i] + dr, align[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }
  drawFormat(modules, isFunction, 0);
  if (version >= 7) {
    const bits = versionBits(version);
    const { topRight, bottomLeft } = versionPositions(size);
    for (let i = 0; i < 18; i++) {
      const dark = (bits >>> i) & 1;
      set(topRight[i][0], topRight[i][1], dark);
      set(bottomLeft[i][0], bottomLeft[i][1], dark);
    }
  }
  return { size, modules, isFunction };
}

function drawFormat(modules, isFunction, mask) {
  const size = modules.length;
  const bits = formatBits(mask);
  const { first, second } = formatPositions(size);
  for (let i = 0; i < 15; i++) {
    const dark = (bits >>> i) & 1;
    for (const [r, c] of [first[i], second[i]]) {
      modules[r][c] = dark;
      isFunction[r][c] = 1;
    }
  }
  modules[size - 8][8] = 1; // the dark module
  isFunction[size - 8][8] = 1;
}

/** Order in which data bits fill the non-function modules (two-column zigzag from the bottom right). */
export function dataPositions(isFunction) {
  const size = isFunction.length;
  const out = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) out.push([r, c]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- penalty

const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_LIKE_REV = [...FINDER_LIKE].reverse();

export function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const line = (get) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) {
        run++;
      } else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= size; i++) {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k++) {
        const v = get(i + k);
        if (v !== FINDER_LIKE[k]) a = false;
        if (v !== FINDER_LIKE_REV[k]) b = false;
      }
      if (a) s += 40;
      if (b) s += 40;
    }
    return s;
  };
  for (let r = 0; r < size; r++) score += line((i) => modules[r][i]);
  for (let c = 0; c < size; c++) score += line((i) => modules[i][c]);
  for (let r = 0; r + 1 < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const v of row) dark += v;
  const percent = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

// ---------------------------------------------------------------- encode

/**
 * Encode text (UTF-8 bytes) as a QR code at level M. Returns
 * { version, mask, size, modules } with modules[row][col] = 1 for dark.
 * Options: minVersion, mask (force one of 0-7; otherwise the lowest penalty wins).
 */
export function encodeQR(text, { minVersion = 1, mask: forcedMask } = {}) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = Math.max(1, minVersion);
  while (version <= MAX_VERSION && byteCapacity(version) < bytes.length) version++;
  if (version > MAX_VERSION) {
    throw new Error(`QR: ${bytes.length} bytes is too long (version ${MAX_VERSION}-M holds ${MAX_BYTES})`);
  }
  const codewords = buildCodewords(encodeData(bytes, version), version);
  const { size, modules: base, isFunction } = functionPatterns(version);
  const positions = dataPositions(isFunction);
  const unmasked = base.map((row) => Uint8Array.from(row));
  positions.forEach(([r, c], i) => {
    unmasked[r][c] = i < codewords.length * 8 ? (codewords[i >>> 3] >>> (7 - (i & 7))) & 1 : 0; // remainder bits stay light
  });
  const apply = (m) => {
    const out = unmasked.map((row) => Uint8Array.from(row));
    for (const [r, c] of positions) if (MASKS[m](r, c)) out[r][c] ^= 1;
    drawFormat(out, grid(size), m);
    return out;
  };
  let best = null;
  const candidates = forcedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  for (const m of candidates) {
    const modules = apply(m);
    const score = penalty(modules);
    if (!best || score < best.score) best = { mask: m, modules, score };
  }
  return { version, mask: best.mask, size, modules: best.modules, penalty: best.score };
}

// ---------------------------------------------------------------- terminal rendering

/**
 * Two module rows per line with half blocks and a quiet zone (4 modules by default).
 * ansi: wrap lines in black-on-white colours so the code reads correctly on dark terminals too.
 * Without ansi, dark modules are drawn as foreground blocks (right for light backgrounds and paper).
 */
export function renderHalfBlocks(qr, { quiet = 4, ansi = false } = {}) {
  const n = qr.size + quiet * 2;
  const dark = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    return rr >= 0 && rr < qr.size && cc >= 0 && cc < qr.size && qr.modules[rr][cc] === 1;
  };
  const lines = [];
  for (let r = 0; r < n; r += 2) {
    let line = '';
    for (let c = 0; c < n; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < n && dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}
