// A placeholder shaped like a card while a page loads. The label is what a screen reader announces.
export function skeleton(label, bars = 3) {
  const box = document.createElement('div');
  box.className = 'skeleton';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-busy', 'true');
  box.setAttribute('aria-label', label);
  for (let i = 0; i < bars; i += 1) {
    const bar = document.createElement('span');
    bar.className = i === 0 ? 'skeleton-bar skeleton-title' : 'skeleton-bar';
    box.append(bar);
  }
  return box;
}
