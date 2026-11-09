const MAX_NAME = 20;
const MAX_ROOM = 32;
const MAX_ROOMS = 100;
const MAX_PLAYERS = 30;
const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_IMAGE = 7 * 1024 * 1024;
const MAX_TOTAL_IMAGES = 256 * 1024 * 1024;
const MAX_SCORE = 99999;
const ROOM_GRACE_MS = 15 * 1000;
const MASTER_GRACE_MS = 30 * 1000;
const PLAYER_GRACE_MS = 10 * 60 * 1000;
const PNG_PREFIX = 'data:image/png;base64,';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/easel.js': ['easel.js', 'text/javascript; charset=utf-8'],
  '/sound.js': ['sound.js', 'text/javascript; charset=utf-8'],
};

const rooms = new Map();
let imageBytes = 0;

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}]/gu, '').trim().slice(0, max);
}

function clampScore(n) {
  return Math.min(MAX_SCORE, Math.max(-MAX_SCORE, n));
}

function send(ws, msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const text = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(text);
  }
}

function broadcastState(room) {
  broadcast(room, {
    type: 'state',
    room: room.id,
    masterId: room.masterId,
    locked: room.locked,
    epoch: room.epoch,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      revealed: p.revealed,
      judgement: p.judgement,
      online: Boolean(p.ws),
    })),
  });
}

function setImage(player, data) {
  imageBytes += (data?.length ?? 0) - (player.image?.length ?? 0);
  player.image = data;
}

// 画像は公開された瞬間に初めて他の参加者へ送る
function setRevealed(room, player, revealed) {
  if (player.revealed === revealed) return;
  player.revealed = revealed;
  if (revealed) {
    broadcast(room, { type: 'image', id: player.id, data: player.image });
  } else {
    player.judgement = null;
  }
}

function playersOf(room) {
  return [...room.players.values()].filter((p) => p.id !== room.masterId);
}

function removePlayer(room, player) {
  setImage(player, null);
  room.players.delete(player.id);
  if (room.masterId === player.id) room.masterId = null;
}

function deleteRoom(room) {
  clearTimeout(room.removal);
  for (const p of room.players.values()) setImage(p, null);
  rooms.delete(room.id);
}

// 全員の接続が一斉に切れても、すぐ戻れば部屋が残るように少し待つ
function settle(room) {
  if (room.players.size === 0) {
    deleteRoom(room);
    return;
  }
  if (!room.removal && ![...room.players.values()].some((p) => p.ws)) {
    room.removal = setTimeout(() => deleteRoom(room), ROOM_GRACE_MS);
  }
  broadcastState(room);
}

function join(ws, msg) {
  if (ws.player) return;
  const name = clean(msg.name, MAX_NAME);
  const roomId = clean(msg.room, MAX_ROOM);
  const token = clean(msg.token, 64);
  if (!name || !roomId || !token) {
    send(ws, { type: 'error', message: '名前とRoom IDを入力してください' });
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) {
      send(ws, { type: 'error', message: '部屋がいっぱいです' });
      return;
    }
    room = { id: roomId, masterId: null, locked: false, epoch: 0, players: new Map(), removal: null };
    rooms.set(roomId, room);
  }

  const everyone = [...room.players.values()];
  if (everyone.some((p) => p.name === name && p.token !== token && p.ws)) {
    send(ws, { type: 'error', message: 'その名前は使われています' });
    return;
  }

  // 切断中の同名の席は引き継ぐ（タブを閉じても点数が消えないように）
  let player = everyone.find((p) => p.token === token) ?? everyone.find((p) => p.name === name);
  if (player) {
    if (player.ws && player.ws !== ws) {
      player.ws.player = null;
      player.ws.close(4000);
    }
    player.token = token;
    player.name = name;
  } else {
    if (room.players.size >= MAX_PLAYERS) {
      const gone = everyone.find((p) => !p.ws);
      if (!gone) {
        send(ws, { type: 'error', message: 'この部屋は満員です' });
        return;
      }
      removePlayer(room, gone);
    }
    player = {
      id: crypto.randomUUID(),
      token,
      name,
      score: 0,
      image: null,
      revealed: false,
      judgement: null,
      ws: null,
      goneAt: 0,
    };
    room.players.set(player.id, player);
  }

  clearTimeout(room.removal);
  room.removal = null;
  player.ws = ws;
  player.goneAt = 0;
  ws.player = player;
  ws.room = room;

  send(ws, { type: 'joined', id: player.id, epoch: room.epoch, image: player.image });
  for (const p of room.players.values()) {
    if (p.revealed) send(ws, { type: 'image', id: p.id, data: p.image });
  }
  broadcastState(room);
}

function leave(ws) {
  const { room, player } = ws;
  if (!player) return;
  ws.player = null;
  ws.room = null;
  removePlayer(room, player);
  settle(room);
}

const playerActions = {
  flip(room, me, msg) {
    if (room.locked && room.masterId !== me.id) return;
    setRevealed(room, me, Boolean(msg.revealed));
  },
  claimMaster(room, me) {
    if (!room.masterId) room.masterId = me.id;
  },
  releaseMaster(room, me) {
    if (room.masterId === me.id) room.masterId = null;
  },
};

const masterActions = {
  flipOne(room, me, msg) {
    const target = room.players.get(msg.id);
    if (target) setRevealed(room, target, Boolean(msg.revealed));
  },
  flipAll(room, me, msg) {
    for (const p of playersOf(room)) setRevealed(room, p, Boolean(msg.revealed));
  },
  setLocked(room, me, msg) {
    room.locked = Boolean(msg.locked);
  },
  resetFlips(room) {
    room.epoch += 1;
    for (const p of room.players.values()) {
      setImage(p, null);
      p.revealed = false;
      p.judgement = null;
    }
  },
  judge(room, me, msg) {
    const correct = new Set(Array.isArray(msg.correct) ? msg.correct : []);
    for (const p of playersOf(room)) {
      p.judgement = p.revealed ? (correct.has(p.id) ? 'correct' : 'wrong') : null;
    }
  },
  clearJudge(room) {
    for (const p of room.players.values()) p.judgement = null;
  },
  score(room, me, msg) {
    const target = room.players.get(msg.id);
    if (!target) return;
    if (Number.isInteger(msg.delta)) target.score = clampScore(target.score + msg.delta);
    else if (Number.isInteger(msg.value)) target.score = clampScore(msg.value);
  },
  resetScores(room) {
    for (const p of room.players.values()) p.score = 0;
  },
};

function receiveImage(ws, room, me, msg) {
  if (msg.epoch !== room.epoch) return;
  if (me.revealed) {
    send(ws, { type: 'restore', data: me.image });
    return;
  }
  if (typeof msg.data !== 'string' || !msg.data.startsWith(PNG_PREFIX) || msg.data.length > MAX_IMAGE) return;
  if (imageBytes + msg.data.length - (me.image?.length ?? 0) > MAX_TOTAL_IMAGES) return;
  setImage(me, msg.data);
}

function handle(ws, msg) {
  if (msg.type === 'join') {
    join(ws, msg);
    return;
  }
  const { room, player: me } = ws;
  if (!me) return;

  if (msg.type === 'leave') {
    leave(ws);
  } else if (msg.type === 'image') {
    receiveImage(ws, room, me, msg);
  } else if (msg.type === 'sound') {
    if (room.masterId === me.id && (msg.kind === 'correct' || msg.kind === 'wrong')) {
      broadcast(room, { type: 'sound', kind: msg.kind });
    }
  } else if (Object.hasOwn(playerActions, msg.type)) {
    playerActions[msg.type](room, me, msg);
    broadcastState(room);
  } else if (Object.hasOwn(masterActions, msg.type) && room.masterId === me.id) {
    masterActions[msg.type](room, me, msg);
    broadcastState(room);
  }
}

function accept(ws) {
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.length > MAX_MESSAGE) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg && typeof msg === 'object') handle(ws, msg);
    } catch (err) {
      console.error(err);
    }
  });
  ws.addEventListener('close', () => {
    const { room, player } = ws;
    if (!player || player.ws !== ws) return;
    player.ws = null;
    player.goneAt = Date.now();
    settle(room);
  });
}

// 切断したままのマスターは席を空け、部屋が操作不能にならないようにする
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    const master = room.players.get(room.masterId);
    if (master && !master.ws && now - master.goneAt > MASTER_GRACE_MS) {
      room.masterId = null;
      changed = true;
    }
    for (const p of room.players.values()) {
      if (!p.ws && now - p.goneAt > PLAYER_GRACE_MS) {
        removePlayer(room, p);
        changed = true;
      }
    }
    if (changed) broadcastState(room);
  }
}, 5 * 1000);

async function serve(req) {
  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    accept(socket);
    return response;
  }
  const path = new URL(req.url).pathname;
  if (!Object.hasOwn(STATIC, path)) return new Response(null, { status: 404 });
  const [file, type] = STATIC[path];
  const body = await Deno.readFile(new URL(`./public/${file}`, import.meta.url));
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
}

const port = Deno.env.get('PORT');
Deno.serve(port ? { port: Number(port) } : {}, serve);
