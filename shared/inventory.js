import catalog from './catalog.json' with { type: 'json' };

export const ITEMS = catalog.items;
export const BLOCKS = catalog.blocks;
export const FURNITURE = catalog.furniture;
export const RECIPES = catalog.recipes;
export const SMELTS = catalog.smelts;
export class GameError extends Error { constructor(code, message = code) { super(message); this.code = code; } }
export function requireValue(ok, code, message) { if (!ok) throw new GameError(code, message); }
export function integer(value, min, max) { requireValue(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_number'); return value; }
export function validItem(id) { integer(id, 0, 65535); requireValue(!!ITEMS[id], 'invalid_item'); return ITEMS[id]; }
export function makeStack(id, n = 1, dur) {
  const d = validItem(id); integer(n, 1, d.stack || 64);
  if (d.durability && dur !== undefined) integer(dur, 1, d.durability);
  return { id, n, ...(d.durability ? { dur: dur ?? d.durability } : {}) };
}
export function match(a, b) { return a && b && a.id === b.id && (!ITEMS[a.id].durability || a.dur === b.dur); }
export function add(slots, stack, order = slots.map((_, i) => i)) {
  if (!stack) return 0;
  let n = stack.n; const max = validItem(stack.id).stack || 64;
  for (const i of order) if (match(slots[i], stack) && slots[i].n < max) { const take = Math.min(n, max - slots[i].n); slots[i].n += take; n -= take; if (!n) return 0; }
  for (const i of order) if (!slots[i]) { const take = Math.min(n, max); slots[i] = { ...stack, n: take }; n -= take; if (!n) return 0; }
  return n;
}
export function consume(slots, i, n = 1) {
  integer(i, 0, slots.length - 1); integer(n, 1, 64);
  requireValue(slots[i] && slots[i].n >= n, 'missing_item');
  if ((slots[i].n -= n) === 0) slots[i] = null;
}
export function give(player, id, n = 1, dur) {
  const stack = makeStack(id, n, dur), test = structuredClone(player.inventory);
  requireValue(add(test, stack) === 0, 'inventory_full'); player.inventory = test;
}
export function damageTool(player, amount = 1) {
  const s = player.inventory[player.hotbar];
  if (!s || player.mode === 'creative' || !ITEMS[s.id]?.durability) return;
  s.dur -= amount; if (s.dur <= 0) player.inventory[player.hotbar] = null;
}
export function fuelValue(id) { return catalog.coals.includes(id) ? 80 : catalog.logs.includes(id) || catalog.planks.includes(id) ? 15 : id === 100 ? 5 : id === 149 ? 160 : 0; }
const ingredientMatches = (ingredient, id) => Array.isArray(ingredient) ? ingredient.includes(id) : ingredient === id;
export function currentRecipe(grid, size) {
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let i = 0; i < grid.length; i++) if (grid[i]) { const x = i % size, y = Math.floor(i / size); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  for (const r of RECIPES) if (r.w === w && r.h === h) for (let mirror = 0; mirror < 2; mirror++) {
    let good = true; const used = [];
    for (let y = 0; y < h && good; y++) for (let x = 0; x < w; x++) {
      const ing = r.cells[y]?.[mirror ? w - 1 - x : x] ?? null, k = (y + y0) * size + x + x0, s = grid[k];
      if (ing === null ? !!s : !s || !ingredientMatches(ing, s.id)) { good = false; break; }
      if (ing !== null) used.push(k);
    }
    if (good) return { r, used };
  }
  return null;
}
function recipePlan(r, source) {
  const pool = structuredClone(source), plan = [];
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const ing = r.cells[y][x]; if (ing === null) continue;
    const i = pool.findIndex(s => s && s.n > 0 && ingredientMatches(ing, s.id)); if (i < 0) return null;
    plan.push({ x, y, id: pool[i].id, source: i }); if (--pool[i].n === 0) pool[i] = null;
  }
  return plan;
}
export function returnEscrow(p, ctx, includeCursor = true) {
  const items = p.craft.filter(Boolean); p.craft = Array(p.craftSize * p.craftSize).fill(null);
  if (includeCursor && p.cursor) { items.push(p.cursor); p.cursor = null; }
  for (const s of items) { const n = add(p.inventory, s); if (n) ctx.drop(p, { ...s, n }); }
}
function canAccept(area, i, s, c) {
  if (area === 'armor') return ITEMS[s.id].armorSlot === i;
  if (area !== 'container') return true;
  if (c.type === 'furnace') return i === 0 ? !!SMELTS[s.id] : i === 1 ? fuelValue(s.id) > 0 : false;
  const d = FURNITURE[c.furnitureType];
  if (d?.fridge) return !!ITEMS[s.id].food || [314, 319].includes(s.id);
  if (c.furnitureType === 'washer') return [320, 321, 322].includes(s.id);
  if (['dryer', 'dryrack'].includes(c.furnitureType)) return [321, 322].includes(s.id);
  if (c.furnitureType === 'dishwasher') return [323, FURNITURE.plate.id].includes(s.id);
  if (c.furnitureType === 'stove') return !!ITEMS[s.id].food || s.id === 112;
  return true;
}
function craft(p, all) {
  for (let count = 0; count < (all ? 64 : 1); count++) {
    const found = currentRecipe(p.craft, p.craftSize); if (!found) return;
    const { r, used } = found, stack = makeStack(r.out, r.n), max = ITEMS[r.out].stack || 64;
    if (all) { const next = structuredClone(p.inventory); if (add(next, stack)) return; p.inventory = next; }
    else { if (p.cursor && (!match(p.cursor, stack) || p.cursor.n + stack.n > max)) return; p.cursor = p.cursor ? { ...p.cursor, n: p.cursor.n + stack.n } : stack; }
    for (const i of used) if (--p.craft[i].n === 0) p.craft[i] = null;
  }
}
function creative(p, ctx, privileged = false) { requireValue(p.mode === 'creative' && ctx.canBuild(p) && (!privileged || p.role === 'owner'), 'permission_denied'); }

export function inventoryAction(p, a, ctx) {
  const op = a.type;
  if (op === 'inventory.select') { p.hotbar = integer(a.slot, 0, 8); return; }
  if (op === 'inventory.close') { returnEscrow(p, ctx); p.container = null; p.craftSize = 2; p.craft = Array(4).fill(null); return; }
  if (op === 'inventory.open') {
    returnEscrow(p, ctx); p.container = null; p.craftSize = 2;
    if (a.target) { const c = ctx.container(p, a.target, true); if (c.type === 'craft') p.craftSize = 3; else p.container = c.uid; }
    p.craft = Array(p.craftSize * p.craftSize).fill(null); return;
  }
  const c = p.container ? ctx.container(p, p.container) : null;
  if (op === 'creative.grant' || op === 'inventory.equip') {
    const def = validItem(a.itemId); creative(p, ctx, a.itemId === 1400 || a.itemId === 1401);
    if (op === 'inventory.equip') {
      const found = p.inventory.slice(0, 9).findIndex(s => s?.id === a.itemId);
      if (found >= 0) p.hotbar = found;
      else { if (p.inventory[p.hotbar]) { const old = p.inventory[p.hotbar]; p.inventory[p.hotbar] = null; requireValue(add(p.inventory, old, Array.from({ length: 27 }, (_, i) => i + 9)) === 0, 'inventory_full'); } p.inventory[p.hotbar] = makeStack(a.itemId, def.stack || 64); }
    } else if (a.destination === 'cursor') p.cursor = makeStack(a.itemId, def.stack || 64);
    else give(p, a.itemId, def.stack || 64);
    return;
  }
  if (op === 'creative.palette') {
    creative(p, ctx); requireValue(Array.isArray(a.items) && a.items.length <= 9, 'invalid_palette');
    p.inventory = a.items.map(id => { if (id === null) return null; const d = validItem(id); creative(p, ctx, id === 1400 || id === 1401); return makeStack(id, d.stack || 64); }).concat(Array(9 - a.items.length).fill(null), p.inventory.slice(9)); return;
  }
  if (op === 'furniture.craft') {
    const d = FURNITURE[a.furnitureType]; requireValue(!!d && ctx.canBuild(p), 'permission_denied');
    if (p.mode === 'creative') give(p, d.id, a.stack ? 64 : 1);
    else {
      const next = structuredClone(p.inventory);
      for (const [id, n] of d.cost) { let remaining = n; for (let i = 0; i < next.length; i++) if (next[i]?.id === id) { const take = Math.min(remaining, next[i].n); consume(next, i, take); remaining -= take; if (!remaining) break; } requireValue(!remaining, 'missing_ingredients'); }
      requireValue(add(next, makeStack(d.id)) === 0, 'inventory_full'); p.inventory = next;
    } return;
  }
  if (op === 'craft.fill') {
    const r = RECIPES[integer(a.recipe, 0, RECIPES.length - 1)];
    requireValue(r.w <= p.craftSize && r.h <= p.craftSize, 'crafting_table_required');
    const pool = structuredClone(p.inventory.concat(p.craft)), plan = recipePlan(r, pool);
    requireValue(p.mode === 'creative' || plan, 'missing_ingredients');
    if (p.mode === 'creative') creative(p, ctx);
    // Reserve ingredients before returning old grid contents. An overflowing
    // inventory must never drop an ingredient and also recreate it in the grid.
    const nextCraft = Array(p.craftSize * p.craftSize).fill(null);
    if (plan) for (const t of plan) { nextCraft[t.y * p.craftSize + t.x] = makeStack(t.id); consume(pool, t.source); }
    if (!plan) {
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const id = r.cells[y][x]; if (id !== null) nextCraft[y * p.craftSize + x] = makeStack(Array.isArray(id) ? id[0] : id); }
    }
    p.inventory = pool.slice(0, 36);
    for (const s of pool.slice(36)) if (s) { const n = add(p.inventory, s); if (n) ctx.drop(p, { ...s, n }); }
    p.craft = nextCraft;
    return;
  }
  if (op === 'craft.take') { craft(p, a.all === true); return; }
  if (op === 'item.drop') {
    const i = integer(a.slot, 0, 35), s = p.inventory[i]; requireValue(s, 'missing_item');
    const n = a.all ? s.n : 1; ctx.drop(p, { ...s, n }); consume(p.inventory, i, n); return;
  }
  if (op === 'item.eat') {
    const s = p.inventory[p.hotbar], food = ITEMS[s?.id]?.food;
    requireValue(food && p.health > 0 && p.hunger < 20, 'cannot_eat');
    requireValue(ctx.now - (p.lastEat || 0) >= 1200, 'too_fast'); p.lastEat = ctx.now;
    p.hunger = Math.min(20, p.hunger + food); if (p.mode !== 'creative') consume(p.inventory, p.hotbar); return;
  }
  if (op === 'container.clear') { requireValue(c && FURNITURE[c.furnitureType]?.trash && ctx.canBuild(p), 'permission_denied'); c.slots.fill(null); ctx.dirtyContainer(c); return; }
  const area = a.area, slots = area === 'inv' ? p.inventory : area === 'armor' ? p.armor : area === 'craft' ? p.craft : area === 'container' ? c?.slots : null;
  if (op === 'inventory.delete') {
    if (area === 'cursor') { p.cursor = null; return; }
    requireValue(slots, 'invalid_slot'); slots[integer(a.index, 0, slots.length - 1)] = null; if (area === 'container') ctx.dirtyContainer(c); return;
  }
  requireValue(op === 'inventory.click', 'unknown_action');
  if (area === 'catalog') return inventoryAction(p, { type: 'creative.grant', itemId: a.index, destination: a.shift ? 'inventory' : 'cursor' }, ctx);
  if (area === 'out') return craft(p, a.shift === true);
  if (area === 'recipe') return inventoryAction(p, { type: 'craft.fill', recipe: a.index }, ctx);
  requireValue(slots, 'invalid_slot'); const i = integer(a.index, 0, slots.length - 1), s = slots[i], button = integer(a.button ?? 0, 0, 2);
  if (a.shift && s) {
    if (area === 'inv' && ITEMS[s.id].armorSlot !== undefined && !p.armor[ITEMS[s.id].armorSlot]) { p.armor[ITEMS[s.id].armorSlot] = s; slots[i] = null; }
    else {
      const destination = area === 'inv' && c ? c.slots : p.inventory;
      const order = area === 'inv' && c ? destination.map((_, j) => j).filter(j => canAccept('container', j, s, c)) : area === 'inv' ? Array.from({ length: i < 9 ? 27 : 9 }, (_, j) => j + (i < 9 ? 9 : 0)) : undefined;
      const left = add(destination, s, order); if (!left) slots[i] = null; else s.n = left;
    }
  } else if (area === 'container' && c.type === 'furnace' && i === 2) {
    if (s && (!p.cursor || match(p.cursor, s))) { const n = Math.min((ITEMS[s.id].stack || 64) - (p.cursor?.n || 0), s.n); if (n) { p.cursor = { ...s, n: (p.cursor?.n || 0) + n }; consume(slots, i, n); p.xp += c.xp || 0; c.xp = 0; } }
  } else if (!p.cursor) {
    if (s) { if (button === 2) { const n = Math.ceil(s.n / 2); p.cursor = { ...s, n }; consume(slots, i, n); } else { p.cursor = s; slots[i] = null; } }
  } else if (canAccept(area, i, p.cursor, c)) {
    const max = area === 'armor' ? 1 : ITEMS[p.cursor.id].stack || 64;
    if (!s || match(s, p.cursor)) { const n = Math.min(button === 2 ? 1 : p.cursor.n, max - (s?.n || 0)); if (n > 0) { slots[i] = { ...p.cursor, n: (s?.n || 0) + n }; p.cursor.n -= n; if (!p.cursor.n) p.cursor = null; } }
    else if (button !== 2 && p.cursor.n <= max) { slots[i] = p.cursor; p.cursor = s; }
  }
  if (c) ctx.dirtyContainer(c);
}
