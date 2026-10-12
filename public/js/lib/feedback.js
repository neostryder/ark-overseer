// Small touches on this device: a short buzz and a soft tone when an action works or fails. Each is a switch
// on the Account page and is saved in this browser only.
const KEYS = { haptics: 'overseer-haptics', sound: 'overseer-sound' };
const DEFAULTS = { haptics: true, sound: false };
const PATTERNS = { done: [18], failed: [30, 60, 30] };
const TONES = { done: [660, 880], failed: [330, 247] };

export function feedbackOn(kind, storage = globalThis.localStorage) {
  try {
    const saved = storage.getItem(KEYS[kind]);
    return saved === null ? DEFAULTS[kind] : saved === 'on';
  } catch {
    return DEFAULTS[kind];
  }
}

export function setFeedback(kind, on, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEYS[kind], on ? 'on' : 'off');
  } catch {
    // A browser that will not keep the choice still honors it until the page closes.
  }
}

// Not every browser can vibrate, and a phone with Do Not Disturb on stays quiet, so a failed call is ignored.
export function buzz(result, env = globalThis) {
  if (!feedbackOn('haptics', env.localStorage)) return false;
  try {
    return Boolean(env.navigator?.vibrate?.(PATTERNS[result]));
  } catch {
    return false;
  }
}

export function chirp(result, env = globalThis) {
  if (!feedbackOn('sound', env.localStorage)) return false;
  try {
    const Audio = env.AudioContext ?? env.webkitAudioContext;
    if (!Audio) return false;
    const context = (chirp.context ??= new Audio());
    const start = context.currentTime;
    TONES[result].forEach((frequency, index) => {
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, start + index * 0.12);
      volume.gain.exponentialRampToValueAtTime(0.08, start + index * 0.12 + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.12 + 0.11);
      tone.connect(volume).connect(context.destination);
      tone.start(start + index * 0.12);
      tone.stop(start + index * 0.12 + 0.12);
    });
    return true;
  } catch {
    return false;
  }
}

// What happened to a request the person just made: done, or failed.
export function signal(result, env = globalThis) {
  buzz(result, env);
  chirp(result, env);
}
