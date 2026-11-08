// The shooter's game server on Cloudflare: a Worker in front, one Durable Object for the city (wrangler.toml): one map,
// up to 100 Citizens online. A page connects to wss://<worker>/ws and sends {"t":"join","ticket":"..."}; when the city
// is full it answers {"t":"full"} and the page waits for a seat. Secrets: GAME_SECRET (shared with the main server).
// Vars: REPORT_URL.
import { Room, signedReport } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/ws') return new Response('Prompt City game server', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName('city')).fetch(request);
  },
};

export class GameRoom {
  constructor(state, env) {
    this.env = env;
    const secret = env.GAME_SECRET;
    const report = env.REPORT_URL ? async (kills) => {
      const { body, signature } = await signedReport(secret, kills);
      const r = await fetch(env.REPORT_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-signature': signature }, body });
      if (!r.ok) throw new Error(`report ${r.status}`);
      return (await r.json()).results;
    } : null;
    this.room = new Room({ id: 'city', secret, report });
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const send = (ws, text) => { try { ws.send(text); } catch {} };
    let joined = false;
    server.addEventListener('message', async (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!joined) {
        let m; try { m = JSON.parse(text); } catch { return server.close(1003, 'bad'); }
        if (m.t !== 'join') return;
        joined = await this.room.join(server, m.ticket, send);
        if (!joined) server.close(1000, 'no seat');
        return;
      }
      this.room.message(server, text, send);
    });
    const gone = () => this.room.leave(server, send);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}
