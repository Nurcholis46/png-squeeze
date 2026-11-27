// png-squeeze entry: lossless PNG recompression for 1280x720 screenshots.
// Reads each stored PNG under the input directory, decodes it to RGBA, then
// searches colour-type reductions (palette, grey, RGB, tRNS keys), per-row
// PNG filters (fixed, heuristics, and a zlib-weighed brute force), and zlib
// settings, keeping the smallest exact file. Pure Node builtins, no clock,
// no randomness: the same input always yields the same bytes.

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32 --

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------- PNG decode --

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

// Decode an 8-bit non-interlaced PNG of colour type 0/2/3/4/6 to RGBA.
// The contest inputs are stored type-6 files, but every accepted form is
// handled so the program stays correct on any well-formed answer-shaped PNG.
function decodePng(bytes: Uint8Array): DecodedImage {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) {
    throw new Error('input does not start with the PNG signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let sawIend = false;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('truncated chunk');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error('chunk ' + type + ' fails CRC');
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) throw new Error('unsupported colour type ' + colourType);
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('unsupported IHDR flags');
    } else if (type === 'PLTE') {
      palette = new Uint8Array(data);
    } else if (type === 'tRNS') {
      trns = new Uint8Array(data);
    } else if (type === 'IDAT') {
      idatParts.push(new Uint8Array(data));
    } else if (type === 'IEND') {
      sawIend = true;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (!sawIend || idatParts.length === 0 || width === 0) throw new Error('incomplete PNG');
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const joined = idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts);
  const raw = inflateSync(joined, { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflated size mismatch');

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? samples[o + i - bpp] : 0;
        const up = y > 0 ? samples[p + i] : 0;
        samples[o + i] = raw[src + i] + ((left + up) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else {
      throw new Error('bad filter type ' + ft);
    }
  }

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette image without PLTE');
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------------- PNG encode --

function ihdrData(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  d[10] = 0;
  d[11] = 0;
  d[12] = 0;
  return d;
}

function assemblePng(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

// ------------------------------------------------------------ image study --

interface ColourInfo {
  word: number;
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
  first: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: ColourInfo[] | null; // null when more than 256 distinct RGBA values
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, n);
  let opaque = true;
  let grey = true;
  const byWord = new Map<number, ColourInfo>();
  let overflow = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!overflow) {
      const w = words[i];
      const seen = byWord.get(w);
      if (seen === undefined) {
        if (byWord.size >= 256) overflow = true;
        else byWord.set(w, { word: w, r: rgba[d], g: rgba[d + 1], b: rgba[d + 2], a, count: 1, first: i });
      } else {
        seen.count++;
      }
    }
  }
  return { opaque, grey, colours: overflow ? null : [...byWord.values()] };
}

// The single transparent colour usable as a tRNS key, or -1. Requires every
// pixel to be opaque or exactly that colour at alpha 0, and no opaque pixel
// to share the colour (so the key stays unambiguous and colours stay exact).
function transparentKeyOf(rgba: Uint8Array, grey: boolean): number {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

function samplesFor(rgba: Uint8Array, colourType: number): Uint8Array {
  if (colourType === 6) return rgba;
  const n = rgba.length >>> 2;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

type PaletteOrder = 'count' | 'luminance' | 'first' | 'morton';

// Spread the bits of a 5-bit value so colours can be ordered along a Morton
// (Z-order) curve through RGB space: neighbours on the curve are close in
// colour, which keeps Sub-filter differences of palette indices small.
function spread5(v: number): number {
  let x = v & 31;
  x = (x | (x << 8)) & 0x00f00f;
  x = (x | (x << 4)) & 0x0c30c3;
  x = (x | (x << 2)) & 0x249249;
  return x;
}

function mortonKey(c: ColourInfo): number {
  return spread5(c.r >> 3) | (spread5(c.g >> 3) << 1) | (spread5(c.b >> 3) << 2);
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

// Palette entries: non-opaque colours first (by alpha, so tRNS is a short
// prefix), then opaque colours in the requested order. Ties break on the
// packed word so the result never depends on map iteration quirks.
function paletteForm(rgba: Uint8Array, colours: ColourInfo[], order: PaletteOrder): PaletteForm {
  const luminance = (c: ColourInfo): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first || x.word - y.word;
    if (order === 'morton') return mortonKey(x) - mortonKey(y) || luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const indexOf = new Map<number, number>();
  entries.forEach((c, i) => indexOf.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let trnsLen = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) trnsLen = i + 1;
  });
  const trns = trnsLen === 0 ? null : Uint8Array.from(entries.slice(0, trnsLen), (c) => c.a);
  const n = rgba.length >>> 2;
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = indexOf.get(words[i]) as number;
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- filters --

function filterRowInto(
  type: number,
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + up) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function distinctPairs(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let count = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      count++;
    }
  }
  return count;
}

// Order-0 entropy of the row in bits, scaled: lower means the byte histogram
// is peakier, which deflate's Huffman stage likes. The histogram buffer is
// caller-owned and reset through the touched list to avoid reallocation.
function entropyCost(row: Uint8Array, hist: Uint32Array, touched: number[]): number {
  touched.length = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (hist[v] === 0) touched.push(v);
    hist[v]++;
  }
  let cost = 0;
  const total = row.length;
  for (const v of touched) {
    const c = hist[v];
    cost += c * Math.log2(total / c);
    hist[v] = 0;
  }
  return cost;
}

type FilterChoice = number | 'minsum' | 'pairs' | 'entropy' | 'brute';

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Build the filtered raw stream (filter byte + filtered row, per row) for one
// sample buffer under one filter choice. 'brute' weighs each row's five
// filtered forms by actually deflating them after the preceding bytes.
function buildFiltered(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: FilterChoice,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  if (typeof choice === 'number') {
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      const at = y * (stride + 1);
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
    }
    return raw;
  }
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  const seen = new Uint32Array(65536);
  const hist = new Uint32Array(256);
  const touched: number[] = [];
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let bestType = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trials[t].subarray(1));
      else if (choice === 'pairs') cost = distinctPairs(trials[t].subarray(1), seen, ++stamp);
      else if (choice === 'entropy') cost = entropyCost(trials[t].subarray(1), hist, touched);
      else {
        cost =
          before.length === 0
            ? deflateSync(trials[t], { level: BRUTE_LEVEL, memLevel: 9 }).length
            : deflateSync(trials[t], { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
      }
    }
    raw.set(trials[bestType], at);
  }
  return raw;
}

// -------------------------------------------------------------- squeezing --

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

function formsFor(rgba: Uint8Array): Form[] {
  const info = analyse(rgba);
  const forms: Form[] = [];
  const channelFilters: FilterChoice[] = [0, 1, 2, 3, 4, 'minsum', 'pairs', 'entropy', 'brute'];
  if (info.colours !== null) {
    const orders: Array<[PaletteOrder, FilterChoice[]]> = [
      ['count', [0, 'minsum', 'entropy']],
      ['luminance', [0, 'minsum', 'pairs', 'entropy', 'brute']],
      ['first', [0, 'minsum', 'entropy']],
      ['morton', [0, 'minsum', 'brute']],
    ];
    for (const [order, filters] of orders) {
      const p = paletteForm(rgba, info.colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    // A non-grey palette image is held in a third of the bytes or less, so
    // the wider channel form cannot win; a grey one still gets its grey form.
    if (!info.grey) return forms;
  }
  const key = info.opaque ? -1 : transparentKeyOf(rgba, info.grey);
  let colourType: number;
  let trns: Uint8Array | null = null;
  if (info.grey) {
    colourType = info.opaque || key >= 0 ? 0 : 4;
    if (key >= 0) trns = Uint8Array.of(0, key);
  } else {
    colourType = info.opaque || key >= 0 ? 2 : 6;
    if (key >= 0) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({
    colourType,
    bpp: CHANNELS[colourType],
    samples: samplesFor(rgba, colourType),
    plte: null,
    trns,
    filters: channelFilters,
  });
  return forms;
}

function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

interface Candidate {
  form: Form;
  choice: FilterChoice;
  raw: Uint8Array;
  screenStream: Uint8Array; // the screening zlib stream itself, kept for the final pick
  screenBytes: number; // screenStream bytes + PLTE/tRNS bytes
}

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY } as const;

// Level-9 settings for the two-stage refine below. Both memLevels earn
// their place: on screenshot data memLevel 8's smaller hash table sometimes
// finds the shorter stream, memLevel 9 sometimes does, so the pick is by
// measurement. Z_FILTERED stays as insurance for heavily filtered streams;
// the RLE and FIXED strategies never won on this content and only cost time.
const REFINE_FIRST = { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY } as const;
const REFINE_SECOND: Array<{ level: number; memLevel: number; strategy: number }> = [
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
];

// FNV-1a over the raw stream, used only to spot byte-identical finalists so
// the same stream is never deflated twice at level 9.
function rawHash(raw: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function squeeze(image: DecodedImage): Uint8Array {
  const { width, height, rgba } = image;
  const candidates: Candidate[] = [];
  for (const form of formsFor(rgba)) {
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      const raw = buildFiltered(form.samples, width, height, form.bpp, choice);
      const stream = deflateSync(raw, SCREEN_OPTS);
      candidates.push({
        form,
        choice,
        raw,
        screenStream: new Uint8Array(stream),
        screenBytes: stream.length + overhead,
      });
    }
  }
  candidates.sort((a, b) => a.screenBytes - b.screenBytes);

  // Refine the strongest few filtered streams at level 9. The screening
  // stream stays in the race (the final pick is by measured bytes, so a
  // level-9 stream that somehow loses is simply not chosen), and identical
  // raw streams among the finalists are refined only once.
  const finalists: Candidate[] = [];
  const seenRaw = new Set<number>();
  for (const cand of candidates) {
    if (finalists.length >= 3) break;
    const h = rawHash(cand.raw);
    if (seenRaw.has(h)) continue;
    seenRaw.add(h);
    finalists.push(cand);
  }
  // Stage one: every finalist at the first level-9 setting. Stage two: the
  // two strongest finalists also at the remaining settings, since the
  // winning raw stream is stable across settings on this content while the
  // winning setting is not. Every stream is weighed with its form's
  // PLTE/tRNS bytes, and the screening stream remains a candidate throughout.
  interface Refined {
    cand: Candidate;
    stream: Uint8Array;
    total: number;
  }
  const refined: Refined[] = finalists.map((cand) => {
    const overhead = chunkOverhead(cand.form);
    let stream: Uint8Array = cand.screenStream;
    const first = deflateSync(cand.raw, REFINE_FIRST);
    if (first.length < stream.length) stream = new Uint8Array(first);
    return { cand, stream, total: stream.length + overhead };
  });
  refined.sort((a, b) => a.total - b.total);
  for (const entry of refined.slice(0, 2)) {
    const overhead = chunkOverhead(entry.cand.form);
    for (const opts of REFINE_SECOND) {
      const stream = deflateSync(entry.cand.raw, opts);
      if (stream.length + overhead < entry.total) {
        entry.stream = new Uint8Array(stream);
        entry.total = stream.length + overhead;
      }
    }
  }
  refined.sort((a, b) => a.total - b.total);
  const winner = refined[0];
  if (winner === undefined) throw new Error('no candidate produced');
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrData(width, height, winner.cand.form.colourType)]];
  if (winner.cand.form.plte !== null) chunks.push(['PLTE', winner.cand.form.plte]);
  if (winner.cand.form.trns !== null) chunks.push(['tRNS', winner.cand.form.trns]);
  chunks.push(['IDAT', winner.stream]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

// ------------------------------------------------------------------- main --

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inputPath = join(INPUT_DIR, id, 'image.png');
  const image = decodePng(new Uint8Array(readFileSync(inputPath)));
  const png = squeeze(image);
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  chmodSync(outDir, 0o755);
  const outPath = join(outDir, 'image.png');
  writeFileSync(outPath, png);
  chmodSync(outPath, 0o644);
}
