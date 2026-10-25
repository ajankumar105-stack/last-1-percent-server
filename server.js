const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.get('/health', (req, res) => res.status(200).send('OK'));

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', ({ name, mode }) => {
    const code = generateCode();
    const room = {
      code, mode: mode || 'coop', maxPlayers: mode === '4v4' ? 8 : 4,
      players: [], state: 'lobby', scoreA: 0, scoreB: 0
    };
    rooms[code] = room; currentRoom = code; socket.join(code);
    room.players.push({ id: socket.id, name: name || 'Survivor', host: true, ready: false, team: mode === '4v4' ? 'A' : null, x: 0, y: 0, hp: 100, kills: 0 });
    socket.emit('room:created', { code });
    io.to(code).emit('room:update', room);
  });

  socket.on('room:join', ({ name, code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('room:error', 'Room not found');
    if (room.players.length >= room.maxPlayers) return socket.emit('room:error', 'Room full');

    currentRoom = code; socket.join(code);
    const team = room.mode === '4v4' ? (room.players.length % 2 === 0 ? 'A' : 'B') : null;
    room.players.push({ id: socket.id, name: name || 'Survivor', host: false, ready: false, team, x: 0, y: 0, hp: 100, kills: 0 });
    io.to(code).emit('room:update', room);
  });

  socket.on('room:team', ({ team }) => {
    const room = rooms[currentRoom];
    if (room) {
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) p.team = team;
      io.to(currentRoom).emit('room:update', room);
    }
  });

  socket.on('room:ready', ({ ready }) => {
    const room = rooms[currentRoom];
    if (room) {
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) p.ready = ready;
      io.to(currentRoom).emit('room:update', room);
    }
  });

  socket.on('room:start', () => {
    const room = rooms[currentRoom];
    if (room) { room.state = 'playing'; io.to(currentRoom).emit('match:start', { mode: room.mode }); }
  });

  socket.on('match:move', (data) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (p) { p.x = data.x; p.y = data.y; p.angle = data.angle; p.hp = data.hp; }
    
    const map = {};
    room.players.forEach(pl => map[pl.id] = pl);
    socket.broadcast.to(currentRoom).emit('match:update', { players: map, scoreA: room.scoreA, scoreB: room.scoreB });
  });

  socket.on('match:shoot', (data) => {
    socket.broadcast.to(currentRoom).emit('match:shot', { shooterId: socket.id, ...data });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) delete rooms[currentRoom];
      else io.to(currentRoom).emit('room:update', room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server online on port ' + PORT));
