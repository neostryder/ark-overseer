import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { badgedIcon, dataUri, tabTitle } from '../public/js/lib/tab-status.js';

const server = (observedState, crashLoop = false) => ({ status: { observedState, crashLoop } });

test('the tab title counts servers that need attention', () => {
  assert.equal(tabTitle('Overseer', []), 'Overseer');
  assert.equal(tabTitle('Overseer', [server('running'), server('stopped')]), 'Overseer');
  assert.equal(tabTitle('Overseer', [server('crashed'), server('running', true), server('running')]), '(2) Overseer');
});

test('the badged icon is still one svg with a dot added', () => {
  const svg = fs.readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  const badged = badgedIcon(svg);
  assert.ok(badged.startsWith('<svg'));
  assert.equal(badged.match(/<\/svg>/g).length, 1);
  assert.match(badged, /<circle /);
  assert.match(dataUri(badged), /^data:image\/svg\+xml,%3Csvg/);
});
