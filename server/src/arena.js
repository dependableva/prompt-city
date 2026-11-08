// The arena (/play): Citizens fight on a map of Prompt City. A holder picks one of their Citizens as their fighter; its
// rarity (its stars) sets how hard it hits. A kill gives $PROMPT (users.credit_balance, like a job's) and season points;
// the season's top 10 get an airdrop.
//
// The server decides everything: where a fighter is, whether a hit lands, who dies. Nothing runs between requests:
// a fighter's place is computed from where it was, where it is walking to and when it set off (pos()), its HP from
// the last hit and the time since (hpNow()), a respawn from the time of death. So the arena works on a serverless
// host with only the database between requests.
//
// Kills pay more for a fighter with fewer stars than its victim: base * victim stars / killer stars. A kill streak adds
// 10% a kill (up to +50%). Per account and UTC day: at most ARENA_DAILY_CAP $PROMPT, and only ARENA_PER_VICTIM kills
// of one victim pay. Fighters off the page (no request for ONLINE_SECONDS) can't be hit, so nobody farms the idle.
import * as m from './market.js';
import { RARITIES, stars } from './game.js';

const fail = (msg) => { throw new m.MarketError(msg); };
const alert = (name, v, d) => { console.error(`ALERT: ${name}="${v}" is not valid; using the default`); return d; };
const intEnv = (name, d, min = 0, max = 1e9) => {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : alert(name, v, d);
};
// "Street:10,Hustler:12,Boss:14,Kingpin:17,Legend:20": the damage of one hit by rarity
export function parseDamage(v) {
  const out = { Street: 10, Hustler: 12, Boss: 14, Kingpin: 17, Legend: 20 };
  if (v == null || String(v).trim() === '') return out;
  const next = { ...out };
  for (const part of String(v).split(',')) {
    const [k, x] = part.split(':').map((s) => s.trim());
    const n = Number(x);
    if (!RARITIES.includes(k) || !Number.isInteger(n) || n < 1 || n > 1000) return alert('ARENA_DAMAGE', v, out);
    next[k] = n;
  }
  return next;
}

export const CONFIG = {
  damage: parseDamage(process.env.ARENA_DAMAGE),
  hp: intEnv('ARENA_HP', 100, 1, 10000),
  hitMs: intEnv('ARENA_HIT_MS', 1000, 100, 60000), // one hit per this long
  range: intEnv('ARENA_RANGE', 80, 10, 1000), // how close a hit lands, in map units
  speed: intEnv('ARENA_SPEED', 220, 10, 5000), // map units a second
  respawnMs: intEnv('ARENA_RESPAWN_MS', 5000, 0, 600000),
  shieldMs: intEnv('ARENA_SHIELD_MS', 5000, 0, 600000), // can't be hit after (re)spawning, until it hits someone
  regenAfterMs: intEnv('ARENA_REGEN_AFTER_MS', 5000, 0, 600000), // HP comes back this long after the last hit taken
  regenPerSec: intEnv('ARENA_REGEN_PER_SEC', 5, 0, 10000),
  killBase: intEnv('ARENA_KILL_BASE', 50, 0, 1e9), // $PROMPT for a kill of a fighter with as many stars as the killer
  dailyCap: intEnv('ARENA_DAILY_CAP', 1500, 0, 1e9), // $PROMPT from kills per account and UTC day
  perVictim: intEnv('ARENA_PER_VICTIM', 3, 0, 1000), // kills of one victim that pay, per UTC day
  streakPct: intEnv('ARENA_STREAK_PCT', 10, 0, 1000), // per kill in a row
  streakMax: intEnv('ARENA_STREAK_MAX', 5, 0, 100), // kills that count for the streak bonus
  switchHours: intEnv('ARENA_SWITCH_HOURS', 24, 0, 24 * 365), // a fighter can be changed this often
  onlineSeconds: intEnv('ARENA_ONLINE_SECONDS', 30, 5, 3600),
  season: (process.env.ARENA_SEASON || 'S1').trim().slice(0, 20) || 'S1',
};
export const ONLINE_MS = () => CONFIG.onlineSeconds * 1000;
const LATENCY = 30; // map units of slack on a hit's distance: the hitter saw the target a moment ago

// The map: Prompt City, 10 districts (the Citizens' Turfs) in two rows of five, streets between them, the ocean below.
export const MAP = { w: 2500, h: 1600, street: 60, ocean: 160 };
export const DISTRICTS = ['Sunset Strip', 'Ocean Drive', 'Neon Night', 'Hot Pink', 'Golden Hour',
  'Skyline', 'Teal Wall', 'Orange Wall', 'Police Lights', 'Cash Rain'];
export function districtRects() {
  const { w, h, street, ocean } = MAP;
  const cols = 5;
  const cw = (w - street * (cols + 1)) / cols;
  const ch = (h - ocean - street * 3) / 2;
  return DISTRICTS.map((name, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return { name, x: street + c * (cw + street), y: street + r * (ch + street), w: cw, h: ch };
  });
}
// where a fighter is on the walkable map (the ocean is not)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampPoint = (x, y) => [clamp(Number(x) || 0, 0, MAP.w), clamp(Number(y) || 0, 0, MAP.h - MAP.ocean)];
export function spawnPoint(rand = Math.random) {
  const d = districtRects()[Math.floor(rand() * DISTRICTS.length)];
  return [Math.round(d.x + 40 + rand() * (d.w - 80)), Math.round(d.y + 40 + rand() * (d.h - 80))];
}
export function districtAt(x, y) {
  return districtRects().find((d) => x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h)?.name || null;
}

const ms = (t) => (t ? new Date(t).getTime() : 0);
export const starsOf = (rarity) => Math.max(1, RARITIES.indexOf(rarity) + 1);
// where a fighter is at time now: from (x, y) towards (tx, ty) since moved_at, at CONFIG.speed
export function pos(f, now) {
  const t = Math.max(0, now - ms(f.moved_at));
  const dx = f.tx - f.x;
  const dy = f.ty - f.y;
  const dist = Math.hypot(dx, dy);
  const go = (CONFIG.speed * t) / 1000;
  if (!dist || go >= dist) return [Number(f.tx), Number(f.ty)];
  return [f.x + (dx * go) / dist, f.y + (dy * go) / dist];
}
export function hpNow(f, now) {
  if (ms(f.dead_until) > now) return 0;
  const since = now - Math.max(ms(f.hurt_at) + CONFIG.regenAfterMs, ms(f.dead_until));
  const back = since > 0 ? Math.floor((since / 1000) * CONFIG.regenPerSec) : 0;
  return Math.min(CONFIG.hp, Number(f.hp) + back);
}
export const alive = (f, now) => ms(f.dead_until) <= now;
export const shielded = (f, now) => ms(f.shield_until) > now;
export const online = (f, now) => now - ms(f.last_seen) <= ONLINE_MS();
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

// what a kill pays: base * victim stars / killer stars, plus the streak; before the daily limits
export function killPoints(killerStars, victimStars, streak = 0) {
  const s = Math.min(Math.max(0, streak), CONFIG.streakMax);
  return Math.round((CONFIG.killBase * victimStars * (100 + s * CONFIG.streakPct)) / killerStars / 100);
}

async function citizen(q, userId, nftId) {
  const [n] = await q(`select n.id, n.name, n.rarity, n.owner_id, c.slug from nfts n join collections c on c.id = n.collection_id
    where n.id = $1`, [Number(nftId)]);
  if (!n || n.slug !== m.OWN_COLLECTION) fail(`${m.nftName(nftId)} is not a Citizen. Only Citizens fight in the arena.`);
  if (Number(n.owner_id) !== Number(userId)) fail(`You don't own ${n.name}. Fight with one of your own Citizens.`);
  return n;
}
// the fighter of an account, if it still owns that Citizen (sold, sent, burned or taken to Solana: it is gone)
async function fighterFor(q, userId, lock = false) {
  const [f] = await q(`select f.*, n.owner_id, n.name as nft_name, n.rarity from arena_fighters f join nfts n on n.id = f.nft_id
    where f.user_id = $1${lock ? ' for update of f' : ''}`, [userId]);
  if (!f) return null;
  if (Number(f.owner_id) !== Number(userId)) {
    await q('delete from arena_fighters where user_id = $1', [userId]);
    return null;
  }
  return f;
}

// my Citizens that can fight, the one fighting now, and when it can be changed
export async function myCitizens(db, userId) {
  return db.query(`select n.id, n.name, n.rarity from nfts n join collections c on c.id = n.collection_id
    where c.slug = $1 and n.owner_id = $2 order by array_position($3::text[], n.rarity) desc nulls last, n.id limit 200`,
  [m.OWN_COLLECTION, userId, RARITIES]);
}

export async function join(db, userId, nftId, now = Date.now()) {
  return db.tx(async (t) => {
    const n = await citizen(t.query, userId, nftId);
    const f = await fighterFor(t.query, userId, true);
    const at = new Date(now);
    if (f && Number(f.nft_id) === Number(n.id)) {
      await t.query('update arena_fighters set last_seen = $2 where user_id = $1', [userId, at]);
      return { ...(await view(t.query, userId, now)), changed: false };
    }
    if (f && CONFIG.switchHours > 0 && now - ms(f.switched_at) < CONFIG.switchHours * 3600e3) {
      const left = Math.ceil((CONFIG.switchHours * 3600e3 - (now - ms(f.switched_at))) / 3600e3);
      fail(`You fight as ${f.nft_name}. The fighter can be changed once in ${CONFIG.switchHours} hours: in ${left} h.`);
    }
    const [x, y] = spawnPoint();
    await t.query(`insert into arena_fighters (user_id, nft_id, stars, hp, x, y, tx, ty, moved_at, shield_until, last_seen, switched_at, streak)
      values ($1, $2, $3, $4, $5, $6, $5, $6, $7, $8, $7, $7, 0)
      on conflict (user_id) do update set nft_id = $2, stars = $3, hp = $4, x = $5, y = $6, tx = $5, ty = $6, moved_at = $7, shield_until = $8,
        last_seen = $7, switched_at = $7, streak = 0, hurt_at = null, dead_until = null, last_hit_at = null`,
    [userId, n.id, starsOf(n.rarity), CONFIG.hp, x, y, at, new Date(now + CONFIG.shieldMs)]);
    return { ...(await view(t.query, userId, now)), changed: !!f };
  });
}

export async function move(db, userId, x, y, now = Date.now()) {
  return db.tx(async (t) => {
    const f = await fighterFor(t.query, userId, true);
    if (!f) fail('Pick your fighter first.');
    if (!alive(f, now)) fail('You are down. Back in a few seconds.');
    const [cx, cy] = pos(f, now);
    const [tx, ty] = clampPoint(x, y);
    await t.query('update arena_fighters set x = $2, y = $3, tx = $4, ty = $5, moved_at = $6, last_seen = $6 where user_id = $1',
      [userId, cx, cy, tx, ty, new Date(now)]);
    return { x: cx, y: cy, tx, ty, t: now };
  });
}

// one hit on another fighter; a kill pays $PROMPT and season points
export async function attack(db, userId, targetAddr, now = Date.now()) {
  return db.tx(async (t) => {
    const [target] = await t.query('select id from users where public_id = $1', [String(targetAddr || '')]);
    if (!target) fail('No such fighter.');
    if (Number(target.id) === Number(userId)) fail("You can't hit yourself.");
    // both rows, always in the same order, so two fighters hitting each other at once don't deadlock
    const ids = [Number(userId), Number(target.id)].sort((a, b) => a - b);
    await t.query('select user_id from arena_fighters where user_id = any($1::int[]) order by user_id for update', [ids]);
    const me = await fighterFor(t.query, userId);
    if (!me) fail('Pick your fighter first.');
    const foe = await fighterFor(t.query, target.id);
    if (!foe) fail('That fighter left the arena.');
    if (!alive(me, now)) fail('You are down. Back in a few seconds.');
    const wait = ms(me.last_hit_at) + CONFIG.hitMs - now;
    if (wait > 0) fail(`Too fast: next hit in ${(wait / 1000).toFixed(1)} s.`);
    if (!alive(foe, now)) fail('Already down.');
    if (!online(foe, now)) fail('That fighter is away.');
    if (shielded(foe, now)) fail('Just spawned: protected for a few seconds.');
    const [mx, my] = pos(me, now);
    const [fx, fy] = pos(foe, now);
    const dist = Math.hypot(mx - fx, my - fy);
    if (dist > CONFIG.range + LATENCY) fail('Too far. Get closer.');
    const at = new Date(now);
    const dmg = CONFIG.damage[RARITIES[me.stars - 1]] ?? CONFIG.damage.Street;
    const hp = hpNow(foe, now) - dmg;
    // a hit ends the hitter's own spawn protection
    await t.query('update arena_fighters set last_hit_at = $2, last_seen = $2, shield_until = least(shield_until, $2) where user_id = $1', [userId, at]);
    if (hp > 0) {
      await t.query('update arena_fighters set hp = $2, hurt_at = $3 where user_id = $1', [foe.user_id, hp, at]);
      return { hit: true, damage: dmg, hp, killed: false };
    }
    // a kill: the victim comes back at a new spot after the respawn time, with full HP and a short protection
    const [sx, sy] = spawnPoint();
    const back = new Date(now + CONFIG.respawnMs);
    await t.query(`update arena_fighters set hp = $2, hurt_at = null, dead_until = $3, x = $4, y = $5, tx = $4, ty = $5, moved_at = $3,
      shield_until = $6, streak = 0 where user_id = $1`, [foe.user_id, CONFIG.hp, back, sx, sy, new Date(now + CONFIG.respawnMs + CONFIG.shieldMs)]);
    const streak = Number(me.streak) + 1;
    await t.query('update arena_fighters set streak = $2 where user_id = $1', [userId, streak]);
    const { points, full, why } = await payKill(t, { killerId: userId, victimId: foe.user_id, killerNft: me.nft_id, victimNft: foe.nft_id,
      killerStars: Number(me.stars), victimStars: Number(foe.stars), streak: Number(me.streak), now });
    const [u] = await t.query('select credit_balance from users where id = $1', [userId]);
    return { hit: true, damage: dmg, hp: 0, killed: true, points, full, why, streak, credit_balance: Number(u.credit_balance),
      victim: { address: targetAddr, nft: Number(foe.nft_id), name: foe.nft_name, stars: Number(foe.stars) } };
  });
}

// a kill's $PROMPT and season points, inside the caller's transaction: base * victim stars / killer stars plus the
// streak, then the day's limits (ARENA_PER_VICTIM paid kills of one victim, ARENA_DAILY_CAP $PROMPT). ref: the game
// server's id of the kill, so a report sent twice pays once.
export async function payKill(t, { killerId, victimId, killerNft, victimNft, killerStars, victimStars, streak = 0, ref = null, now = Date.now() }) {
  if (ref) {
    const [had] = await t.query('select points from arena_kills where ref = $1', [ref]);
    if (had) return { points: Number(had.points), full: Number(had.points), why: null, repeated: true };
  }
  const day = dayOf(now);
  // one at a time per killer, so two kills at once can't both fit under the cap
  await t.query('select id from users where id = $1 for update', [killerId]);
  const [{ paid, same }] = await t.query(`select coalesce(sum(points), 0)::bigint as paid,
    count(*) filter (where victim_id = $3 and points > 0)::int as same
    from arena_kills where killer_id = $1 and day = $2`, [killerId, day, victimId]);
  const full = killPoints(killerStars, victimStars, streak);
  let points = full;
  let why = null;
  if (same >= CONFIG.perVictim) { points = 0; why = `already ${CONFIG.perVictim} paid kills of this fighter today`; }
  const room = Math.max(0, CONFIG.dailyCap - Number(paid));
  if (points > room) { points = room; why = room ? 'the daily limit' : `the daily limit (${CONFIG.dailyCap.toLocaleString('en-US')} $PROMPT) is reached`; }
  await t.query(`insert into arena_kills (season, day, killer_id, victim_id, killer_nft, victim_nft, killer_stars, victim_stars, points, ref)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [CONFIG.season, day, killerId, victimId, killerNft, victimNft, killerStars, victimStars, points, ref]);
  await t.query(`insert into arena_scores (season, user_id, kills, points) values ($1, $2, 1, $3)
    on conflict (season, user_id) do update set kills = arena_scores.kills + 1, points = arena_scores.points + $3`, [CONFIG.season, killerId, points]);
  await t.query(`insert into arena_scores (season, user_id, deaths) values ($1, $2, 1)
    on conflict (season, user_id) do update set deaths = arena_scores.deaths + 1`, [CONFIG.season, victimId]);
  if (points) await t.query('update users set credit_balance = credit_balance + $1 where id = $2', [points, killerId]);
  return { points, full, why };
}

// how a fighter looks to everyone: where it is heading and since when, so the page can move it smoothly
function publicFighter(f, now) {
  const [x, y] = pos(f, now);
  return {
    address: f.public_id, handle: f.show_handle ? f.handle : null, nft: Number(f.nft_id), name: f.nft_name, stars: Number(f.stars),
    x: Math.round(x), y: Math.round(y), tx: Number(f.tx), ty: Number(f.ty), hp: hpNow(f, now), max_hp: CONFIG.hp,
    dead_until: alive(f, now) ? null : ms(f.dead_until), shield: shielded(f, now), streak: Number(f.streak),
  };
}

// the arena as everyone sees it (cached briefly by the CDN): the fighters on the page, the last kills, the top 10
export async function world(db, now = Date.now()) {
  const rows = await db.query(`select f.*, u.public_id, u.handle, u.show_handle, n.name as nft_name from arena_fighters f
    join users u on u.id = f.user_id join nfts n on n.id = f.nft_id and n.owner_id = f.user_id
    where f.last_seen > $1 order by f.last_seen desc limit 300`, [new Date(now - ONLINE_MS())]);
  return { t: now, season: CONFIG.season, map: MAP, fighters: rows.map((f) => publicFighter(f, now)), kills: await feed(db), top: await top(db) };
}

export async function feed(db, limit = 12) {
  const rows = await db.query(`select k.created_at, k.points, k.killer_stars, k.victim_stars, k.killer_nft, k.victim_nft,
      ku.public_id as killer, vu.public_id as victim, case when ku.show_handle then ku.handle end as killer_handle,
      case when vu.show_handle then vu.handle end as victim_handle from arena_kills k
    join users ku on ku.id = k.killer_id join users vu on vu.id = k.victim_id where k.season = $1 order by k.id desc limit $2`, [CONFIG.season, limit]);
  return rows.map((r) => ({ at: ms(r.created_at), killer: r.killer, victim: r.victim, killer_handle: r.killer_handle, victim_handle: r.victim_handle, killer_nft: Number(r.killer_nft), victim_nft: Number(r.victim_nft),
    killer_stars: Number(r.killer_stars), victim_stars: Number(r.victim_stars), points: Number(r.points) }));
}

export async function top(db, limit = 10, season = CONFIG.season) {
  const rows = await db.query(`select s.user_id, s.kills, s.deaths, s.points, u.public_id, u.handle, u.show_handle from arena_scores s
    join users u on u.id = s.user_id where s.season = $1 and (s.kills > 0 or s.points > 0)
    order by s.points desc, s.kills desc, s.deaths asc, s.user_id asc limit $2`, [season, limit]);
  return rows.map((r, i) => ({ rank: i + 1, address: r.public_id, handle: r.show_handle ? r.handle : null,
    kills: Number(r.kills), deaths: Number(r.deaths), points: Number(r.points) }));
}

// one account's arena: its fighter, today's $PROMPT from kills, the season score and rank
export async function view(q, userId, now = Date.now()) {
  const query = q.query ? q.query : q;
  const [f] = await query(`select f.*, u.public_id, u.handle, u.show_handle, n.name as nft_name, n.owner_id from arena_fighters f
    join users u on u.id = f.user_id join nfts n on n.id = f.nft_id where f.user_id = $1`, [userId]);
  const [s] = await query('select kills, deaths, points from arena_scores where season = $1 and user_id = $2', [CONFIG.season, userId]);
  const [{ today }] = await query('select coalesce(sum(points), 0)::bigint as today from arena_kills where killer_id = $1 and day = $2', [userId, dayOf(now)]);
  let rank = null;
  if (s && (Number(s.points) > 0 || Number(s.kills) > 0)) {
    const [r] = await query(`select count(*)::int + 1 as rank from arena_scores where season = $1 and
      (points > $2 or (points = $2 and kills > $3) or (points = $2 and kills = $3 and deaths < $4) or (points = $2 and kills = $3 and deaths = $4 and user_id < $5))`,
    [CONFIG.season, s.points, s.kills, s.deaths, userId]);
    rank = r.rank;
  }
  const fighter = f && Number(f.owner_id) === Number(userId) ? publicFighter(f, now) : null;
  return {
    fighter, season: CONFIG.season, kills: Number(s?.kills || 0), deaths: Number(s?.deaths || 0), points: Number(s?.points || 0), rank,
    today: Number(today), daily_cap: CONFIG.dailyCap,
    next_switch: f && CONFIG.switchHours > 0 ? Math.max(now, ms(f.switched_at) + CONFIG.switchHours * 3600e3) : null,
  };
}

export async function me(db, userId, now = Date.now()) {
  await db.query('update arena_fighters set last_seen = $2 where user_id = $1', [userId, new Date(now)]);
  return { ...(await view(db.query, userId, now)), citizens: await myCitizens(db, userId) };
}

export function rules() {
  return {
    hp: CONFIG.hp, damage: CONFIG.damage, hit_ms: CONFIG.hitMs, range: CONFIG.range, speed: CONFIG.speed, respawn_ms: CONFIG.respawnMs,
    shield_ms: CONFIG.shieldMs, kill_base: CONFIG.killBase, daily_cap: CONFIG.dailyCap, per_victim: CONFIG.perVictim,
    streak_pct: CONFIG.streakPct, streak_max: CONFIG.streakMax, switch_hours: CONFIG.switchHours, season: CONFIG.season,
    map: MAP, districts: districtRects(), stars: RARITIES.map((r, i) => ({ rarity: r, stars: stars(i + 1), damage: CONFIG.damage[r] })),
  };
}
