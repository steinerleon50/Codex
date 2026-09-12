import { DatabaseSync, backup } from 'node:sqlite';
import { SqlStore } from './sql-store.js';

// The same authoritative reducer runs on ordinary Node.js and a persistent disk.
// A fenced lease prevents an overlapping replacement process from writing stale state.
export function openWorldStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
  const statements = new Map();
  const execute = (sql, args) => {
    let query = statements.get(sql);
    if (!query) { query = db.prepare(sql); if (statements.size < 128) statements.set(sql, query); }
    return query.columns().length ? query.all(...args) : (query.run(...args), []);
  };
  const token = crypto.randomUUID();
  let lost = false;
  db.exec('CREATE TABLE IF NOT EXISTS runtime_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,expires INTEGER NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT token,expires FROM runtime_lease WHERE id=1').get();
    if (row && row.expires > Date.now()) throw new Error('World is still owned by another live server');
    db.prepare('INSERT INTO runtime_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires=excluded.expires').run(token, Date.now() + 15000);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const storage = {
    sql: { exec(sql, ...args) { return { toArray: () => execute(sql, args) }; } },
    transactionSync(fn) {
      if (lost) throw new Error('World lease was lost');
      db.exec('BEGIN IMMEDIATE');
      try {
        const lease = db.prepare('SELECT token FROM runtime_lease WHERE id=1').get();
        if (lease?.token !== token) { lost = true; queueMicrotask(() => store.onFatal?.()); throw new Error('World lease was replaced'); }
        const result = fn();
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  // SQL writes must execute eagerly, matching SQLite transaction semantics.
  storage.sql.exec = (sql, ...args) => { const rows = execute(sql, args); return { toArray: () => rows }; };
  const store = new SqlStore(storage);
  let closed = false;
  const leaseTimer = setInterval(() => {
    try { storage.transactionSync(() => db.prepare('UPDATE runtime_lease SET expires=? WHERE id=1 AND token=?').run(Date.now() + 15000, token)); }
    catch { lost = true; clearInterval(leaseTimer); store.onFatal?.(); }
  }, 5000);
  leaseTimer.unref();
  store.backup = destination => backup(db, destination);
  store.close = () => {
    if (closed) return; closed = true; clearInterval(leaseTimer);
    try { db.prepare('DELETE FROM runtime_lease WHERE id=1 AND token=?').run(token); } finally { db.close(); }
  };
  return store;
}
