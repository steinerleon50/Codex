import { createTerrain } from './terrain.js';
import { TREE_VERSION, TREE_META, baseBlock, baseEntities, transformedBuilding } from './treehouse-template.js';
import { sampleLift, planLift, liftOccupant, liftDoorOccupied, liftCollisionBoxes } from './online-lift.js';
import { ITEMS, BLOCKS, FURNITURE, GameError, requireValue, integer, validItem, makeStack, add, give, consume, damageTool, inventoryAction, returnEscrow, SMELTS, fuelValue } from './inventory.js';

export const PROTOCOL = 1;
export const MAX_COORD = 2000000;
const mod = (n, m) => (n % m + m) % m;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function hashString(value) { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return h >>> 0; }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const sectionKey = (x, y, z) => [Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16)].join(',');
const cellIndex = (x, y, z) => mod(y, 16) * 256 + mod(z, 16) * 16 + mod(x, 16);
const overlaps = (a, b, e = 0.0001) => a[0] < b[3] - e && a[3] > b[0] + e && a[1] < b[4] - e && a[4] > b[1] + e && a[2] < b[5] - e && a[5] > b[2] + e;
export function coordinates(a, integerOnly = true) {
  for (const key of ['x', 'y', 'z']) requireValue(Number.isFinite(a[key]) && (integerOnly ? Number.isSafeInteger(a[key]) : true), 'invalid_coordinates');
  requireValue(Math.abs(a.x) <= MAX_COORD && Math.abs(a.z) <= MAX_COORD && a.y >= 1 && a.y <= 1000000, 'invalid_coordinates');
  return a;
}
export function playerPublic(p) {
  return { id: p.id, name: p.name, skin: p.skin, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    vx: p.vx, vy: p.vy, vz: p.vz, health: p.health, dead: p.dead, height: p.height,
    state: p.state || 'idle', flight: p.flight, held: p.inventory[p.hotbar]?.id || 0, armor: p.armor.map(s => s?.id || 0) };
}
export function playerPrivate(p) {
  return { ...playerPublic(p), inventory: p.inventory, armor: p.armor, hotbar: p.hotbar,
    cursor: p.cursor, craft: p.craft, craftSize: p.craftSize, container: p.container, hunger: p.hunger,
    xp: p.xp, air: p.air, mode: p.mode, role: p.role, revision: p.revision, epoch: p.epoch, spawn: p.spawn, seat:p.seat || null };
}

// The store interface is implemented by strongly consistent per-world SQLite.
// No client snapshot can call put(). Transactions include both inventory and world deltas.
export class VoxelWorld {
  constructor(store, metadata, now = Date.now()) {
    this.store = store; this.meta = store.get('meta', 'world') || { ...metadata, version: 1, time: 300, timeAt: now, weather: 'clear', revision: 0 };
    requireValue(this.meta.id === metadata.id && this.meta.seed === metadata.seed && this.meta.owner === metadata.owner, 'world_mismatch');
    this.terrain = createTerrain(hashString(this.meta.seed), BLOCKS);
    this.players = new Map(); this.sections = new Map(); this.entities = new Map(); this.entityBuckets = new Map(); this.events = [];
    this.dirty = new Map(); this.now = now; this.lastTick = now; this.lastSave = now;
    this.stage = null; this.meta.mode = metadata.mode;
    if (!store.get('meta', 'world')) store.transaction(() => store.put('meta', 'world', this.meta));
  }
  time() { return mod(this.meta.time + (this.now - this.meta.timeAt) / 1000, 1200); }
  structures() {
    const list = this.meta.structures ||= [];
    if (this.structureList !== list) {
      this.structureList = list; this.baseEntities = new Map(); this.baseBuckets = new Map();
      for (const b of list) for (const e of baseEntities(b)) {
        e.structure = b.uid; this.baseEntities.set(e.uid, e);
        const key = Math.floor(e.x / 16) + ',' + Math.floor(e.z / 16);
        if (!this.baseBuckets.has(key)) this.baseBuckets.set(key, []);
        this.baseBuckets.get(key).push(e);
      }
      this.entityBuckets.clear();
    }
    return list;
  }
  structureComplete(uid) { return this.structures().some(b => b.uid === uid && this.now >= b.startAt + b.duration); }
  columnEntities(cx, cz) {
    this.structures();
    const map = new Map((this.baseBuckets.get(cx + ',' + cz) || []).map(e => [e.uid, e]));
    for (const e of this.store.nearby(cx,cx,cz,cz)) map.set(e.uid,e);
    for (const [,r] of this.pendingWrites || []) if(r[0]==='entity' && r[2] && Math.floor(r[2].x/16)===cx && Math.floor(r[2].z/16)===cz) map.set(r[1],r[2]);
    return [...map.values()].filter(e => e.kind !== 'removed' && (!e.structure || this.structureComplete(e.structure)));
  }
  getSection(key) {
    if (this.stage?.sections.has(key)) return this.stage.sections.get(key);
    if (!this.sections.has(key)) this.sections.set(key, this.store.get('section', key) || { key, revision: 0, edits: {} });
    return this.sections.get(key);
  }
  getBlock(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 1) return 11;
    const s = this.getSection(sectionKey(x, y, z)), i = cellIndex(x, y, z);
    if (s.edits[i] !== undefined) return s.edits[i];
    for (const b of this.structures()) {
      const [ox,oy,oz] = b.origin, localY = y - oy;
      if (this.now < b.startAt + b.duration && localY > TREE_META.bounds[1] + (TREE_META.bounds[4] - TREE_META.bounds[1]) * Math.max(0,(this.now-b.startAt)/b.duration)) continue;
      const id = baseBlock(x-ox,localY,z-oz); if (id !== undefined) return id;
    }
    if (y >= 112) return 0;
    return this.terrain.generate(Math.floor(x / 16), Math.floor(z / 16)).data[y * 256 + mod(z, 16) * 16 + mod(x, 16)];
  }
  setBlock(x, y, z, id) {
    coordinates({ x, y, z }); integer(id, 0, 255); requireValue(!!BLOCKS[id], 'invalid_block');
    const key = sectionKey(x, y, z);
    if (!this.stage.sections.has(key)) this.stage.sections.set(key, structuredClone(this.getSection(key)));
    const section = this.stage.sections.get(key); section.edits[cellIndex(x, y, z)] = id; section.revision++;
    this.stage.events.push({ type: 'block.update', x, y, z, id, section: key, revision: section.revision });
  }
  entity(uid) {
    requireValue(typeof uid === 'string' && /^[a-zA-Z0-9,:._-]{1,160}$/.test(uid), 'invalid_entity');
    if (this.stage?.entities.has(uid)) return this.stage.entities.get(uid);
    // A deletion inside the current batch must not reload the old durable item.
    const pending = this.pendingWrites?.get('entity:' + uid);
    if (pending) return pending[2]?.kind==='removed' ? null : pending[2];
    if (!this.entities.has(uid)) {
      this.structures(); const base=this.baseEntities.get(uid);
      if(base) for(const e of this.columnEntities(Math.floor(base.x/16),Math.floor(base.z/16))) this.indexEntity(e);
      else { const entity = this.store.get('entity', uid); if (entity) this.entities.set(uid, entity); }
    }
    const e=this.entities.get(uid); return e?.kind === 'removed' ? null : e || null;
  }
  updateEntity(e) { this.stage.entities.set(e.uid, e); }
  removeEntity(e) { this.stage.entities.set(e.uid, e.structure ? {uid:e.uid,kind:'removed',structure:e.structure,x:e.x,y:e.y,z:e.z} : null); this.stage.events.push({ type: 'entity.remove', uid: e.uid, x: e.x, y: e.y, z: e.z }); }
  indexEntity(e) {
    const key = Math.floor(e.x / 16) + ',' + Math.floor(e.z / 16);
    let bucket = this.entityBuckets.get(key);
    if (!bucket) { bucket = new Set(); this.entityBuckets.set(key, bucket); }
    bucket.add(e.uid); this.entities.set(e.uid, e);
  }
  nearby(x, z, range = 16) {
    this.structures();
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16), r = Math.ceil(range / 16), map = new Map();
    for (let bx = cx - r; bx <= cx + r; bx++) for (let bz = cz - r; bz <= cz + r; bz++) {
      const key = bx + ',' + bz;
      if (!this.entityBuckets.has(key)) {
        const loaded = this.columnEntities(bx, bz);
        this.entityBuckets.set(key, new Set());
        for (const e of loaded) this.indexEntity(e);
      }
      for (const uid of this.entityBuckets.get(key)) { const e = this.entities.get(uid); if (e && e.kind!=='removed') map.set(uid, e); }
    }
    for (const [uid, e] of this.stage?.entities || []) { if (!e || e.kind==='removed') map.delete(uid); else if (Math.abs(e.x - x) <= range + 16 && Math.abs(e.z - z) <= range + 16) map.set(uid, e); }
    return [...map.values()];
  }
  blockBoxes(x, y, z) {
    const b = BLOCKS[this.getBlock(x, y, z)];
    if (!b?.solid) return [];
    return (b.boxes || [b.bounds || [0, 0, 0, 1, 1, 1]]).map(a => [x + a[0], y + a[1], z + a[2], x + a[3], y + a[4], z + a[5]]);
  }
  furnitureBoxes(e) {
    const d = FURNITURE[e.furnitureType || e.type]; if (!d) return [];
    const a = e.q * Math.PI / 2, c = Math.cos(a), s = Math.sin(a), scale = e.scale || [1, 1, 1];
    return d.collisions[e.state?.open ? 1 : 0].map(b => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 8; k++) { const x = b[k & 1 ? 3 : 0] * scale[0], y = b[k & 2 ? 4 : 1] * scale[1], z = b[k & 4 ? 5 : 2] * scale[2]; const p = [e.x + c * x + s * z, e.y + y, e.z - s * x + c * z]; for (let n = 0; n < 3; n++) { lo[n] = Math.min(lo[n], p[n]); hi[n] = Math.max(hi[n], p[n]); } }
      return [...lo, ...hi];
    });
  }
  collision(x, y, z, radius = 0.29, height = 1.78, ignoreFurniture) {
    const body = [x - radius, y + 0.025, z - radius, x + radius, y + height - 0.025, z + radius];
    for (let by = Math.floor(y); by <= Math.floor(y + height); by++) for (let bz = Math.floor(z - radius); bz <= Math.floor(z + radius); bz++) for (let bx = Math.floor(x - radius); bx <= Math.floor(x + radius); bx++) for (const box of this.blockBoxes(bx, by, bz)) if (overlaps(body, box)) return true;
    for (const e of this.nearby(x, z, 4)) if (e.kind === 'furniture' && e.uid !== ignoreFurniture) for (const box of this.furnitureBoxes(e)) if (overlaps(body, box)) return true;
    for (const e of this.nearby(x,z,4)) if(e.kind==='lift' && e.uid!==ignoreFurniture) for(const box of liftCollisionBoxes(e,y,this.now)) if(overlaps(body,box)) return true;
    return false;
  }
  canBuild(p) { return ['owner', 'builder'].includes(p.role); }
  reach(p, target, limit = p.mode === 'creative' ? 8 : 5.5) {
    coordinates(target, false);
    const dx = target.x - p.x, dy = target.y - (p.y + p.height - 0.18), dz = target.z - p.z, length = Math.hypot(dx, dy, dz);
    requireValue(length <= limit + 0.35, 'out_of_reach');
    for (let d = 0.3; d < length - 0.75; d += 0.25) { const id = this.getBlock(p.x + dx * d / length, p.y + p.height - 0.18 + dy * d / length, p.z + dz * d / length); requireValue(!BLOCKS[id]?.opaque, 'blocked_line_of_sight'); }
  }
  spawn() {
    for (let r = 0; r < 128; r += 4) for (let d = 0; d < 8; d++) { const x = 8 + Math.round(Math.cos(d * Math.PI / 4) * r), z = 8 + Math.round(Math.sin(d * Math.PI / 4) * r); for (let y = 110; y > 32; y--) if (BLOCKS[this.getBlock(x, y, z)]?.solid && !this.collision(x + 0.5, y + 1.001, z + 0.5)) return [x + 0.5, y + 1.001, z + 0.5]; }
    return [8.5, 112, 8.5];
  }
  join(identity, epoch) {
    let p = this.store.get('player', identity.user.id);
    if (!p) {
      const spawn = this.spawn();
      p = { id: identity.user.id, x: spawn[0], y: spawn[1], z: spawn[2], spawn, vx: 0, vy: 0, vz: 0, yaw: -0.35, pitch: -0.09,
        health: 20, hunger: 20, air: 20, xp: 0, exhaustion: 0, dead: false, height: 1.8, flight: false,
        inventory: Array(36).fill(null), armor: Array(4).fill(null), cursor: null, craft: Array(4).fill(null), craftSize: 2, container: null, hotbar: 0, revision: 0, recent: [], fallStart: spawn[1] };
      if (this.meta.mode === 'creative') [1, 8, 3, 4, 7, 9, 25, 33, 107].forEach((id, i) => { p.inventory[i] = makeStack(id, 64); });
    }
    p = { ...p, name: identity.user.name, skin: identity.user.skin, role: identity.role, mode: this.meta.mode, epoch, vx: 0, vy: 0, vz: 0, lastMove: this.now, lastReceive: this.now, rate: {}, container: null };
    if(p.lift){const lift=this.entity(p.lift);if(lift?.kind==='lift' && Math.hypot(p.x-lift.x,p.z-lift.z)<1.5){p.y=sampleLift(lift,this.now).y+.24;p.fallStart=p.y;}else p.lift=null;}
    this.players.set(p.id, p); this.store.transaction(() => this.store.put('player', p.id, p)); return p;
  }
  leave(uid) {
    const p = this.players.get(uid); if (!p) return;
    this.store.transaction(() => this.store.put('player', uid, p)); this.players.delete(uid);
  }
  rate(p, key, max, windowMs = 1000) {
    const r = p.rate[key] || (p.rate[key] = { time: this.now, n: 0 });
    if (this.now - r.time >= windowMs) { r.time = this.now; r.n = 0; }
    requireValue(++r.n <= max, 'rate_limited');
  }
  move(uid, a) {
    const p = this.players.get(uid); requireValue(p && !p.dead, 'not_playing'); this.rate(p, 'move', 35);
    coordinates(a, false); for (const key of ['yaw', 'pitch']) requireValue(Number.isFinite(a[key]) && Math.abs(a[key]) < 100000, 'invalid_rotation');
    let riding = p.lift ? this.entity(p.lift) : null;
    if (riding?.kind === 'lift' && liftOccupant(riding,p,this.now,1)) {
      const cab=sampleLift(riding,this.now);
      if(Math.hypot(a.x-riding.x,a.z-riding.z)<1.45 && Math.abs(a.y-(cab.y+.24))<Math.max(1.2,Math.abs(cab.speed)*1.2)) a={...a,y:cab.y+.24};
      else {p.lift=null;riding=null;}
    } else {p.lift=null;riding=null;}
    const elapsed = clamp((this.now - p.lastMove) / 1000, 0.016, 1.5), maxSpeed = p.mode === 'creative' ? 22 : 8.5;
    const horizontal = Math.hypot(a.x - p.x, a.z - p.z), vertical = a.y - p.y;
    p.moveBudget = Math.min(maxSpeed * 1.6, (p.moveBudget ?? maxSpeed * 0.4) + maxSpeed * elapsed);
    requireValue(horizontal <= p.moveBudget, 'movement_rejected');
    const lift = p.lift ? this.entity(p.lift) : null, liftSpeed = lift ? 30 : 0;
    requireValue(horizontal <= maxSpeed * elapsed + 0.6 && vertical <= (liftSpeed || (p.mode === 'creative' ? 22 : 9)) * elapsed + 0.75 && vertical >= -48 * elapsed - 1, 'movement_rejected');
    requireValue(!a.flight || p.mode === 'creative', 'flight_denied');
    const height = a.crouch || a.state === 'slide' ? 1.5 : 1.8;
    const steps = Math.max(1, Math.ceil(Math.hypot(horizontal, vertical) / 0.35));
    for (let i = 1; i <= steps; i++) requireValue(!this.collision(p.x + (a.x - p.x) * i / steps, p.y + vertical * i / steps, p.z + (a.z - p.z) * i / steps, 0.27, height - 0.08, p.seat || riding?.uid), 'collision_rejected');
    const grounded = this.collision(a.x, a.y - 0.13, a.z, 0.25, 0.12), water = this.getBlock(a.x, a.y + 0.5, a.z) === 10, ladder = this.getBlock(a.x, a.y + 0.7, a.z) === 58;
    if (p.mode !== 'creative' && !grounded && !water && !ladder && !lift && !p.seat) {
      if (p.airborneSince === undefined) p.airborneSince = this.now;
      requireValue(this.now - p.airborneSince < 1500 || vertical < -0.03, 'flight_denied');
    } else p.airborneSince = undefined;
    if (grounded && !p.grounded && p.mode !== 'creative' && !water && !lift) this.hurt(p, Math.max(0, Math.floor((p.fallStart || p.y) - a.y - 3)), 'fall');
    if (grounded || water || lift) p.fallStart = a.y; else p.fallStart = Math.max(p.fallStart || a.y, a.y);
    p.vx = (a.x - p.x) / elapsed; p.vy = vertical / elapsed; p.vz = (a.z - p.z) / elapsed;
    p.x = a.x; p.y = a.y; p.z = a.z; p.yaw = mod(a.yaw + Math.PI, Math.PI * 2) - Math.PI; p.pitch = clamp(a.pitch, -1.55, 1.55);
    p.moveBudget -= horizontal; p.height = height; p.flight = !!a.flight && p.mode === 'creative'; p.grounded = grounded;
    p.state = p.seat ? 'sitting' : water ? 'swimming' : a.state === 'slide' && horizontal / elapsed > 3 ? 'slide' : !grounded ? (vertical > 0 ? 'jump' : 'fall') : a.crouch ? 'crouch' : horizontal > 0.01 ? (horizontal / elapsed > 5 ? 'sprint' : 'walk') : 'idle';
    p.exhaustion += horizontal * (p.state === 'sprint' ? 0.08 : 0.018); p.lastMove = this.now; p.lastReceive = this.now;
    return playerPublic(p);
  }
  hurt(p, amount, cause) {
    if (p.mode === 'creative' || amount <= 0 || p.dead || this.now < (p.hurtUntil || 0)) return;
    const armor = p.armor.reduce((sum, s) => sum + (ITEMS[s?.id]?.armor || 0), 0);
    p.health = Math.max(0, p.health - Math.max(1, amount * (1 - armor * 0.04))); p.hurtUntil = this.now + 650;
    if (p.health <= 0) { p.dead = true; p.cause = cause; }
  }
  drop(p, stack) {
    const e = { uid: crypto.randomUUID(), kind: 'drop', x: p.x, y: p.y + 0.5, z: p.z, stack: { ...stack }, createdAt: this.now, pickAt: this.now + 800, expiresAt: this.now + 300000 };
    this.updateEntity(e); this.stage.events.push({ type: 'entity.spawn', entity: e });
  }
  container(p, target, create = false) {
    requireValue(this.canBuild(p), 'permission_denied');
    let e, key;
    if (typeof target === 'string') { key = target; e = this.entity(key); }
    else if (target?.furniture) { key = String(target.furniture); const furniture = this.entity(key); requireValue(furniture?.kind === 'furniture', 'invalid_container'); const d = FURNITURE[furniture.furnitureType]; requireValue(d?.storage, 'invalid_container'); e = { ...furniture, slots: furniture.slots || Array(d.storage).fill(null), type: 'furniture' }; }
    else if (target) { coordinates(target); const id = this.getBlock(target.x, target.y, target.z); requireValue([23, 24, 47].includes(id), 'invalid_container'); key = 'container:' + [target.x, target.y, target.z].join(','); e = this.entity(key) || { uid: key, kind: 'container', type: id === 23 ? 'craft' : id === 24 ? 'furnace' : 'chest', x: target.x, y: target.y, z: target.z, slots: Array(id === 24 ? 3 : id === 23 ? 0 : 27).fill(null), burn: 0, progress: 0, xp: 0 }; }
    requireValue(e && (e.kind === 'container' || e.kind === 'furniture'), 'invalid_container'); this.reach(p, e, 8);
    if (!this.stage.entities.has(key)) this.stage.entities.set(key, structuredClone(e));
    return this.stage.entities.get(key);
  }
  context() { return { now: this.now, canBuild: p => this.canBuild(p), drop: (p, s) => this.drop(p, s), container: (p, t, c) => this.container(p, t, c), dirtyContainer: c => this.updateEntity(c) }; }
  action(uid, a) {
    const original = this.players.get(uid); requireValue(original, 'not_playing');
    requireValue(!original.dead || a.type === 'player.respawn', 'player_dead');
    requireValue(a && typeof a.type === 'string' && typeof a.actionId === 'string' && /^[a-zA-Z0-9:_-]{1,80}$/.test(a.actionId), 'invalid_action');
    requireValue(a.epoch === original.epoch, 'superseded_session');
    if (original.recent.includes(a.actionId)) return { type: 'ack', actionId: a.actionId, duplicate: true, player: playerPrivate(original) };
    requireValue(a.revision === original.revision, 'stale_revision');
    this.rate(original, 'action', 50);
    const p = structuredClone(original); this.stage = { sections: new Map(), entities: new Map(), events: [], meta: null };
    try {
      this.reduce(p, a);
      p.revision++; p.recent.push(a.actionId); if (p.recent.length > 128) p.recent.shift();
      const stage = this.stage;
      const writes = [...stage.sections].map(([key, value]) => ['section', key, value]);
      for (const [key, value] of stage.entities) writes.push(['entity', key, value]);
      if (stage.meta) writes.push(['meta', 'world', stage.meta]);
      writes.push(['player', uid, p]);
      if (this.pendingWrites) for (const [kind, key, value] of writes) this.pendingWrites.set(kind + ':' + key, [kind, key, value]);
      else this.store.transaction(() => { for (const [kind, key, value] of writes) if (value === null) this.store.delete(kind, key); else this.store.put(kind, key, value); });
      for (const [key, section] of stage.sections) this.sections.set(key, section);
      for (const [key, entity] of stage.entities) if (entity) this.indexEntity(entity); else this.entities.delete(key);
      if (stage.meta) this.meta = stage.meta;
      this.players.set(uid, p); this.events.push(...stage.events);
      for (const e of stage.entities.values()) if (e) this.events.push({ type: 'entity.update', entity: e });
      return { type: 'ack', actionId: a.actionId, player: playerPrivate(p), container: p.container ? this.entity(p.container) : null };
    } finally { this.stage = null; }
  }
  beginBatch() { this.pendingWrites = new Map(); }
  flushBatch() {
    const writes = this.pendingWrites; this.pendingWrites = null;
    if (!writes?.size) return;
    this.store.transaction(() => { for (const [kind, key, value] of writes.values()) if (value === null) this.store.delete(kind, key); else this.store.put(kind, key, value); });
  }
  reduce(p, a) {
    if (/^(inventory\.|creative\.|craft\.|item\.(drop|eat)$|furniture\.craft$|container\.clear$)/.test(a.type)) return inventoryAction(p, a, this.context());
    requireValue(!p.dead || a.type === 'player.respawn', 'player_dead');
    if (a.type === 'player.respawn') { requireValue(p.dead, 'not_dead'); returnEscrow(p, this.context()); for (const s of p.inventory.concat(p.armor)) if (s) this.drop(p, s); p.inventory.fill(null); p.armor.fill(null); p.xp = Math.floor(p.xp * 0.5); [p.x, p.y, p.z] = p.spawn; p.vx = p.vy = p.vz = 0; p.health = p.hunger = p.air = 20; p.dead = false; p.hurtUntil = this.now + 3000; return; }
    if (a.type === 'item.pickup') { const e = this.entity(a.uid); requireValue(e?.kind === 'drop' && this.now >= e.pickAt && distance(p, e) <= 2.2, 'pickup_denied'); const n = add(p.inventory, e.stack); if (!n) this.removeEntity(e); else if (n < e.stack.n) this.updateEntity({ ...e, stack: { ...e.stack, n } }); return; }
    requireValue(this.canBuild(p), 'permission_denied');
    if(a.type==='structure.tree') {
      requireValue(p.role==='owner' && p.mode==='creative','permission_denied');
      this.rate(p,'structure',1,30000);
      requireValue(this.structures().length<4,'structure_limit');
      let x=integer(a.x ?? Math.floor(p.x-Math.sin(p.yaw)*140),-MAX_COORD+80,MAX_COORD-80);
      let z=integer(a.z ?? Math.floor(p.z-Math.cos(p.yaw)*140),-MAX_COORD+90,MAX_COORD-90);
      requireValue(Math.hypot(x-p.x,z-p.z)<260,'out_of_reach');
      let y=111;while(y>12 && !BLOCKS[this.terrain.generate(Math.floor(x/16),Math.floor(z/16)).data[y*256+mod(z,16)*16+mod(x,16)]]?.solid)y--;
      y=Math.max(12,y+1);
      const bounds=TREE_META.bounds.map((v,i)=>v+[x,y,z][i%3]);
      for(const b of this.structures())requireValue(!overlaps(bounds,transformedBuilding(b).bounds),'structure_overlap');
      for(const other of this.players.values())requireValue(!overlaps(bounds,[other.x-.3,other.y,other.z-.3,other.x+.3,other.y+other.height,other.z+.3]),'player_in_build_area');
      const descriptor={uid:crypto.randomUUID(),kind:'tree',version:TREE_VERSION,origin:[x,y,z],startAt:this.now+1800,duration:12000};
      this.stage.meta={...this.meta,structures:[...this.structures(),descriptor],revision:(this.meta.revision||0)+1};
      this.stage.events.push({type:'structure.add',structure:descriptor}); return;
    }
    if(a.type==='structure.visit') {
      const b=this.structures().find(b=>b.uid===a.uid)||this.structures()[0];
      requireValue(b && this.now>=b.startAt+b.duration,'building_in_progress');
      // A dedicated visit command only reaches a server-defined doorway.
      const [x,y,z]=transformedBuilding(b).entry;let found=false;
      for(const [dx,dz] of [[0,0],[0,1],[0,2],[1,0],[-1,0]])if(!this.collision(x+dx,y+.04,z+dz)){p.x=x+dx;p.y=y+.04;p.z=z+dz;found=true;break;}
      requireValue(found,'destination_blocked');p.vx=p.vy=p.vz=0;p.lastMove=this.now;return;
    }
    if(a.type==='lift.call') {
      const base=this.entity(a.uid);requireValue(base?.kind==='lift','invalid_lift');
      const floor=integer(a.floor,0,base.floors.length-1), pose=sampleLift(base,this.now);
      const landing=base.floors.reduce((a,b)=>Math.abs(a.y-p.y)<Math.abs(b.y-p.y)?a:b);
      requireValue(Math.hypot(p.x-base.x,p.z-base.z)<=6 && (Math.abs(p.y-landing.y)<4 || liftOccupant(base,p,this.now,.3)),'out_of_reach');
      requireValue(pose.state==='idle','lift_busy');this.rate(p,'lift',2,2000);
      requireValue(![...this.players.values()].some(other=>liftDoorOccupied(base,other,this.now)),'lift_door_blocked');
      const motion=planLift(base,base.floors[floor].y,this.now);if(motion)this.updateEntity({...base,y:pose.y,motion});return;
    }
    if (a.type === 'block.mine') {
      coordinates(a); this.reach(p, { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 });
      const id = this.getBlock(a.x, a.y, a.z), b = BLOCKS[id]; requireValue(id && !b.unbreakable, 'unbreakable');
      p.mining = { x: a.x, y: a.y, z: a.z, id, tool: p.inventory[p.hotbar]?.id || 0, started: this.now }; return;
    }
    if (a.type === 'block.break') {
      coordinates(a); this.reach(p, { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 });
      const id = this.getBlock(a.x, a.y, a.z), b = BLOCKS[id], s = p.inventory[p.hotbar], tool = ITEMS[s?.id]; requireValue(id && !b.unbreakable, 'unbreakable');
      const harvest = !b.tier || tool?.tool === 'pick' && tool.tier >= b.tier;
      if (p.mode !== 'creative') {
        const m = p.mining; requireValue(m && m.x === a.x && m.y === a.y && m.z === a.z && m.id === id && m.tool === (s?.id || 0), 'start_mining_first');
        let seconds = b.hardness;
        if (tool?.tool === b.group) seconds *= b.group === 'pick' ? 1.65 / tool.speed : 1.05 / tool.speed; else if (b.tier) seconds *= 4.2; else seconds *= 0.92;
        if (!harvest && tool?.tool === b.group) seconds *= 3;
        if (this.getBlock(p.x, p.y + 0.5, p.z) === 10) seconds *= 2.5;
        requireValue(this.now - m.started + 80 >= Math.max(0.06, seconds) * 1000, 'mining_too_fast');
      }
      this.setBlock(a.x, a.y, a.z, 0); p.mining = null;
      const container = this.entity('container:' + [a.x, a.y, a.z].join(','));
      if (container) { for (const stack of container.slots || []) if (stack) this.drop({ x: a.x + 0.5, y: a.y, z: a.z + 0.5 }, stack); this.removeEntity(container); }
      if (p.mode !== 'creative') { if (harvest && ITEMS[b.drop ?? id]) this.drop({ x: a.x + 0.5, y: a.y, z: a.z + 0.5 }, makeStack(b.drop ?? id, b.dropN || 1)); damageTool(p, tool?.tool === 'sword' ? 2 : 1); p.exhaustion += 0.035; p.xp += harvest ? b.xp || 0 : 0; }
      return;
    }
    if (a.type === 'block.place') {
      coordinates(a); this.reach(p, { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 });
      const s = p.inventory[p.hotbar], id = s?.id; requireValue(s && BLOCKS[id] && !ITEMS[id].furniture && id !== 11, 'invalid_held_block');
      let placed = id;
      if (BLOCKS[id].stairs) placed = id - (BLOCKS[id].rotation || 0) + integer(a.rotation ?? 0, 0, 3);
      requireValue(BLOCKS[placed], 'invalid_block');
      const old = this.getBlock(a.x, a.y, a.z); requireValue(old === 0 || BLOCKS[old]?.plant || BLOCKS[old]?.fluid, 'occupied');
      const box = [a.x, a.y, a.z, a.x + 1, a.y + 1, a.z + 1];
      for (const other of this.players.values()) requireValue(!BLOCKS[placed].solid || !overlaps(box, [other.x - 0.3, other.y, other.z - 0.3, other.x + 0.3, other.y + other.height, other.z + 0.3]), 'player_in_block');
      this.setBlock(a.x, a.y, a.z, placed); if (p.mode !== 'creative') consume(p.inventory, p.hotbar); return;
    }
    if (a.type === 'furniture.place') {
      coordinates(a, false); this.reach(p, a, 8);
      const held = p.inventory[p.hotbar], type = ITEMS[held?.id]?.furniture, def = FURNITURE[type]; requireValue(def, 'invalid_furniture');
      const e = { uid: crypto.randomUUID(), kind: 'furniture', furnitureType: type, type, x: a.x, y: a.y, z: a.z, q: integer(a.q, 0, 3), theme: integer(a.theme ?? 0, 0, 5), state: { open: false, on: !!def.light }, slots: def.storage ? Array(def.storage).fill(null) : undefined };
      if (a.parent) { const host = this.entity(a.parent); requireValue(host?.kind === 'furniture' && distance(host, e) <= 4, 'invalid_attachment'); e.parent = host.uid; }
      const boxes = this.furnitureBoxes(e);
      for (const b of boxes) for (let y = Math.floor(b[1] + 0.02); y <= Math.floor(b[4] - 0.02); y++) for (let z = Math.floor(b[2] + 0.02); z <= Math.floor(b[5] - 0.02); z++) for (let x = Math.floor(b[0] + 0.02); x <= Math.floor(b[3] - 0.02); x++) for (const block of this.blockBoxes(x, y, z)) requireValue(!overlaps(b, block, 0.018), 'furniture_collision');
      this.updateEntity(e); if (p.mode !== 'creative') consume(p.inventory, p.hotbar); return;
    }
    if (a.type === 'furniture.toggle' || a.type === 'furniture.take' || a.type === 'furniture.sit' || a.type === 'furniture.sleep' || a.type === 'appliance.start' || a.type === 'appliance.stop') {
      const base = this.entity(a.uid); requireValue(base?.kind === 'furniture', 'invalid_furniture'); this.reach(p, base, 8); const e = structuredClone(base), d = FURNITURE[e.furnitureType];
      if (a.type === 'furniture.take') { requireValue(!this.nearby(e.x, e.z, 8).some(c => c.parent === e.uid), 'remove_attached_items_first'); give(p, d.id); for (const s of e.slots || []) if (s) this.drop(p, s); this.removeEntity(e); return; }
      if (a.type === 'furniture.sit') { requireValue(d.seat !== undefined, 'not_a_seat'); p.seat = e.uid; p.x = e.x; p.y = e.y + Number(Array.isArray(d.seat) ? d.seat[1] : d.seat) + 0.025; p.z = e.z; p.state = 'sitting'; return; }
      if (a.type === 'furniture.sleep') { requireValue(d.bed, 'not_a_bed'); p.spawn = [e.x + 1.3, e.y + 0.1, e.z]; p.health = 20; this.stage.meta = { ...this.meta, time: 300, timeAt: this.now }; return; }
      if (a.type.startsWith('appliance.')) { requireValue(d.appliance || ['washer', 'dryer', 'dishwasher', 'stove', 'dryrack'].includes(e.furnitureType), 'not_an_appliance'); e.state.on = a.type.endsWith('start'); e.state.started = this.now; e.state.until = e.state.on ? this.now + (e.furnitureType === 'dryrack' ? 25000 : 12000) : 0; }
      else { const key = a.key || (d.storage || e.furnitureType === 'door' ? 'open' : 'on'); requireValue(['open', 'on', 'recline'].includes(key), 'invalid_state'); e.state[key] = !e.state[key]; }
      this.updateEntity(e); return;
    }
    if (a.type === 'player.stand') {
      requireValue(p.seat,'not_seated');const e=this.entity(p.seat);requireValue(e?.kind==='furniture','invalid_furniture');
      const d=FURNITURE[e.furnitureType],size=d.size,angle=e.q*Math.PI/2,c=Math.cos(angle),s=Math.sin(angle);let found=false;
      for(const [lx,lz] of [[0,size[2]/2+.6],[size[0]/2+.6,0],[-size[0]/2-.6,0],[0,-size[2]/2-.6]]) {
        const x=e.x+c*lx+s*lz,z=e.z-s*lx+c*lz,y=e.y+.04;
        if(!this.collision(x,y,z)){p.x=x;p.y=y;p.z=z;found=true;break;}
      }
      requireValue(found,'destination_blocked');p.seat=null;p.state='idle';p.vx=p.vy=p.vz=0;p.lastMove=this.now;return;
    }
    if (a.type === 'tnt.prime') {
      coordinates(a); this.reach(p, a, 8); requireValue(this.getBlock(a.x, a.y, a.z) === 53, 'not_tnt');
      requireValue(p.mode === 'creative' || p.inventory[p.hotbar]?.id === 146, 'requires_flint');
      this.setBlock(a.x, a.y, a.z, 0); this.updateEntity({ uid: crypto.randomUUID(), kind: 'tnt', x: a.x + 0.5, y: a.y, z: a.z + 0.5, owner: p.id, deadline: this.now + 4000 }); damageTool(p); return;
    }
    if (a.type === 'owner.fill') {
      requireValue(p.role === 'owner' && p.mode === 'creative', 'permission_denied'); this.rate(p, 'fill', 3, 60000);
      coordinates(a.from); coordinates(a.to); const id = integer(a.block, 0, 255); requireValue(BLOCKS[id], 'invalid_block');
      const lo = ['x', 'y', 'z'].map(k => Math.min(a.from[k], a.to[k])), hi = ['x', 'y', 'z'].map(k => Math.max(a.from[k], a.to[k]));
      requireValue((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) <= 32768, 'edit_too_large');
      for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (let x = lo[0]; x <= hi[0]; x++) if (this.getBlock(x, y, z) !== 11) this.setBlock(x, y, z, id);
      return;
    }
    if (a.type === 'owner.teleport') { requireValue(p.role === 'owner' && p.mode === 'creative', 'permission_denied'); coordinates(a, false); requireValue(!this.collision(a.x, a.y, a.z), 'destination_blocked'); p.x = a.x; p.y = a.y; p.z = a.z; p.lastMove = this.now; return; }
    throw new GameError('unknown_action');
  }
  snapshotChunk(cx, cz) {
    integer(cx, -125000, 125000); integer(cz, -125000, 125000);
    const sections = this.store.sections(cx, cz);
    return { type: 'chunk.snapshot', cx, cz, sections, entities: this.columnEntities(cx, cz) };
  }
  tick(now) {
    const before=this.lastTick;this.now = now; const dt = Math.min(0.25, (now - this.lastTick) / 1000); this.lastTick = now;
    this.completedStructures ||= new Set();
    for(const b of this.structures())if(now>=b.startAt+b.duration && !this.completedStructures.has(b.uid)){
      this.completedStructures.add(b.uid);this.entityBuckets.clear();this.events.push({type:'structure.ready',structure:b});
    }
    const elevators=[...this.baseEntities.values()].filter(e=>e.kind==='lift' && this.structureComplete(e.structure));
    for(const base of elevators){const lift=this.entity(base.uid)||base, old=sampleLift(lift,before), current=sampleLift(lift,now);
      for(const p of this.players.values())if(liftOccupant(lift,p,before,.04)) {p.y+=current.y-old.y;p.vy=0;p.lift=lift.uid;p.fallStart=p.y;}
    }
    for (const p of this.players.values()) {
      if (p.mode === 'creative' || p.dead) continue;
      p.exhaustion += dt * 0.009;
      while (p.exhaustion >= 4) { p.exhaustion -= 4; p.hunger = Math.max(0, p.hunger - 1); }
      const head = this.getBlock(p.x, p.y + p.height - 0.12, p.z);
      p.air = head === 10 ? Math.max(0, p.air - dt) : Math.min(20, p.air + dt * 8);
      if (!p.air) this.hurt(p, 2, 'drowning');
      if (this.getBlock(p.x, p.y + 0.4, p.z) === 41) this.hurt(p, 4, 'lava');
      if (now - (p.regenAt || 0) >= 5000) { p.regenAt = now; if (p.hunger >= 16 && p.health < 20) { p.health++; p.exhaustion++; } else if (!p.hunger && p.health > 1) this.hurt(p, 1, 'starvation'); }
    }
    if (now - this.lastSave >= 10000) { this.store.transaction(() => { for (const p of this.players.values()) this.store.put('player', p.id, p); }); this.lastSave = now; }
    if (this.sections.size > 512) { for (const key of this.sections.keys()) { if (this.sections.size <= 384) break; this.sections.delete(key); } }
  }
}
