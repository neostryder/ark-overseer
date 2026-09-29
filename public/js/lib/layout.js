export const RESIZE_IDLE_MS = 150;

export function layoutMode(width, height, coarse = false) {
  if (width <= 720 || height < 560) return 'drawer';
  if (width <= 1024) return 'compact';
  return 'wide';
}

export function resizeDeadline(now) {
  return now + RESIZE_IDLE_MS;
}

export function isResizing(now, deadline) {
  return now < deadline;
}

export function railClass(mode, open) {
  if (!open || mode === 'wide') return '';
  return mode === 'compact' ? 'rail-expanded' : 'drawer-open';
}

// distance is positive when the pointer moves toward the rail's opening edge.
export function shouldCloseSwipe(distance, elapsedMs, railWidth) {
  return distance > 0 && (distance >= railWidth / 3 || (distance >= 24 && distance / Math.max(elapsedMs, 1) >= 0.55));
}
