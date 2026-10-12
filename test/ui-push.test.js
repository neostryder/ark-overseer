import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { keyBytes, needsHomeScreen, pushSupported } from '../public/js/lib/push.js';

test('a VAPID key becomes the 65 bytes the browser expects', () => {
  const bytes = keyBytes('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
});

test('push support is detected from the browser, and iPhones need the Home Screen app', () => {
  assert.equal(pushSupported({ navigator: { serviceWorker: {} }, window: { PushManager: {} } }), true);
  assert.equal(pushSupported({ navigator: {}, window: { PushManager: {} } }), false);
  assert.equal(pushSupported({ navigator: { serviceWorker: {} }, window: {} }), false);
  assert.equal(needsHomeScreen({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', standalone: false }), true);
  assert.equal(needsHomeScreen({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', standalone: true }), false);
  assert.equal(needsHomeScreen({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', standalone: false }), false);
});

// Runs the service worker against a stand-in for its scope.
function runWorker() {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: 'https://ark.example' },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async (url) => opened.push(url) },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL });
  return { listeners, shown, opened };
}

test('the service worker shows a pushed alert and ignores a malformed one', async () => {
  const { listeners, shown } = runWorker();
  const run = async (data) => {
    let pending;
    listeners.push({ data, waitUntil: (promise) => (pending = promise) });
    await pending;
  };
  await run({
    json: () => ({ title: 'Neo Olympus needs attention', body: 'It crashed.', tag: 'crash-1', url: '/#/host' }),
  });
  await run({
    json: () => {
      throw new Error('not json');
    },
  });
  assert.equal(shown[0].title, 'Neo Olympus needs attention');
  assert.equal(shown[0].options.tag, 'crash-1');
  assert.equal(shown[0].options.data.url, '/#/host');
  assert.equal(shown[1].title, 'Overseer');
});

test('tapping an alert opens the page it names and never another site', async () => {
  const { listeners, opened } = runWorker();
  const tap = async (url) => {
    let pending;
    listeners.notificationclick({
      notification: { close: () => {}, data: { url } },
      waitUntil: (promise) => (pending = promise),
    });
    await pending;
  };
  await tap('/#/servers/3/overview');
  await tap('https://evil.example/x');
  assert.deepEqual(opened, ['https://ark.example/#/servers/3/overview']);
});
