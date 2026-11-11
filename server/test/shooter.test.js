// The shooter: the shared rules (site/game/sim.js), the game server's room (game/room.js) and the main server's side
// (shooter.js: the game pass, the signed kill reports that pay like arena kills). One end-to-end match: two browsers'
// worth of websockets on a real game server, a kill in a live round, the $PROMPT on the account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const SECRET = crypto.randomBytes(32).toString('hex');
process.env.TEST_MODE = '1';
process.env.MCP_TRADING = 'open';
process.env.GAME_SECRET = SECRET;
process.env.GAME_URL = 'ws://127.0.0.1:1'; // set for real below, once the game server has a port
for (const k of Object.keys(process.env)) if (k.startsWith('ARENA_')) delete process.env[k];
const sim = await import('../../site/game/sim.js');
const { Room, readTicket, signedReport } = await import('../../game/room.js');
const { startGameServer } = await import('../../game/node-server.js');
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { memoryStorage } = await import('../src/storage.js');
const { checkMoney } = await import('../src/backup.js');
const m = await import('../src/market.js');
const arena = await import('../src/arena.js');
const shooter = await import('../src/shooter.js');

let db, app, server, base, game;
before(async () => {
  db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  ({ app } = await createApp({ db, publicUrl: 'http://localhost', devLogin: true, storage: memoryStorage() }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  game = await startGameServer({ port: 0, secret: SECRET, reportUrl: `${base}/api/shooter/report`, rules: { roundMs: 60000, endMs: 300 } });
  shooter.CONFIG.url = `ws://127.0.0.1:${game.port}`;
});
after(async () => { game?.close(); server?.close(); await db?.close(); });

let k = 0;
async function user(handle = `s${++k}`) {
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
const credit = async (u) => Number((await db.query('select credit_balance from users where id = $1', [u.id]))[0].credit_balance);

test('shooter rules: W walks where you look, walls stop walking and shots, the bay stops walking only, damage by stars', () => {
  const map = sim.MAPS.city;
  const r = sim.RULES.radius;
  // facing west (the outer wall) and holding W: stopped at the wall
  let [x, y] = [sim.TILE + r + 2, sim.TILE * 3 + 16];
  for (let i = 0; i < 20; i++) [x, y] = sim.moveStep(map, x, y, { u: true }, Math.PI, 50);
  assert.ok(x >= sim.TILE + r - 0.1, `stopped by the wall at ${x}`);
  assert.equal(sim.hitsWall(map, x, y, r), false);
  // W forward along the look, S back, D to the right of it (looking east, right is south)
  const [fx, fy] = sim.moveStep(map, 600, 80, { u: true }, 0, 100);
  assert.ok(fx > 610 && Math.abs(fy - 80) < 0.01);
  const [bx] = sim.moveStep(map, 600, 80, { d: true }, 0, 100);
  assert.ok(bx < 590);
  const [rx, ry] = sim.moveStep(map, 600, 80, { r: true }, 0, 100);
  assert.ok(Math.abs(rx - 600) < 0.01 && ry > 90);
  const [lx, ly] = sim.moveStep(map, 600, 80, { r: true }, Math.PI / 2, 100);
  assert.ok(lx < 590 && Math.abs(ly - 80) < 0.01, 'looking south, right is west');
  // diagonal walking is as fast as straight walking
  const [dx, dy] = sim.moveStep(map, 600, 80, { u: true, r: true }, 0, 100);
  assert.ok(Math.abs(Math.hypot(dx - 600, dy - 80) - sim.RULES.speed / 10) < 0.5);
  // a shot along row 4 from the left stops at the first building (column 8)
  const d = sim.shotWallDistance(map, 40, 4 * 32 + 16, 0, 2000);
  assert.ok(d > 200 && d < 230, `shot stopped after ${d}`);
  assert.equal(sim.blocksWalk(map, 5, 67), true, 'the bay');
  assert.equal(sim.blocksShot(map, 5, 67), false);
  // a gun for each number of stars: pistol, SMG, shotgun, rifle, marksman rifle; more stars, more damage a second
  const W = sim.RULES.weapons;
  assert.deepEqual(W.map((w) => w.key), ['pistol', 'smg', 'shotgun', 'rifle', 'marksman']);
  const dps = W.map((w) => (w.dmg * w.pellets * 1000) / w.fireMs);
  for (let i = 1; i < 5; i++) assert.ok(dps[i] > dps[i - 1], `${W[i].key} hits harder a second than ${W[i - 1].key}`);
  assert.deepEqual(W.map((w) => Math.ceil(100 / (w.dmg * w.pellets))), [7, 12, 2, 5, 2]);
  assert.equal(sim.weaponOf(3).key, 'shotgun'); assert.equal(sim.weaponOf(9).key, 'marksman'); assert.equal(sim.weaponOf(0).key, 'pistol');
});

test('shooter map: one city for everyone, up to 100 online, both crews have room to spawn', () => {
  assert.deepEqual(Object.keys(sim.MAPS), ['city']);
  assert.equal(sim.mapFor(2).key, 'city');
  assert.equal(sim.mapFor(100).key, 'city');
  assert.equal(sim.RULES.maxPlayers, 100);
  const city = sim.MAPS.city;
  assert.ok(city.spawns[0].length >= 100 && city.spawns[1].length >= 100);
  assert.deepEqual(city.rows, sim.cityRows(), 'the same city from the same seed');
  // every spawn tile can reach the other crew's: a flood fill over walkable tiles
  const seen = new Set(); const [sx, sy] = city.spawns[0][0].map((v) => Math.floor(v / sim.TILE));
  const q = [[sx, sy]];
  while (q.length) { const [x, y] = q.pop(); const key = `${x},${y}`; if (seen.has(key) || sim.blocksWalk(city, x, y)) continue; seen.add(key); q.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]); }
  for (const [x, y] of city.spawns[1].slice(0, 20)) assert.ok(seen.has(`${Math.floor(x / sim.TILE)},${Math.floor(y / sim.TILE)}`));
});

test('shooter world: warmup, a live round, a kill by stars, no friendly fire, the round ends', () => {
  let t = 1e6; const now = () => t;
  const kills = [];
  const w = new sim.World({ now, rand: () => 0.5, onKill: (x) => kills.push(x) });
  const a = w.add({ id: 1, uid: 11, addr: 'city_a', nft: 1, stars: 5 });
  assert.equal(w.phase, 'warmup');
  const b = w.add({ id: 2, uid: 12, addr: 'city_b', nft: 2, stars: 1 });
  w.step(); assert.equal(w.phase, 'live'); assert.notEqual(a.team, b.team);
  // face to face on an open street (row 3): the Legend's marksman rifle kills the Street in 2 shots
  Object.assign(a, { x: 200, y: 112, a: 0 }); Object.assign(b, { x: 300, y: 112 });
  w.input(1, { keys: {}, a: 0, fire: true });
  for (let i = 0; i < 20 && b.alive; i++) { t += 300; w.step(); }
  assert.equal(b.alive, false);
  assert.equal(a.ammo, sim.RULES.weapons[4].mag - 2);
  assert.equal(kills.length, 1);
  assert.equal(kills[0].paid, true);
  assert.equal(kills[0].killerStars, 5);
  // one crew is out: the round ends, then a new one starts
  t += 50; w.step(); assert.equal(w.phase, 'end'); assert.deepEqual(w.score, [a.team === 0 ? 1 : 0, a.team === 1 ? 1 : 0]);
  t += sim.RULES.endMs + 10; w.step(); assert.equal(w.phase, 'live'); assert.equal(b.alive, true);
  // teammates don't hurt each other in a round
  const c = w.add({ id: 3, uid: 13, addr: 'city_c', nft: 3, stars: 5 });
  assert.equal(c.alive, true, 'joining early in a round: in right away');
  const t0 = t; t = w.phaseUntil - 10000;
  const late = w.add({ id: 4, uid: 14, addr: 'city_d', nft: 4, stars: 1 });
  assert.equal(late.alive, false, 'joining in the last 30 seconds waits for the next round');
  w.remove(4); t = t0;
  t += 1; w.step();
  c.team = a.team; c.alive = true; Object.assign(c, { x: 300, y: 112, hp: 100 }); Object.assign(a, { x: 200, y: 112, a: 0, ammo: 10, reloadUntil: 0, nextShot: 0 });
  Object.assign(b, { x: 200, y: 400 });
  for (let i = 0; i < 5; i++) { t += 300; w.step(); }
  assert.equal(c.hp, 100);
  // the snapshot: only what is near my Citizen
  Object.assign(b, { x: 3000, y: 2000 });
  const s = w.snapshot(1);
  assert.ok(!s.p.some((p) => p[0] === 2), 'far players are not sent');
  assert.ok(s.p.some((p) => p[0] === 1));
  // a tracer says who shot and whether it hit
  assert.ok(w.shots.every((x) => x.length === 7));
  // the Boss's shotgun: all 7 pellets hit up close (one blast leaves 37 HP), nothing at twice its range
  const d = w.add({ id: 5, uid: 15, addr: 'city_e', nft: 5, stars: 3 });
  t += 1; w.step();
  Object.assign(d, { x: 200, y: 112, a: 0, alive: true, team: 1 - b.team, ammo: 6, reloadUntil: 0, nextShot: 0 });
  Object.assign(b, { x: 300, y: 112, hp: 100, alive: true });
  w.input(5, { keys: {}, a: 0, fire: true }); t += 1; w.step(); w.input(5, { keys: {}, a: 0, fire: false });
  assert.equal(b.hp, 100 - 7 * 9);
  assert.equal(w.shots.filter((x) => x[6] === 5).length, 7, 'a tracer for every pellet');
  Object.assign(b, { x: 200 + 2 * sim.RULES.weapons[2].range, hp: 100 });
  Object.assign(d, { nextShot: 0 }); w.input(5, { keys: {}, a: 0, fire: true }); t += 1; w.step();
  assert.equal(b.hp, 100);
  w.remove(5);
  // standing still with the same aim is not playing (a seat left open in another tab frees up after a while)
  const was = a.lastActive; t += 5000;
  w.input(1, { keys: {}, a: a.a, fire: false }); assert.equal(a.lastActive, was);
  w.input(1, { keys: { u: true }, a: a.a, fire: false }); assert.equal(a.lastActive, t);
  // the page's input number comes back with its position, so the page can compare like with like
  w.input(1, { keys: {}, a: a.a, fire: false, seq: 41 }); assert.equal(a.seq, 41);
  w.input(1, { keys: {}, a: a.a, fire: false, seq: 'x' }); assert.equal(a.seq, 41);
});

test('shooter pass: the main server signs it, the game server reads it; a changed or late one is refused', async () => {
  const u = await user();
  await assert.rejects(shooter.ticket(db, u.id), /Pick your fighter/);
  const nft = await give(u, 'Kingpin');
  await arena.join(db, u.id, nft);
  const t = await shooter.ticket(db, u.id);
  const p = await readTicket(SECRET, t.ticket);
  assert.equal(p.u, u.id); assert.equal(p.n, nft); assert.equal(p.s, 4); assert.equal(p.a, u.public_id);
  assert.equal(await readTicket('another secret is not the same at all', t.ticket), null);
  const [body, mac] = t.ticket.split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, s: 5 })).toString('base64url');
  assert.equal(await readTicket(SECRET, `${forged}.${mac}`), null);
  assert.equal(await readTicket(SECRET, `${body}.${mac}`, Date.now() + 11 * 60e3), null, 'expired');
});

test('shooter report: signed, pays like an arena kill, once per kill, the daily cap', async () => {
  const a = await user(); const b = await user();
  const na = await give(a, 'Street'); const nb = await give(b, 'Legend');
  const kill = (ref, streak = 0) => ({ ref, killer: a.id, victim: b.id, killer_nft: na, victim_nft: nb, killer_stars: 1, victim_stars: 5, killer_streak: streak, at: Date.now() });
  const post = async (kills, sign = true) => {
    const { body, signature } = await signedReport(SECRET, kills);
    const r = await fetch(`${base}/api/shooter/report`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sign ? { 'x-game-signature': signature } : {}) }, body });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await post([kill('x1')], false)).status, 403);
  const before = await credit(a);
  const r1 = await post([kill('r1'), kill('r2', 1)]);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body.results.map((x) => x.points), [250, 275]);
  const again = await post([kill('r1')]);
  assert.equal(again.body.results[0].points, 250, 'the same kill reported twice');
  assert.equal(await credit(a), before + 525, '... pays once');
  const third = await post([kill('r3'), kill('r4')]);
  assert.deepEqual(third.body.results.map((x) => x.points), [250, 0], 'only 3 paid kills of one victim a day');
  // an old report is refused
  const old = JSON.stringify({ kills: [kill('r5')], at: Date.now() - 10 * 60e3 });
  const sig = crypto.createHmac('sha256', SECRET).update(old).digest('base64url');
  assert.equal((await fetch(`${base}/api/shooter/report`, { method: 'POST', headers: { 'x-game-signature': sig }, body: old })).status, 403);
  const c = await checkMoney(db);
  assert.ok(c.creditMatch);
});

test('shooter match end to end: two players on the game server, a kill in a live round, $PROMPT on the account', async () => {
  const a = await user(); const b = await user();
  await arena.join(db, a.id, await give(a, 'Legend'));
  await arena.join(db, b.id, await give(b, 'Street'));
  const before = await credit(a);
  const open = async (u) => {
    const t = await shooter.ticket(db, u.id);
    const ws = new WebSocket(`${t.url}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', ticket: t.ticket }));
    const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = msgs.find(fn); if (x) return x; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
    return { ws, msgs, until };
  };
  const pa = await open(a); const pb = await open(b);
  const ha = await pa.until((x) => x.t === 'hello'); await pb.until((x) => x.t === 'hello');
  await pa.until((x) => x.t === 's' && x.phase === 'live');
  // put them face to face (the test reaches into the room) and let a hold the trigger
  const room = game.rooms.get('city');
  const [A, B] = [room.world.players.get(ha.id), [...room.world.players.values()].find((p) => p.id !== ha.id)];
  Object.assign(A, { x: 200, y: 112 }); Object.assign(B, { x: 300, y: 112 });
  pb.ws.send(JSON.stringify({ t: 'in', k: {}, a: Math.PI, f: false }));
  for (let i = 0; i < 40; i++) { pa.ws.send(JSON.stringify({ t: 'in', k: {}, a: 0, f: true })); await new Promise((r) => setTimeout(r, 50)); if (!B.alive) break; }
  assert.equal(B.alive, false, 'b is down');
  const paid = await pa.until((x) => x.t === 'paid', 6000);
  assert.equal(paid.points, 10, 'a Legend that takes down a Street: 50 × 1 ÷ 5');
  assert.equal(await credit(a), before + 10);
  assert.equal((await arena.view(db.query, a.id)).kills >= 1, true);
  pa.ws.close(); pb.ws.close();
});

test('shooter room: one seat per account, the room is full at its limit, a bad pass gets no seat', async () => {
  const sent = [];
  const room = new Room({ id: 'rx', secret: SECRET, report: null, rules: { maxPlayers: 2 }, timers: { setInterval: () => 1, clearInterval: () => {} } });
  const send = (s, text) => sent.push([s, JSON.parse(text)]);
  const pass = async (u) => (await shooter.ticket(db, u.id)).ticket;
  const a = await user(); await arena.join(db, a.id, await give(a));
  const b = await user(); await arena.join(db, b.id, await give(b));
  const c = await user(); await arena.join(db, c.id, await give(c));
  assert.equal(await room.join('s1', 'nonsense', send), false);
  assert.equal(await room.join('s1', await pass(a), send), true);
  assert.equal(await room.join('s2', await pass(a), send), true, 'the same account again: the new tab plays');
  assert.equal(room.size, 1);
  assert.equal(await room.join('s3', await pass(b), send), true);
  assert.equal(await room.join('s4', await pass(c), send), false);
  assert.ok(sent.some(([s, msg]) => s === 's4' && msg.t === 'full' && msg.n === 2 && msg.max === 2));
  // the scoreboard goes to everyone, where your crew is only to your crew
  sent.length = 0; room.board(send);
  const [b2, b3] = ['s2', 's3'].map((s) => sent.find(([x]) => x === s)[1]);
  assert.equal(b2.t, 'board'); assert.equal(b2.b.length, 2);
  const team = (s) => room.world.players.get(room.sockets.get(s)).team;
  assert.ok(b2.mates.every(([id]) => room.world.players.get(id).team === team('s2')));
  assert.ok(b3.mates.every(([id]) => room.world.players.get(id).team === team('s3')));
  assert.notDeepEqual(b2.mates, b3.mates);
});
