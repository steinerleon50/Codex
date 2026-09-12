# Aurelia realtime server

Deployment source for the original Aurelia / Voxelcraft game at https://aurelia-worlds.f34th3r.chatgpt.site.

This branch contains the authoritative Node server and shared game rules. The complete game frontend, independent accounts and durable world storage stay on ChatGPT Sites.

Source snapshot: 283ab824cc6f1454f01074d942a00d12a89487c3 from the Aurelia Site repository.

## Deployment

Render Free Node web service, Frankfurt, one instance. Build with `npm ci --prefix room-server --omit=dev --ignore-scripts`. Start with `node --max-old-space-size=192 room-server/server.js`. Health endpoint: `/health`.

Set NODE_VERSION=24, NODE_ENV=production and SITE_ORIGIN=https://aurelia-worlds.f34th3r.chatgpt.site. Configure ROOM_STORAGE_SECRET securely on both backends; never commit it or expose it to the game browser. Use Render's assigned PORT. No disk, PostgreSQL, Redis or autoscaling is required.

## Scope

Core multiplayer includes identities, interpolated humanoid players, movement validation, synchronized blocks, semantic inventories, item pickup, permissions and reconnecting. Seeded terrain plus chunk modifications, players and entities persist through authenticated Sites APIs with atomic commits and world leases.

Advanced shared structures, elevators, TNT outcomes and mobs are not all implemented online. Full original features remain available locally. This is the first playable core, not the full completed production conversion.

## Free hosting

Render Free sleeps when idle and has shared runtime, bandwidth and build limits. Cold starts may delay joining by about a minute. Do not add paid resources or automatic upgrades. If a payment method is present, verify overage controls before deployment to honor a strict zero-cost requirement.

Committed worlds survive Render restarts because Sites stores persistent data. Four loaded worlds and eight players per world are configured safety caps, not measured production capacity guarantees.
