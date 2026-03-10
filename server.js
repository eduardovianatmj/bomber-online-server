const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bomber Online Server OK");
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

const GRID_W = 15;
const GRID_H = 13;
const TILE = 32;
const ROOM_MAX = 6;
const MIN_PLAYERS_TO_START = 2;
const TICK_RATE = 1000 / 20;

const rooms = new Map();

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[randInt(0, chars.length - 1)];
  return code;
}

function createMap(seed = Date.now(), density = 0.58) {
  const map = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(0));

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1) {
        map[y][x] = 1;
      }
    }
  }

  for (let y = 2; y < GRID_H - 1; y += 2) {
    for (let x = 2; x < GRID_W - 1; x += 2) {
      map[y][x] = 1;
    }
  }

  const spawns = [
    [1, 1],
    [GRID_W - 2, 1],
    [1, GRID_H - 2],
    [GRID_W - 2, GRID_H - 2],
    [1, Math.floor(GRID_H / 2)],
    [GRID_W - 2, Math.floor(GRID_H / 2)]
  ];

  const safe = new Set();
  for (const [sx, sy] of spawns) {
    safe.add(`${sx},${sy}`);
    safe.add(`${sx + 1},${sy}`);
    safe.add(`${sx - 1},${sy}`);
    safe.add(`${sx},${sy + 1}`);
    safe.add(`${sx},${sy - 1}`);
  }

  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  for (let y = 1; y < GRID_H - 1; y++) {
    for (let x = 1; x < GRID_W - 1; x++) {
      if (map[y][x] !== 0) continue;
      if (safe.has(`${x},${y}`)) continue;
      if (rnd() < density) map[y][x] = 2;
    }
  }

  return map;
}

function makeRoom(hostSocketId) {
  let code;
  do code = roomCode();
  while (rooms.has(code));

  const room = {
    code,
    hostId: hostSocketId,
    status: "lobby",
    selectedMap: "arena-classic",
    settings: {
      roundsToWin: 3,
      bombFuseMs: 1900,
      breakableDensity: 0.58
    },
    map: createMap(Date.now(), 0.58),
    players: {},
    bombs: [],
    explosions: [],
    powerUps: [],
    createdAt: Date.now(),
    startedAt: null,
    lastTick: Date.now()
  };

  rooms.set(code, room);
  return room;
}

function getSpawnByIndex(index) {
  const spawns = [
    { tx: 1, ty: 1 },
    { tx: GRID_W - 2, ty: 1 },
    { tx: 1, ty: GRID_H - 2 },
    { tx: GRID_W - 2, ty: GRID_H - 2 },
    { tx: 1, ty: Math.floor(GRID_H / 2) },
    { tx: GRID_W - 2, ty: Math.floor(GRID_H / 2) }
  ];
  return spawns[index] || spawns[0];
}

function makePlayer(socketId, name, index, character = "nova") {
  const spawn = getSpawnByIndex(index);
  return {
    id: socketId,
    name: name || `Player ${index + 1}`,
    character,
    x: (spawn.tx + 0.5) * TILE,
    y: (spawn.ty + 0.5) * TILE,
    tx: spawn.tx,
    ty: spawn.ty,
    alive: true,
    speed: 118,
    hitboxW: 18,
    hitboxH: 18,
    input: { up: false, down: false, left: false, right: false, bomb: false },
    bombRange: 2,
    maxBombs: 1,
    shield: 0,
    score: 0,
    color: ["#2563eb", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4"][index % 6],
    lastBombAt: 0
  };
}

function tileAt(room, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return 1;
  return room.map[ty][tx];
}

function isSolid(room, tx, ty) {
  const t = tileAt(room, tx, ty);
  if (t === 1 || t === 2) return true;
  if (room.bombs.some(b => b.tx === tx && b.ty === ty && !b.passable)) return true;
  return false;
}

function rectHitsSolid(room, rx, ry, rw, rh) {
  const left = Math.floor(rx / TILE);
  const right = Math.floor((rx + rw - 1) / TILE);
  const top = Math.floor(ry / TILE);
  const bottom = Math.floor((ry + rh - 1) / TILE);

  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (isSolid(room, tx, ty)) return true;
    }
  }
  return false;
}

function countAlive(room) {
  return Object.values(room.players).filter(p => p.alive).length;
}

function livingPlayers(room) {
  return Object.values(room.players).filter(p => p.alive);
}

function canPlaceBomb(room, player) {
  const owned = room.bombs.filter(b => b.ownerId === player.id).length;
  return owned < player.maxBombs && Date.now() - player.lastBombAt > 250;
}

function placeBomb(room, player) {
  const tx = Math.floor(player.x / TILE);
  const ty = Math.floor(player.y / TILE);

  if (tileAt(room, tx, ty) !== 0) return;
  if (room.bombs.some(b => b.tx === tx && b.ty === ty)) return;
  if (!canPlaceBomb(room, player)) return;

  room.bombs.push({
    id: `${Date.now()}_${Math.random()}`,
    tx,
    ty,
    ownerId: player.id,
    fuse: room.settings?.bombFuseMs || 1900,
    range: player.bombRange,
    createdAt: Date.now(),
    passable: true
  });

  player.lastBombAt = Date.now();
}

function dropPowerUp(room, tx, ty) {
  const roll = Math.random();
  if (roll < 0.18) {
    room.powerUps.push({ tx, ty, type: "range" });
  } else if (roll < 0.28) {
    room.powerUps.push({ tx, ty, type: "shield" });
  }
}

function applyExplosionDamage(room, cells) {
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);

    if (cells.some(c => c.tx === tx && c.ty === ty)) {
      if (p.shield > 0) {
        p.shield -= 1;
      } else {
        p.alive = false;
      }
    }
  }
}

function explodeBomb(room, bomb) {
  const cells = [{ tx: bomb.tx, ty: bomb.ty }];
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 }
  ];

  for (const d of dirs) {
    for (let i = 1; i <= bomb.range; i++) {
      const tx = bomb.tx + d.dx * i;
      const ty = bomb.ty + d.dy * i;
      const tile = tileAt(room, tx, ty);

      if (tile === 1) break;

      cells.push({ tx, ty });

      if (tile === 2) {
        room.map[ty][tx] = 0;
        dropPowerUp(room, tx, ty);
        break;
      }
    }
  }

  room.explosions.push({
    cells,
    createdAt: Date.now(),
    duration: 550
  });

  applyExplosionDamage(room, cells);

  for (const other of room.bombs) {
    if (other.id === bomb.id) continue;
    if (cells.some(c => c.tx === other.tx && c.ty === other.ty)) {
      other.fuse = Math.min(other.fuse, 80);
    }
  }
}

function pickupPowerUps(room) {
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);

    const idx = room.powerUps.findIndex(pp => pp.tx === tx && pp.ty === ty);
    if (idx >= 0) {
      const item = room.powerUps[idx];
      if (item.type === "range") p.bombRange = Math.min(6, p.bombRange + 1);
      if (item.type === "shield") p.shield = Math.min(2, p.shield + 1);
      room.powerUps.splice(idx, 1);
    }
  }
}

function updatePlayers(room, dt) {
  for (const player of Object.values(room.players)) {
    if (!player.alive) continue;

    const input = player.input;
    let dx = 0;
    let dy = 0;

    if (input.left) dx -= 1;
    if (input.right) dx += 1;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;

    if (dx !== 0 && dy !== 0) {
      dx *= 0.7071;
      dy *= 0.7071;
    }

    const vx = dx * player.speed;
    const vy = dy * player.speed;

    const halfW = player.hitboxW / 2;
    const halfH = player.hitboxH / 2;

    let nx = player.x + vx * dt;
    let ny = player.y + vy * dt;

    if (vx !== 0) {
      const rx = nx - halfW;
      const ry = player.y - halfH;
      if (rectHitsSolid(room, rx, ry, player.hitboxW, player.hitboxH)) {
        nx = player.x;
      }
    }

    if (vy !== 0) {
      const rx = nx - halfW;
      const ry = ny - halfH;
      if (rectHitsSolid(room, rx, ry, player.hitboxW, player.hitboxH)) {
        ny = player.y;
      }
    }

    player.x = clamp(nx, TILE * 0.5, GRID_W * TILE - TILE * 0.5);
    player.y = clamp(ny, TILE * 0.5, GRID_H * TILE - TILE * 0.5);

    player.tx = Math.floor(player.x / TILE);
    player.ty = Math.floor(player.y / TILE);

    if (input.bomb) {
      placeBomb(room, player);
      player.input.bomb = false;
    }
  }
}

function updateBombPassability(room) {
  for (const bomb of room.bombs) {
    const owner = room.players[bomb.ownerId];
    if (!owner || !owner.alive) {
      bomb.passable = false;
      continue;
    }
    const sameTile = Math.floor(owner.x / TILE) === bomb.tx && Math.floor(owner.y / TILE) === bomb.ty;
    if (!sameTile) bomb.passable = false;
  }
}

function updateBombs(room, deltaMs) {
  for (let i = room.bombs.length - 1; i >= 0; i--) {
    const bomb = room.bombs[i];
    bomb.fuse -= deltaMs;
    if (bomb.fuse <= 0) {
      explodeBomb(room, bomb);
      room.bombs.splice(i, 1);
    }
  }
}

function updateExplosions(room) {
  for (let i = room.explosions.length - 1; i >= 0; i--) {
    const ex = room.explosions[i];
    if (Date.now() - ex.createdAt >= ex.duration) {
      room.explosions.splice(i, 1);
    }
  }
}

function maybeFinishMatch(room) {
  if (room.status !== "playing") return;
  const alive = livingPlayers(room);
  if (alive.length <= 1) {
    room.status = "finished";
    if (alive[0]) alive[0].score += 1;
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    selectedMap: room.selectedMap,
    settings: room.settings,
    map: room.map,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      character: p.character,
      x: p.x,
      y: p.y,
      tx: p.tx,
      ty: p.ty,
      alive: p.alive,
      bombRange: p.bombRange,
      shield: p.shield,
      score: p.score,
      color: p.color
    })),
    bombs: room.bombs.map(b => ({
      tx: b.tx,
      ty: b.ty,
      fuse: b.fuse,
      ownerId: b.ownerId
    })),
    explosions: room.explosions.map(ex => ({
      cells: ex.cells,
      createdAt: ex.createdAt,
      duration: ex.duration
    })),
    powerUps: room.powerUps,
    canStart: Object.keys(room.players).length >= MIN_PLAYERS_TO_START
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", serializeRoom(room));
}

function resetMatch(room) {
  room.status = "playing";
  room.map = createMap(Date.now(), room.settings?.breakableDensity || 0.58);
  room.bombs = [];
  room.explosions = [];
  room.powerUps = [];
  room.startedAt = Date.now();

  const ids = Object.keys(room.players);
  ids.forEach((id, index) => {
    const current = room.players[id];
    const fresh = makePlayer(id, current.name, index, current.character || "nova");
    fresh.score = current.score;
    room.players[id] = fresh;
  });
}

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    const deltaMs = now - room.lastTick;
    room.lastTick = now;
    const dt = Math.min(0.05, deltaMs / 1000);

    if (room.status === "playing") {
      updatePlayers(room, dt);
      updateBombPassability(room);
      updateBombs(room, deltaMs);
      updateExplosions(room);
      pickupPowerUps(room);
      maybeFinishMatch(room);
    }

    broadcastRoom(room);
  }
}, TICK_RATE);

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, character, selectedMap, settings }) => {
    const room = makeRoom(socket.id);

    if (selectedMap) room.selectedMap = selectedMap;
    if (settings) {
      room.settings = {
        ...room.settings,
        ...settings
      };
    }

    room.players[socket.id] = makePlayer(
      socket.id,
      name || "Host",
      0,
      character || "nova"
    );

    socket.join(room.code);

    socket.emit("room:joined", {
      roomCode: room.code,
      playerId: socket.id,
      host: true
    });

    broadcastRoom(room);
  });

  socket.on("room:join", ({ roomCode, name, character }) => {
    const room = rooms.get((roomCode || "").toUpperCase());

    if (!room) {
      socket.emit("error:message", "Sala não encontrada.");
      return;
    }

    if (Object.keys(room.players).length >= ROOM_MAX) {
      socket.emit("error:message", "Sala cheia.");
      return;
    }

    if (room.status === "playing") {
      socket.emit("error:message", "A partida já começou.");
      return;
    }

    const index = Object.keys(room.players).length;
    room.players[socket.id] = makePlayer(
      socket.id,
      name || `Player ${index + 1}`,
      index,
      character || "nova"
    );

    socket.join(room.code);

    socket.emit("room:joined", {
      roomCode: room.code,
      playerId: socket.id,
      host: room.hostId === socket.id
    });

    broadcastRoom(room);
  });

  socket.on("room:update-config", ({ roomCode, selectedMap, settings, character }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    if (character) {
      player.character = character;
    }

    if (room.hostId === socket.id) {
      if (selectedMap) room.selectedMap = selectedMap;
      if (settings) {
        room.settings = {
          ...room.settings,
          ...settings
        };
      }
    }

    broadcastRoom(room);
  });

  socket.on("room:start", ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < MIN_PLAYERS_TO_START) return;

    resetMatch(room);
    broadcastRoom(room);
  });

  socket.on("room:restart", ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    resetMatch(room);
    broadcastRoom(room);
  });

  socket.on("player:input", ({ roomCode, input }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    player.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
      bomb: !!input.bomb
    };
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        if (room.hostId === socket.id) {
          room.hostId = Object.keys(room.players)[0] || null;
        }

        if (Object.keys(room.players).length === 0) {
          rooms.delete(code);
        } else {
          if (room.status === "playing" && countAlive(room) <= 1) {
            room.status = "finished";
          }
          broadcastRoom(room);
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bomber Online Server rodando na porta ${PORT}`);
});
