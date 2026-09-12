// Only confirmed state lives in Sites D1. This bounded cache is disposable.
export class CacheMiss extends Error {
  constructor(request) { super('Authoritative data must be loaded first'); this.request = request; }
}
export class CloudStore {
  static async open({ siteOrigin, secret, worldId, request = fetch }) {
    if (!secret || secret.length < 48) throw new Error('A server-only storage secret is required');
    const store = new CloudStore(siteOrigin, secret, worldId, request);
    const lease = await store.call({ op: 'acquire' });
    store.fence = lease.fence; store.sequence = lease.sequence; store.expiresAt = lease.expiresAt;
    await store.hydrate({ op: 'get', kind: 'meta', key: 'world' });
    return store;
  }
  constructor(origin, secret, worldId, request) {
    this.origin = new URL(origin).origin; this.secret = secret; this.worldId = worldId; this.request = request;
    this.holder = crypto.randomUUID(); this.rows = new Map(); this.known = new Set(); this.columns = new Map();
    this.pending = new Map(); this.changeVersion = 0; this.bytes = 0; this.closed = false;
  }
  async call(data, attempts = 3) {
    if (this.closed) throw new Error('Storage is closed');
    const body = JSON.stringify({ world: this.worldId, holder: this.holder, fence: this.fence, dimension: 'overworld', ...data });
    if (Buffer.byteLength(body) > 524288) throw new Error('Atomic save exceeds free-tier request budget');
    let error;
    for (let n = 0; n < attempts; n++) {
      try {
        const response = await this.request(this.origin + '/api/game/world-storage', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.secret },
          body, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) { const failure = new Error('World storage rejected request (' + response.status + ')'); failure.terminal = response.status < 500 && response.status !== 429; throw failure; }
        return await response.json();
      } catch (caught) { error = caught; if (caught.terminal) break; if (n + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 200 * 2 ** n)); }
    }
    throw error;
  }
  rowKey(kind, key) { return kind + ':' + key; }
  columnFor(kind, key, value) {
    if (kind === 'section') { const p = key.split(','); return p[0] + ',' + p[2]; }
    if (kind === 'entity' && value) return Math.floor(value.x / 16) + ',' + Math.floor(value.z / 16);
    return null;
  }
  cache(kind, key, value) {
    const id = this.rowKey(kind, key), previous = this.rows.get(id), encoded = value === null ? null : JSON.stringify(value);
    if (previous) this.bytes -= Buffer.byteLength(previous.encoded);
    if (encoded === null) this.rows.delete(id); else { this.bytes += Buffer.byteLength(encoded); this.rows.set(id, { kind, key, encoded, column: this.columnFor(kind, key, value) }); }
    this.known.add(id);
  }
  get(kind, key) {
    const id = this.rowKey(kind, key), row = this.rows.get(id);
    if (row) return JSON.parse(row.encoded);
    if (this.known.has(id)) return null;
    const column = this.columnFor(kind, key);
    if (column && this.columns.has(column)) return null;
    throw new CacheMiss(column ? { op: 'column', cx: Number(column.split(',')[0]), cz: Number(column.split(',')[1]) } : { op: 'get', kind, key });
  }
  put(kind, key, value) {
    if (!this.transactionWrites) throw new Error('Write outside a transaction');
    const copy = JSON.parse(JSON.stringify(value));
    if (Buffer.byteLength(JSON.stringify(copy)) > 65536) throw new Error('Persistent record exceeds 64 KiB; blobs need separate storage');
    this.transactionWrites.set(this.rowKey(kind, key), { kind, key, value: copy });
  }
  delete(kind, key) { if (!this.transactionWrites) throw new Error('Write outside a transaction'); this.transactionWrites.set(this.rowKey(kind, key), { kind, key, value: null }); }
  transaction(fn) {
    if (this.transactionWrites) throw new Error('Nested storage transaction');
    this.transactionWrites = new Map();
    try {
      const value = fn(), combined = new Map([...this.pending, ...this.transactionWrites]);
      // Do not split inventory/world changes into partially committed batches.
      if (combined.size > 128 || Buffer.byteLength(JSON.stringify([...combined.values()])) > 490000) throw new Error('Atomic edit is too large');
      for (const r of this.transactionWrites.values()) this.cache(r.kind, r.key, r.value);
      this.pending = combined; this.changeVersion++; return value;
    } finally { this.transactionWrites = null; }
  }
  column(cx, cz) {
    const key = cx + ',' + cz;
    if (!this.columns.has(key)) throw new CacheMiss({ op: 'column', cx, cz });
    this.columns.set(key, Date.now());
    return [...this.rows.values()].filter(r => r.column === key);
  }
  nearby(x0, x1, z0, z1) {
    const rows = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const r of this.column(x, z)) if (r.kind === 'entity') rows.push(JSON.parse(r.encoded));
    return rows;
  }
  sections(cx, cz) { return this.column(cx, cz).filter(r => r.kind === 'section').map(r => JSON.parse(r.encoded)); }
  async hydrate(query) {
    if (query.op === 'get') { const r = await this.call(query); this.cache(query.kind, query.key, r.value); return; }
    const records = []; let cursor = null;
    do {
      const page = await this.call({ ...query, cursor }); records.push(...page.records); cursor = page.next;
      if (records.length > 25000) throw new Error('Column exceeds the active server memory budget');
    } while (cursor);
    // No empty-column marker is visible until ALL pages have arrived.
    for (const r of records) if (!this.pending.has(this.rowKey(r.kind, r.key))) this.cache(r.kind, r.key, r.value);
    this.columns.set(query.cx + ',' + query.cz, Date.now());
    if (this.bytes > 67108864) throw new Error('Active world cache exceeds 64 MiB; reconnect to release distant data');
  }
  async run(fn, game = null) {
    for (let tries = 0; tries < 2048; tries++) {
      // Reads can suspend. Restore simulation state before retrying; never repeat a
      // partially applied movement/tick or accept unknown records as empty terrain.
      const players = game ? structuredClone(game.players) : null;
      const timing = game ? [game.now, game.lastTick, game.lastSave] : null;
      const version = this.changeVersion;
      try { return fn(); }
      catch (error) {
        if (!(error instanceof CacheMiss)) throw error;
        if (version !== this.changeVersion) throw new Error('Cache miss after a local commit; reconnect required');
        if (game) { game.players = players; [game.now, game.lastTick, game.lastSave] = timing; }
        await this.hydrate(error.request);
      }
    }
    throw new Error('World load exceeds the per-operation budget');
  }
  async flush() {
    if (!this.pending.size) {
      if (Date.now() + 20000 > this.expiresAt) { const lease = await this.call({ op: 'renew' }); this.expiresAt = lease.expires_at; }
      return;
    }
    // Frozen payload and stable ID survive a response lost AFTER D1 committed.
    const writes = [...this.pending.values()];
    const operation = { op: 'commit', batch: crypto.randomUUID(), sequence: this.sequence, writes };
    const result = await this.call(operation);
    if (result.sequence !== this.sequence + 1) throw new Error('Unexpected world commit sequence');
    this.sequence = result.sequence; this.pending.clear(); this.expiresAt = Date.now() + 40000;
  }
  async close() {
    if (this.closed) return;
    try { if (!this.pending.size) await this.call({ op: 'release' }, 1); } catch {} finally { this.closed = true; this.secret = ''; this.rows.clear(); this.known.clear(); this.columns.clear(); }
  }
}
