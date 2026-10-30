'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6
});

app.use(express.json({ limit: '32kb' }));

const INSTANCE_CAP = Math.min(50, Math.max(8, Number(process.env.INSTANCE_CAP) || 24));
const rooms = new Map();
const openInstances = new Map(); // mapKey -> [instanceId,...]
const leaderboard = []; // { id, name, avatar, score, kills, wave, t }
const eventClaimsMemory = new Map(); // key -> { name, kind, t, coins }
const MAX_ROOM_AGE = 6 * 60 * 60 * 1000;

const MODE_LIMITS = {
  coop: 4,
  survival: 4,
  open: INSTANCE_CAP,
  event_duel: 2,
  event_2v2: 4,
  event_4v4: 8
};
const MAPS = new Set(['city', 'lab', 'desert', 'docks']);

app.get('/', (_req, res) => res.json({
  name: 'Last 1 Percent Online',
  status: 'ok',
  instanceCap: INSTANCE_CAP,
  modes: Object.keys(MODE_LIMITS),
  maps: [...MAPS],
  note: 'Set INSTANCE_CAP env to raise open-world capacity (max practical depends on host).'
}));
app.get('/health', (_req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  players: [...rooms.values()].reduce((n, r) => n + r.players.filter(p => !p.isBot).length, 0),
  bots: [...rooms.values()].reduce((n, r) => n + r.players.filter(p => p.isBot).length, 0)
}));
app.get('/leaderboard', (_req, res) => res.json({ board: leaderboard.slice(0, 20) }));
app.get('/events/schedule', (_req, res) => {
  const now = new Date();
  const day = now.getUTCDay(); // 0 Sun .. 5 Fri 6 Sat
  const active = day === 5 || day === 6;
  res.json({
    active,
    timezone: 'UTC',
    windows: [
      { day: 'Friday', utcHour: 14, durationHours: 4, formats: ['event_duel', 'event_2v2'] },
      { day: 'Saturday', utcHour: 14, durationHours: 4, formats: ['event_2v2', 'event_4v4'] }
    ],
    message: active
      ? 'Weekend competitive events are marked active (UTC Fri/Sat). Host still controls room start.'
      : 'Next events: Friday & Saturday (UTC). Normal open/co-op play remains available.'
  });
});

function cleanName(v) {
  return String(v || 'Survivor').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Survivor';
}
function cleanCode(v) {
  return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    host: p.host,
    ready: p.ready,
    team: p.team,
    hp: p.hp,
    kills: p.kills,
    deaths: p.deaths,
    score: p.score || 0,
    avatar: p.avatar || '',
    isBot: !!p.isBot,
    x: p.x,
    y: p.y,
    angle: p.angle
  };
}
function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    map: room.map,
    maxPlayers: room.maxPlayers,
    state: room.state,
    instance: room.instance || 1,
    scoreA: room.scoreA,
    scoreB: room.scoreB,
    players: room.players.map(publicPlayer)
  };
}
function emitRoomsList() {
  const list = [...rooms.values()]
    .filter(r => r.state === 'lobby' && r.players.filter(p => !p.isBot).length < r.maxPlayers)
    .map(r => ({
      code: r.code,
      mode: r.mode,
      map: r.map,
      maxPlayers: r.maxPlayers,
      instance: r.instance || 1,
      players: r.players.filter(p => !p.isBot).map(p => ({ id: p.id, name: p.name, host: p.host, ready: p.ready, team: p.team }))
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
function pushLeaderboard(entry) {
  const id = entry.id || entry.name;
  const idx = leaderboard.findIndex(e => e.id === id);
  if (idx >= 0) {
    if ((entry.score || 0) >= (leaderboard[idx].score || 0)) leaderboard[idx] = { ...leaderboard[idx], ...entry, t: Date.now() };
  } else {
    leaderboard.push({ ...entry, t: Date.now() });
  }
  leaderboard.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.kills || 0) - (a.kills || 0));
  if (leaderboard.length > 50) leaderboard.length = 50;
  io.emit('leaderboard:update', { board: leaderboard.slice(0, 15) });
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
  // Drop loot crate on disconnect during open/pvp play
  if (room.state === 'playing' && (room.mode === 'open' || room.mode.startsWith('event_'))) {
    io.to(room.code).emit('match:loot', {
      id: 'loot_' + crypto.randomBytes(4).toString('hex'),
      x: socket.data.lastX || 0,
      y: socket.data.lastY || 0,
      type: 'crate',
      from: socket.data.playerName || 'Player'
    });
  }
  if (!room.players.filter(p => !p.isBot).length) {
    rooms.delete(room.code);
  } else {
    if (!room.players.some(p => p.host && !p.isBot)) {
      const human = room.players.find(p => !p.isBot);
      if (human) {
        human.host = true;
        human.ready = true;
      }
    }
    if (announce) emitRoom(room);
  }
  if (announce) emitRoomsList();
}
function makeBot(room, i) {
  const id = 'bot_' + room.code + '_' + i + '_' + crypto.randomBytes(2).toString('hex');
  return {
    id,
    name: 'AI-' + (i + 1),
    country: '',
    host: false,
    ready: true,
    team: null,
    hp: 100,
    kills: 0,
    deaths: 0,
    score: 0,
    avatar: '',
    isBot: true,
    x: (Math.random() - 0.5) * 400,
    y: (Math.random() - 0.5) * 400,
    angle: Math.random() * Math.PI * 2
  };
}
function fillBots(room, targetHumansAndBots) {
  const humans = room.players.filter(p => !p.isBot).length;
  let bots = room.players.filter(p => p.isBot);
  const want = Math.max(0, Math.min(room.maxPlayers - humans, targetHumansAndBots - humans));
  while (bots.length > want) {
    const b = bots.pop();
    room.players = room.players.filter(p => p.id !== b.id);
  }
  bots = room.players.filter(p => p.isBot);
  let i = bots.length;
  while (bots.length < want) {
    const b = makeBot(room, i++);
    room.players.push(b);
    bots.push(b);
  }
}
function findOpenInstance(map) {
  for (const room of rooms.values()) {
    if (room.mode === 'open' && room.map === map && room.state !== 'closed') {
      const humans = room.players.filter(p => !p.isBot).length;
      if (humans < room.maxPlayers) return room;
    }
  }
  return null;
}
function createOpenRoom(map) {
  const code = 'O' + generateCode().slice(0, 4);
  const instance = (openInstances.get(map) || []).length + 1;
  const room = {
    code,
    mode: 'open',
    map: MAPS.has(map) ? map : 'city',
    maxPlayers: MODE_LIMITS.open,
    state: 'playing',
    instance,
    scoreA: 0,
    scoreB: 0,
    createdAt: Date.now(),
    lastShot: new Map(),
    lootClaimed: new Set(),
    players: []
  };
  rooms.set(code, room);
  const list = openInstances.get(map) || [];
  list.push(code);
  openInstances.set(map, list);
  fillBots(room, Math.min(6, room.maxPlayers));
  return room;
}

io.on('connection', socket => {
  socket.data.roomCode = null;

  socket.on('rooms:list', () => emitRoomsList());
  socket.on('leaderboard:get', () => socket.emit('leaderboard:update', { board: leaderboard.slice(0, 15) }));

  socket.on('world:join', payload => {
    removePlayer(socket, false);
    const map = MAPS.has(payload && payload.map) ? payload.map : 'city';
    let room = findOpenInstance(map);
    if (!room) room = createOpenRoom(map);
    // Replace one bot if present
    const bot = room.players.find(p => p.isBot);
    if (bot) room.players = room.players.filter(p => p.id !== bot.id);
    const player = {
      id: socket.id,
      name: cleanName(payload && payload.name),
      country: String((payload && payload.country) || '').slice(0, 40),
      host: !room.players.some(p => !p.isBot),
      ready: true,
      team: null,
      hp: 100,
      kills: 0,
      deaths: 0,
      score: 0,
      avatar: String((payload && payload.avatar) || '').slice(0, 200),
      isBot: false,
      x: (Math.random() - 0.5) * 200,
      y: (Math.random() - 0.5) * 200,
      angle: 0
    };
    room.players.push(player);
    fillBots(room, Math.min(8, room.maxPlayers));
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerName = player.name;
    socket.emit('world:joined', { code: room.code, map: room.map, instance: room.instance, maxPlayers: room.maxPlayers });
    io.to(room.code).emit('match:start', {
      code: room.code,
      mode: 'open',
      map: room.map,
      instance: room.instance,
      hostId: room.players.find(p => p.host && !p.isBot)?.id,
      players: room.players.map(publicPlayer)
    });
    emitRoom(room);
  });

  socket.on('room:create', payload => {
    removePlayer(socket, false);
    let mode = payload && payload.mode;
    if (!MODE_LIMITS[mode]) mode = 'coop';
    // Block event modes unless client says eventOk (schedule is advisory)
    if (String(mode).startsWith('event_') && !(payload && payload.eventOk)) mode = 'coop';
    const map = MAPS.has(payload && payload.map) ? payload.map : 'city';
    const code = generateCode();
    const room = {
      code,
      mode,
      map,
      maxPlayers: MODE_LIMITS[mode],
      state: 'lobby',
      instance: 1,
      scoreA: 0,
      scoreB: 0,
      createdAt: Date.now(),
      lastShot: new Map(),
      lootClaimed: new Set(),
      players: [{
        id: socket.id,
        name: cleanName(payload && payload.name),
        country: String((payload && payload.country) || '').slice(0, 40),
        host: true,
        ready: true,
        team: mode.includes('2v2') || mode.includes('4v4') || mode.includes('duel') ? 'A' : null,
        hp: 100, kills: 0, deaths: 0, score: 0,
        avatar: String((payload && payload.avatar) || '').slice(0, 200),
        isBot: false,
        x: 0, y: 0, angle: 0
      }]
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerName = room.players[0].name;
    socket.emit('room:created', { code, mode, map });
    emitRoom(room);
  });

  socket.on('room:join', payload => {
    const code = cleanCode(payload && payload.code);
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', { message: 'Room not found.' });
    if (room.state === 'closed') return socket.emit('room:error', { message: 'Room closed.' });
    const humans = room.players.filter(p => !p.isBot).length;
    if (humans >= room.maxPlayers) return socket.emit('room:error', { message: 'Room full — try Open World (auto instance).' });
    if (room.state === 'lobby' || room.mode === 'open' || room.state === 'playing') {
      removePlayer(socket, false);
      const bot = room.players.find(p => p.isBot);
      if (bot) room.players = room.players.filter(p => p.id !== bot.id);
      room.players.push({
        id: socket.id,
        name: cleanName(payload && payload.name),
        country: String((payload && payload.country) || '').slice(0, 40),
        host: false,
        ready: room.mode === 'open',
        team: null,
        hp: 100, kills: 0, deaths: 0, score: 0,
        avatar: String((payload && payload.avatar) || '').slice(0, 200),
        isBot: false,
        x: (Math.random() - 0.5) * 160,
        y: (Math.random() - 0.5) * 160,
        angle: 0
      });
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerName = cleanName(payload && payload.name);
      socket.emit('room:joined', { code, mode: room.mode, map: room.map });
      if (room.mode === 'open' || room.state === 'playing') {
        socket.emit('match:start', {
          code: room.code,
          mode: room.mode,
          map: room.map,
          instance: room.instance,
          players: room.players.map(publicPlayer)
        });
      }
      emitRoom(room);
    }
  });

  socket.on('room:ready', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.isBot) return;
    p.ready = !!(payload && payload.ready);
    emitRoom(room);
  });

  socket.on('room:team', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'lobby') return;
    if (!String(room.mode).includes('2v2') && !String(room.mode).includes('4v4') && !String(room.mode).includes('duel')) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    p.team = payload && payload.team === 'B' ? 'B' : 'A';
    emitRoom(room);
  });

  socket.on('room:start', () => {
    const room = getRoom(socket);
    if (!room) return socket.emit('room:error', { message: 'Not in a room.' });
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || !p.host) return socket.emit('room:error', { message: 'Only host can start.' });
    const humans = room.players.filter(pl => !pl.isBot);
    if (humans.length < 1) return;
    if (humans.length < 2 && room.mode !== 'survival' && room.mode !== 'coop') {
      return socket.emit('room:error', { message: 'Need at least 2 players.' });
    }
    const notReady = humans.filter(pl => !pl.host && !pl.ready);
    if (notReady.length) return socket.emit('room:error', { message: 'Wait for Ready.' });
    room.state = 'playing';
    emitRoom(room);
    io.to(room.code).emit('match:start', {
      code: room.code,
      mode: room.mode,
      map: room.map,
      hostId: p.id,
      players: room.players.map(publicPlayer)
    });
  });

  socket.on('room:leave', () => removePlayer(socket, true));

  socket.on('match:move', data => {
    const room = getRoom(socket);
    if (!room || !data) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.isBot) return;
    p.x = Math.max(-800, Math.min(800, Number(data.x) || 0));
    p.y = Math.max(-800, Math.min(800, Number(data.y) || 0));
    p.angle = Number.isFinite(data.angle) ? data.angle : 0;
    if (room.mode === 'open' || room.mode === 'coop' || room.mode === 'survival') {
      p.hp = Number.isFinite(data.hp) ? Math.max(0, Math.min(1000, data.hp)) : p.hp;
    }
    socket.data.lastX = p.x;
    socket.data.lastY = p.y;
    socket.to(room.code).emit('match:update', {
      players: room.players.map(publicPlayer),
      scoreA: room.scoreA,
      scoreB: room.scoreB
    });
  });

  socket.on('match:shoot', data => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.isBot || p.hp <= 0) return;
    const now = Date.now();
    const last = room.lastShot.get(socket.id) || 0;
    if (now - last < 70) return;
    room.lastShot.set(socket.id, now);
    const shotAngle = Number.isFinite(data && data.angle) ? data.angle : p.angle;
    socket.to(room.code).emit('match:shot', { shooterId: socket.id, x: p.x, y: p.y, angle: shotAngle });

    // PvP in open world + event modes
    if (room.mode !== 'open' && !String(room.mode).startsWith('event_')) return;
    const range = Math.max(40, Math.min(240, Number(data && data.range) || 150));
    const damage = Math.max(1, Math.min(45, Number(data && data.damage) || 14));
    for (const other of room.players) {
      if (other.id === p.id || other.hp <= 0 || other.isBot) continue;
      if (p.team && other.team && p.team === other.team) continue;
      const dx = other.x - p.x, dy = other.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1) continue;
      let diff = Math.abs(Math.atan2(dy, dx) - shotAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > 0.5) continue;
      other.hp = Math.max(0, other.hp - damage);
      if (other.hp === 0) {
        other.deaths += 1;
        p.kills += 1;
        p.score = (p.score || 0) + 25;
        const lootId = 'loot_' + crypto.randomBytes(4).toString('hex');
        io.to(room.code).emit('match:loot', {
          id: lootId, x: other.x, y: other.y, type: 'crate', from: other.name
        });
        other.x = (Math.random() - 0.5) * 300;
        other.y = (Math.random() - 0.5) * 300;
        other.hp = 100;
        pushLeaderboard({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, kills: p.kills, wave: 0 });
      }
      io.to(other.id).emit('match:hit', { damage, hp: other.hp, from: p.name, dead: false });
      io.to(room.code).emit('match:pvp', {
        shooterId: p.id, targetId: other.id, shooterName: p.name, targetName: other.name,
        damage, hp: other.hp, kills: p.kills, scoreA: room.scoreA, scoreB: room.scoreB
      });
      break;
    }
  });

  socket.on('match:loot-claim', payload => {
    const room = getRoom(socket);
    if (!room) return;
    const id = String(payload && payload.id || '');
    if (!id || room.lootClaimed.has(id)) {
      return socket.emit('match:loot-denied', { id });
    }
    room.lootClaimed.add(id);
    const p = room.players.find(pl => pl.id === socket.id);
    if (p) p.score = (p.score || 0) + 5;
    io.to(room.code).emit('match:loot-taken', { id, by: socket.id, name: p && p.name });
  });

  socket.on('lobby:chat', payload => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || p.isBot) return;
    const text = String((payload && payload.text) || '').replace(/[<>]/g, '').trim().slice(0, 180);
    if (!text) return;
    io.to(room.code).emit('lobby:chat', { name: p.name, text, t: Date.now() });
  });

  socket.on('match:zombies', payload => {
    const room = getRoom(socket);
    if (!room || room.state !== 'playing') return;
    if (!['coop', 'survival', 'open'].includes(room.mode)) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || !p.host || p.isBot) return;
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

  socket.on('event:claim', payload => {
    const name = cleanName(payload && payload.name);
    const kind = String((payload && payload.kind) || 'play').slice(0, 12);
    const week = String((payload && payload.week) || 'W').slice(0, 16);
    const key = week + ':' + kind + ':' + name.toLowerCase();
    if (eventClaimsMemory.has(key)) {
      return socket.emit('event:claim-result', { ok: false, reason: 'Already claimed on server this week' });
    }
    const coins = kind === 'mvp' ? 120 : kind === 'win' ? 80 : 35;
    eventClaimsMemory.set(key, { name, kind, t: Date.now(), coins });
    socket.emit('event:claim-result', { ok: true, coins, kind, frame: kind === 'mvp' ? 'mvp' : (kind === 'win' ? 'event' : 'mission') });
  });
  socket.on('stats:submit', payload => {
    const name = cleanName(payload && payload.name);
    const score = Math.max(0, Math.min(1e7, Number(payload && payload.score) || 0));
    const kills = Math.max(0, Math.min(1e5, Number(payload && payload.kills) || 0));
    const wave = Math.max(0, Math.min(9999, Number(payload && payload.wave) || 0));
    pushLeaderboard({
      id: socket.id,
      name,
      avatar: String((payload && payload.avatar) || '').slice(0, 200),
      score: score + kills * 3 + wave * 10,
      kills,
      wave
    });
  });

  socket.on('match:end', () => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p || !p.host) return;
    if (room.mode === 'open') return;
    room.state = 'lobby';
    room.players.forEach(pl => { if (!pl.isBot) { pl.ready = pl.host; pl.hp = 100; } });
    emitRoom(room);
    io.to(room.code).emit('match:end', { code: room.code });
  });

  socket.on('disconnect', () => removePlayer(socket, true));
});

// Simple bot wander broadcast
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing' && room.mode !== 'open') continue;
    let moved = false;
    for (const p of room.players) {
      if (!p.isBot) continue;
      p.angle += (Math.random() - 0.5) * 0.4;
      p.x = Math.max(-700, Math.min(700, p.x + Math.cos(p.angle) * 12));
      p.y = Math.max(-700, Math.min(700, p.y + Math.sin(p.angle) * 12));
      moved = true;
    }
    if (moved) {
      io.to(room.code).emit('match:update', {
        players: room.players.map(publicPlayer),
        scoreA: room.scoreA,
        scoreB: room.scoreB
      });
    }
  }
}, 500).unref();

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > MAX_ROOM_AGE) rooms.delete(code);
  }
  emitRoomsList();
}, 60000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Last 1 Percent server on', PORT, 'instanceCap', INSTANCE_CAP));
