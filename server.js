'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 60000
});
app.get('/', (_req, res) => res.status(200).send('Last 1 Percent multiplayer server online'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, room) => n + room.players.length, 0) }));
const rooms = new Map();
const MAX_ROOM_AGE = 6 * 60 * 60 * 1000;
function cleanName(v) { return String(v || 'Survivor').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Survivor'; }
function cleanCode(v) { return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); }
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return { code: room.code, mode: room.mode, map: room.map, maxPlayers: room.maxPlayers, state: room.state,
    scoreA: room.scoreA, scoreB: room.scoreB,
    players: room.players.map(p => ({ ...p })) };
}
function emitRoom(room) { io.to(room.code).emit('room:update', publicRoom(room)); emitRoomsList(); }
function emitRoomsList() {
  const list = [...rooms.values()].filter(r => r.state === 'lobby' && r.players.length < r.maxPlayers)
    .map(r => ({ code: r.code, mode: r.mode, map: r.map, maxPlayers: r.maxPlayers, players: r.players.map(p => ({ id: p.id, name: p.name, host: p.host, ready: p.ready, team: p.team })) }));
  io.emit('rooms:list', list);
}
function getRoom(socket) { const room = socket.data.roomCode && rooms.get(socket.data.roomCode); return room || null; }
function removePlayer(socket, announce = true) {
  const room = getRoom(socket);
  if (!room) { socket.data.roomCode = null; return; }
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(room.code); socket.data.roomCode = null;
  if (!room.players.length) rooms.delete(room.code);
  else {
    if (!room.players.some(p => p.host)) { room.players[0].host = true; room.players[0].ready = false; }
    if (room.state === 'playing' && room.players.length < 2) room.state = 'lobby';
    if (announce) emitRoom(room);
  }
  if (announce) socket.emit('room:left', { code: room.code });
  emitRoomsList();
}
io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.emit('server:hello', { version: 2 });
  socket.on('rooms:list', () => emitRoomsList());
  socket.on('room:create', payload => {
    removePlayer(socket, false);
    const mode = ['coop', 'duel', '2v2', '4v4', 'survival'].includes(payload && payload.mode) ? payload.mode : 'coop';
    const map = ['city', 'lab', 'desert', 'docks'].includes(payload && payload.map) ? payload.map : 'city';
    const code = generateCode();
    const maxPlayers = mode === 'duel' ? 2 : mode === '2v2' ? 4 : mode === '4v4' ? 8 : 4;
    const competitive = ['duel', '2v2', '4v4'].includes(mode);
    const room = { code, mode, map, maxPlayers, players: [], state: 'lobby', scoreA: 0, scoreB: 0, createdAt: Date.now(), lastShot: new Map() };
    room.players.push({ id: socket.id, name: cleanName(payload && payload.name), country: String(payload && payload.country || '').slice(0, 8), host: true, ready: true, team: competitive ? 'A' : null, x: 0, y: 0, angle: 0, hp: 100, kills: 0, deaths: 0 });
    rooms.set(code, room); socket.data.roomCode = code; socket.join(code);
    socket.emit('room:created', { code, mode, maxPlayers }); emitRoom(room);
  });
  socket.on('room:join', payload => {
    const code = cleanCode(payload && payload.code), room = rooms.get(code);
    if (!room) return socket.emit('room:error', 'Room not found. Check the code.');
    if (socket.data.roomCode === code && room.players.some(p => p.id === socket.id)) {
      return socket.emit('room:joined', { code, mode: room.mode, maxPlayers: room.maxPlayers });
    }
    if (room.state !== 'lobby') return socket.emit('room:error', 'Match already started.');
    if (room.players.length >= room.maxPlayers) return socket.emit('room:error', 'Room full.');
    removePlayer(socket, false);
    const competitive = ['duel', '2v2', '4v4'].includes(room.mode);
    const team = competitive ? (room.players.filter(p => p.team === 'A').length <= room.players.filter(p => p.team === 'B').length ? 'A' : 'B') : null;
    room.players.push({ id: socket.id, name: cleanName(payload && payload.name), country: String(payload && payload.country || '').slice(0, 8), host: false, ready: false, team, x: 0, y: 0, angle: 0, hp: 100, kills: 0, deaths: 0 });
    socket.data.roomCode = code; socket.join(code);
    socket.emit('room:joined', { code, mode: room.mode, maxPlayers: room.maxPlayers }); emitRoom(room);
  });
  socket.on('room:team', payload => {
    const room = getRoom(socket); if (!room || room.state !== 'lobby' || !['duel', '2v2', '4v4'].includes(room.mode)) return;
    const p = room.players.find(p => p.id === socket.id), team = payload && payload.team;
    if (p && (team === 'A' || team === 'B')) { p.team = team; p.ready = false; emitRoom(room); }
  });
  socket.on('room:ready', payload => {
    const room = getRoom(socket); if (!room || room.state !== 'lobby') return;
    const p = room.players.find(p => p.id === socket.id); if (p) { p.ready = !!(payload && payload.ready); emitRoom(room); }
  });
  socket.on('room:start', () => {
    const room = getRoom(socket); if (!room) return socket.emit('room:error', 'Join a room first.');
    const p = room.players.find(p => p.id === socket.id);
    if (!p || !p.host) return socket.emit('room:error', 'Only the host can start the match.');
    if (room.state !== 'lobby') return;
    if (room.players.length < 2) return socket.emit('room:error', 'At least 2 players are needed to start.');
    const notReady = room.players.filter(pl => !pl.host && !pl.ready);
    if (notReady.length) return socket.emit('room:error', 'Wait until every other player is Ready.');
    room.state = 'playing'; emitRoom(room);
    io.to(room.code).emit('match:start', { code: room.code, mode: room.mode, map: room.map, hostId: p.id, players: room.players.map(pl => ({ id: pl.id, name: pl.name, team: pl.team })) });
  });
  socket.on('room:leave', () => removePlayer(socket, true));
  socket.on('match:move', data => {
    const room = getRoom(socket); if (!room || room.state !== 'playing' || !data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    const p = room.players.find(p => p.id === socket.id); if (!p) return;
    p.x = Math.max(-100000, Math.min(100000, data.x)); p.y = Math.max(-100000, Math.min(100000, data.y));
    p.angle = Number.isFinite(data.angle) ? data.angle : 0; if (!['duel', '2v2', '4v4'].includes(room.mode)) p.hp = Number.isFinite(data.hp) ? Math.max(0, Math.min(1000, data.hp)) : p.hp;
    socket.to(room.code).emit('match:update', { players: room.players.map(pl => ({ id: pl.id, name: pl.name, team: pl.team, x: pl.x, y: pl.y, angle: pl.angle, hp: pl.hp, kills: pl.kills })), scoreA: room.scoreA, scoreB: room.scoreB });
  });
  socket.on('match:shoot', data => {
    const room = getRoom(socket); if (!room || room.state !== 'playing') return;
    const p = room.players.find(p => p.id === socket.id); if (!p) return;
    const now = Date.now(), previous = room.lastShot.get(socket.id) || 0;
    if (now - previous < 110) return; // basic server-side fire-rate limit
    room.lastShot.set(socket.id, now);
    const weapon = String(data && data.weapon || '').slice(0, 30);
    const shotAngle = Number.isFinite(data && data.angle) ? Math.max(-Math.PI, Math.min(Math.PI, data.angle)) : p.angle;
    p.angle = shotAngle;
    socket.to(room.code).emit('match:shot', { shooterId: socket.id, x: p.x, y: p.y, angle: shotAngle, weapon });
    if (!['duel', '2v2', '4v4'].includes(room.mode)) return;
    // Server-authoritative PvP ray check. Clients cannot choose a target or damage value.
    const range = weapon.toLowerCase().includes('sniper') ? 950 : weapon.toLowerCase().includes('shotgun') ? 360 : 650;
    let target = null, bestAlong = range;
    for (const other of room.players) {
      if (other.id === p.id || other.hp <= 0 || (p.team && other.team === p.team)) continue;
      const dx = other.x - p.x, dy = other.y - p.y;
      const along = dx * Math.cos(shotAngle) + dy * Math.sin(shotAngle);
      const across = Math.abs(-dx * Math.sin(shotAngle) + dy * Math.cos(shotAngle));
      if (along > 20 && along < bestAlong && across < 30) { target = other; bestAlong = along; }
    }
    if (target) {
      const damage = weapon.toLowerCase().includes('sniper') ? 65 : weapon.toLowerCase().includes('shotgun') ? 42 : 24;
      target.hp = Math.max(0, target.hp - damage);
      if (target.hp === 0) { p.kills = (p.kills || 0) + 1; target.deaths = (target.deaths || 0) + 1; }
      io.to(target.id).emit('match:hit', { damage, hp: target.hp, from: p.name, dead: target.hp === 0 });
      io.to(room.code).emit('match:pvp', { shooterId: p.id, targetId: target.id, shooterName: p.name, targetName: target.name, damage, hp: target.hp, kills: p.kills, deaths: target.deaths, scoreA: room.scoreA, scoreB: room.scoreB });
      io.to(room.code).emit('match:update', { players: room.players.map(pl => ({ id: pl.id, name: pl.name, team: pl.team, x: pl.x, y: pl.y, angle: pl.angle, hp: pl.hp, kills: pl.kills, deaths: pl.deaths })), scoreA: room.scoreA, scoreB: room.scoreB });
    }
  });
  socket.on('lobby:chat', payload => {
    const room = getRoom(socket); if (!room || room.state !== 'lobby') return;
    const p = room.players.find(p => p.id === socket.id); if (!p) return;
    const text = String(payload && payload.text || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 180);
    if (!text) return;
    io.to(room.code).emit('lobby:chat', { name: p.name, text, t: Date.now() });
  });

  socket.on('match:zombies', payload => {
    const room = getRoom(socket); if (!room || room.state !== 'playing' || !['coop', 'survival'].includes(room.mode)) return;
    const p = room.players.find(p => p.id === socket.id); if (!p || !p.host) return;
    const zombies = Array.isArray(payload && payload.zombies) ? payload.zombies.slice(0, 80).map(z => ({
      id: String(z && z.id || '').slice(0, 40), x: Number(z && z.x), y: Number(z && z.y), hp: Number(z && z.hp), maxHp: Number(z && z.maxHp), speed: Number(z && z.speed), r: Number(z && z.r), boss: !!(z && z.boss), type: String(z && z.type || 'normal').slice(0, 12), slow: Number(z && z.slow) || 0
    })).filter(z => z.id && Number.isFinite(z.x) && Number.isFinite(z.y) && Number.isFinite(z.hp) && Number.isFinite(z.maxHp)) : [];
    io.to(room.code).except(socket.id).emit('match:zombies', { zombies, level: Math.max(1, Math.min(999, Number(payload && payload.level) || 1)) });
  });
  socket.on('match:zombie-hit', payload => {
    const room = getRoom(socket); if (!room || room.state !== 'playing' || !['coop', 'survival'].includes(room.mode)) return;
    const p = room.players.find(p => p.id === socket.id); if (!p || p.host) return;
    const id = String(payload && payload.id || '').slice(0, 40), damage = Math.max(1, Math.min(150, Number(payload && payload.damage) || 1));
    if (!id) return;
    const host = room.players.find(pl => pl.host); if (host) io.to(host.id).emit('match:zombie-hit', { id, damage, from: p.name });
  });
  socket.on('match:score', data => {
    const room = getRoom(socket); if (!room || room.state !== 'playing' || !data) return;
    // Only accept small positive score increments; competitive results still require server-side validation.
    if (data.team === 'A' && Number.isFinite(data.delta)) room.scoreA = Math.max(0, Math.min(999999, room.scoreA + Math.max(0, Math.min(10, data.delta))));
    if (data.team === 'B' && Number.isFinite(data.delta)) room.scoreB = Math.max(0, Math.min(999999, room.scoreB + Math.max(0, Math.min(10, data.delta))));
    io.to(room.code).emit('match:score', { scoreA: room.scoreA, scoreB: room.scoreB });
  });
  socket.on('match:end', () => {
    const room = getRoom(socket); if (!room) return;
    const p = room.players.find(p => p.id === socket.id); if (!p || !p.host) return;
    room.state = 'lobby'; room.players.forEach(pl => { pl.ready = pl.host; pl.hp = 100; pl.x = 0; pl.y = 0; }); room.lastShot.clear(); emitRoom(room);
    io.to(room.code).emit('match:end', { code: room.code });
  });
  socket.on('disconnect', () => removePlayer(socket, true));
});
setInterval(() => { const now = Date.now(); for (const [code, room] of rooms) if (now - room.createdAt > MAX_ROOM_AGE) rooms.delete(code); emitRoomsList(); }, 60000).unref();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Last 1 Percent server online on port ' + PORT));
