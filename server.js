const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const VERSION = 'alphabet-spin v7-nonsense-guard';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

console.log('=== alphabet-spin SERVER v7 (nonsense guard) ===');

app.use(express.static('public'));
app.get('/__health', (req, res) => res.send('ok'));
app.get('/__version', (req, res) => res.send(VERSION));
app.get('/favicon.ico', (req, res) => res.status(204).end());

const ROOMS = {};
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// ---------- helpers ----------
function randomLetter(used = []) {
  const available = LETTERS.filter(l => !used.includes(l));
  if (available.length === 0) return LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return available[Math.floor(Math.random() * available.length)];
}
function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function roomSnapshot(room) {
  return {
    state: room.state,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    hostId: room.hostId,
    turnIndex: room.turnIndex,
    currentLetter: room.currentLetter,
    roundsPerPlayer: room.roundsPerPlayer,
    order: room.order,
    timerEndTs: room.timerEndTs,
    usedLetters: room.usedLetters
  };
}
function currentPlayer(room) {
  if (!room || !room.order.length) return null;
  const id = room.order[room.turnIndex % room.order.length];
  return room.players.find(p => p.id === id) || null;
}
function totalTurns(room) {
  return room.players.length * room.roundsPerPlayer;
}

// core nonsense guards
function looksLikeWord(w) { return /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(w); }
function hasTripleRepeat(w) { return /(.)\1\1/.test(w); }      // cooool, heeey
function isAllSameChar(w) { return /^([A-Za-z])\1+$/.test(w); } // aaaa, BBBB
function validWordForLetter(w, letter) {
  const t = (w || '').trim();
  if (t.length < 2) return false;
  if (!looksLikeWord(t)) return false;
  if (t[0].toUpperCase() !== letter) return false;
  const lower = t.toLowerCase();
  if (hasTripleRepeat(lower)) return false;
  if (isAllSameChar(lower)) return false;
  return true;
}
function allUnique(arr) {
  const s = new Set(arr.map(x => x.trim().toLowerCase()));
  return s.size === arr.length;
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  console.log('[server] socket connected', socket.id);

  socket.on('createRoom', ({ name }) => {
    const roomCode = makeRoomCode();
    ROOMS[roomCode] = {
      hostId: socket.id,
      players: [{ id: socket.id, name: name?.trim() || 'Host', score: 0 }],
      state: 'lobby',
      turnIndex: 0,
      roundsPerPlayer: 5,
      currentLetter: null,
      timerEndTs: null,
      order: [socket.id],
      usedLetters: []
    };
    socket.join(roomCode);
    console.log('[server] room created', roomCode, 'host', socket.id);
    socket.emit('roomJoined', { roomCode, snapshot: roomSnapshot(ROOMS[roomCode]) });
    io.to(roomCode).emit('roomUpdate', roomSnapshot(ROOMS[roomCode]));
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    console.log('[server] joinRoom from', socket.id, 'room', roomCode);
    const room = ROOMS[roomCode];
    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.state !== 'lobby') return socket.emit('errorMsg', 'Game already started.');
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({ id: socket.id, name: name?.trim() || 'Player', score: 0 });
    room.order.push(socket.id);
    socket.join(roomCode);

    socket.emit('roomJoined', { roomCode, snapshot: roomSnapshot(room) });
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
  });

  socket.on('startGame', ({ roomCode, roundsPerPlayer = 5 }) => {
    console.log('[server] startGame recv', { from: socket.id, roomCode, roundsPerPlayer });
    if (!roomCode) return socket.emit('errorMsg', 'Room code missing on startGame.');
    const room = ROOMS[roomCode];
    if (!room) return socket.emit('errorMsg', 'Room not found on startGame.');
    if (room.hostId !== socket.id) return socket.emit('errorMsg', 'Only host can start.');
    if (room.players.length < 2) return socket.emit('errorMsg', 'Need at least 2 players.');

    room.roundsPerPlayer = Math.max(1, Math.min(10, roundsPerPlayer | 0));
    room.state = 'playing';
    room.turnIndex = 0;
    room.usedLetters = [];

    io.to(roomCode).emit('toast', 'Starting game…');
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
    startTurn(roomCode);
  });

  socket.on('submitAnswers', ({ roomCode, answers }) => {
    const room = ROOMS[roomCode];
    if (!room || room.state !== 'playing') return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;
    if (Date.now() > room.timerEndTs) return;

    const expected = (room.currentLetter || '').toUpperCase();
    const cats = ['name', 'place', 'animal', 'thing', 'movie'];

    const vals = cats.map(k => (answers?.[k] || '').trim());
    const allOk = vals.every(v => validWordForLetter(v, expected)) && allUnique(vals);

    if (allOk) {
      cp.score += 1;
      io.to(roomCode).emit('toast', `${cp.name} completed valid entries! +1 point`);
      nextTurn(roomCode);
    } else {
      socket.emit('errorMsg', 'Invalid or duplicate words detected. Use real words, letters/spaces only, length ≥ 2, no 3+ repeats.');
    }
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
  });

  socket.on('nextTurnTimeout', ({ roomCode }) => {
    const room = ROOMS[roomCode];
    if (!room || room.state !== 'playing') return;
    if (Date.now() >= room.timerEndTs) nextTurn(roomCode);
  });

  socket.on('disconnect', () => {
    console.log('[server] socket disconnected', socket.id);
    for (const [code, room] of Object.entries(ROOMS)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        room.players.splice(idx, 1);
        room.order = room.order.filter(id => id !== socket.id);
        if (room.players.length === 0) {
          delete ROOMS[code];
          continue;
        }
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        io.to(code).emit('roomUpdate', roomSnapshot(room));
      }
    }
  });
});

function startTurn(roomCode) {
  const room = ROOMS[roomCode];
  if (!room) return;

  const maxTurns = totalTurns(room);
  if (room.turnIndex >= maxTurns) {
    room.state = 'ended';
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
    io.to(roomCode).emit('toast', 'Game over!');
    console.log('[server] game over', roomCode);
    return;
  }

  const cp = currentPlayer(room);
  room.currentLetter = randomLetter(room.usedLetters);
  room.usedLetters.push(room.currentLetter);
  room.timerEndTs = Date.now() + 60000;

  io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
  io.to(roomCode).emit('turnStarted', {
    snapshot: roomSnapshot(room),
    currentPlayerId: cp?.id || null
  });

  console.log('[server] turnStarted', { roomCode, letter: room.currentLetter, currentPlayer: cp?.id });
}
function nextTurn(roomCode) {
  const room = ROOMS[roomCode];
  if (!room) return;
  room.turnIndex += 1;
  startTurn(roomCode);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → ${PORT}`));

