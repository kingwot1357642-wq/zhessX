const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 256 * 1024 });
// HTML must never be served from a stale browser cache (mobile Chrome keeps old copies); images may be cached briefly.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, must-revalidate");
    else res.setHeader("Cache-Control", "public, max-age=300");
  }
}));
app.get("/health", (_req, res) => res.json({ ok: true, service: "Board Arena" }));

// room = { slots: [socketIdOrNull, socketIdOrNull], picks: [picksOrNull, picksOrNull], gameStarted }
// slot 0 = Player 1 (team 0), slot 1 = Player 2 (team 1). The slot never changes while a player stays in the room.
const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const POPULATION = { sword: 2, archer: 2, mage: 3, shield: 2, meric: 3, assassin: 3, witch: 3, redscales: 5, jugger: 4 };

function makeCode() {
  let code;
  do { code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
const getSocket = id => (id ? io.sockets.sockets.get(id) : null);
const memberIds = room => room.slots.filter(Boolean);
function roomPlayers(room) {
  return room.slots.map(id => {
    const s = getSocket(id);
    return s ? { ready: !!s.data.ready, selected: !!s.data.selected } : null;
  });
}
function emitRoom(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("room_update", { roomCode: code, players: roomPlayers(room) });
}
function resetPlayerFlags(socket) {
  socket.data.ready = false; socket.data.selected = false; socket.data.rematch = false;
}
function removeFromRoom(socket, notify = true) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null; socket.data.playerNumber = 0; resetPlayerFlags(socket);
  if (!room) return;
  room.slots = room.slots.map(id => (id === socket.id ? null : id));
  const remaining = memberIds(room);
  if (!remaining.length) { rooms.delete(code); return; }
  // Whoever stays goes back to the waiting state; the match (if any) is over.
  room.gameStarted = false; room.picks = [null, null];
  remaining.forEach(id => { const s = getSocket(id); if (s) resetPlayerFlags(s); });
  if (notify) io.to(code).emit("player_left");
  emitRoom(code);
}

io.on("connection", socket => {
  socket.data.roomCode = null; socket.data.playerNumber = 0; resetPlayerFlags(socket);

  socket.on("create_room", () => {
    if (socket.data.roomCode) removeFromRoom(socket);
    const roomCode = makeCode(), room = { slots: [socket.id, null], picks: [null, null], gameStarted: false };
    rooms.set(roomCode, room); socket.join(roomCode); socket.data.roomCode = roomCode;
    socket.data.playerNumber = 1; resetPlayerFlags(socket);
    socket.emit("room_created", { roomCode, playerNumber: 1, players: roomPlayers(room) });
  });

  socket.on("join_room", payload => {
    const roomCode = String(payload?.roomCode || "").trim().toUpperCase(), room = rooms.get(roomCode);
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode) || !room) return socket.emit("room_error", { message: "ไม่พบห้องนี้ กรุณาตรวจสอบรหัสห้อง" });
    if (socket.data.roomCode === roomCode) return socket.emit("room_error", { message: "คุณอยู่ในห้องนี้อยู่แล้ว" });
    const slot = room.slots.indexOf(null);
    if (slot < 0 || room.gameStarted) return socket.emit("room_error", { message: "ห้องนี้มีผู้เล่นครบหรือเริ่มเกมแล้ว" });
    if (socket.data.roomCode) removeFromRoom(socket);
    room.slots[slot] = socket.id; socket.join(roomCode); socket.data.roomCode = roomCode;
    socket.data.playerNumber = slot + 1; resetPlayerFlags(socket);
    socket.emit("room_joined", { roomCode, playerNumber: slot + 1, players: roomPlayers(room) });
    emitRoom(roomCode);
  });

  socket.on("set_ready", payload => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!code || payload?.roomCode !== code || !room || room.gameStarted) return;
    socket.data.ready = true; emitRoom(code);
  });

  socket.on("submit_pick", payload => {
    const code = socket.data.roomCode, room = rooms.get(code), picks = payload?.picks;
    if (!code || payload?.roomCode !== code || !room || memberIds(room).length !== 2 || !socket.data.ready || room.gameStarted) return;
    const index = room.slots.indexOf(socket.id);
    if (index < 0 || room.picks[index]) return;
    const valid = Array.isArray(picks) && picks.length >= 1 && picks.every(k => Object.prototype.hasOwnProperty.call(POPULATION, k)) && new Set(picks).size === picks.length && picks.reduce((sum, k) => sum + POPULATION[k], 0) <= 15;
    if (!valid) return socket.emit("room_error", { message: "ชุดตัวละครไม่ถูกต้อง หรือ Population เกิน 15 กรุณาเลือกใหม่" });
    room.picks[index] = picks; socket.data.selected = true; emitRoom(code);
    if (room.picks.every(Boolean)) {
      room.gameStarted = true;
      io.to(code).emit("game_start", { picks: room.picks, firstTurn: Math.random() < 0.5 ? 0 : 1 });
    }
  });

  socket.on("game_state", payload => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!code || payload?.roomCode !== code || !room?.gameStarted || room.slots.indexOf(socket.id) < 0) return;
    const state = payload.state;
    if (!state || !Array.isArray(state.U) || !Array.isArray(state.P) || ![0, 1].includes(state.turn)) return;
    // Relay the latest game snapshot (and the visual effects that produced it) to the opponent; never echo it to its sender.
    socket.to(code).emit("game_state", { state });
  });

  // Both players must ask for a rematch; then everyone goes back to the roster selection (still ready).
  socket.on("request_rematch", payload => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!code || payload?.roomCode !== code || !room || !room.gameStarted || memberIds(room).length !== 2) return;
    socket.data.rematch = true;
    socket.to(code).emit("rematch_requested");
    const ids = memberIds(room);
    if (ids.every(id => getSocket(id)?.data.rematch)) {
      room.gameStarted = false; room.picks = [null, null];
      ids.forEach(id => { const s = getSocket(id); if (s) { s.data.rematch = false; s.data.selected = false; } });
      emitRoom(code);
      io.to(code).emit("rematch_start");
    }
  });

  socket.on("leave_room", () => removeFromRoom(socket));
  socket.on("disconnect", () => removeFromRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Board Arena server listening on ${PORT}`));
