// Pull-to-refresh for touch screens. A pull that starts at the top of the page and is dragged past the
// threshold refreshes it. The distance is damped so a long drag feels like resistance.
export const PULL_THRESHOLD = 72;
export const PULL_MAX = 120;

export function pullDistance(dy) {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX, dy * 0.5);
}
export function pullPhase(distance) {
  if (distance <= 0) return 'idle';
  return distance >= PULL_THRESHOLD ? 'ready' : 'pulling';
}

// Returns a function that stops listening. canStart is asked when a touch begins, so the page can refuse
// while a menu or dialog is open or while a form holds unsaved edits.
export function watchPull({ indicator, onRefresh, canStart, target = document }) {
  let startY = null;
  let distance = 0;
  let busy = false;
  const show = (phase, px) => {
    indicator.dataset.phase = phase;
    indicator.style.setProperty('--pull', `${px}px`);
  };
  const reset = () => {
    startY = null;
    distance = 0;
    show('idle', 0);
  };
  const handleStart = (event) => {
    if (busy || event.touches.length !== 1 || window.scrollY > 0 || !canStart(event)) return;
    startY = event.touches[0].clientY;
  };
  const handleMove = (event) => {
    if (startY === null) return;
    const dy = event.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) return reset();
    distance = pullDistance(dy);
    show(pullPhase(distance), distance);
    if (event.cancelable) event.preventDefault();
  };
  const handleEnd = async () => {
    if (startY === null) return;
    const ready = pullPhase(distance) === 'ready';
    if (!ready) return reset();
    busy = true;
    startY = null;
    show('refreshing', PULL_THRESHOLD * 0.6);
    try {
      await onRefresh();
    } finally {
      busy = false;
      reset();
    }
  };
  target.addEventListener('touchstart', handleStart, { passive: true });
  target.addEventListener('touchmove', handleMove, { passive: false });
  target.addEventListener('touchend', handleEnd);
  target.addEventListener('touchcancel', reset);
  return () => {
    target.removeEventListener('touchstart', handleStart);
    target.removeEventListener('touchmove', handleMove);
    target.removeEventListener('touchend', handleEnd);
    target.removeEventListener('touchcancel', reset);
  };
}
