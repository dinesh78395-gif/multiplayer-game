const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const VERSION = 'alphabet-spin v8-timeout-safe';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.get('/__health', (_, res) => res.send('ok'));
app.get('/__version', (_, res) => res.send(VERSION));
app.get('/favicon.ico', (_, res) => res.status(204).end());

// ----------------- state -----------------
const ROOMS = {};
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// ----------------- helpers -----------------
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

// validation (same as before)
function looksLikeWord(w) { return /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(w); }
function hasTripleRepeat(w) { return /(.)\1\1/.test(w); }
function isAllSameChar(w) { return /^([A-Za-z])\1+$/.test(w); }
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

// ----------------- sockets -----------------
io.on('connection', (socket) => {
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
      usedLetters: [],
      // NEW: for robust timeout handling
      timerHandle: null,
      turnSerial: 0
    };
    socket.join(roomCode);
    socket.emit('roomJoined', { roomCode, snapshot: roomSnapshot(ROOMS[roomCode]) });
    io.to(roomCode).emit('roomUpdate', roomSnapshot(ROOMS[roomCode]));
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = ROOMS[roomCode];
    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.state !== 'lobby') return socket.emit('errorMsg', 'Game already started.');

    room.players.push({ id: socket.id, name: name?.trim() || 'Player', score: 0 });
    room.order.push(socket.id);
    socket.join(roomCode);

    socket.emit('roomJoined', { roomCode, snapshot: roomSnapshot(room) });
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
  });

  socket.on('startGame', ({ roomCode, roundsPerPlayer = 5 }) => {
    const room = ROOMS[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('errorMsg', 'Only host can start.');
    if (room.players.length < 2) return socket.emit('errorMsg', 'Need at least 2 players.');

    room.roundsPerPlayer = Math.max(1, Math.min(10, roundsPerPlayer | 0));
    room.state = 'playing';
    room.turnIndex = 0;
    room.usedLetters = [];
    // clear any leftover timer
    if (room.timerHandle) { clearTimeout(room.timerHandle); room.timerHandle = null; }

    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
    startTurn(roomCode);
  });

  socket.on('submitAnswers', ({ roomCode, answers }) => {
    const room = ROOMS[roomCode];
    if (!room || room.state !== 'playing') return;

    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return; // only current player can submit
    if (Date.now() > room.timerEndTs) return; // time up -> ignore

    const expected = (room.currentLetter || '').toUpperCase();
    const fields = [
      answers?.name || '',
      answers?.place || '',
      answers?.animal || '',
      answers?.thing || '',
      answers?.movie || ''
    ];
    const ok = fields.every(v => validWordForLetter(v, expected)) && allUnique(fields);

    if (!ok) {
      socket.emit('errorMsg', 'Invalid or duplicate words. Use real words starting with the letter.');
      return;
    }

    cp.score += 1;
    io.to(roomCode).emit('toast', `${cp.name} completed valid entries! +1 point`);
    nextTurn(roomCode); // will clear timer and start new one
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
  });

  // client failsafe (kept, but server no longer depends on it)
  socket.on('nextTurnTimeout', ({ roomCode }) => {
    const room = ROOMS[roomCode];
    if (!room || room.state !== 'playing') return;
    if (Date.now() >= room.timerEndTs) nextTurn(roomCode);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(ROOMS)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        const wasCurrent = currentPlayer(room)?.id === socket.id;
        room.players.splice(idx, 1);
        room.order = room.order.filter(id => id !== socket.id);

        if (room.players.length === 0) {
          // cleanup whole room
          if (room.timerHandle) clearTimeout(room.timerHandle);
          delete ROOMS[code];
          continue;
        }
        if (room.hostId === socket.id) room.hostId = room.players[0].id;

        // if current player quit during turn, advance
        if (room.state === 'playing' && wasCurrent) {
          io.to(code).emit('toast', 'Current player left — advancing turn');
          nextTurn(code);
        } else {
          io.to(code).emit('roomUpdate', roomSnapshot(room));
        }
      }
    }
  });
});

// ----------------- turn engine (server-authoritative) -----------------
function startTurn(roomCode) {
  const room = ROOMS[roomCode];
  if (!room) return;

  // end-of-game
  const maxTurns = totalTurns(room);
  if (room.turnIndex >= maxTurns) {
    room.state = 'ended';
    // clear any pending timer
    if (room.timerHandle) { clearTimeout(room.timerHandle); room.timerHandle = null; }
    io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
    io.to(roomCode).emit('toast', 'Game over!');
    return;
  }

  // set up new turn
  room.turnSerial += 1;                     // unique id for this turn
  const serial = room.turnSerial;
  const cp = currentPlayer(room);

  room.currentLetter = randomLetter(room.usedLetters);
  room.usedLetters.push(room.currentLetter);
  room.timerEndTs = Date.now() + 60_000;    // 60s

  // clear any previous timeout and start a fresh one
  if (room.timerHandle) clearTimeout(room.timerHandle);
  const ms = Math.max(0, room.timerEndTs - Date.now() + 120); // small buffer
  room.timerHandle = setTimeout(() => {
    const r = ROOMS[roomCode];
    if (!r || r.state !== 'playing') return;
    // ensure we're still on the same turn (avoid race)
    if (r.turnSerial !== serial) return;

    io.to(roomCode).emit('toast', `${currentPlayer(r)?.name || 'Player'} ran out of time`);
    nextTurn(roomCode); // will call startTurn again
  }, ms);

  // notify clients
  io.to(roomCode).emit('roomUpdate', roomSnapshot(room));
  io.to(roomCode).emit('turnStarted', {
    snapshot: roomSnapshot(room),
    currentPlayerId: cp?.id || null
  });
}

function nextTurn(roomCode) {
  const room = ROOMS[roomCode];
  if (!room) return;

  // stop existing timeout for the finishing turn
  if (room.timerHandle) { clearTimeout(room.timerHandle); room.timerHandle = null; }

  room.turnIndex += 1;
  startTurn(roomCode);
}

// ----------------- start server -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running → ' + PORT));
