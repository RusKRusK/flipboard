import { Easel } from './easel.js';
import { unlockAudio, playSound, setVolume } from './sound.js';

const $ = (id) => document.getElementById(id);

const PALETTE = ['#111111', '#e0312b', '#2368d8', '#1f9d4d', '#f08a00', '#8a3fc7', '#7a4a21', '#dddddd'];
const SESSION_KEY = 'flipboard.session';
const NAME_KEY = 'flipboard.name';
const VOLUME_KEY = 'flipboard.volume';

let ws = null;
let session = readSession();
let myId = null;
let state = null;
let epoch = null;
let seated = false;

const images = new Map();
const tiles = new Map();
const checked = new Set();
const swatches = [];

const easel = new Easel({
  canvas: $('canvas'),
  brush: $('brush'),
  onChange: (data) => {
    send({ type: 'image', data, epoch });
    refreshTiles();
  },
  onHistory: renderTools,
});

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function writeSession(value) {
  session = value;
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(SESSION_KEY);
}

// crypto.randomUUID は http の LAN アドレスでは使えない
function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendJoin() {
  if (session) send({ type: 'join', ...session });
}

function connect() {
  if (!session || (ws && ws.readyState <= WebSocket.OPEN)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws?room=${encodeURIComponent(session.room)}`);
  ws = socket;
  socket.onopen = () => {
    $('net').hidden = true;
    sendJoin();
  };
  socket.onmessage = (e) => receive(JSON.parse(e.data));
  socket.onclose = (e) => {
    if (socket !== ws) return;
    if (e.code === 4000) {
      backToLogin();
    } else if (!seated) {
      backToLogin('接続できませんでした');
    } else {
      $('net').hidden = false;
      setTimeout(connect, 1000);
    }
  };
}

function receive(msg) {
  switch (msg.type) {
    case 'joined':
      onJoined(msg);
      break;
    case 'image':
      if (msg.data) images.set(msg.id, msg.data);
      else images.delete(msg.id);
      refreshTiles();
      break;
    case 'restore':
      easel.load(msg.data);
      break;
    case 'state':
      render(msg);
      break;
    case 'sound':
      playSound(msg.kind);
      break;
    case 'error':
      backToLogin(msg.message);
      break;
  }
}

function onJoined(msg) {
  myId = msg.id;
  // 同じページのままの再接続なら、手元の絵のほうが新しい
  if (seated && msg.epoch === epoch) {
    send({ type: 'image', data: easel.current, epoch });
  } else {
    easel.load(msg.image);
  }
  epoch = msg.epoch;
  seated = true;
  history.replaceState(null, '', `?room=${encodeURIComponent(session.room)}`);
  $('login').hidden = true;
  $('room').hidden = false;
}

function backToLogin(message = '') {
  const socket = ws;
  ws = null;
  socket?.close();
  writeSession(null);
  seated = false;
  state = null;
  myId = null;
  epoch = null;
  images.clear();
  checked.clear();
  tiles.forEach((t) => t.el.remove());
  tiles.clear();
  easel.load(null);
  $('login-error').textContent = message;
  $('room').hidden = true;
  $('login').hidden = false;
}

function render(s) {
  if (s.epoch !== epoch) {
    epoch = s.epoch;
    easel.load(null);
    checked.clear();
    images.clear();
  }
  state = s;
  const me = s.players.find((p) => p.id === myId);
  if (!me) return;
  const isMaster = s.masterId === myId;
  if (!isMaster) checked.clear();

  $('room-id').textContent = s.room;
  $('master').hidden = !isMaster;
  $('lock').checked = s.locked;

  const masterBtn = $('master-btn');
  const masterPlayer = s.players.find((p) => p.id === s.masterId);
  masterBtn.disabled = Boolean(masterPlayer) && !isMaster;
  masterBtn.textContent = isMaster ? 'マスターを降りる' : masterPlayer ? `マスター: ${masterPlayer.name}` : 'マスターになる';

  easel.setLocked(me.revealed);
  $('tools').disabled = me.revealed;
  $('live').hidden = !me.revealed;
  if (me.judgement) $('surface').dataset.j = me.judgement;
  else delete $('surface').dataset.j;

  const canFlip = isMaster || !s.locked;
  const flipBtn = $('flip-btn');
  flipBtn.disabled = !canFlip;
  flipBtn.classList.toggle('open', me.revealed);
  flipBtn.innerHTML = '';
  flipBtn.append(canFlip ? (me.revealed ? '非公開にする' : '公開する') : '公開禁止中');
  if (canFlip) {
    const key = document.createElement('kbd');
    key.textContent = 'F';
    flipBtn.append(key);
  }

  // マスターでなくなったら、裏向きの絵は手元にも残さない
  if (!isMaster) {
    for (const p of s.players) if (!p.revealed) images.delete(p.id);
  }
  renderTiles(s, isMaster);
}

function refreshTiles() {
  if (state) renderTiles(state, state.masterId === myId);
}

function createTile(id) {
  const el = $('tile-tmpl').content.firstElementChild.cloneNode(true);
  const q = (selector) => el.querySelector(selector);
  const tile = {
    el,
    front: q('.front'),
    img: q('.front img'),
    peek: q('.back img'),
    name: q('.name'),
    role: q('.role'),
    score: q('.score'),
    adjust: q('.adjust'),
    ctl: q('.ctl'),
    ok: q('.ok'),
    toggle: q('.toggle'),
    pts: q('.pts'),
    revealed: false,
  };
  tile.ok.addEventListener('change', () => {
    if (tile.ok.checked) checked.add(id);
    else checked.delete(id);
  });
  tile.toggle.addEventListener('click', () => send({ type: 'flipOne', id, revealed: !tile.revealed }));
  q('.minus').addEventListener('click', () => send({ type: 'score', id, delta: -1 }));
  q('.plus').addEventListener('click', () => send({ type: 'score', id, delta: 1 }));
  tile.pts.addEventListener('change', () => {
    const value = Number(tile.pts.value);
    if (Number.isInteger(value)) send({ type: 'score', id, value });
  });
  $('tiles').append(el);
  tiles.set(id, tile);
  return tile;
}

function renderTiles(s, isMaster) {
  const alive = new Set(s.players.map((p) => p.id));
  for (const [id, tile] of tiles) {
    if (!alive.has(id)) {
      tile.el.remove();
      tiles.delete(id);
      images.delete(id);
      checked.delete(id);
    }
  }

  for (const p of s.players) {
    const tile = tiles.get(p.id) ?? createTile(p.id);
    const editable = isMaster && p.id !== myId;
    tile.revealed = p.revealed;
    tile.el.classList.toggle('revealed', p.revealed);
    tile.el.classList.toggle('me', p.id === myId);
    tile.el.classList.toggle('off', !p.online);

    if (p.judgement) tile.front.dataset.j = p.judgement;
    else delete tile.front.dataset.j;

    const data = p.id === myId ? easel.current : images.get(p.id);
    const src = p.revealed ? data : null;
    tile.img.hidden = !src;
    if (src && tile.img.getAttribute('src') !== src) tile.img.src = src;
    // マスターだけは裏面に薄く絵が見える
    const peek = isMaster && !p.revealed ? data : null;
    tile.peek.hidden = !peek;
    if (peek && tile.peek.getAttribute('src') !== peek) tile.peek.src = peek;

    tile.name.textContent = p.name;
    tile.role.hidden = p.id !== s.masterId;
    tile.score.textContent = p.score;
    tile.score.hidden = editable;
    tile.adjust.hidden = !editable;

    tile.ctl.hidden = !editable;
    tile.ok.checked = checked.has(p.id);
    tile.toggle.textContent = p.revealed ? '非公開' : '公開';
    if (document.activeElement !== tile.pts) tile.pts.value = p.score;
  }
}

function renderTools() {
  $('tool-pen').setAttribute('aria-pressed', easel.tool === 'pen');
  $('tool-eraser').setAttribute('aria-pressed', easel.tool === 'eraser');
  for (const s of swatches) s.setAttribute('aria-pressed', s.dataset.color === easel.color);
  const range = $('width');
  range.value = easel.width;
  $('undo').disabled = !easel.canUndo;
  $('redo').disabled = !easel.canRedo;
}

function setTool(tool) {
  easel.tool = tool;
  renderTools();
}

function setColor(color) {
  easel.color = color;
  easel.tool = 'pen';
  renderTools();
}

function nudgeWidth(direction) {
  const step = Math.max(1, Math.round(easel.width * 0.2));
  easel.width = Math.min(120, Math.max(1, easel.width + direction * step));
  renderTools();
}

function toggleOwnFlip() {
  const me = state?.players.find((p) => p.id === myId);
  if (me && !$('flip-btn').disabled && !easel.drawing) send({ type: 'flip', revealed: !me.revealed });
}

for (const color of PALETTE) {
  const swatch = document.createElement('button');
  swatch.className = 'swatch';
  swatch.style.background = color;
  swatch.dataset.color = color;
  swatch.setAttribute('aria-label', color);
  swatch.addEventListener('click', () => setColor(color));
  swatches.push(swatch);
  $('swatches').append(swatch);
}

$('tool-pen').addEventListener('click', () => setTool('pen'));
$('tool-eraser').addEventListener('click', () => setTool('eraser'));
$('width').addEventListener('input', (e) => {
  easel.width = Number(e.target.value);
});
$('undo').addEventListener('click', () => easel.undo());
$('redo').addEventListener('click', () => easel.redo());
$('clear').addEventListener('click', () => easel.clear());
$('flip-btn').addEventListener('click', toggleOwnFlip);

$('volume').addEventListener('input', (e) => {
  setVolume(Number(e.target.value));
  localStorage.setItem(VOLUME_KEY, e.target.value);
});
$('volume').addEventListener('change', () => playSound('correct'));

$('master-btn').addEventListener('click', () => {
  send({ type: state.masterId === myId ? 'releaseMaster' : 'claimMaster' });
});
$('leave').addEventListener('click', () => {
  send({ type: 'leave' });
  backToLogin();
});

$('all-open').addEventListener('click', () => send({ type: 'flipAll', revealed: true }));
$('all-close').addEventListener('click', () => send({ type: 'flipAll', revealed: false }));
$('reset-flips').addEventListener('click', () => {
  if (confirm('全員のフリップをリセットしますか？')) send({ type: 'resetFlips' });
});
$('lock').addEventListener('change', (e) => send({ type: 'setLocked', locked: e.target.checked }));
$('judge').addEventListener('click', () => send({ type: 'judge', correct: [...checked] }));
$('clear-judge').addEventListener('click', () => send({ type: 'clearJudge' }));
$('snd-question').addEventListener('click', () => send({ type: 'sound', kind: 'question' }));
$('snd-question2').addEventListener('click', () => send({ type: 'sound', kind: 'question2' }));
$('snd-correct').addEventListener('click', () => send({ type: 'sound', kind: 'correct' }));
$('snd-wrong').addEventListener('click', () => send({ type: 'sound', kind: 'wrong' }));
$('reset-scores').addEventListener('click', () => {
  if (confirm('全員の点数をリセットしますか？')) send({ type: 'resetScores' });
});

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  const name = $('login-name').value.trim();
  const room = $('login-room').value.trim();
  if (!name || !room) return;
  localStorage.setItem(NAME_KEY, name);
  $('login-error').textContent = '';
  writeSession({ name, room, token: newToken() });
  connect();
});

addEventListener('pointerdown', unlockAudio);

addEventListener('keydown', (e) => {
  if (!state || $('room').hidden) return;
  if (e.target.matches('input[type=number], input[type=text]')) return;

  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) easel.redo();
      else easel.undo();
    } else if (e.code === 'KeyY') {
      e.preventDefault();
      easel.redo();
    }
    return;
  }
  if (e.altKey) return;

  if (e.key === '[') nudgeWidth(-1);
  else if (e.key === ']') nudgeWidth(1);
  else if (e.key === 'Delete') easel.clear();
  else if (e.code === 'KeyB') setTool('pen');
  else if (e.code === 'KeyE') setTool('eraser');
  else if (e.code === 'KeyF' && !e.repeat) toggleOwnFlip();
  else if (/^Digit[1-8]$/.test(e.code)) setColor(PALETTE[Number(e.code.at(-1)) - 1]);
});

$('volume').value = localStorage.getItem(VOLUME_KEY) ?? 100;
setVolume(Number($('volume').value));

$('login-name').value = session?.name ?? localStorage.getItem(NAME_KEY) ?? '';
$('login-room').value = session?.room ?? new URLSearchParams(location.search).get('room') ?? '';

// サーバーが無反応な接続を見分けられるように定期的に送る
setInterval(() => send({ type: 'ping' }), 25 * 1000);

renderTools();
connect();
