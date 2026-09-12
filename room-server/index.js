import { VoxelWorld, playerPrivate, playerPublic, PROTOCOL } from '../shared/world-engine.js';
import { GameError } from '../shared/inventory.js';

const MAX_PLAYERS = 8;
const send = (socket, value) => { if (socket.readyState !== 1) return; if (socket.bufferedAmount > 2097152) { socket.close(1013, 'Slow connection; reconnect to resync'); return; } try { socket.send(JSON.stringify(value)); } catch {} };

export class WorldRoom {
  constructor(store, worldId, verifyTicket, onEmpty = () => {}) {
    this.store = store; this.worldId = worldId; this.verifyTicket = verifyTicket; this.onEmpty = onEmpty;
    this.game = null; this.sessions = new Map(); this.pending = new Set(); this.attachments = new WeakMap();
    this.timer = null; this.chain = Promise.resolve(); this.queued = 0; this.tickCount = 0; this.mutations = [];
    const metadata = this.store.get('meta', 'world');
    if (metadata) this.game = new VoxelWorld(this.store, metadata);
  }
  enqueue(fn) {
    if (this.closing || this.failed) return Promise.reject(new GameError('connection_closed'));
    if (this.queued >= 384) return Promise.reject(new GameError('server_busy'));
    this.queued++;
    const task = this.chain.then(() => { if (this.failed) throw new GameError('save_unavailable'); return fn(); });
    this.chain = task.catch(() => {}).finally(() => { this.queued--; }); return task;
  }
  run(fn) { return this.store.run ? this.store.run(fn, this.game) : fn(); }
  durable() { return this.store.flush?.(); }
  fatal(error) {
    if (this.failed) return; this.failed = true; clearInterval(this.timer); this.timer = null;
    console.error('World paused safely:', error instanceof Error ? error.message : 'save unavailable');
    for (const s of this.sessions.values()) { send(s.socket, { type: 'save.error', message: 'Saving is unavailable. Reconnect to recover the last confirmed state.' }); s.socket.close(1013, 'Saving unavailable; reconnect'); }
    // Do not expose speculative state or roll it back while a commit is ambiguous.
    queueMicrotask(() => this.close(false).catch(() => {}).finally(() => this.onEmpty()));
  }
  accept(socket) {
    if (this.closing || this.sessions.size + this.pending.size >= MAX_PLAYERS + 4) { socket.close(1013, 'World is full'); return; }
    this.pending.add(socket); this.attachments.set(socket, { pending: true, world: this.worldId });
    const timeout = setTimeout(() => { if (this.pending.has(socket)) socket.close(4001, 'Authentication timeout'); }, 15000); timeout.unref?.();
    socket.on('message', (data, binary) => this.webSocketMessage(socket, binary ? data : data.toString()));
    socket.on('close', () => { clearTimeout(timeout); this.pending.delete(socket); this.webSocketClose(socket); });
    socket.on('error', () => this.webSocketClose(socket));
  }
  async authenticate(socket, msg) {
    if (typeof msg.ticket !== 'string' || !/^[A-Z2-9]{48}$/.test(msg.ticket)) throw new GameError('invalid_ticket');
    return this.authenticateIdentity(socket, await this.verifyTicket(msg.ticket));
  }
  authenticateIdentity(socket, identity) { return this.enqueue(() => this.admit(socket, identity)); }
  async admit(socket, identity) {
    if (this.closing || socket.readyState !== 1) throw new GameError('connection_closed');
    const attachment = this.attachments.get(socket);
    if (attachment?.identity && identity.user.id !== attachment.identity.user.id) throw new GameError('identity_changed');
    if (identity.world.id !== attachment?.world) throw new GameError('wrong_world');
    try {
      if (!this.game) this.game = await this.run(() => new VoxelWorld(this.store, identity.world));
      const existing = this.sessions.get(identity.user.id);
      if (!existing && this.sessions.size >= MAX_PLAYERS) throw new GameError('world_full');
      if (existing?.socket === socket) {
        existing.identity = identity; existing.expiresAt = Date.now() + 90000; existing.awaitingAuth = false;
        const p = this.game.players.get(identity.user.id); p.role = identity.role; p.mode = identity.world.mode;
        send(socket, { type: 'auth.renewed' }); return;
      }
      await this.flushMutations();
      if (existing) { this.game.leave(identity.user.id); existing.socket.close(4009, 'Opened on another device'); }
      const epoch = crypto.randomUUID();
      const p = await this.run(() => this.game.join(identity, epoch));
      await this.durable();
      if (socket.readyState !== 1) { this.game.leave(p.id); await this.durable(); return; }
      const session = { socket, identity, epoch, subscriptions: new Set(), expiresAt: Date.now() + 90000, lastSent: '', awaitingAuth: false, chunkQueue: [], interest: 3 };
      this.sessions.set(p.id, session); this.attachments.set(socket, { identity, epoch, world: identity.world.id }); this.pending.delete(socket);
      send(socket, { type: 'world.welcome', protocol: PROTOCOL, world: { ...this.game.meta, time: this.game.time() }, player: playerPrivate(p), maxPlayers: MAX_PLAYERS, serverTime: Date.now() });
      this.subscribe(session, p, true); this.start();
    } catch (error) { if (!(error instanceof GameError)) this.fatal(error); throw error; }
  }
  webSocketMessage(socket, raw) {
    if (this.closing || this.failed) return;
    if (typeof raw !== 'string' || raw.length > 16384) { socket.close(1009, 'Message too large'); return; }
    let msg;
    try { msg = JSON.parse(raw); if (!msg || typeof msg.type !== 'string') throw 0; }
    catch { send(socket, { type: 'error', code: 'invalid_message' }); return; }
    const attachment = this.attachments.get(socket), uid = attachment?.identity?.user?.id, session = this.sessions.get(uid);
    if (!session || session.socket !== socket) { send(socket, { type: 'error', code: 'authentication_required' }); return; }
    if (msg.type === 'auth') {
      if (session.authPending || Date.now() - (session.lastAuth || 0) < 10000) { send(socket, { type: 'error', code: 'rate_limited' }); return; }
      session.authPending = true; session.lastAuth = Date.now();
      this.authenticate(socket, msg).catch(() => socket.close(4001, 'Authentication failed')).finally(() => { session.authPending = false; }); return;
    }
    // At most one queued movement sample per connection; render FPS is unrelated.
    if (msg.type === 'player.state') { session.latestMove = msg; if (session.moveQueued) return; session.moveQueued = true; }
    this.enqueue(async () => {
      if (this.sessions.get(uid) !== session || socket.readyState !== 1) return;
      if (msg.type === 'player.state') { msg = session.latestMove; session.moveQueued = false; }
      try {
        if (session.expiresAt < Date.now()) throw new GameError('authentication_required');
        const game = this.game; game.now = Date.now(); game.rate(game.players.get(uid), 'message', 90);
        if (msg.type === 'ping') { send(socket, { type: 'pong', sent: Number.isFinite(msg.sent) ? msg.sent : null, serverTime: Date.now() }); return; }
        if (msg.type === 'player.state') { await this.run(() => game.move(uid, msg)); this.subscribe(session, game.players.get(uid)); return; }
        if (msg.type === 'interest') { game.rate(game.players.get(uid), 'interest', 3); session.interest = Math.max(2, Math.min(5, Math.floor(Number(msg.radius) || 3))); this.subscribe(session, game.players.get(uid), true); return; }
        if (msg.type === 'chat.message') {
          game.rate(game.players.get(uid), 'chat', 5, 10000);
          if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 300) throw new GameError('invalid_chat');
          const event = { type: 'chat.message', id: crypto.randomUUID(), name: game.players.get(uid).name, text: msg.text.trim().replace(/[\x00-\x1f]/g, ''), time: Date.now() };
          for (const other of this.sessions.values()) send(other.socket, event); return;
        }
        if (this.mutations.length >= 256) throw new GameError('server_busy');
        this.mutations.push({ uid, msg, socket });
      } catch (error) {
        if (!(error instanceof GameError)) { this.fatal(error); return; }
        const p = this.game?.players.get(uid);
        send(socket, { type: 'error', code: error.code, actionId: msg.actionId, player: p ? playerPrivate(p) : undefined });
      }
    }).catch(error => { if (!this.failed) send(socket, { type: 'error', code: error.code || 'server_busy' }); });
  }
  subscribe(session, p, force = false) {
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16), center = cx + ',' + cz;
    if (!force && session.center === center) return;
    session.center = center; const wanted = new Set(), additions = [];
    const pending = new Set(session.chunkQueue.map(c => c.x + ',' + c.z)), r = session.interest || 3;
    for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) { const key = x + ',' + z; wanted.add(key); if (!session.subscriptions.has(key) || pending.has(key)) additions.push({ x, z, distance: (x - cx) ** 2 + (z - cz) ** 2 }); }
    for (const key of session.subscriptions) if (!wanted.has(key)) send(session.socket, { type: 'chunk.unsubscribe', key });
    session.subscriptions = wanted; session.chunkQueue = additions.sort((a, b) => a.distance - b.distance);
  }
  events() {
    const events = this.game.events.splice(0); if (!events.length) return;
    for (const session of this.sessions.values()) {
      const visible = events.filter(e => { const p = e.entity || e; return session.subscriptions.has(Math.floor(p.x / 16) + ',' + Math.floor(p.z / 16)); });
      for (let i = 0; i < visible.length; i += 128) send(session.socket, { type: 'world.delta', events: visible.slice(i, i + 128) });
    }
  }
  async flushMutations() {
    if (!this.mutations.length) return;
    const queue = this.mutations.splice(0, 32), replies = []; this.game.beginBatch();
    for (const { uid, msg, socket } of queue) {
      if (this.sessions.get(uid)?.socket !== socket) continue;
      try { replies.push([socket, await this.run(() => this.game.action(uid, msg))]); }
      catch (error) {
        if (!(error instanceof GameError)) throw error;
        replies.push([socket, { type: 'error', code: error.code, actionId: msg.actionId, player: playerPrivate(this.game.players.get(uid)) }]);
      }
    }
    this.game.flushBatch(); await this.durable();
    for (const [socket, value] of replies) send(socket, value); this.events();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.tickQueued || this.closing || this.failed) return;
      this.tickQueued = true;
      this.enqueue(() => this.tick()).catch(error => this.fatal(error)).finally(() => { this.tickQueued = false; });
    }, 50); this.timer.unref?.();
  }
  async tick() {
    if (!this.game || !this.sessions.size) { clearInterval(this.timer); this.timer = null; return; }
    await this.flushMutations(); await this.run(() => this.game.tick(Date.now())); await this.durable(); this.tickCount++;
    for (const [uid, session] of this.sessions) {
      if (session.expiresAt < Date.now()) { session.socket.close(4001, 'Session expired'); continue; }
      if (session.expiresAt - Date.now() < 45000 && !session.awaitingAuth) { session.awaitingAuth = true; send(session.socket, { type: 'auth.renew' }); }
      for (let i = 0; i < 2 && session.chunkQueue.length; i++) {
        const c = session.chunkQueue.shift(); if (session.subscriptions.has(c.x + ',' + c.z)) this.sendChunk(session.socket, await this.run(() => this.game.snapshotChunk(c.x, c.z)));
      }
      if (this.tickCount % 2 === 0) {
        const players = [...this.game.players.values()].filter(p => p.id !== uid && session.subscriptions.has(Math.floor(p.x / 16) + ',' + Math.floor(p.z / 16))).map(playerPublic), encoded = JSON.stringify(players);
        if (encoded !== session.lastSent || this.tickCount % 40 === 0) { send(session.socket, { type: 'players.snapshot', players, serverTime: Date.now() }); session.lastSent = encoded; }
      }
      if (this.tickCount % 100 === 0) send(session.socket, { type: 'world.time', time: this.game.time(), weather: this.game.meta.weather, player: playerPrivate(this.game.players.get(uid)), savedAt: this.game.lastSave });
    }
    this.events();
  }
  sendChunk(socket, snapshot) {
    send(socket, { type: 'chunk.begin', cx: snapshot.cx, cz: snapshot.cz });
    for (const section of snapshot.sections) send(socket, { type: 'chunk.section', section });
    for (let i = 0; i < snapshot.entities.length; i += 48) send(socket, { type: 'entities.snapshot', entities: snapshot.entities.slice(i, i + 48) });
    send(socket, { type: 'chunk.ready', cx: snapshot.cx, cz: snapshot.cz });
  }
  webSocketClose(socket) {
    if (this.closing || this.failed) return;
    const uid = this.attachments.get(socket)?.identity?.user?.id;
    this.enqueue(async () => {
      if (this.sessions.get(uid)?.socket === socket) {
        await this.flushMutations(); this.game?.leave(uid); await this.durable(); this.sessions.delete(uid);
        for (const session of this.sessions.values()) send(session.socket, { type: 'player.leave', id: uid });
      }
      if (!this.sessions.size && !this.pending.size) { clearInterval(this.timer); this.timer = null; this.onEmpty(); }
    }).catch(error => this.fatal(error));
  }
  async close(save = true) {
    if (this.closing) return; this.closing = true; clearInterval(this.timer); this.timer = null;
    try {
      await this.chain;
      if (save && !this.failed) { while (this.mutations.length) await this.flushMutations(); for (const uid of this.sessions.keys()) this.game?.leave(uid); await this.durable(); }
    } finally {
      for (const session of this.sessions.values()) session.socket.close(1012, 'Server restarting; reconnect');
      for (const socket of this.pending) socket.close(1012, 'Server restarting; reconnect');
      this.sessions.clear(); this.pending.clear(); await this.store.close?.();
    }
  }
}
