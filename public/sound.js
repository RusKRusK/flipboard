const FILES = { correct: '/o.mp3', wrong: '/x.mp3' };

const sounds = {};
let ctx;
let output;
let gain = 1;

function load(kind) {
  sounds[kind] ??= fetch(FILES[kind])
    .then((res) => res.arrayBuffer())
    .then((data) => ctx.decodeAudioData(data))
    .catch((err) => {
      delete sounds[kind];
      throw err;
    });
  return sounds[kind];
}

export function unlockAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    output = ctx.createGain();
    output.gain.value = gain;
    output.connect(ctx.destination);
    for (const kind of Object.keys(FILES)) load(kind).catch(() => {});
  }
  if (ctx.state === 'suspended') ctx.resume();
}

// 耳の感じ方に合わせて、スライダーの値を2乗して音量にする
export function setVolume(percent) {
  gain = (percent / 100) ** 2;
  if (output) output.gain.value = gain;
}

export async function playSound(kind) {
  unlockAudio();
  try {
    const buffer = await load(kind);
    // 操作前のページで鳴らすと、最初のクリックの瞬間に遅れて鳴ってしまう
    if (ctx.state !== 'running') return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.start();
  } catch (err) {
    console.error(err);
  }
}
