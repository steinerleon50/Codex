import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { WorldRoom } from './index.js';
import { openWorldStore } from './node-store.js';
import { CloudStore } from './cloud-store.js';
import { PROTOCOL } from '../shared/world-engine.js';

export function createGameServer({ siteOrigin, dataDirectory, verifyTicket, storageSecret, storageRequest, maxRooms = 4 }) {
  const origin = new URL(siteOrigin).origin;
  if (!storageSecret && !dataDirectory) throw new Error('Durable cloud storage or a persistent DATA_DIR is required');
  if (dataDirectory) mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const authenticate = verifyTicket || (async ticket => {
    const response = await fetch(origin + '/api/game/verify-ticket', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Authentication failed');
    return response.json();
  });
  const rooms = new Map(), opening = new Map(), idleTimers = new Map();
  let shuttingDown = false;
  const server = createServer((request, response) => {
    if (request.url !== '/health') { response.writeHead(404).end(); return; }
    response.writeHead(shuttingDown ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: !shuttingDown, protocol: PROTOCOL, activeWorlds: rooms.size, maxPlayersPerWorld: 8 }));
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false, clientTracking: true });
  server.on('upgrade', (request, socket, head) => {
    const match = (request.url || '').match(/^\/room\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
    if (shuttingDown || !match || request.headers.origin !== origin || sockets.clients.size >= 80) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    // Unauthenticated connections never open world databases or consume a room.
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.alive = true; ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      const timeout = setTimeout(() => ws.close(4001, 'Authentication timeout'), 10000); timeout.unref();
      ws.on('close', () => clearTimeout(timeout));
      ws.once('message', async (raw, binary) => {
        try {
          const msg = !binary && JSON.parse(raw.toString());
          if (!msg || msg.type !== 'auth' || !/^[A-Z2-9]{48}$/.test(msg.ticket)) throw new Error('Invalid ticket');
          const identity = await authenticate(msg.ticket);
          if (identity.world?.id !== match[1] || !identity.user?.id || !['owner', 'builder', 'visitor'].includes(identity.role)) throw new Error('Access denied');
          if (ws.readyState !== 1 || shuttingDown) return;
          const id = match[1];
          let room = rooms.get(id);
          if (room?.closing || room?.failed) { rooms.delete(id); room = null; }
          if (!room) {
            if (!opening.has(id)) {
              if (rooms.size + opening.size >= maxRooms) { ws.close(1013, 'Server is full'); return; }
              const create = (async () => {
                const store = storageSecret
                  ? await CloudStore.open({ siteOrigin: origin, secret: storageSecret, worldId: id, request: storageRequest })
                  : openWorldStore(join(dataDirectory, id + '.sqlite'));
                const current = new WorldRoom(store, id, authenticate, () => {
                  if (idleTimers.has(id)) return;
                  const timer = setTimeout(async () => {
                    idleTimers.delete(id);
                    if (current.sessions.size || current.pending.size) return;
                    if (rooms.get(id) === current) rooms.delete(id);
                    try { await current.close(); } catch { /* Last confirmed save remains durable. */ }
                  }, current.failed ? 0 : 30000); timer.unref(); idleTimers.set(id, timer);
                });
                rooms.set(id, current);
                store.onFatal = () => { if (rooms.get(id) !== current) return; rooms.delete(id); current.fatal(new Error('World authority lost')); };
                return current;
              })();
              opening.set(id, create); create.finally(() => opening.delete(id)).catch(() => {});
            }
            room = await opening.get(id);
          }
          clearTimeout(idleTimers.get(match[1])); idleTimers.delete(match[1]);
          clearTimeout(timeout); room.accept(ws);
          // The initial single-use ticket was verified above; do not consume it twice.
          await room.authenticateIdentity(ws, identity);
        } catch { ws.close(4001, 'Authentication or world loading failed'); }
      });
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL }));
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 20000); heartbeat.unref();
  return {
    server,
    async close() {
      shuttingDown = true; clearInterval(heartbeat);
      for (const timer of idleTimers.values()) clearTimeout(timer);
      await Promise.allSettled([...opening.values()]);
      const saves = await Promise.allSettled([...rooms.values()].map(room => room.close()));
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise(resolve => server.close(resolve));
      if (saves.some(result => result.status === 'rejected')) throw new Error('A final world save failed; the last committed state is retained');
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SITE_ORIGIN?.startsWith('https://')) throw new Error('SITE_ORIGIN must use HTTPS');
  const app = createGameServer({ siteOrigin: process.env.SITE_ORIGIN, dataDirectory: process.env.DATA_DIR, storageSecret: process.env.ROOM_STORAGE_SECRET });
  app.server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
  const stop = () => app.close().then(() => process.exit(0)).catch(() => process.exit(1));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
