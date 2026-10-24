const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.json({
  name: 'Last 1 Percent – Survival online lobby',
  status: 'ok',
  featureStatus: {
    roomCodes: 'enabled',
    maxPlayersPerRoom: 4,
    readyState: 'enabled',
    hostStartSignal: 'enabled',
    synchronizedGameplay: 'not implemented yet',
    competitiveProfiles: 'not implemented yet',
    roomLobby: 'enabled'
  }
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000
});
const rooms = new Map();
const socketRoom = new Map();
const MAX_PLAYERS = 4;

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), b => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}
function safeName(value) {
  const s = String(value || 'Player').replace(/[<>]/g, '').trim().slice(0, 18);
  return s || 'Player';
}
function publicRoom(room) {
  return {
    code: room.code,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, country: p.country,
      host: p.id === room.hostId, ready: p.ready
    })),
    phase: room.phase
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
}
function removeFromRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  broadcastRoom(room);
}
function sendError(socket, message) {
  socket.emit('room:error', { message });
}

io.on('connection', socket => {
  socket.on('rooms:list', () => {
    socket.emit('rooms:list', [...rooms.values()].filter(r => r.phase === 'lobby').map(publicRoom));
  });

  socket.on('room:create', payload => {
    removeFromRoom(socket);
    const code = makeCode();
    const room = {
      code, hostId: socket.id, phase: 'lobby',
      players: new Map([[socket.id, {
        id: socket.id, name: safeName(payload?.name),
        country: String(payload?.country || '').slice(0, 40), ready: false
      }]])
    };
    rooms.set(code, room);
    socketRoom.set(socket.id, code);
    socket.join(code);
    socket.emit('room:created', { code });
    broadcastRoom(room);
  });

  socket.on('room:join', payload => {
    const code = String(payload?.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendError(socket, 'Room not found. Check the code.');
    if (room.phase !== 'lobby') return sendError(socket, 'That match has already started.');
    if (room.players.size >= MAX_PLAYERS) return sendError(socket, 'Room is full (maximum 4 players).');
    removeFromRoom(socket);
    room.players.set(socket.id, {
      id: socket.id, name: safeName(payload?.name),
      country: String(payload?.country || '').slice(0, 40), ready: false
    });
    socketRoom.set(socket.id, code);
    socket.join(code);
    socket.emit('room:joined', { code });
    broadcastRoom(room);
  });

  socket.on('room:ready', payload => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!room || room.phase !== 'lobby') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.ready = Boolean(payload?.ready);
    broadcastRoom(room);
  });

  socket.on('room:start', () => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!room) return sendError(socket, 'Create or join a room first.');
    if (room.hostId !== socket.id) return sendError(socket, 'Only the room host can start the match.');
    if (room.players.size < 2) return sendError(socket, 'At least 2 players are needed to start an online match.');
    const notReady = [...room.players.values()].filter(p => p.id !== room.hostId && !p.ready);
    if (notReady.length) return sendError(socket, 'Wait until every other player is ready.');
    room.phase = 'starting';
    io.to(room.code).emit('match:start', {
      code: room.code,
      players: publicRoom(room).players,
      startedAt: Date.now()
    });
    broadcastRoom(room);
  });

  socket.on('room:leave', () => removeFromRoom(socket));
  socket.on('disconnect', () => removeFromRoom(socket));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Last 1 Percent online lobby listening on port ${port}`);
});
