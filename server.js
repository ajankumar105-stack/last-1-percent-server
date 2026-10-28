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

app.get('/', (_req, res) => res.status(200).json({
  name: 'Last 1 Percent Online',
  status: 'ok',
  modes: ['coop', 'duel', '2v2', '4v4', 'survival'],
  maps: ['city', 'lab', 'desert', 'docks']
}));
app.get('/health', (_req, res) => res.status(200).json({
  ok: true,
  rooms: rooms.size,
  players: [...rooms.values()].reduce((n, room) => n + room.players.length, 0)
}));

const rooms = new Map();
const MAX_ROOM_AGE = 6 * 60 * 60 * 1000;
const MODE_LIMITS = { coop: 4, duel: 2, '2v2': 4, '4v4': 8, survival: 4 };
const MAPS = new Set(['city', 'lab', 'desert', 'docks']);

function cleanName(v) {
  return String(v || 'Survivor').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Survivor';
}
function cleanCode(v) {
  return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    map: room.map,
    maxPlayers: room.maxPlayers,
    state: room.state,
    scoreA: room.scoreA,
    scoreB: room.scoreB,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      country: p.country,
      host: p.host,
      ready: p.ready,
      team: p.team,
      hp: p.hp,
      kills: p.kills,
      deaths: p.deaths
    }))
  };
}
function emitRoomsList() {
  const list = [...rooms.values()]
    .filter(r => r.state === 'lobby' && r.players.length < r.maxPlayers)
    .map(r => ({
      code: r.code,
      mode: r.mode,
      map: r.map,
      maxPlayers: r.maxPlayers,
      players: r.players.map(p => ({ id: p.id, name: p.name, host: p.host, ready: p.ready, team: p.team }))
    }));
  io.emit('rooms:list', list);
}
function emitRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
  emitRoomsList();
}
function getRoom(socket) {
  return (socket.data.roomCode && rooms.get(socket.data.roomCode)) || null;
}
function removePlayer(socket, announce = true) {
  const room = getRoom(socket);
  if (!room) {
    socket.data.roomCode = null;
    return;
  }
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;
  if (!room.players.length) {
    rooms.delete(room.code);
  } else {
    if (!room.players.some(p => p.host)) {
      room.players[0].host = true;
      room.players[0].ready = false;
    }
    if (room.state === 'playing' && room.players.length < 2 && room.mode !== 'survival' && room.mode !== 'coop') {
      room.state = 'lobby';
      room.players.forEach(p => { p.ready = p.host; });
      io.to(room.code).emit('match:end', { code: room.code, reason: 'players_left' });
    }
    if (announce) emitRoom(room);
  }
  if (announce) emitRoomsList();
}

io.on('connection', socket => {
  socket.data.roomCode = null;

  socket.on('rooms:list', () => emitRoomsList());

  socket.on('room:create', payload => {
    removePlayer(socket, false);
    const mode = MODE_LIMITS[payload && payload.mode] ? payload.mode : 'coop';
    const map = MAPS.has(payload && payload.map) ? payload.map : 'city';
    const code = generateCode();
    const room = {
      code,
      mode,
      map,
      maxPlayers: MODE_LIMITS[mode],
      state: 'lobby',
      scoreA: 0,
      scoreB: 0,
      createdAt: Date.now(),
      lastShot: new Map(),
      players: [{
        id: socket.id,
        name: cleanName(payload && payload.name),
        country: String((payload && payload.country) || '').slice(0, 40),
        host: true,
        ready: true,
        team: mode === 'duel' || mode === '2v2' || mode === '4v4' ? 'A' : null,
        x: 0, y: 0, angle: 0, hp: 100, kills: 0, deaths: 0
      }]
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room:created', { code, mode, map });
    emitRoom(room);
  });

  socket.on('room:join', payload => {
    const code = cleanCode(payload && payload.code);
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', { message: 'Room not found. Check the code.' });
    if (room.state !== 'lobby') return socket.emit('room:error', { message: 'Match already started.' });
    if (room.players.length >= room.maxPlayers) return socket.emit('room:error', { message: 'Room is full.' });
    if (room.players.some(p => p.id === socket.id)) return;
    removePlayer(socket, false);
    const teamModes = ['duel', '2v2', '4v4'];
    let team = null;
    if (teamModes.includes(room.mode)) {
      const a = room.players.filter(p => p.team === 'A').length;
      const b = room.players.filter(p => p.team === 'B').length;
      team = a <= b ? 'A' : 'B';
    }
    room.players.push({
      id: socket.id,
      name: cleanName(payload && payload.name),
      country: String((payload && payload.country) || '').slice(0, 40),
      host: false,
      ready: false,
      team,
      x: 0, y: 0, angle: 0, hp: 100, kills: 0, deaths: 0
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room:joined', { code, mode: room.mode, map: room.map });
    emitRoom(room);
  });

  socket.on('room:ready', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    p.ready = !!(payload && payload.ready);
    emitRoom(room);
  });

  socket.on('room:team', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'lobby') return;
    if (!['duel', '2v2', '4v4'].includes(room.mode)) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    const team = payload && payload.team === 'B' ? 'B' : 'A';
    const limit = room.mode === 'duel' ? 1 : room.mode === '2v2' ? 2 : 4;
    if (room.players.filter(pl => pl.team === team && pl.id !== p.id).length >= limit) {
      return socket.emit('room:error', { message: 'That team is full.' });
    }
    p.team = team;
    emitRoom(room);
  });

  socket.on('room:start', () => {
    const room = getRoom(socket);
    if (!room) return socket.emit('room:error', { message: 'Create or join a room first.' });
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || !p.host) return socket.emit('room:error', { message: 'Only the host can start.' });
    const minPlayers = room.mode === 'duel' ? 2 : room.mode === '4v4' ? 2 : 2;
    if (room.players.length < minPlayers) {
      return socket.emit('room:error', { message: 'Need at least ' + minPlayers + ' players to start.' });
    }
    const notReady = room.players.filter(pl => !pl.host && !pl.ready);
    if (notReady.length) return socket.emit('room:error', { message: 'Wait until every other player is Ready.' });
    room.state = 'playing';
    room.scoreA = 0;
    room.scoreB = 0;
    room.players.forEach(pl => { pl.hp = 100; pl.kills = 0; pl.deaths = 0; });
    emitRoom(room);
    io.to(room.code).emit('match:start', {
      code: room.code,
      mode: room.mode,
      map: room.map,
      hostId: p.id,
      players: room.players.map(pl => ({ id: pl.id, name: pl.name, team: pl.team }))
    });
  });

  socket.on('room:leave', () => removePlayer(socket, true));

  socket.on('match:move', data => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing' || !data) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    p.x = Math.max(-600, Math.min(600, Number(data.x) || 0));
    p.y = Math.max(-600, Math.min(600, Number(data.y) || 0));
    p.angle = Number.isFinite(data.angle) ? data.angle : 0;
    if (!['duel', '2v2', '4v4'].includes(room.mode)) {
      p.hp = Number.isFinite(data.hp) ? Math.max(0, Math.min(1000, data.hp)) : p.hp;
    }
    socket.to(room.code).emit('match:update', {
      players: room.players.map(pl => ({
        id: pl.id, name: pl.name, team: pl.team, x: pl.x, y: pl.y, angle: pl.angle, hp: pl.hp, kills: pl.kills, deaths: pl.deaths
      })),
      scoreA: room.scoreA,
      scoreB: room.scoreB
    });
  });

  socket.on('match:shoot', data => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.hp <= 0) return;
    const now = Date.now();
    const last = room.lastShot.get(socket.id) || 0;
    if (now - last < 80) return; // rate limit
    room.lastShot.set(socket.id, now);
    const shotAngle = Number.isFinite(data && data.angle) ? data.angle : p.angle;
    const weapon = String((data && data.weapon) || 'gun').slice(0, 24);
    socket.to(room.code).emit('match:shot', { shooterId: socket.id, x: p.x, y: p.y, angle: shotAngle, weapon });

    if (!['duel', '2v2', '4v4'].includes(room.mode)) return;

    // Server-side PvP hit validation (simple cone / range)
    const range = Math.max(40, Math.min(220, Number(data && data.range) || 140));
    const damage = Math.max(1, Math.min(40, Number(data && data.damage) || 12));
    for (const other of room.players) {
      if (other.id === p.id || other.hp <= 0) continue;
      if (p.team && other.team && p.team === other.team) continue; // no friendly fire
      const dx = other.x - p.x;
      const dy = other.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1) continue;
      const ang = Math.atan2(dy, dx);
      let diff = Math.abs(ang - shotAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > 0.55) continue;
      other.hp = Math.max(0, other.hp - damage);
      if (other.hp === 0) {
        other.deaths += 1;
        p.kills += 1;
        if (p.team === 'A') room.scoreA += 1;
        if (p.team === 'B') room.scoreB += 1;
        // soft respawn position
        other.x = (other.team === 'B' ? 220 : -220) + (Math.random() * 40 - 20);
        other.y = Math.random() * 80 - 40;
        other.hp = 100;
      }
      io.to(other.id).emit('match:hit', {
        damage, hp: other.hp, from: p.name, dead: other.hp === 0 && false, // respawned
        elim: other.deaths
      });
      io.to(room.code).emit('match:pvp', {
        shooterId: p.id, targetId: other.id, shooterName: p.name, targetName: other.name,
        damage, hp: other.hp, kills: p.kills, deaths: other.deaths, scoreA: room.scoreA, scoreB: room.scoreB
      });
      io.to(room.code).emit('match:update', {
        players: room.players.map(pl => ({
          id: pl.id, name: pl.name, team: pl.team, x: pl.x, y: pl.y, angle: pl.angle, hp: pl.hp, kills: pl.kills, deaths: pl.deaths
        })),
        scoreA: room.scoreA, scoreB: room.scoreB
      });
      break; // one target per shot
    }
  });

  socket.on('lobby:chat', payload => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    const text = String((payload && payload.text) || '').replace(/[<>]/g, '').trim().slice(0, 180);
    if (!text) return;
    io.to(room.code).emit('lobby:chat', { name: p.name, text, t: Date.now() });
  });

  socket.on('match:zombies', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing' || !['coop', 'survival'].includes(room.mode)) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || !p.host) return;
    const zombies = Array.isArray(payload && payload.zombies)
      ? payload.zombies.slice(0, 80).map(z => ({
          id: String(z && z.id || '').slice(0, 40),
          x: Number(z && z.x), y: Number(z && z.y),
          hp: Number(z && z.hp), maxHp: Number(z && z.maxHp),
          speed: Number(z && z.speed), r: Number(z && z.r),
          boss: !!(z && z.boss), type: String(z && z.type || 'normal').slice(0, 12),
          slow: Number(z && z.slow) || 0
        })).filter(z => z.id && Number.isFinite(z.x) && Number.isFinite(z.y))
      : [];
    io.to(room.code).except(socket.id).emit('match:zombies', {
      zombies,
      level: Math.max(1, Math.min(999, Number(payload && payload.level) || 1))
    });
  });

  socket.on('match:zombie-hit', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing' || !['coop', 'survival'].includes(room.mode)) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.host) return;
    const id = String(payload && payload.id || '').slice(0, 40);
    const damage = Math.max(1, Math.min(150, Number(payload && payload.damage) || 1));
    if (!id) return;
    const host = room.players.find(pl => pl.host);
    if (host) io.to(host.id).emit('match:zombie-hit', { id, damage, from: p.name });
  });

  socket.on('match:end', () => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || !p.host) return;
    room.state = 'lobby';
    room.players.forEach(pl => { pl.ready = pl.host; pl.hp = 100; pl.x = 0; pl.y = 0; });
    room.lastShot.clear();
    emitRoom(room);
    io.to(room.code).emit('match:end', { code: room.code });
  });

  socket.on('disconnect', () => removePlayer(socket, true));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > MAX_ROOM_AGE) rooms.delete(code);
  }
  emitRoomsList();
}, 60000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Last 1 Percent server online on port ' + PORT));
