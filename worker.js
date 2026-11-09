import { DurableObject } from 'cloudflare:workers';

const MAX_NAME = 20;
const MAX_ROOM = 32;
const MAX_PLAYERS = 30;
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_ROOM_IMAGES = 32 * 1024 * 1024;
const MAX_SCORE = 99999;
const ROOM_GRACE_MS = 15 * 1000;
const MASTER_GRACE_MS = 30 * 1000;
const PLAYER_GRACE_MS = 10 * 60 * 1000;
const STALE_MS = 90 * 1000;
const PNG_PREFIX = 'data:image/png;base64,';

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

function drop(ws, code) {
  try {
    ws.close(code);
  } catch {
    // すでに閉じている
  }
}

function setImage(room, player, data) {
  room.imageBytes += (data?.length ?? 0) - (player.image?.length ?? 0);
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
  setImage(room, player, null);
  room.players.delete(player.id);
  if (room.masterId === player.id) room.masterId = null;
}

function createRoom() {
  return {
    id: '',
    masterId: null,
    locked: false,
    epoch: 0,
    players: new Map(),
    imageBytes: 0,
    removal: null,
    sweeper: null,
  };
}

function resetRoom(room) {
  clearTimeout(room.removal);
  clearInterval(room.sweeper);
  room.removal = null;
  room.sweeper = null;
  room.masterId = null;
  room.locked = false;
  room.epoch = 0;
  room.players.clear();
  room.imageBytes = 0;
}

// 全員の接続が一斉に切れても、すぐ戻れば部屋が残るように少し待つ
function settle(room) {
  if (room.players.size === 0) {
    resetRoom(room);
    return;
  }
  if (!room.removal && ![...room.players.values()].some((p) => p.ws)) {
    room.removal = setTimeout(() => resetRoom(room), ROOM_GRACE_MS);
  }
  broadcastState(room);
}

function markGone(player, now) {
  player.ws.player = null;
  player.ws = null;
  player.goneAt = now;
}

function sweep(room) {
  const now = Date.now();
  let changed = false;
  for (const p of room.players.values()) {
    if (p.ws && now - p.seenAt > STALE_MS) {
      const { ws } = p;
      markGone(p, now);
      drop(ws, 1011);
      changed = true;
    }
  }
  // 切断したままのマスターは席を空け、部屋が操作不能にならないようにする
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
  if (changed) settle(room);
}

function join(ws, room, msg) {
  if (ws.player) return;
  const name = clean(msg.name, MAX_NAME);
  const token = clean(msg.token, 64);
  if (!name || !token) {
    send(ws, { type: 'error', message: '名前とRoom IDを入力してください' });
    return;
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
      const old = player.ws;
      old.player = null;
      drop(old, 4000);
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
      seenAt: 0,
    };
    room.players.set(player.id, player);
  }

  clearTimeout(room.removal);
  room.removal = null;
  room.sweeper ??= setInterval(() => sweep(room), 5 * 1000);
  player.ws = ws;
  player.goneAt = 0;
  player.seenAt = Date.now();
  ws.player = player;

  send(ws, { type: 'joined', id: player.id, epoch: room.epoch, image: player.image });
  for (const p of room.players.values()) {
    if (p.revealed) send(ws, { type: 'image', id: p.id, data: p.image });
  }
  broadcastState(room);
}

function leave(ws, room) {
  const { player } = ws;
  ws.player = null;
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
      setImage(room, p, null);
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
  if (room.imageBytes + msg.data.length - (me.image?.length ?? 0) > MAX_ROOM_IMAGES) return;
  setImage(room, me, msg.data);
}

function handle(ws, room, msg) {
  if (msg.type === 'join') {
    join(ws, room, msg);
    return;
  }
  const { player: me } = ws;
  if (!me) return;
  me.seenAt = Date.now();

  if (msg.type === 'leave') {
    leave(ws, room);
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

function accept(ws, room) {
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.length > MAX_MESSAGE) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg && typeof msg === 'object') handle(ws, room, msg);
    } catch (err) {
      console.error(err);
    }
  });
  ws.addEventListener('close', () => {
    const { player } = ws;
    if (!player || player.ws !== ws) return;
    markGone(player, Date.now());
    settle(room);
  });
}

// Room ID ごとに1つ作られ、同じ部屋の接続は必ずここに集まる
export class Room extends DurableObject {
  room = createRoom();

  fetch(request) {
    this.room.id = clean(new URL(request.url).searchParams.get('room'), MAX_ROOM);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    accept(server, this.room);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 404 });
    }
    const roomId = clean(url.searchParams.get('room'), MAX_ROOM);
    if (!roomId) return new Response(null, { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
  },
};
