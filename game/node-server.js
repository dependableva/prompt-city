// The shooter's game server in Node (local play and the tests; on the internet it runs on Cloudflare, worker.js).
// A page connects to /ws (one city, up to 100 online), sends {"t":"join","ticket":"..."} and then its keys 20-30 times a second.
// GAME_SECRET: the secret shared with the main server; REPORT_URL: the main server's /api/shooter/report.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, signedReport } from './room.js';

export function startGameServer({ port = 8787, secret, reportUrl, fetchImpl = fetch, rules = {} } = {}) {
  if (!secret) throw new Error('GAME_SECRET is required');
  const report = reportUrl ? async (kills) => {
    const { body, signature } = await signedReport(secret, kills);
    const r = await fetchImpl(reportUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-signature': signature }, body });
    if (!r.ok) throw new Error(`report ${r.status}`);
    return (await r.json()).results;
  } : null;
  const rooms = new Map();
  const roomOf = (id) => {
    if (!rooms.has(id)) rooms.set(id, new Room({ id, secret, report, rules }));
    return rooms.get(id);
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: [...rooms].map(([id, r]) => [id, r.size]) }));
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  const send = (ws, text) => { if (ws.readyState === 1) ws.send(text); };
  wss.on('connection', (ws, req) => {
    const room = roomOf('city'); // one city for everyone
    let joined = false;
    ws.on('message', async (data) => {
      const text = String(data);
      if (!joined) {
        let m; try { m = JSON.parse(text); } catch { return ws.close(); }
        if (m.t !== 'join') return;
        joined = await room.join(ws, m.ticket, send);
        if (!joined) ws.close();
        return;
      }
      room.message(ws, text, send);
    });
    ws.on('close', () => room.leave(ws, send));
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, wss, rooms, port: server.address().port,
    close: () => { for (const r of rooms.values()) r.stop(); wss.close(); server.close(); } })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startGameServer({ port: Number(process.env.PORT || 8787), secret: process.env.GAME_SECRET, reportUrl: process.env.REPORT_URL });
  console.log(`game server on :${s.port}`);
}
