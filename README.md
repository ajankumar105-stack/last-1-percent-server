# Last 1 Percent – Survival: online lobby starter

This adds a real backend for **private 5-character room codes, up to 4 players per room, player lists, ready state, host transfer on disconnect, and host-only match-start signaling**. It does not replace the existing solo game.

## Important honest status
This is **Phase 1: online lobby**. The players are connected through a server, but zombie positions, bullets, health, waves, deaths, revives, and match results are **not yet synchronized**. A `match:start` signal is not a playable shared online match. Do not advertise this as complete online co-op until that gameplay-authority phase is built and tested.

## Deploy the backend
1. Upload this folder to a Node.js hosting service that supports long-running WebSocket apps (for example Render or Railway).
2. Use build/install command `npm install` and start command `npm start`.
3. Set `PORT` only if the hosting platform requires it; the server reads `process.env.PORT`.
4. After deploy, open the service URL. It should return JSON with `"status":"ok"`. `/health` should return `{"ok":true,"rooms":0}` when no rooms exist.
5. Copy the deployed HTTPS URL.

## Connect the HTML game
1. Open `Last_1_Percent_Online_Lobby.html` in a text editor.
2. Find `const MULTIPLAYER_SERVER = (localStorage.getItem('l1p_server_url') || '').replace(/\/+$/, '');`
3. Replace it with `const MULTIPLAYER_SERVER = 'https://YOUR-DEPLOYED-SERVER.example';` using your actual deployed URL, **or** keep the localStorage option and set `localStorage.setItem('l1p_server_url', 'https://YOUR-DEPLOYED-SERVER.example')` in the browser console.
4. Host the HTML over HTTPS for reliable mobile browser access. Open the same game URL on two devices, create a room on one, and join using the displayed code on the other.

## Local test
Requires Node.js 18+:
```bash
npm install
npm start
```
Then set the game server URL to `http://localhost:3000` on the same computer. For phones on the same Wi-Fi, use the computer's LAN IP instead of `localhost` and allow the port through the firewall.

## Next phase
Implement authoritative shared gameplay: server-owned match state and validated movement/fire/hit events, synced zombies and bosses, health/revives/waves, reconnect handling, anti-cheat, match results, persistent accounts and leaderboard. The existing game's combat loop currently runs locally, so this is a separate integration step.
