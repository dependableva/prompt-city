// The shooter's side on the main server: the game pass and the kills.
// - A signed-in player with a fighter (arena.js join: a Citizen it owns) gets a short-lived ticket, signed with
//   GAME_SECRET, that the game server (game/) checks: the account, its city address, the Citizen and its stars.
// - The game server reports kills from live rounds, signed with the same secret; each pays like an arena kill
//   (arena.payKill: base * victim stars / killer stars, the streak, the daily limits) and only once (its ref).
// GAME_URL: the game server's websocket address (wss://...); without it and GAME_SECRET the shooter is off and /play
// shows the arena.
import crypto from 'node:crypto';
import * as arena from './arena.js';
import { MarketError } from './market.js';

const fail = (msg) => { throw new MarketError(msg); };
const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const CONFIG = {
  secret: process.env.GAME_SECRET || '',
  url: (process.env.GAME_URL || '').trim(),
  ticketMin: 10,
  skewMs: 5 * 60 * 1000, // a report older than this is refused (each kill pays once anyway)
};
export const enabled = () => !!(CONFIG.secret && CONFIG.secret.length >= 32 && /^wss?:\/\//.test(CONFIG.url));
const mac = (text) => crypto.createHmac('sha256', CONFIG.secret).update(text).digest('base64url');

export async function ticket(db, userId, now = Date.now()) {
  if (!enabled()) fail('The shooter is not switched on yet.');
  const v = await arena.view(db.query, userId, now);
  if (!v.fighter) fail('Pick your fighter first.');
  const [u] = await db.query('select public_id, handle, show_handle from users where id = $1', [userId]);
  const body = b64url(JSON.stringify({ u: Number(userId), a: u.public_id, h: u.show_handle ? u.handle : null, n: v.fighter.nft,
    s: v.fighter.stars, e: now + CONFIG.ticketMin * 60e3, r: crypto.randomBytes(6).toString('hex') }));
  return { ticket: `${body}.${mac(body)}`, url: CONFIG.url, expires: now + CONFIG.ticketMin * 60e3 };
}

// the game server's report: { kills: [{ ref, killer, victim, killer_nft, victim_nft, killer_stars, victim_stars,
// killer_streak, at }], at }, signed in the x-game-signature header
export function verify(raw, signature, now = Date.now()) {
  if (!enabled() || !signature || !raw) return null;
  const want = Buffer.from(mac(raw));
  const got = Buffer.from(String(signature));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let body; try { body = JSON.parse(raw); } catch { return null; }
  if (!body || !Array.isArray(body.kills) || body.kills.length > 200 || Math.abs(now - Number(body.at)) > CONFIG.skewMs) return null;
  return body;
}

export async function report(db, kills, now = Date.now()) {
  const results = [];
  for (const k of kills) {
    const ref = String(k.ref || '').slice(0, 80);
    const ok = ref && [k.killer, k.victim, k.killer_nft, k.victim_nft].every((x) => Number.isInteger(Number(x)) && Number(x) > 0)
      && Number(k.killer) !== Number(k.victim);
    if (!ok) { results.push({ ref, points: 0, why: 'bad kill' }); continue; }
    const r = await db.tx((t) => arena.payKill(t, {
      killerId: Number(k.killer), victimId: Number(k.victim), killerNft: Number(k.killer_nft), victimNft: Number(k.victim_nft),
      killerStars: clampStars(k.killer_stars), victimStars: clampStars(k.victim_stars), streak: Math.max(0, Number(k.killer_streak) || 0),
      ref, now: Number.isFinite(Number(k.at)) && Math.abs(now - Number(k.at)) < CONFIG.skewMs ? Number(k.at) : now,
    }));
    results.push({ ref, points: r.points, why: r.why });
  }
  return results;
}
const clampStars = (s) => Math.max(1, Math.min(5, Number(s) | 0));
