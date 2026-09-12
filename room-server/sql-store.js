export class SqlStore {
  constructor(storage) {
    this.storage = storage; this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, cx INTEGER, cz INTEGER, updated INTEGER NOT NULL, PRIMARY KEY(kind,key))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS records_spatial ON records(kind,cx,cz)`);
  }
  get(kind, key) { const rows = this.sql.exec('SELECT value FROM records WHERE kind=? AND key=?', kind, key).toArray(); return rows.length ? JSON.parse(rows[0].value) : null; }
  put(kind, key, value) {
    const encoded = JSON.stringify(value); if (new TextEncoder().encode(encoded).byteLength > 512000) throw new Error('Persistent record exceeds application size limit');
    let cx = null, cz = null;
    if (kind === 'section') { const xyz = key.split(',').map(Number); cx = xyz[0]; cz = xyz[2]; }
    if (kind === 'entity') { cx = Math.floor(value.x / 16); cz = Math.floor(value.z / 16); }
    this.sql.exec(`INSERT INTO records(kind,key,value,cx,cz,updated) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value,cx=excluded.cx,cz=excluded.cz,updated=excluded.updated`, kind, key, encoded, cx, cz, Date.now());
  }
  delete(kind, key) { this.sql.exec('DELETE FROM records WHERE kind=? AND key=?', kind, key); }
  transaction(fn) { return this.storage.transactionSync(fn); }
  nearby(x0, x1, z0, z1) { return this.sql.exec(`SELECT value FROM records WHERE kind='entity' AND cx BETWEEN ? AND ? AND cz BETWEEN ? AND ? LIMIT 6000`, x0, x1, z0, z1).toArray().map(row => JSON.parse(row.value)); }
  sections(cx, cz) { return this.sql.exec(`SELECT value FROM records WHERE kind='section' AND cx=? AND cz=? ORDER BY key LIMIT 2048`, cx, cz).toArray().map(row => JSON.parse(row.value)); }
}
