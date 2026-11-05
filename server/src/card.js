// The cards people post on X, 1600 x 900 in the site's pixel style: the burn card ("BURNT 5 NFTs · 50,000 $PROMPT")
// and the free airdrop card ("FREE 1,000 $PROMPT").
// Drawn here pixel by pixel with a small bitmap font, no image libraries: /burn/<id>.png (app.js) renders it once and
// the CDN keeps it. The burned NFTs come from the thumbnails the function carries (collection/thumbs, 252 px).
import fs from 'node:fs';
import path from 'node:path';
import { readPng, toRgba, encodeRgb } from './png.js';

export const W = 1600;
export const H = 900;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  bg: hex('#120626'), dot: hex('#22103D'), tile: hex('#1B0B33'), edge: hex('#2E1A4D'),
  cream: hex('#FFF3E6'), red: hex('#FF4FA3'), dim: hex('#B9A8C9'), ink: hex('#120626'),
  orange: hex('#FF8A3D'), yellow: hex('#FFD23F'),
};

// 5 x 7 pixel glyphs ("#" lit); narrow ones are fewer columns wide
const G = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '-': ['....', '....', '....', '####', '....', '....', '....'],
  '→': ['.....', '..#..', '...#.', '#####', '...#.', '..#..', '.....'],
  ',': ['..', '..', '..', '..', '.#', '.#', '#.'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ':': ['.', '.', '#', '.', '.', '#', '.'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '·': ['.', '.', '.', '#', '.', '.', '.'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
};
const glyph = (ch) => G[ch] || G[String(ch).toUpperCase()] || G[' '];
export const textWidth = (text, scale) => [...String(text)].reduce((w, ch, i) => w + (glyph(ch)[0].length + (i ? 1 : 0)) * scale, 0);

// the market's logo: a Prompt City citizen in pink shades (the same as the site's), 19 x 16
const LOGO = [
  ['#1B1020', 'M6 0h7v1h-7zM5 1h9v1h-9zM4 2h11v1h-11zM4 3h1v1h-1zM14 3h1v1h-1z'],
  ['#E8B98F', 'M5 3h9v1h-9zM4 4h11v1h-11zM4 7h11v1h-11zM4 8h5v1h-5zM10 8h5v1h-5zM4 9h11v1h-11zM4 10h3v1h-3zM12 10h3v1h-3zM5 11h9v1h-9z'],
  ['#C98E62', 'M9 8h1v1h-1zM7 12h5v1h-5zM8 13h3v1h-3z'],
  ['#FF4FA3', 'M3 5h13v1h-13zM3 6h1v1h-1zM8 6h3v1h-3zM15 6h1v1h-1z'],
  ['#120626', 'M4 6h4v1h-4zM11 6h4v1h-4z'],
  ['#FFF3E6', 'M7 10h5v1h-5z'],
  ['#2DE2E6', 'M3 13h4v1h-4zM12 13h4v1h-4zM2 14h6v1h-6zM11 14h6v1h-6zM1 15h17v1h-17z'],
  ['#FFD23F', 'M7 13h1v1h-1zM11 13h1v1h-1zM8 14h3v1h-3z'],
];

function canvas() {
  const px = new Uint8Array(W * H * 3);
  const rect = (x, y, w, h, c) => {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(W, Math.round(x + w));
    const y1 = Math.min(H, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const o = (yy * W + xx) * 3;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
      }
    }
  };
  const text = (s, x, y, scale, color) => {
    let cx = x;
    for (const ch of String(s)) {
      const g = glyph(ch);
      for (let r = 0; r < 7; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '#') rect(cx + c * scale, y + r * scale, scale, scale, color);
      cx += (g[0].length + 1) * scale;
    }
    return cx - scale; // where the text ends
  };
  return { px, rect, text };
}

// the largest whole scale (up to max) at which the text fits in width
const fit = (s, width, max) => {
  let sc = max;
  while (sc > 2 && textWidth(s, sc) > width) sc--;
  return sc;
};

// one NFT into a size x size square: the thumbnail (252 px), every source pixel sampled once per target pixel
// false when the picture couldn't be read (a placeholder is drawn instead)
function drawNft(cv, thumbsDir, id, pixel, x, y, size) {
  let img;
  try {
    img = readPng(fs.readFileSync(path.join(thumbsDir, `${Number(id)}.png`)));
  } catch {
    cv.rect(x, y, size, size, C.tile);
    cv.text(`#${id}`, x + 12, y + size / 2 - 14, 4, C.dim);
    return false;
  }
  const rgba = toRgba(img);
  // pixel art: the 28 x 28 grid inside the 252 px thumbnail, each cell one block
  const grid = pixel && img.width % 28 === 0 ? 28 : null;
  for (let ty = 0; ty < size; ty++) {
    const sy = grid ? Math.floor(((Math.floor((ty * grid) / size) + 0.5) * img.height) / grid) : Math.floor((ty * img.height) / size);
    for (let tx = 0; tx < size; tx++) {
      const sx = grid ? Math.floor(((Math.floor((tx * grid) / size) + 0.5) * img.width) / grid) : Math.floor((tx * img.width) / size);
      const i = (Math.min(sy, img.height - 1) * img.width + Math.min(sx, img.width - 1)) * 4;
      const a = rgba[i + 3] / 255;
      const o = ((y + ty) * W + (x + tx)) * 3;
      for (let k = 0; k < 3; k++) cv.px[o + k] = Math.round(rgba[i + k] * a + C.tile[k] * (1 - a));
    }
  }
  return true;
}

// pixel flames along a strip: deterministic for a burn, so the card is the same each time it is drawn
function flames(cv, x0, x1, base, seed) {
  const u = 10;
  let r = (seed * 2654435761) >>> 0;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cols = Math.ceil((x1 - x0) / u);
  const hs = [];
  for (let c = 0; c < cols; c++) hs.push(5 + 4 * Math.sin(c * 0.55 + seed) + 3 * Math.sin(c * 1.9 + seed * 1.7) + rnd() * 4);
  for (let c = 0; c < cols; c++) {
    const h = Math.max(2, Math.round((hs[c] + (hs[c - 1] ?? hs[c]) + (hs[c + 1] ?? hs[c])) / 3 + rnd() * 2));
    const x = x0 + c * u;
    cv.rect(x, base - h * u, u, h * u, C.red);
    const o = Math.round(h * 0.62);
    if (o > 1) cv.rect(x, base - o * u, u, o * u, C.orange);
    const yl = Math.round(h * 0.3);
    if (yl > 0) cv.rect(x, base - yl * u, u, yl * u, C.yellow);
    if (rnd() < 0.18) cv.rect(x, base - (h + 2 + Math.floor(rnd() * 4)) * u, u, u, rnd() < 0.5 ? C.orange : C.yellow); // a spark
  }
}

// { id, count, credit, nfts: [{ id, pixel }] } → PNG; opts.missing counts the NFT pictures that couldn't be read
export function burnCard(burn, opts = {}) {
  const { thumbsDir, site = 'PROMPT.CITY' } = opts;
  const cv = canvas();
  cv.rect(0, 0, W, H, C.bg);
  for (let y = 15; y < H; y += 30) for (let x = 15; x < W; x += 30) cv.rect(x, y, 5, 5, C.dot);

  // top: the logo and the name, and what this is
  cv.rect(80, 64, 19 * 5, 16 * 5, C.red);
  LOGO.forEach(([col, d]) => {
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) cv.rect(80 + Number(m[1]) * 5, 64 + Number(m[2]) * 5, Number(m[3]) * 5, 5, hex(col));
  });
  cv.text('PROMPT CITY', 196, 76, 8, C.cream);
  const tag = 'INSIDE YOUR AI';
  cv.text(tag, W - 80 - textWidth(tag, 5), 86, 5, C.dim);

  // left: BURNT / 5 NFTs / 50,000 $PROMPT / AIRDROP
  const left = 80;
  const colW = 740;
  cv.text('BURNT', left, 200, fit('BURNT', colW, 24), C.red);
  const n = Number(burn.count);
  const what = `${n.toLocaleString('en-US')} NFT${n === 1 ? '' : 's'}`;
  cv.text(what, left, 405, fit(what, colW, 14), C.cream);
  const amount = Number(burn.credit).toLocaleString('en-US');
  const sc = fit(`${amount} $PROMPT`, colW, 10);
  const end = cv.text(amount, left, 535, sc, C.cream);
  cv.text('$PROMPT', end + sc * 4, 535, sc, C.red);
  const badge = 'AIRDROP · INSIDE AI';
  const bw = textWidth(badge, 5) + 40;
  cv.rect(left, 640, bw, 75, C.red);
  cv.text(badge, left + 20, 660, 5, C.ink);

  // right: the burned NFTs (up to 9; the last square says how many more), flames along the bottom
  const area = { x: 900, y: 175, w: 620, h: 570 };
  const nfts = (burn.nfts || []).slice();
  const cols = nfts.length <= 1 ? 1 : nfts.length <= 4 ? 2 : 3;
  const [tile, gap] = cols === 1 ? [504, 0] : cols === 2 ? [252, 18] : [168, 14]; // 18x, 9x, 6x the 28 px grid
  const slots = cols * cols;
  const more = nfts.length > slots ? nfts.length - (slots - 1) : 0;
  const shown = more ? nfts.slice(0, slots - 1) : nfts.slice(0, slots);
  const rows = Math.ceil((shown.length + (more ? 1 : 0)) / cols);
  const gridW = cols * tile + (cols - 1) * gap;
  const gridH = rows * tile + (rows - 1) * gap;
  const gx = area.x + Math.round((area.w - gridW) / 2);
  const gy = area.y + Math.round((area.h - gridH) / 2) - 10;
  const at = (i) => [gx + (i % cols) * (tile + gap), gy + Math.floor(i / cols) * (tile + gap)];
  shown.forEach((x, i) => {
    const [tx, ty] = at(i);
    cv.rect(tx - 6, ty - 6, tile + 12, tile + 12, C.edge);
    if (!drawNft(cv, thumbsDir, x.id, x.pixel, tx, ty, tile)) opts.missing = (opts.missing || 0) + 1;
  });
  if (more) {
    const [tx, ty] = at(shown.length);
    cv.rect(tx - 6, ty - 6, tile + 12, tile + 12, C.edge);
    cv.rect(tx, ty, tile, tile, C.tile);
    const label = `+${more.toLocaleString('en-US')}`;
    const s2 = fit(label, tile - 30, 8);
    cv.text(label, tx + Math.round((tile - textWidth(label, s2)) / 2), ty + Math.round(tile / 3 - 3.5 * s2), s2, C.cream);
  }
  flames(cv, gx - 30, gx + gridW + 30, Math.min(H - 70, gy + gridH + 40), Number(burn.id) || 1);

  // bottom: where, and how to do it yourself
  cv.text(site, left, 800, 5, C.cream);
  const how = '/BURNCITIZEN IN YOUR AI';
  cv.text(how, W - 80 - textWidth(how, 5), 800, 5, C.dim);
  return encodeRgb(W, H, cv.px);
}

// The $PROMPT coin, 30 x 30 cells: a round pink coin with a cream rim and a citizen face in shades (16 x 10) in the
// middle, light from the top left. FACE: # cream, g grey (its shade), k black, . the coin's red.
const FACE = [
  '....########....',
  '...##########...',
  '..#kkkk##kkkk#..',
  '..#kkkk##kkkk#..',
  '...##########...',
  '...#####g####...',
  '....##kkkk##....',
  '.....######.....',
  '......####......',
  '................',
];
export const COIN_N = 30;
const MID = (COIN_N - 1) / 2;
const R0 = 14.7; // the coin
const R1 = 13.3; // inside the rim
const dist = (x, y) => Math.hypot(x - MID, y - MID);
export function coinCell(x, y) {
  const d = dist(x, y);
  if (d > R0) return null;
  const light = x + y < 22;
  const dark = x + y > 36;
  if (d > R1) return light ? hex('#FFFFFF') : dark ? hex('#B5B2AB') : C.cream; // the rim
  const f = FACE[y - 10]?.[x - 7] || '.';
  if (f === '#') return C.cream;
  if (f === 'g') return hex('#B5B2AB');
  if (f === 'k') return C.ink;
  return dark && d > R1 - 2 ? hex('#D63C8F') : C.red; // a darker crescent inside the rim, bottom right
}

// { id, amount } → PNG: "FREE / 1,000 $PROMPT / AIRDROP · INSIDE AI" and a big pixel coin with sparkles
export function airdropCard(drop, { site = 'PROMPT.CITY' } = {}) {
  const cv = canvas();
  cv.rect(0, 0, W, H, C.bg);
  for (let y = 15; y < H; y += 30) for (let x = 15; x < W; x += 30) cv.rect(x, y, 5, 5, C.dot);
  cv.rect(80, 64, 19 * 5, 16 * 5, C.red);
  LOGO.forEach(([col, d]) => {
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) cv.rect(80 + Number(m[1]) * 5, 64 + Number(m[2]) * 5, Number(m[3]) * 5, 5, hex(col));
  });
  cv.text('PROMPT CITY', 196, 76, 8, C.cream);
  const tag = 'INSIDE YOUR AI';
  cv.text(tag, W - 80 - textWidth(tag, 5), 86, 5, C.dim);

  const left = 80;
  const colW = 760;
  cv.text('FREE', left, 200, fit('FREE', colW, 24), C.red);
  const amount = Number(drop.amount).toLocaleString('en-US');
  const sc = fit(amount, colW, 18);
  cv.text(amount, left, 395, sc, C.cream);
  cv.text('$PROMPT', left, 395 + 7 * sc + 28, fit('$PROMPT', colW, 10), C.red);
  const badge = 'AIRDROP · INSIDE AI';
  cv.rect(left, 660, textWidth(badge, 5) + 40, 75, C.red);
  cv.text(badge, left + 20, 680, 5, C.ink);

  // the coin: 24 cells of 20 px, with a shadow and sparkles
  const cell = 16;
  const cx = 1010;
  const cy = 190;
  for (let y = 0; y < COIN_N; y++) for (let x = 0; x < COIN_N; x++) if (dist(x, y) <= R0) cv.rect(cx + 24 + x * cell, cy + 24 + y * cell, cell, cell, hex('#1A1A1F'));
  for (let y = 0; y < COIN_N; y++) {
    for (let x = 0; x < COIN_N; x++) {
      const c = coinCell(x, y);
      if (c) cv.rect(cx + x * cell, cy + y * cell, cell, cell, c);
    }
  }
  // sparkles: little pixel crosses around the coin
  const spark = (x, y, s, col) => { cv.rect(x - s, y, s * 3, s, col); cv.rect(x, y - s, s, s * 3, col); };
  spark(960, 200, 10, C.yellow);
  spark(1520, 260, 10, C.cream);
  spark(1480, 700, 8, C.yellow);
  spark(955, 640, 8, C.cream);
  spark(1530, 520, 6, C.orange);

  cv.text(site, left, 800, 5, C.cream);
  const how = '/PROMPTCITY FREE1000';
  if (drop.code) {
    const say = `/PROMPTCITY ${String(drop.code).toUpperCase()}`;
    cv.text(say, W - 80 - textWidth(say, 5), 800, 5, C.dim);
  } else cv.text(how, W - 80 - textWidth(how, 5), 800, 5, C.dim);
  return encodeRgb(W, H, cv.px);
}
