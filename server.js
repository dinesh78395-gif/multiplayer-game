const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// Health checks
app.get("/__health", (_, res) => res.send("ok"));
app.get("/__version", (_, res) => res.send("v10-ai-india-nodict-30s-skipfix"));

// =============================
//   HEURISTIC WORD VALIDATION
//   (NO DICTIONARIES USED)
// =============================
function looksLegitWord(w) {
  if (!w) return false;
  const t = w.trim().toLowerCase();

  // letters only, single token
  if (!/^[a-z]+$/.test(t)) return false;

  // length bounds
  if (t.length < 3 || t.length > 12) return false;

  // must contain a vowel
  if (!/[aeiou]/.test(t)) return false;

  // no three identical letters in a row
  if (/(.)\1\1/.test(t)) return false;

  // allow common 3-consonant clusters; block 4+ only
  if (/[bcdfghjklmnpqrstvwxyz]{4,}/.test(t)) return false;

  // unlikely n-grams that show up in junk
  const rare = ["qj","xv","zx","jj","kk","fq","jh","kjh","xq","pz"];
  if (rare.some(x => t.includes(x))) return false;

  // limit very rare letters overall
  const rareCount = (t.match(/[qxz]/g) || []).length;
  if (rareCount > 2) return false;

  // block simple repeating patterns like 'ababab' or 'xyzxyz'
  if (/(..)\1{2,}/.test(t) || /(...)\1{2,}/.test(t)) return false;

  return true;
}

function validateCategory(word, letter /*, cat */) {
  if (!word) return false;
  const t = word.trim().toLowerCase();
  if (t[0] !== letter.toLowerCase()) return false;
  return looksLegitWord(t);
}

// =============================
//  GAME STATE + HELPERS
// =============================
const ROOMS = {};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function randomLetter(used) {
  const avail = LETTERS.filter(l => !used.includes(l));
  return avail.length
    ? avail[Math.floor(Math.random() * avail.length)]
    : LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function snapshot(room) {
  return {
    state: room.state,
    players: room.players,
    hostId: room.hostId,
    turnIndex: room.turnIndex,
    currentLetter: room.currentLetter,
    roundsPerPlayer: room.roundsPerPlayer,
    order: room.order,
    timerEndTs: room.timerEndTs
  };
}

function currentPlayer(room) {
  return room.players.find(p => p.id === room.order[room.turnIndex % room.order.length]);
}

// =============================
//          SOCKET LOGIC
// =============================
io.on("connection", socket => {
  // CREATE ROOM
  socket.on("createRoom", ({ name }) => {
    const code = makeRoomCode();

    ROOMS[code] = {
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0 }],
      order: [socket.id],
      state: "lobby",
      turnIndex: 0,
      roundsPerPlayer: 5,
      currentLetter: null,
      usedLetters: [],
      timerEndTs: null,
      timerHandle: null,
      turnSerial: 0
    };

    socket.join(code);
    socket.emit("roomJoined", { roomCode: code, snapshot: snapshot(ROOMS[code]) });
    io.to(code).emit("roomUpdate", snapshot(ROOMS[code]));
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ roomCode, name }) => {
    const room = ROOMS[roomCode];
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (room.state !== "lobby") return socket.emit("errorMsg", "Game already started.");

    room.players.push({ id: socket.id, name, score: 0 });
    room.order.push(socket.id);

    socket.join(roomCode);
    socket.emit("roomJoined", { roomCode, snapshot: snapshot(room) });
    io.to(roomCode).emit("roomUpdate", snapshot(room));
  });

  // START GAME
  socket.on("startGame", ({ roomCode }) => {
    const room = ROOMS[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("errorMsg", "Only host can start.");
    if (room.players.length < 2) return socket.emit("errorMsg", "Need at least 2 players.");

    room.state = "playing";
    room.turnIndex = 0;
    room.usedLetters = [];

    io.to(roomCode).emit("roomUpdate", snapshot(room));
    startTurn(roomCode);
  });

  // SUBMIT ANSWERS
  socket.on("submitAnswers", ({ roomCode, answers }) => {
    const room = ROOMS[roomCode];
    if (!room || room.state !== "playing") return;

    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return; // only current player

    const L = room.currentLetter;
    const now = Date.now();
    const isTimeUp = room.timerEndTs && now >= room.timerEndTs;

    const ok =
      validateCategory(answers.name,   L) &&
      validateCategory(answers.place,  L) &&
      validateCategory(answers.animal, L) &&
      validateCategory(answers.thing,  L) &&
      validateCategory(answers.movie,  L);

    // If time is already up, skip turn regardless of validity
    if (isTimeUp) {
      io.to(roomCode).emit("toast", ok ? "Too late! Time's up — no point." : "Invalid & time's up — skipping turn.");
      nextTurn(roomCode);
      io.to(roomCode).emit("roomUpdate", snapshot(room));
      return;
    }

    if (!ok) {
      // Not time-up yet: just tell the player to fix it
      socket.emit("errorMsg", "Invalid entries! Letters only, must start with the letter, length 3–12, no repeats/junk.");
      return;
    }

    // Valid and in time → score
    cp.score++;
    io.to(roomCode).emit("toast", `${cp.name} scored +1`);
    nextTurn(roomCode);
    io.to(roomCode).emit("roomUpdate", snapshot(room));
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(ROOMS)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const wasCurrent = currentPlayer(room)?.id === socket.id;

      room.players.splice(idx, 1);
      room.order = room.order.filter(id => id !== socket.id);

      if (room.players.length === 0) {
        delete ROOMS[code];
        continue;
      }

      if (room.hostId === socket.id) room.hostId = room.players[0].id;

      if (room.state === "playing" && wasCurrent) {
        io.to(code).emit("toast", "Player left — skipping turn.");
        nextTurn(code);
      }

      io.to(code).emit("roomUpdate", snapshot(room));
    }
  });
});

// =============================
//        TURN ENGINE
// =============================
function startTurn(code) {
  const room = ROOMS[code];
  if (!room) return;

  const maxTurns = room.players.length * room.roundsPerPlayer;
  if (room.turnIndex >= maxTurns) {
    room.state = "ended";
    io.to(code).emit("roomUpdate", snapshot(room));
    io.to(code).emit("toast", "Game Over!");
    return;
  }

  room.turnSerial++;
  const serial = room.turnSerial;

  room.currentLetter = randomLetter(room.usedLetters);
  room.usedLetters.push(room.currentLetter);

  // ⏱️ 30 seconds per turn
  room.timerEndTs = Date.now() + 30000;

  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerHandle = setTimeout(() => {
    const r = ROOMS[code];
    if (!r || r.turnSerial !== serial) return; // stale guard
    io.to(code).emit("toast", "Time's up!");
    nextTurn(code);
    io.to(code).emit("roomUpdate", snapshot(r));
  }, 30500); // small buffer

  io.to(code).emit("turnStarted", {
    snapshot: snapshot(room),
    currentPlayerId: currentPlayer(room)?.id
  });
}

function nextTurn(code) {
  const room = ROOMS[code];
  if (!room) return;

  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
  room.turnIndex++;
  startTurn(code);
}

// =============================
//        WATCHDOG (failsafe)
// =============================
// If for any reason a room sits past time-up (e.g., process hiccup),
// nudge it forward automatically.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of Object.entries(ROOMS)) {
    if (room.state === "playing" && room.timerEndTs && now - room.timerEndTs > 1500) {
      // If timer handle somehow gone or stale, push the turn.
      if (!room.timerHandle) {
        io.to(code).emit("toast", "Auto-skip (watchdog).");
        nextTurn(code);
        io.to(code).emit("roomUpdate", snapshot(room));
      }
    }
  }
}, 2000);

// =============================
//          START SERVER
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server live → " + PORT));
