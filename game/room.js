// The shooter's one city: up to RULES.maxPlayers (100) Citizens online at once; when it is full, a page waits for a seat. It runs the world 20 times a second, takes every
// player's keys, aim and trigger, and sends everyone the world back. Who a player is comes from a ticket the main
// server signed (/api/shooter/ticket): the account, its city address and the Citizen it fights with. Kills in a live
// round go back to the main server (/api/shooter/report, signed), which pays the $PROMPT under its own limits and
// answers what each kill paid. The same code runs on Cloudflare (worker.js) and in Node (node-server.js, tests).
import { World, RULES } from '../site/game/sim.js';

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(secret, text) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text)));
}
// a ticket is "<payload base64url>.<hmac base64url>"; the payload says who and with which Citizen, until when
export async function readTicket(secret, ticket, now = Date.now()) {
  const [body, mac] = String(ticket || '').split('.');
  if (!body || !mac || body.length > 2000) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(mac), enc.encode(body));
  if (!ok) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
  if (!p || typeof p.e !== 'number' || p.e < now) return null;
  return p; // { u: user id, a: city address, h: handle or null, n: NFT id, s: stars, e: expires (ms) }
}

export class Room {
  // send(socket, text); close(socket); report(kills) -> Promise<[{ ref, points, why }]>; now(); setInterval/clearInterval
  constructor({ id = 'city', secret, report, now = () => Date.now(), rules = {}, timers = globalThis }) {
    this.id = id; this.secret = secret; this.report = report; this.now = now; this.timers = timers;
    this.sockets = new Map(); // socket -> player id
    this.byUser = new Map(); // account -> player id (one seat per account)
    this.pending = []; // kills waiting to be reported
    this.seq = 0;
    this.world = new World({ rules, now, onKill: (k) => this.kill(k) });
    this.loop = null;
  }
  get size() { return this.world.players.size; }
  full() { return this.size >= this.world.rules.maxPlayers; }
  async join(socket, ticket, send) {
    const t = await readTicket(this.secret, ticket, this.now());
    if (!t) return send(socket, JSON.stringify({ t: 'error', error: 'Your game pass expired: reload the page.' })), false;
    const had = this.byUser.get(t.u);
    if (had != null) this.leaveId(had); // the same account from another tab: the new one plays
    if (this.full()) return send(socket, JSON.stringify({ t: 'full', n: this.size, max: this.world.rules.maxPlayers })), false;
    const id = ++this.seq;
    const p = this.world.add({ id, uid: t.u, addr: t.a, handle: t.h, nft: t.n, stars: t.s });
    this.sockets.set(socket, id); this.byUser.set(t.u, id);
    send(socket, JSON.stringify({ t: 'hello', id, room: this.id, rules: this.world.rules, team: p.team,
      roster: this.roster() }));
    this.broadcast(send, { t: 'roster', roster: this.roster() });
    if (!this.loop) this.start(send);
    return true;
  }
  roster() {
    return [...this.world.players.values()].map((p) => ({ id: p.id, addr: p.addr, handle: p.handle, nft: p.nft, stars: p.stars, team: p.team }));
  }
  message(socket, text, send) {
    const id = this.sockets.get(socket); if (id == null) return;
    if (text.length > 300) return;
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'in') this.world.input(id, { keys: m.k || {}, a: Number(m.a), fire: !!m.f, reload: !!m.r });
    else if (m.t === 'ping') send(socket, JSON.stringify({ t: 'pong', c: m.c, s: this.now() }));
  }
  leave(socket, send) {
    const id = this.sockets.get(socket); this.sockets.delete(socket);
    if (id != null) this.leaveId(id);
    if (send) this.broadcast(send, { t: 'roster', roster: this.roster() });
    if (!this.sockets.size) this.stop();
  }
  leaveId(id) {
    const p = this.world.players.get(id);
    if (p) this.byUser.delete(p.uid);
    this.world.remove(id);
    for (const [s, pid] of this.sockets) if (pid === id) this.sockets.delete(s);
  }
  broadcast(send, msg) {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const s of this.sockets.keys()) send(s, text);
  }
  start(send) {
    this.send = send;
    let last = this.now();
    this.loop = this.timers.setInterval(() => {
      const now = this.now();
      // nobody holds a seat for nothing: no line for a minute, or nothing done for two, and you are out
      for (const [s, id] of this.sockets) { const p = this.world.players.get(id); if (p && (now - p.lastInput > 60000 || now - p.lastActive > 120000)) { this.leave(s, send); try { s.close?.(4000, 'idle'); } catch {} } }
      this.world.step(Math.min(100, now - last)); last = now;
      // each page gets the players and shots near its own Citizen, plus its own ammo and reload
      for (const [s, id] of this.sockets) {
        const p = this.world.players.get(id);
        send(s, JSON.stringify({ ...this.world.snapshot(id), me: p ? { ammo: p.ammo, reloading: p.reloadUntil ? Math.max(0, p.reloadUntil - now) : 0 } : null }));
      }
      // every 2 seconds: the scoreboard (Tab) for everyone, and where your own crew is (the radar)
      if (this.tickNo % 40 === 0) this.board(send);
      if (this.pending.length && this.tickNo % 20 === 0) this.flush();
      this.tickNo++;
    }, this.world.rules.tickMs);
    this.tickNo = 0;
  }
  board(send) {
    const all = [...this.world.players.values()];
    const b = all.map((p) => [p.id, p.team, p.kills, p.deaths, p.alive ? 1 : 0]);
    const mates = [0, 1].map((team) => all.filter((p) => p.team === team && p.alive).map((p) => [p.id, Math.round(p.x), Math.round(p.y)]));
    const text = [0, 1].map((team) => JSON.stringify({ t: 'board', b, mates: mates[team] }));
    for (const [s, id] of this.sockets) { const p = this.world.players.get(id); if (p) send(s, text[p.team]); }
  }
  stop() { if (this.loop) this.timers.clearInterval(this.loop); this.loop = null; this.flush(); }
  kill(k) {
    if (!k.paid) return; // warmup kills don't pay
    this.pending.push({ ref: `${this.id}:${crypto.randomUUID()}`, killer: k.killerPlayer.uid, victim: k.victimPlayer.uid,
      killer_nft: k.killerPlayer.nft, victim_nft: k.victimPlayer.nft, killer_stars: k.killerStars, victim_stars: k.victimStars,
      killer_streak: k.streak || 0, killer_id: k.killer, at: this.now() });
  }
  // send the kills to the main server; what each paid goes back to the killer's page
  async flush() {
    if (!this.pending.length || !this.report) return;
    const batch = this.pending.splice(0, 50);
    try {
      const results = await this.report(batch);
      for (const r of results || []) {
        const k = batch.find((x) => x.ref === r.ref); if (!k) continue;
        for (const [s, id] of this.sockets) if (id === k.killer_id) this.send?.(s, JSON.stringify({ t: 'paid', points: r.points, why: r.why || null }));
      }
    } catch (e) {
      // the main server didn't answer: keep them for the next try (each kill has its own ref, so a retry can't pay twice)
      this.pending.unshift(...batch);
      if (this.pending.length > 2000) this.pending.splice(0, this.pending.length - 2000);
    }
  }
}

// the report request: the JSON body signed with the shared secret, with the time (the main server refuses old ones)
export async function signedReport(secret, kills, now = Date.now()) {
  const body = JSON.stringify({ kills, at: now });
  return { body, signature: await sign(secret, body) };
}
export { RULES };
