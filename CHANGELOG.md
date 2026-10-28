# Last 1 Percent Online — Full upgrade changelog

## Client (index.html)
- Loading screen with staged progress + ENTER skip + 8s safety
- Match auto-start: closes all menus, applies map/mode, team spawns
- 4 maps with dense solid walls + collision (`tryMovePlayer`)
- Humanoid cartoon zombies
- Lobby scene canvas (base, barricades, zombies orbiting, player slots)
- Local friends list (device-only) + join-by-saved-code
- Copy room code + system share invite + `#join=CODE`
- Avatar image upload (localStorage)
- Online position stream (~20 Hz) + server shot events for PvP
- Kill feed + team score HUD (A/B)
- Minimap, gun levels, ranks, pets, missions, shop preserved
- Mobile safe-area / orientation layout

## Server (server.js)
- Modes: coop, duel, 2v2, 4v4, survival with max seats
- Maps: city, lab, desert, docks
- Teams + no friendly fire
- Server-side PvP cone/range validation + rate limit
- Host zombie broadcast + non-host hit relay
- Lobby chat, room list, host migration on leave

## How to deploy
See README.md
