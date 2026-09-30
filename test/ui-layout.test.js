import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layoutMode, railClass, shouldCloseSwipe, resizeDeadline, isResizing } from '../public/js/lib/layout.js';

test('layout modes follow the shared width and height boundaries', () => {
  for (const coarse of [false, true]) {
    assert.equal(layoutMode(720, 844, coarse), 'drawer');
    assert.equal(layoutMode(721, 560, coarse), 'compact');
    assert.equal(layoutMode(1024, 560, coarse), 'compact');
    assert.equal(layoutMode(1025, 560, coarse), 'wide');
    assert.equal(layoutMode(1025, 559, coarse), 'drawer');
    assert.equal(layoutMode(844, 390, coarse), 'drawer');
    assert.equal(layoutMode(390, 844, coarse), 'drawer');
  }
});

test('swipe closure accounts for rail width, distance, speed, and direction', () => {
  assert.equal(shouldCloseSwipe(100, 400, 300), true);
  assert.equal(shouldCloseSwipe(99, 400, 300), false);
  assert.equal(shouldCloseSwipe(30, 40, 300), true);
  assert.equal(shouldCloseSwipe(20, 20, 300), false);
  assert.equal(shouldCloseSwipe(-120, 80, 300), false);
  assert.equal(shouldCloseSwipe(88, 400, 264), true);
});

test('rail state uses an overlay only where the rail can open', () => {
  assert.equal(railClass('drawer', true), 'drawer-open');
  assert.equal(railClass('compact', true), 'rail-expanded');
  assert.equal(railClass('wide', true), '');
  assert.equal(railClass('drawer', false), '');
});

test('resize debounce stays active until 150 ms after the latest event', () => {
  let deadline = resizeDeadline(1000);
  assert.equal(deadline, 1150);
  assert.equal(isResizing(1149, deadline), true);
  deadline = resizeDeadline(1130);
  assert.equal(isResizing(1200, deadline), true);
  assert.equal(isResizing(1280, deadline), false);
});

test('the server list toggle is hidden except in the medium layout, and the section tabs keep their width', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // .button comes later in the file, so a one-class rule would lose and the toggle would show at every width.
  assert.match(css, /\n\.button\.rail-expand\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /\n\.rail-expand\s*[,{]/);
  assert.match(css, /\n\.section-nav a\s*\{\s*flex:\s*none;/);
});

test('CSS gates hover, pairs viewport height fallbacks, and HTML includes safe area support', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const stack = [];
  for (const match of css.matchAll(/([^{}]+)\{|}/g)) {
    if (match[0] === '}') {
      stack.pop();
      continue;
    }
    const selector = match[1].trim();
    if (selector.includes(':hover')) {
      assert.ok(
        stack.some((block) => /@media\s*\(hover:\s*hover\)/.test(block)),
        selector,
      );
    }
    stack.push(selector);
  }
  const lines = css.split(/\r?\n/);
  assert.match(css, /@media \(min-width: 721px\) and \(max-width: 1024px\) and \(min-height: 560px\)/);
  assert.match(css, /@media \(max-width: 720px\), \(max-height: 559px\)/);
  for (let index = 0; index < lines.length; index++) {
    if (/\b100vh\b/.test(lines[index])) assert.match(lines[index + 1] ?? '', /100dvh/, `line ${index + 1}`);
  }
  for (const file of ['index.html', 'login.html']) {
    const html = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /viewport-fit=cover/, file);
  }
});
