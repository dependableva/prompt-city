// The arena (arena.js, /play): fighters are Citizens; stars set the damage; kills pay $PROMPT with daily limits; the
// season's points rank the top 10. All of it is decided by the server from times and places in the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open';
delete process.env.DISTRICTS;
for (const k of Object.keys(process.env)) if (k.startsWith('ARENA_')) delete process.env[k];
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { checkMoney } = await import('../src/backup.js');
const m = await import('../src/market.js');
const arena = await import('../src/arena.js');

let db, app, server, base;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

let k = 0;
async function user(handle = `a${++k}`) {
  const u = await m.upsertUser(db, { xId: `dev:${handle}`, handle });
  await m.ensurePublicIds(db);
  return (await db.query('select * from users where id = $1', [u.id]))[0];
}
async function give(u, rarity = 'Street') {
  const [n] = await db.query(`update nfts set owner_id = $1, minted_at = now() where id = (
    select n.id from nfts n join collections c on c.id = n.collection_id where c.slug = 'citizens' and n.minted_at is null and n.rarity = $2
    order by n.id limit 1) returning id`, [u.id, rarity]);
  return Number(n.id);
}
// two fighters standing next to each other, out of their spawn protection
async function pair(ra = 'Street', rb = 'Street', t0 = Date.now()) {
  const a = await user(); const b = await user();
  await arena.join(db, a.id, await give(a, ra), t0);
  await arena.join(db, b.id, await give(b, rb), t0);
  await db.query(`update arena_fighters set x = 500, y = 500, tx = 500, ty = 500, moved_at = $2, shield_until = null, last_seen = $2
    where user_id = any($1::int[])`, [[a.id, b.id], new Date(t0)]);
  return { a, b, t0 };
}
const seen = (ids, t) => db.query('update arena_fighters set last_seen = $2 where user_id = any($1::int[])', [ids, new Date(t)]);
// hits until the victim is down, one a second; returns the kill
async function kill(a, b, t) {
  for (let i = 0; i < 50; i++) {
    t += 1000;
    await seen([a.id, b.id], t);
    const r = await arena.attack(db, a.id, b.public_id, t);
    if (r.killed) return { r, t };
  }
  throw new Error('no kill');
}
const credit = async (u) => Number((await db.query('select credit_balance from users where id = $1', [u.id]))[0].credit_balance);
const moneyOk = async () => {
  const c = await checkMoney(db);
  assert.ok(c.balancesMatch);
  assert.ok(c.creditMatch, '$PROMPT = burns + drops + jobs + arena kills - claims');
};

test('arena: damage by stars, 100 HP, one hit a second, range, kill and respawn with protection', async () => {
  const { a, b, t0 } = await pair('Legend', 'Street');
  let t = t0 + 1000;
  const h1 = await arena.attack(db, a.id, b.public_id, t);
  assert.equal(h1.damage, 20);
  assert.equal(h1.hp, 80);
  await assert.rejects(arena.attack(db, a.id, b.public_id, t + 300), /Too fast/);
  // the Street hits back for 10
  const back = await arena.attack(db, b.id, a.public_id, t + 100);
  assert.equal(back.damage, 10);
  assert.equal(back.hp, 90);
  // a Legend takes a Street down in 5 hits
  let r;
  for (let i = 0; i < 4; i++) { t += 1000; await seen([a.id, b.id], t); r = await arena.attack(db, a.id, b.public_id, t); }
  assert.equal(r.killed, true);
  assert.equal(r.victim.stars, 1);
  // down: no hits, no moves, back after the respawn time, then protected until it hits someone
  await assert.rejects(arena.attack(db, a.id, b.public_id, t + 1000), /Already down/);
  await assert.rejects(arena.move(db, b.id, 100, 100, t + 1000), /You are down/);
  const after = t + arena.CONFIG.respawnMs + 10;
  await seen([a.id, b.id], after);
  const [fb] = await db.query('select * from arena_fighters where user_id = $1', [b.id]);
  assert.equal(arena.hpNow(fb, after), 100, 'full HP again');
  await db.query('update arena_fighters set x = 500, y = 500, tx = 500, ty = 500, moved_at = $2 where user_id = $1', [b.id, new Date(after)]);
  await assert.rejects(arena.attack(db, a.id, b.public_id, after + 1000), /protected/);
  // too far
  await db.query('update arena_fighters set x = 2000, y = 900, tx = 2000, ty = 900, shield_until = null where user_id = $1', [b.id]);
  await assert.rejects(arena.attack(db, a.id, b.public_id, after + 2000), /Too far/);
  await moneyOk();
});

test('arena: a kill pays 50 × victim stars ÷ killer stars, the streak adds 10% a kill', () => {
  assert.equal(arena.killPoints(1, 1), 50);
  assert.equal(arena.killPoints(1, 5), 250, 'a Street that takes down a Legend');
  assert.equal(arena.killPoints(5, 1), 10, 'a Legend that takes down a Street');
  assert.equal(arena.killPoints(3, 3, 2), 60, '+20% for 2 kills in a row');
  assert.equal(arena.killPoints(1, 1, 9), 75, 'the streak counts at most 5 kills: +50%');
});

test('arena: $PROMPT and season points from kills, 3 paid kills of one victim a day, the daily cap', async () => {
  const { a, b, t0 } = await pair('Street', 'Legend');
  const before = await credit(a);
  let t = t0;
  // a Street takes down a Legend: 250 $PROMPT, then 275 (streak 1), then 300 (streak 2)
  const got = [];
  for (let i = 0; i < 4; i++) {
    const x = await kill(a, b, t); t = x.t + arena.CONFIG.respawnMs + arena.CONFIG.shieldMs + 10;
    await db.query('update arena_fighters set x = 500, y = 500, tx = 500, ty = 500, moved_at = $2, shield_until = null where user_id = $1', [b.id, new Date(t)]);
    got.push(x.r);
  }
  assert.deepEqual(got.map((r) => r.points), [250, 275, 300, 0]);
  assert.match(got[3].why, /3 paid kills of this fighter today/);
  assert.equal(await credit(a), before + 825);
  const me = await arena.view(db.query, a.id, t);
  assert.equal(me.kills, 4);
  assert.equal(me.points, 825);
  assert.equal(me.today, 825);
  assert.equal(me.rank >= 1, true);
  const vb = await arena.view(db.query, b.id, t);
  assert.equal(vb.deaths, 4);
  // the daily cap: kills of other fighters stop paying at 1,500 $PROMPT
  let paid = 825;
  for (let i = 0; i < 6 && paid < arena.CONFIG.dailyCap; i++) {
    const c = await user();
    await arena.join(db, c.id, await give(c, 'Legend'), t);
    await db.query('update arena_fighters set x = 500, y = 500, tx = 500, ty = 500, moved_at = $2, shield_until = null where user_id = $1', [c.id, new Date(t)]);
    const x = await kill(a, c, t); t = x.t;
    paid += x.r.points;
  }
  assert.equal(paid, arena.CONFIG.dailyCap);
  assert.equal((await arena.view(db.query, a.id, t)).today, arena.CONFIG.dailyCap);
  await moneyOk();
});

test('arena: only Citizens you own; one fighter change a day; a sold Citizen leaves the arena; the idle can not be hit', async () => {
  const a = await user(); const b = await user();
  const n1 = await give(a, 'Street'); const n2 = await give(a, 'Boss'); const nb = await give(b, 'Street');
  await assert.rejects(arena.join(db, a.id, nb), /don't own/);
  const t0 = Date.now();
  const j = await arena.join(db, a.id, n1, t0);
  assert.equal(j.fighter.stars, 1);
  await assert.rejects(arena.join(db, a.id, n2, t0 + 3600e3), /once in 24 hours/);
  const j2 = await arena.join(db, a.id, n2, t0 + 25 * 3600e3);
  assert.equal(j2.fighter.stars, 3);
  assert.equal(j2.changed, true);
  // the idle: no request for longer than ONLINE_SECONDS
  await arena.join(db, b.id, nb, t0);
  await db.query('update arena_fighters set x = 500, y = 500, tx = 500, ty = 500, moved_at = $2, shield_until = null, last_seen = $2 where user_id = any($1::int[])', [[a.id, b.id], new Date(t0)]);
  const later = t0 + arena.ONLINE_MS() + 5000;
  await seen([a.id], later);
  await assert.rejects(arena.attack(db, a.id, b.public_id, later), /away/);
  // b sells or sends its Citizen: its fighter is gone
  await db.query('update nfts set owner_id = $1 where id = $2', [a.id, nb]);
  await seen([a.id, b.id], later + 1000);
  await assert.rejects(arena.attack(db, a.id, b.public_id, later + 1000), /left the arena/);
  await assert.rejects(arena.move(db, b.id, 1, 1, later + 1000), /Pick your fighter/);
});

test('arena: walking takes time at the arena speed and stays on the map', async () => {
  const a = await user();
  const t0 = Date.now();
  await arena.join(db, a.id, await give(a, 'Hustler'), t0);
  await db.query('update arena_fighters set x = 100, y = 100, tx = 100, ty = 100, moved_at = $2 where user_id = $1', [a.id, new Date(t0)]);
  const r = await arena.move(db, a.id, 100 + arena.CONFIG.speed * 2, 100, t0);
  assert.equal(r.tx, 100 + arena.CONFIG.speed * 2);
  const [f] = await db.query('select * from arena_fighters where user_id = $1', [a.id]);
  assert.deepEqual(arena.pos(f, t0 + 1000).map(Math.round), [100 + arena.CONFIG.speed, 100]);
  assert.deepEqual(arena.pos(f, t0 + 5000).map(Math.round), [100 + arena.CONFIG.speed * 2, 100]);
  const off = await arena.move(db, a.id, 99999, 99999, t0 + 5000);
  assert.equal(off.tx, arena.MAP.w);
  assert.equal(off.ty, arena.MAP.h - arena.MAP.ocean, 'not into the ocean');
  assert.equal(arena.districtRects().length, 10);
  assert.ok(arena.districtAt(...arena.spawnPoint()), 'fighters spawn inside a district');
});

test('arena: the site: the world is public and cached, playing needs the sign-in and the site header', async () => {
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } return r; };
  const cookie = () => [...jar].map(([key, v]) => `${key}=${v}`).join('; ');
  const raw = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o, headers: { cookie: cookie(), ...(o.headers || {}) } }).then(keep);
  const w = await raw('/api/arena/world');
  assert.equal(w.status, 200);
  assert.match(w.headers.get('netlify-cdn-cache-control') || '', /s-maxage=1/);
  const world = await w.json();
  assert.ok(Array.isArray(world.fighters) && Array.isArray(world.top) && world.map.w > 0);
  assert.equal((await raw('/api/arena/rules')).status, 200);
  assert.equal((await raw('/api/arena/me')).status, 401, 'signed out');
  assert.equal((await raw('/play')).status, 200, 'the page');
  // sign in on the site, as the launchpad does
  const handle = `site${crypto.randomBytes(3).toString('hex')}`;
  const start = await raw('/login/site?return=%2Fplay');
  const id = new URL(start.headers.get('location'), base).searchParams.get('req');
  const done = await raw('/login/dev', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${id}&handle=${handle}` });
  assert.equal(done.headers.get('location'), '/play');
  const u = (await db.query('select * from users where handle = $1', [handle]))[0];
  const nft = await give(u, 'Kingpin');
  const post = (p, body, headers = { 'x-mcp-site': '1', origin: 'http://localhost' }) => raw('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/arena/join', { nft_id: nft }, {})).status, 403, 'another site can not make the move');
  const j = await post('/arena/join', { nft_id: nft });
  assert.equal(j.status, 200);
  assert.equal((await j.json()).fighter.stars, 4);
  const mine = await (await raw('/api/arena/me')).json();
  assert.equal(mine.fighter.nft, nft);
  assert.ok(mine.citizens.some((c) => Number(c.id) === nft));
  assert.equal((await post('/arena/move', { x: 300, y: 300 })).status, 200);
  const bad = await post('/arena/attack', { target: 'city_nobody' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /No such fighter/);
  const w2 = await (await raw('/api/arena/world')).json();
  assert.ok(w2.fighters.some((f) => f.nft === nft), 'on the map for everyone');
});
