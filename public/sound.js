let ctx;

export function unlockAudio() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
}

function tone({ type, freq, start, length, volume }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t = ctx.currentTime + start;
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, t);
  gain.gain.setValueAtTime(volume, t + length * 0.6);
  gain.gain.exponentialRampToValueAtTime(0.001, t + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length);
}

const SOUNDS = {
  correct: [
    { type: 'sine', freq: 1319, start: 0, length: 0.2, volume: 0.5 },
    { type: 'sine', freq: 1047, start: 0.2, length: 0.7, volume: 0.5 },
  ],
  wrong: [
    { type: 'sawtooth', freq: 140, start: 0, length: 0.18, volume: 0.35 },
    { type: 'sawtooth', freq: 140, start: 0.24, length: 0.55, volume: 0.35 },
  ],
};

export function playSound(kind) {
  unlockAudio();
  SOUNDS[kind].forEach(tone);
}
