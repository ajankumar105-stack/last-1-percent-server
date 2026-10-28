# Last 1 Percent Online — Upgrade package (Oct 2026)

## What this package is
Upgraded `index.html` (game + lobby client) + `server.js` + `package.json` for your existing Last 1 Percent project.

## Implemented and verified in this environment
1. **Loading screen** — progress bar, tips, skip/safety timeout, then enters main UI.
2. **Match start flow** — Host Start closes multi/menu overlays and starts the same match for connected clients (no manual Back needed).
3. **4 maps with different layouts + solid walls** — Dead City, Biohazard Lab, Dustlands, Night Docks (`city` / `lab` / `desert` / `docks`) with collision via `tryMovePlayer`.
4. **Humanoid cartoon zombies** — body, legs, arms, head, face (not plain circles).
5. **Copy room code + Invite share** + `#join=CODE` deep link.
6. **Avatar image** — local upload stored in `localStorage` (not a permanent account DB).
7. **Server PvP validation** — rate-limited `match:shoot`, range/angle cone, **no friendly fire** on same team, score A/B.
8. **Modes on server** — coop, duel, 2v2, 4v4, survival with max player limits.
9. **Lobby chat** (already present; kept wired).
10. **Mobile safe-area** tweaks for tip bar / controls.

## Implemented but not fully two-device tested here
- Real-time PvP damage across two phones (server logic is in place; you must test on two devices).
- Host zombie authority sync under heavy lag / Render sleep.
- 4v4 with 8 concurrent players (limit coded; not load-tested).

## Not implemented (honest limitations)
- Permanent **friends database** / accounts / login — needs a real DB + auth (room codes + share are the supported invite path).
- Full **roofless 3D-style animated lobby scene** with 4 walking avatars — UI lobby + in-match remote players instead (2D preserved).
- Server-authoritative **loot ownership** for every pickup (solo/local still client-side; coop uses host zombie sync).
- Paid assets / custom music files (procedural beeps remain).

## Deploy — frontend (GitHub Pages)
1. Replace repo `index.html` with this package’s `index.html`.
2. Commit + wait for Pages update.
3. Hard-refresh the game URL on the phone.

## Deploy — backend (Render / Railway / Fly / Koyeb)
1. Upload folder with `server.js` + `package.json`.
2. Build: `npm install`
3. Start: `npm start` (or `node server.js`)
4. Set env `PORT` if the host requires it.
5. Open service URL — should return JSON status.
6. In game ONLINE → **Change Server URL** if needed → paste HTTPS URL (no trailing slash).
7. Use **Wake Server** after free-tier sleep.

## Local test
```bash
npm install
npm start
```
Open `index.html` via any static server (or GitHub Pages). Set server URL to `http://localhost:3000` (phones on LAN: use PC IP).

## Suggested commit message
```
Upgrade maps+walls, humanoid zombies, loading screen, match auto-start, PvP server validation
```
