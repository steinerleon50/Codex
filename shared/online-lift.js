// Shared, stateless elevator geometry and trajectory. No timers or persistence here.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const smooth = t => (t = clamp(t, 0, 1), t * t * t * (t * (t * 6 - 15) + 10));
export const LIFT_ACCELERATION = 4.8;
export const LIFT_MAX_SPEED = 26;
export const LIFT_CLOSE_MS = 1100;
export const LIFT_OPEN_MS = 1200;

export function liftTravel(distance) {
  const d = Math.abs(distance), acceleration = LIFT_ACCELERATION;
  if (d < 0.00001) return { distance: 0, acceleration, accelerationTime: 0, cruiseTime: 0, peakSpeed: 0, duration: 0 };
  const accelerationTime = Math.min(LIFT_MAX_SPEED / acceleration, Math.sqrt(d / acceleration));
  const peakSpeed = acceleration * accelerationTime;
  const cruiseTime = Math.max(0, (d - acceleration * accelerationTime * accelerationTime) / peakSpeed);
  return { distance: d, acceleration, accelerationTime, cruiseTime, peakSpeed, duration: 2 * accelerationTime + cruiseTime };
}

export function sampleLift(lift, now = Date.now()) {
  const m = lift.motion;
  if (!m || !Number.isFinite(m.from) || !Number.isFinite(m.to) || !Number.isFinite(m.startAt)) {
    return { y: Number(lift.y) || 0, door: 1, state: 'idle', speed: 0, destination: null, arrived: true };
  }
  const travel = liftTravel(m.to - m.from), direction = Math.sign(m.to - m.from);
  const movingAt = m.startAt + LIFT_CLOSE_MS, arrivingAt = movingAt + travel.duration * 1000;
  const endAt = arrivingAt + LIFT_OPEN_MS;
  if (now < movingAt) return { y: m.from, door: 1 - smooth((now - m.startAt) / LIFT_CLOSE_MS), state: 'closing', speed: 0, destination: m.to, arrived: false, endAt };
  if (now < arrivingAt && travel.duration > 0) {
    const t = (now - movingAt) / 1000, a = travel.acceleration, ta = travel.accelerationTime;
    let distance, speed;
    if (t < ta) { distance = 0.5 * a * t * t; speed = a * t; }
    else if (t < ta + travel.cruiseTime) { distance = 0.5 * a * ta * ta + travel.peakSpeed * (t - ta); speed = travel.peakSpeed; }
    else { const remaining = travel.duration - t; distance = travel.distance - 0.5 * a * remaining * remaining; speed = a * remaining; }
    return { y: m.from + direction * distance, door: 0, state: 'moving', speed: direction * speed, destination: m.to, arrived: false, endAt };
  }
  if (now < endAt) return { y: m.to, door: smooth((now - arrivingAt) / LIFT_OPEN_MS), state: 'opening', speed: 0, destination: null, arrived: false, endAt };
  return { y: m.to, door: 1, state: 'idle', speed: 0, destination: null, arrived: true, endAt };
}

export function planLift(lift, destination, now = Date.now()) {
  const current = sampleLift(lift, now);
  if (current.state !== 'idle' || !Number.isFinite(destination) || !lift.floors.some(f => f.y === destination)) return null;
  if (Math.abs(destination - current.y) < 0.005) return null;
  return { from: current.y, to: destination, startAt: now + 180 };
}

export function liftLocalPoint(lift, p) {
  const q = (lift.q || 0) * Math.PI / 2, c = Math.cos(q), s = Math.sin(q);
  const x = p.x - lift.x, z = p.z - lift.z;
  return [c * x - s * z, p.y, s * x + c * z];
}

export function liftOccupant(lift, p, now = Date.now(), verticalSlack = 0) {
  const local = liftLocalPoint(lift, p), cabin = sampleLift(lift, now);
  return Math.abs(local[0]) < 1.08 && Math.abs(local[2]) < 1.08 && p.y >= cabin.y + 0.18 - verticalSlack && p.y < cabin.y + 0.55 + verticalSlack;
}

export function liftDoorOccupied(lift, p, now = Date.now()) {
  const local = liftLocalPoint(lift, p), cabin = sampleLift(lift, now);
  return Math.abs(local[0]) < 0.80 && local[2] > 1 && local[2] < 1.55 && Math.abs(p.y - cabin.y) < 2.5;
}

// Exact boxes from the existing Aurora renderer, transformed into world space.
export function liftCollisionBoxes(lift, nearY, now = Date.now()) {
  const cab = sampleLift(lift, now), boxes = [];
  if (!lift.floors?.length) return boxes;
  const bottom = lift.floors[0].y, top = lift.floors[lift.floors.length - 1].y + 2.7;
  const q = (lift.q || 0) * Math.PI / 2, c = Math.cos(q), s = Math.sin(q);
  function add(b, y = 0) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 8; k++) {
      const x = b[k & 1 ? 3 : 0], z = b[k & 4 ? 5 : 2];
      const p = [lift.x + c * x + s * z, y + b[k & 2 ? 4 : 1], lift.z - s * x + c * z];
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
    }
    boxes.push([...lo, ...hi]);
  }
  if (nearY > bottom - 2 && nearY < top + 2) {
    add([-1.37, bottom, -1.37, -1.28, top, 1.37]); add([1.28, bottom, -1.37, 1.37, top, 1.37]); add([-1.28, bottom, -1.37, 1.28, top, -1.28]);
  }
  if (Math.abs(nearY - cab.y) < 5) {
    add([-1.22, 0, -1.22, 1.22, .235, 1.22], cab.y); add([-1.22, 2.51, -1.22, 1.22, 2.68, 1.22], cab.y);
    add([-1.2, .23, -1.2, -1.12, 2.5, 1.2], cab.y); add([1.12, .23, -1.2, 1.2, 2.5, 1.2], cab.y); add([-1.12, .23, -1.2, 1.12, 2.5, -1.13], cab.y);
    for (const x of [-.99, .99]) add([x - .16, .23, 1.13, x + .16, 2.5, 1.2], cab.y);
    for (const x of [-.42 - cab.door * .82, .42 + cab.door * .82]) add([x - .41, .24, 1.155, x + .41, 2.29, 1.205], cab.y);
  }
  for (const f of lift.floors) {
    if (Math.abs(f.y - nearY) > 4) continue;
    add([-1.38, .05, 1.27, 1.38, .242, 2.29], f.y);
    for (const x of [-1.26, 1.26]) add([x - .05, .24, 1.24, x + .05, 2.58, 1.41], f.y);
    if (Math.abs(f.y - cab.y) > .18 || cab.door < .15) add([-1.2, .24, 1.31, 1.2, 2.48, 1.35], f.y);
  }
  return boxes;
}
