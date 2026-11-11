// The shooter's rules, shared by the game server (game/) and the page (site/play.html): the one map of Prompt City,
// how a Citizen walks (W forward where it looks, S back, A / D to the sides, like in a shooter; walls stop it), how a
// shot flies (a straight line at chest height, the first wall or player it meets), the guns by stars, and the rounds.
// The server runs the world; the page draws it in 3D and uses the same walking code to move its own Citizen without
// waiting for the server.
//
// Tiles of 32 px (the page draws 1 px as 1/22 m: a tile is about 1.5 m). # building, c crate (both stop people and
// bullets), ~ the bay (stops people, not bullets), p a palm (stops both), A / B the two crews' spawn tiles, . street.

// the city: the whole downtown, for up to 100 players at once, built from a seed: blocks of buildings with alleys, streets with
// crates, palms on the waterfront; the left half mirrored, so neither crew has the better side
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function cityRows(seed = 20261105, cols = 112, rows = 70) {
  const half = cols / 2;
  const g = Array.from({ length: rows }, () => Array(half).fill('.'));
  const r = rng(seed);
  const bay = 4;
  for (let y = 0; y < rows; y++) { g[y][0] = '#'; }
  for (let x = 0; x < half; x++) { g[0][x] = '#'; for (let y = rows - bay; y < rows; y++) g[y][x] = '~'; }
  // the spawn strip on the outer edge: crew A on the left (crew B is its mirror)
  for (let y = 2; y < rows - bay - 2; y++) for (let x = 1; x <= 3; x++) g[y][x] = 'A';
  // blocks: 11 x 9 tiles with 4-tile streets between them, starting after the spawn strip
  const bw = 11; const bh = 9; const st = 4;
  for (let by = st; by + bh < rows - bay - 1; by += bh + st) {
    for (let bx = 8; bx + bw <= half - 1; bx += bw + st) {
      // one to three buildings in a block, with an alley through it
      const split = r() < 0.5;
      const cut = split ? bx + 3 + Math.floor(r() * (bw - 6)) : by + 3 + Math.floor(r() * (bh - 6));
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const alley = split ? Math.abs(x - cut) <= 1 : Math.abs(y - cut) <= 1;
          if (!alley) g[y][x] = '#';
        }
      }
      if (r() < 0.35) { const x = bx + 1 + Math.floor(r() * (bw - 2)); for (let y = by; y < by + bh; y++) g[y][x] = '.'; }
    }
  }
  // crates on the streets for cover, palms along the waterfront
  for (let i = 0; i < 70; i++) {
    const x = 5 + Math.floor(r() * (half - 6)); const y = 2 + Math.floor(r() * (rows - bay - 4));
    if (g[y][x] === '.' && g[y][x + 1] === '.' && g[y + 1]?.[x] === '.') { g[y][x] = 'c'; if (r() < 0.6) g[y][x + 1] = 'c'; }
  }
  for (let x = 6; x < half - 1; x += 5 + Math.floor(r() * 4)) if (g[rows - bay - 2][x] === '.') g[rows - bay - 2][x] = 'p';
  return g.map((row) => row.join('') + [...row].reverse().join('').replace(/A/g, 'B'));
}

function makeMap(key, rows, maxPlayers) {
  const cols = rows[0].length;
  const spawns = [[], []];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === 'A') spawns[0].push([x * TILE + TILE / 2, y * TILE + TILE / 2]);
    if (c === 'B') spawns[1].push([x * TILE + TILE / 2, y * TILE + TILE / 2]);
  }));
  return { key, rows, cols, nrows: rows.length, w: cols * TILE, h: rows.length * TILE, spawns, maxPlayers };
}
export const TILE = 32;
export const MAPS = { city: makeMap('city', cityRows(), 100) };
// one map for everyone
export const mapFor = () => MAPS.city;

const BLOCK_WALK = new Set(['#', 'c', '~', 'p']);
const BLOCK_SHOT = new Set(['#', 'c', 'p']);
export const tileAt = (map, cx, cy) => (cx < 0 || cy < 0 || cx >= map.cols || cy >= map.nrows ? '#' : map.rows[cy][cx]);
export const blocksWalk = (map, cx, cy) => BLOCK_WALK.has(tileAt(map, cx, cy));
export const blocksShot = (map, cx, cy) => BLOCK_SHOT.has(tileAt(map, cx, cy));
export const TEAMS = [{ key: 'neon', name: 'Neon Crew', color: '#FF4FA3' }, { key: 'tide', name: 'Tide Crew', color: '#2DE2E6' }];

// the numbers of the game; the server can change them, the page gets them with the first message
export const RULES = {
  radius: 12, // a Citizen is a circle this big
  speed: 165, // px a second (about 7.5 m/s)
  hp: 100,
  // the guns, one for each number of stars: more stars, more damage a second. dmg is a bullet (a shotgun fires
  // pellets of it in a cone), fireMs the time between shots (holding the button keeps firing), range in px, spread in
  // radians either way standing still or walking
  weapons: [
    { key: 'pistol', name: 'Pistol', dmg: 16, pellets: 1, cone: 0, fireMs: 290, mag: 12, reloadMs: 1400, range: 700, spreadStill: 0.012, spreadMove: 0.045 },
    { key: 'smg', name: 'SMG', dmg: 9, pellets: 1, cone: 0, fireMs: 135, mag: 30, reloadMs: 1800, range: 560, spreadStill: 0.03, spreadMove: 0.07 },
    { key: 'shotgun', name: 'Shotgun', dmg: 9, pellets: 7, cone: 0.22, fireMs: 850, mag: 6, reloadMs: 2200, range: 380, spreadStill: 0.02, spreadMove: 0.04 },
    { key: 'rifle', name: 'Assault rifle', dmg: 21, pellets: 1, cone: 0, fireMs: 240, mag: 25, reloadMs: 1900, range: 900, spreadStill: 0.012, spreadMove: 0.05 },
    { key: 'marksman', name: 'Marksman rifle', dmg: 50, pellets: 1, cone: 0, fireMs: 520, mag: 8, reloadMs: 2300, range: 1200, spreadStill: 0.004, spreadMove: 0.05 },
  ],
  tickMs: 50, // 20 updates a second
  roundMs: 150000,
  endMs: 4000, // the pause between rounds
  warmupRespawnMs: 3000, // before a round can start: back after this long, kills don't pay
  lateJoinMs: 30000, // joining a round with more than this left: in right away
  maxPlayers: 100,
  view: 1400, // px (about 64 m): a page gets the players and shots this close to its own Citizen
};

// the gun of a Citizen with these stars (1 to 5)
export const weaponOf = (stars, rules = RULES) => rules.weapons[Math.min(4, Math.max(0, (stars || 1) - 1))];

// one step of walking for dt ms: keys u / d forward and back along the look angle a, l / r to the sides (strafing);
// walls stop the circle, sliding along them
export function moveStep(map, x, y, keys, a, dt, rules = RULES) {
  const f = (keys.u ? 1 : 0) - (keys.d ? 1 : 0);
  const s = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
  if (!f && !s) return [x, y];
  const ca = Math.cos(a || 0); const sa = Math.sin(a || 0);
  let dx = f * ca - s * sa; let dy = f * sa + s * ca;
  const len = Math.hypot(dx, dy);
  const step = (rules.speed * dt) / 1000;
  dx = (dx / len) * step; dy = (dy / len) * step;
  const r = rules.radius;
  let nx = x + dx;
  if (hitsWall(map, nx, y, r)) nx = dx > 0 ? Math.floor((nx + r) / TILE) * TILE - r - 0.01 : Math.floor((nx - r) / TILE + 1) * TILE + r + 0.01;
  if (hitsWall(map, nx, y, r)) nx = x;
  let ny = y + dy;
  if (hitsWall(map, nx, ny, r)) ny = dy > 0 ? Math.floor((ny + r) / TILE) * TILE - r - 0.01 : Math.floor((ny - r) / TILE + 1) * TILE + r + 0.01;
  if (hitsWall(map, nx, ny, r)) ny = y;
  return [nx, ny];
}
// does a circle at (x, y) overlap a tile people can't walk through
export function hitsWall(map, x, y, r) {
  const x0 = Math.floor((x - r) / TILE); const x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE); const y1 = Math.floor((y + r) / TILE);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (!blocksWalk(map, cx, cy)) continue;
      const nx = Math.max(cx * TILE, Math.min(x, cx * TILE + TILE));
      const ny = Math.max(cy * TILE, Math.min(y, cy * TILE + TILE));
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
    }
  }
  return false;
}
// where a shot from (x, y) at angle a stops: the first wall tile on its way (a grid walk), or its range
export function shotWallDistance(map, x, y, a, range) {
  const dx = Math.cos(a); const dy = Math.sin(a);
  let cx = Math.floor(x / TILE); let cy = Math.floor(y / TILE);
  if (blocksShot(map, cx, cy)) return 0;
  const sx = dx > 0 ? 1 : -1; const sy = dy > 0 ? 1 : -1;
  const tdx = Math.abs(TILE / (dx || 1e-9)); const tdy = Math.abs(TILE / (dy || 1e-9));
  let tx = (dx > 0 ? (cx + 1) * TILE - x : x - cx * TILE) / Math.abs(dx || 1e-9);
  let ty = (dy > 0 ? (cy + 1) * TILE - y : y - cy * TILE) / Math.abs(dy || 1e-9);
  let t = 0;
  while (t < range) {
    if (tx < ty) { t = tx; tx += tdx; cx += sx; } else { t = ty; ty += tdy; cy += sy; }
    if (t >= range) break;
    if (blocksShot(map, cx, cy)) return t;
  }
  return range;
}
// the distance along a ray to a circle, or null if it misses
export function rayCircle(x, y, a, px, py, r) {
  const dx = Math.cos(a); const dy = Math.sin(a);
  const fx = px - x; const fy = py - y;
  const along = fx * dx + fy * dy;
  if (along < 0) return null;
  const d2 = fx * fx + fy * fy - along * along;
  if (d2 > r * r) return null;
  return along - Math.sqrt(r * r - d2);
}

// ---------- the world: players, shots and rounds (the server runs it; tests drive it directly) ----------
export class World {
  constructor({ rules = RULES, rand = Math.random, now = () => Date.now(), onKill = () => {} } = {}) {
    this.rules = { ...RULES, ...rules };
    this.rand = rand; this.now = now; this.onKill = onKill;
    this.players = new Map(); // id -> player
    this.phase = 'warmup'; // warmup | live | end
    this.phaseUntil = 0;
    this.round = 0;
    this.score = [0, 0];
    this.map = MAPS.city;
    this.shots = []; // this tick's tracers, for the page
    this.events = []; // this tick's kills and round changes
    this.tick = 0;
  }
  add(p) {
    const team = this.teamForNew();
    const pl = { id: p.id, uid: p.uid, addr: p.addr, handle: p.handle || null, nft: p.nft, stars: Math.max(1, Math.min(5, p.stars | 0)),
      team, x: 0, y: 0, a: 0, hp: this.rules.hp, alive: false, deadAt: 0, keys: {}, fire: false, ammo: weaponOf(p.stars, this.rules).mag,
      reloadUntil: 0, nextShot: 0, kills: 0, deaths: 0, streak: 0, lastInput: this.now(), lastActive: this.now() };
    this.players.set(pl.id, pl);
    // late in a round you wait for the next one; early enough, you join the fight right away
    if (this.phase === 'live' && this.phaseUntil - this.now() < this.rules.lateJoinMs) { pl.alive = false; pl.deadAt = this.now(); } else this.spawn(pl);
    return pl;
  }
  remove(id) { this.players.delete(id); }
  teamForNew() {
    const n = [0, 0];
    for (const p of this.players.values()) n[p.team]++;
    return n[0] <= n[1] ? 0 : 1;
  }
  spawn(p) {
    const spots = this.map.spawns[p.team];
    const taken = [...this.players.values()].filter((o) => o !== p && o.alive);
    let pick = null;
    for (let i = 0; i < 12 && !pick; i++) {
      const s = spots[Math.floor(this.rand() * spots.length)];
      if (!taken.some((o) => Math.hypot(o.x - s[0], o.y - s[1]) < 28)) pick = s;
    }
    const [x, y] = pick || spots[Math.floor(this.rand() * spots.length)];
    Object.assign(p, { x, y, hp: this.rules.hp, alive: true, ammo: weaponOf(p.stars, this.rules).mag, reloadUntil: 0, a: p.team === 0 ? 0 : Math.PI });
  }
  input(id, { keys, a, fire, reload, seq }) {
    const p = this.players.get(id); if (!p) return;
    const k = { u: !!keys?.u, d: !!keys?.d, l: !!keys?.l, r: !!keys?.r };
    // someone who walks, turns or shoots is playing; a page left open in another tab only keeps the line alive
    if (k.u || k.d || k.l || k.r || fire || reload || (Number.isFinite(a) && Math.abs(a - p.a) > 0.001)) p.lastActive = this.now();
    p.keys = k;
    if (Number.isFinite(a)) p.a = a;
    p.fire = !!fire;
    // the page's input number: it tells the page which of its own moves this position already includes
    if (Number.isSafeInteger(seq) && seq > 0) p.seq = seq;
    const w = weaponOf(p.stars, this.rules);
    if (reload && p.ammo < w.mag && !p.reloadUntil) p.reloadUntil = this.now() + w.reloadMs;
    p.lastInput = this.now();
  }
  teamsReady() {
    const n = [0, 0];
    for (const p of this.players.values()) n[p.team]++;
    return n[0] > 0 && n[1] > 0;
  }
  startRound() {
    // even crews, alternating by joining order
    [...this.players.values()].forEach((p, i) => { p.team = i % 2; });
    this.round++;
    this.phase = 'live'; this.phaseUntil = this.now() + this.rules.roundMs;
    for (const p of this.players.values()) this.spawn(p);
    this.events.push({ t: 'round', round: this.round, map: this.map.key });
  }
  endRound(winner) {
    if (winner != null) this.score[winner]++;
    this.phase = 'end'; this.phaseUntil = this.now() + this.rules.endMs;
    this.events.push({ t: 'end', winner, score: [...this.score] });
  }
  step(dt = this.rules.tickMs) {
    const now = this.now();
    this.tick++; this.shots = []; this.events = [];
    // rounds: warmup until both crews have someone; a live round until one crew is out or the time is up
    if (this.phase === 'warmup' && this.teamsReady()) this.startRound();
    else if (this.phase === 'live') {
      if (!this.teamsReady()) { this.phase = 'warmup'; this.score = [0, 0]; for (const p of this.players.values()) if (!p.alive) this.spawn(p); }
      else {
        const alive = [0, 0];
        for (const p of this.players.values()) if (p.alive) alive[p.team]++;
        if (!alive[0] || !alive[1]) this.endRound(alive[0] ? 0 : alive[1] ? 1 : null);
        else if (now >= this.phaseUntil) this.endRound(alive[0] === alive[1] ? null : alive[0] > alive[1] ? 0 : 1);
      }
    } else if (this.phase === 'end' && now >= this.phaseUntil) {
      if (this.teamsReady()) this.startRound(); else { this.phase = 'warmup'; for (const p of this.players.values()) this.spawn(p); }
    }
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.phase === 'warmup' && now - p.deadAt >= this.rules.warmupRespawnMs) this.spawn(p);
        continue;
      }
      [p.x, p.y] = moveStep(this.map, p.x, p.y, p.keys, p.a, dt, this.rules);
      const w = weaponOf(p.stars, this.rules);
      if (p.reloadUntil && now >= p.reloadUntil) { p.ammo = w.mag; p.reloadUntil = 0; }
      if (p.fire && !p.reloadUntil && now >= p.nextShot && this.phase !== 'end') {
        if (p.ammo <= 0) { p.reloadUntil = now + w.reloadMs; continue; }
        p.ammo--; p.nextShot = now + w.fireMs;
        const moving = p.keys.u || p.keys.d || p.keys.l || p.keys.r;
        const spread = moving ? w.spreadMove : w.spreadStill;
        const a = p.a + (this.rand() * 2 - 1) * spread;
        // a shotgun's pellets fan out evenly over its cone, each a little off
        for (let i = 0; i < w.pellets; i++) {
          const off = w.pellets > 1 ? (i / (w.pellets - 1) - 0.5) * w.cone + (this.rand() - 0.5) * (w.cone / w.pellets) : 0;
          this.shoot(p, a + off, w);
        }
        if (p.ammo <= 0) p.reloadUntil = now + w.reloadMs;
      }
    }
  }
  shoot(p, a, w = weaponOf(p.stars, this.rules)) {
    const ox = p.x + Math.cos(a) * (this.rules.radius + 2); const oy = p.y + Math.sin(a) * (this.rules.radius + 2);
    let dist = shotWallDistance(this.map, ox, oy, a, w.range);
    let victim = null;
    for (const o of this.players.values()) {
      // no friendly fire in a round; in the warmup everyone is fair game
      if (o === p || !o.alive || (o.team === p.team && this.phase !== 'warmup')) continue;
      const d = rayCircle(ox, oy, a, o.x, o.y, this.rules.radius);
      if (d != null && d < dist) { dist = d; victim = o; }
    }
    // a tracer for the pages: from, to, the shooter's crew, whether it hit someone, who shot
    this.shots.push([Math.round(ox), Math.round(oy), Math.round(ox + Math.cos(a) * dist), Math.round(oy + Math.sin(a) * dist), p.team, victim ? 1 : 0, p.id]);
    if (!victim) return;
    victim.hp -= w.dmg;
    if (victim.hp > 0) return;
    victim.hp = 0; victim.alive = false; victim.deadAt = this.now(); victim.deaths++; victim.streak = 0;
    p.kills++;
    const ev = { t: 'kill', killer: p.id, victim: victim.id, killerStars: p.stars, victimStars: victim.stars, paid: this.phase === 'live', streak: p.streak };
    p.streak++;
    this.events.push(ev);
    this.onKill({ ...ev, killerPlayer: p, victimPlayer: victim, round: this.round });
  }
  // what a page gets 20 times a second: the round, and the players and shots near its own Citizen (everyone, when
  // it has none or is down: it watches)
  snapshot(forId = null) {
    const me = forId != null ? this.players.get(forId) : null;
    const v2 = this.rules.view * this.rules.view;
    const near = (x, y) => !me || !me.alive || (x - me.x) ** 2 + (y - me.y) ** 2 <= v2;
    let alive = [0, 0];
    for (const p of this.players.values()) if (p.alive) alive[p.team]++;
    return {
      t: 's', tick: this.tick, phase: this.phase, left: Math.max(0, this.phaseUntil - this.now()), round: this.round, score: this.score,
      m: this.map.key, alive, n: this.players.size,
      p: [...this.players.values()].filter((p) => p === me || near(p.x, p.y))
        .map((p) => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.a * 100) / 100, p.hp, p.alive ? 1 : 0, p.team, p.kills, p.deaths]),
      shots: this.shots.filter((s) => near(s[0], s[1]) || near(s[2], s[3])), ev: this.events,
    };
  }
}
