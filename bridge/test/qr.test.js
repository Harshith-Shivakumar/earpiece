// QR encoder: known vectors, structural invariants, and an independent read-back of every symbol
// (unmask, de-interleave, Reed-Solomon syndromes, byte-mode parse).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MASKS, MAX_BYTES, blockLayout, buildCodewords, byteCapacity, dataPositions, encodeData, encodeQR, formatBits,
  formatPositions, functionPatterns, gfMul, gfPow2, penalty, renderHalfBlocks, rsEncode, versionBits, versionPositions,
} from '../src/qr.js';

const hex = (s) => s.split(' ').map((h) => parseInt(h, 16));

describe('Reed-Solomon and data codewords', () => {
  it('matches the ISO/IEC 18004 Annex I example "01234567", version 1-M', () => {
    const data = hex('10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11');
    assert.deepEqual(rsEncode(data, 10), hex('A5 24 D4 C1 ED 36 C7 87 2C 55'));
  });

  it('matches the Thonky "HELLO WORLD" example, version 1-M', () => {
    const data = hex('20 5B 0B 78 D1 72 DC 4D 43 40 EC 11 EC 11 EC 11');
    assert.deepEqual(rsEncode(data, 10), hex('C4 23 27 77 EB D7 E7 E2 5D 17'));
  });

  it('packs byte mode with terminator and pad codewords', () => {
    // 0100 | 00000010 | 01101000 01101001 | 0000 -> 40 26 86 90, then EC 11 ... to 16 codewords
    assert.deepEqual(encodeData(Buffer.from('hi'), 1), hex('40 26 86 90 EC 11 EC 11 EC 11 EC 11 EC 11 EC 11'));
    // Version 10 uses a 16-bit count.
    assert.deepEqual(encodeData(Buffer.from('A'), 10).slice(0, 4), hex('40 00 14 10'));
  });

  it('has the level M byte capacities of versions 1 to 20', () => {
    assert.deepEqual(
      Array.from({ length: 20 }, (_, i) => byteCapacity(i + 1)),
      [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666],
    );
    assert.equal(MAX_BYTES, 666);
  });

  it('interleaves blocks (version 5-M: two blocks of 43 + 24)', () => {
    const data = Array.from({ length: 86 }, (_, i) => i);
    const cw = buildCodewords(data, 5);
    assert.equal(cw.length, 134);
    assert.deepEqual(cw.slice(0, 4), [0, 43, 1, 44]);
    assert.deepEqual(cw.slice(86, 88), [rsEncode(data.slice(0, 43), 24)[0], rsEncode(data.slice(43), 24)[0]]);
  });
});

describe('format and version information', () => {
  it('produces the standard level M format strings', () => {
    const expected = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((m) => formatBits(m).toString(2).padStart(15, '0')), expected);
  });

  it('produces the standard version strings for 7 to 20', () => {
    assert.deepEqual(
      Array.from({ length: 14 }, (_, i) => versionBits(i + 7).toString(16).toUpperCase().padStart(5, '0')),
      ['07C94', '085BC', '09A99', '0A4D3', '0BBF6', '0C762', '0D847', '0E60D', '0F928', '10B78', '1145D', '12A17', '13532', '149A6'],
    );
  });
});

/** Independent reader: pull codewords out of a symbol and parse the byte-mode text. */
function readBack(qr) {
  const { isFunction } = functionPatterns(qr.version);
  const bits = dataPositions(isFunction).map(([r, c]) => qr.modules[r][c] ^ (MASKS[qr.mask](r, c) ? 1 : 0));
  const { ec, groups } = blockLayout(qr.version);
  const sizes = groups.flatMap(([count, n]) => Array(count).fill(n));
  const total = sizes.reduce((a, b) => a + b, 0) + ec * sizes.length;
  const codewords = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  // De-interleave.
  const blocks = sizes.map(() => ({ data: [], ec: [] }));
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((n, b) => i < n && blocks[b].data.push(codewords[k++]));
  for (let i = 0; i < ec; i++) blocks.forEach((b) => b.ec.push(codewords[k++]));
  // Every block must be a valid Reed-Solomon codeword: all syndromes zero.
  for (const b of blocks) {
    const c = [...b.data, ...b.ec];
    for (let i = 0; i < ec; i++) {
      let s = 0;
      for (const v of c) s = gfMul(s, gfPow2(i)) ^ v; // Horner at alpha^i
      assert.equal(s, 0, `syndrome ${i} of a block is not zero`);
    }
  }
  const data = blocks.flatMap((b) => b.data);
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  const take = (n) => stream.splice(0, n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(4), 0b0100, 'byte mode');
  const len = take(qr.version <= 9 ? 8 : 16);
  return Buffer.from(Array.from({ length: len }, () => take(8))).toString('utf8');
}

function readFormat(qr) {
  const { first, second } = formatPositions(qr.size);
  const read = (pos) => pos.reduce((acc, [r, c], i) => acc | (qr.modules[r][c] << i), 0);
  return [read(first), read(second)];
}

const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
const textFor = (v) => {
  let s = `v${v}:`;
  while (Buffer.byteLength(s) < byteCapacity(v)) s += 'Earpiece ✓ '[s.length % 11];
  while (Buffer.byteLength(s) > byteCapacity(v)) s = s.slice(0, -1);
  return s;
};

describe('symbols', () => {
  for (let v = 1; v <= 20; v++) {
    it(`version ${v}: structure, format, version info and data read back`, () => {
      const text = textFor(v);
      const qr = encodeQR(text);
      assert.equal(qr.version, v);
      assert.equal(qr.size, 17 + 4 * v);
      const m = qr.modules;
      const n = qr.size;
      // Finder patterns and their light separators.
      for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
        for (let r = 0; r < 7; r++) assert.equal([...m[r0 + r].slice(c0, c0 + 7)].join(''), FINDER[r]);
      }
      for (let i = 0; i < 8; i++) {
        assert.equal(m[7][i], 0);
        assert.equal(m[i][7], 0);
        assert.equal(m[7][n - 1 - i], 0);
        assert.equal(m[n - 8][i], 0);
      }
      // Timing patterns.
      for (let i = 8; i < n - 8; i++) {
        assert.equal(m[6][i], i % 2 === 0 ? 1 : 0);
        assert.equal(m[i][6], i % 2 === 0 ? 1 : 0);
      }
      assert.equal(m[n - 8][8], 1, 'dark module');
      // Format information: both copies agree, decode to level M and the chosen mask.
      const [f1, f2] = readFormat(qr);
      assert.equal(f1, f2);
      const data = (f1 ^ 0x5412) >>> 10;
      assert.equal(data >>> 3, 0b00, 'level M');
      assert.equal(data & 7, qr.mask);
      assert.equal(f1, formatBits(qr.mask), 'BCH check bits are right');
      // Version information from version 7.
      if (v >= 7) {
        const { topRight, bottomLeft } = versionPositions(n);
        const read = (pos) => pos.reduce((acc, [r, c], i) => acc | (m[r][c] << i), 0);
        assert.equal(read(topRight), versionBits(v));
        assert.equal(read(bottomLeft), versionBits(v));
      }
      // Alignment pattern at the bottom-right centre (versions 2+).
      if (v >= 2) {
        const c = n - 7;
        assert.equal(m[c][c], 1);
        for (const [dr, dc] of [[-1, -1], [-1, 0], [0, 1], [1, 1]]) assert.equal(m[c + dr][c + dc], 0);
        for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2], [0, 2]]) assert.equal(m[c + dr][c + dc], 1);
      }
      assert.equal(readBack(qr), text);
    });
  }

  it('every mask gives a valid, readable symbol, and the lowest penalty wins', () => {
    const text = 'earpiece://pair?v=1&name=Mac&id=x&token=y';
    const scores = [];
    for (let mask = 0; mask < 8; mask++) {
      const qr = encodeQR(text, { mask });
      assert.equal(qr.mask, mask);
      assert.equal(readFormat(qr)[0], formatBits(mask));
      assert.equal(readBack(qr), text);
      scores.push(penalty(qr.modules));
    }
    const auto = encodeQR(text);
    assert.equal(auto.penalty, Math.min(...scores));
    assert.equal(scores[auto.mask], auto.penalty);
  });

  it('scores the penalty rules', () => {
    const allLight = Array.from({ length: 21 }, () => new Uint8Array(21));
    // 42 runs of 21 (3 + 16 each), 400 2x2 blocks (3 each), 0% dark (10 * 10).
    assert.equal(penalty(allLight), 42 * 19 + 400 * 3 + 100);
  });

  it('refuses text longer than version 20-M holds', () => {
    assert.throws(() => encodeQR('x'.repeat(MAX_BYTES + 1)), /too long/);
    assert.equal(encodeQR('x'.repeat(MAX_BYTES)).version, 20);
  });

  it('functionPatterns does not reserve data modules', () => {
    for (let v = 1; v <= 20; v++) {
      const { isFunction } = functionPatterns(v);
      const { ec, groups } = blockLayout(v);
      const codewords = groups.reduce((a, [c, n]) => a + c * (n + ec), 0);
      const remainder = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3][v];
      assert.equal(dataPositions(isFunction).length, codewords * 8 + remainder, `version ${v}`);
    }
  });
});

describe('terminal rendering', () => {
  it('draws two rows per line with a 4-module quiet zone', () => {
    const qr = encodeQR('hello');
    const lines = renderHalfBlocks(qr).split('\n');
    assert.equal(lines.length, Math.ceil((qr.size + 8) / 2));
    for (const l of lines) assert.equal([...l].length, qr.size + 8);
    assert.equal(lines[0].trim(), '');
    assert.equal(lines[1].trim(), '');
    assert.equal(lines[2].slice(4, 11), '█▀▀▀▀▀█', 'rows 0-1 of the top-left finder');
    assert.equal(lines[2].slice(0, 4), '    ');
  });

  it('wraps lines in black-on-white when asked', () => {
    const lines = renderHalfBlocks(encodeQR('hi'), { ansi: true }).split('\n');
    for (const l of lines) {
      assert.ok(l.startsWith('\x1b[30;47m'));
      assert.ok(l.endsWith('\x1b[0m'));
    }
  });
});
