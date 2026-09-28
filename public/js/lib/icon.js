const SVG = 'http://www.w3.org/2000/svg';
// An icon from /icons/sprite.svg. It is decorative: the control next to it carries the text.
export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `/icons/sprite.svg#${name}`);
  svg.append(use);
  return svg;
}
