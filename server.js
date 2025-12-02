const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// Health checks for Render
app.get("/__health", (_, res) => res.send("ok"));
app.get("/__version", (_, res) => res.send("v10-ai-india"));

// =============================
//      LOAD DICTIONARIES
// =============================
function loadDict(name) {
  try {
    const data = fs.readFileSync(__dirname + `/public/dict/${name}.json`, "utf8");
    return JSON.parse(data).map(w => w.toLowerCase());
  } catch (err) {
    console.error(`⚠️ Missing dictionary: ${name}`);
    return [];
  }
}

const WORD_LIST = loadDict("words");      // 30,000 english words
const NAMES     = loadDict("names");      // Indian + global names
const ANIMALS   = loadDict("animals");    // India animals
const PLACES    = loadDict("places");     // India cities/states
const MOVIES    = loadDict("movies");     // India movies
const THINGS    = loadDict("things");     // common nouns

console.log("Loaded Dictionaries:");
console.log({
  words: WORD_LIST.length,
  names: NAMES.length,
  animals: ANIMALS.length,
  places: PLACES.length,
  movies: MOVIES.length,
  things: THINGS.length
});

// =============================
//   AI STYLE VALIDATION
// =============================

function looksAIRealWord(w) {
  const t = w.toLowerCase();

  // must have vowel unless Indian name
  if (!/[aeiou]/.test(t) && !NAMES.includes(t)) return false;

  // block crazy clusters like “bhjtr”
  if (/[bcdfghjklmnpqrstvwxyz]{4,}/.test(t) && !NAMES.includes(t)) return false;

  // weird patterns
  const rare = ["qj","xv","zx","jj","kk","fq","jh","kjh","xq","pz"];
  if (rare.some(x => t.includes(x))) return false;

  // reject > 3 repeats
  if (/(.)\1\1/.test(t)) return false;

  return true;
}

function validateCategory(word, letter, cat) {
  if (!word) return false;

  const t = word.trim().toLowerCase();
  if (!t || t.length < 2) return false;

  // must start with the letter
  if (t[0] !== letter.toLowerCase()) return false;

  // only letters/spaces
  if (!/^[a-z ]+$/.test(t)) return false;

  // CATEGORY DICTIONARIES
  if (cat === "name")   return NAMES.includes(t);
  if (cat === "animal") return ANIMALS.includes(t);
  if (cat === "place")  return PLACES.includes(t);
  if (cat === "movie")  return MOVIES.includes(t);

  // THING = english dictionary + things.json
  if (!WORD_LIST.includes(t) && !THINGS.includes(t)) return false;

  // AI-style check
  return looksAIRealWord(t);
}

// =============================
//  GAME STATE + HELPERS
// =============================
const ROOMS = {};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function randomLetter(used) {
  const avail = LETTERS.filter(l => !used.includes(l));
  return avail.length ? avail[Math.floor(Math.random() * avail.length)]
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
    if (cp.id !== socket.id) return; // only current player

    const L = room.currentLetter;

    const ok =
      validateCategory(answers.name,   L, "name")   &&
      validateCategory(answers.place,  L, "place")  &&
      validateCategory(answers.animal, L, "animal") &&
      validateCategory(answers.thing,  L, "thing")  &&
      validateCategory(answers.movie,  L, "movie");

    if (!ok) {
      socket.emit("errorMsg", "Invalid entries! Use real Indian/English words.");
      return;
    }

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
  room.timerEndTs = Date.now() + 60000;

  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerHandle = setTimeout(() => {
    const r = ROOMS[code];
    if (!r || r.turnSerial !== serial) return;
    io.to(code).emit("toast", "Time's up!");
    nextTurn(code);
  }, 60500);

  io.to(code).emit("turnStarted", {
    snapshot: snapshot(room),
    currentPlayerId: currentPlayer(room)?.id
  });
}

function nextTurn(code) {
  const room = ROOMS[code];
  if (!room) return;

  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.turnIndex++;
  startTurn(code);
}

// =============================
//          START SERVER
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Server live → " + PORT)
);

