import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../public/js/strings.js';

class NodeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
}

test('the network page shows firewall drift and fixes one drifted rule', async () => {
  const old = {
    HTMLElement: globalThis.HTMLElement,
    customElements: globalThis.customElements,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  const server = { game_port: 7777, query_port: 27015, rcon_port: 27020 };
  const ruleName = 'ARK Overseer - One [1] - Game';
  const state = { kind: 'drifted', service: false };
  const calls = [];
  const asks = [];
  const toasts = [];
  let allow = false;
  let applyStatus = 200;
  const fixButtons = (node, found = []) => {
    if (!node || typeof node !== 'object') return found;
    if (node.tagName === 'button' && node.children?.includes(STRINGS.network.fix)) found.push(node);
    for (const child of node.children || []) fixButtons(child, found);
    return found;
  };
  globalThis.HTMLElement = class extends NodeElement {
    constructor() {
      super('custom-element');
    }
  };
  globalThis.customElements = { define: (_name, component) => (globalThis.NetworkComponent = component) };
  globalThis.document = {
    createElement: (tag) => new NodeElement(tag),
    createElementNS: (_namespace, tag) => new NodeElement(tag),
    querySelector: (selector) => {
      if (selector === 'ao-dialog')
        return {
          ask: async (title, message) => {
            asks.push({ title, message });
            return allow;
          },
        };
      if (selector === 'ao-toast') return { show: (text) => toasts.push(text) };
      return null;
    },
  };
  globalThis.fetch = async (path, options = {}) => {
    calls.push([path, options.method || 'GET', options.body || null]);
    if (path === `/api/servers/1/firewall?rule=${encodeURIComponent(ruleName)}`)
      return { ok: true, status: 200, json: async () => ({ rule: ruleName, script: 'one', token: 'tok' }) };
    if (path === '/api/servers/1/firewall/apply') {
      const failed = applyStatus === 409;
      return {
        ok: !failed,
        status: applyStatus,
        json: async () => (failed ? { error: 'changed' } : { applied: true }),
      };
    }
    const drift =
      state.kind === 'matched'
        ? { checked: true, localRulesIgnored: false, ok: true, rules: [] }
        : state.kind === 'unchecked'
          ? { checked: false, localRulesIgnored: false, ok: null, rules: [] }
          : {
              checked: true,
              localRulesIgnored: false,
              ok: false,
              rules: [
                {
                  name: ruleName,
                  problems: ['ports'],
                  expected: { ports: [{ from: 7777, to: 7778 }], protocol: 'UDP', direction: 'in' },
                  actual: { ports: [7777], protocol: 'UDP', direction: 'in', enabled: true },
                },
              ],
            };
    const firewall = {
      rules: [{ name: ruleName, coveredBy: null }],
      script: null,
      checked: drift.checked,
      localRulesIgnored: false,
      token: null,
      drift,
    };
    const payloads = {
      '/api/servers/1': server,
      '/api/servers/1/firewall': firewall,
      '/api/host': { service: state.service },
    };
    if (!payloads[path]) throw new Error(path);
    return { ok: true, status: 200, json: async () => payloads[path] };
  };
  try {
    await import('../public/js/components/ao-server-network.js');
    const open = async () => {
      const component = new globalThis.NetworkComponent();
      component.setAttribute('server-id', '1');
      await component.connectedCallback();
      return component;
    };
    const component = await open();
    const driftedSection = component.children[2];
    assert.equal(driftedSection.children[0].textContent, STRINGS.network.firewall);
    assert.equal(driftedSection.children[1].className, 'drift-fix');
    assert.equal(driftedSection.children[1].children[0].className, 'wizard-warning');
    assert.equal(
      driftedSection.children[1].children[0].textContent,
      `${ruleName}: ${STRINGS.network.driftProblems.ports}`,
    );
    const fix = fixButtons(driftedSection)[0];
    assert.equal(fix.children.at(-1), STRINGS.network.fix);
    const before = calls.length;
    await fix.listeners.click();
    assert.deepEqual(asks, [
      { title: STRINGS.network.firewall, message: STRINGS.network.confirmFix.replace('{name}', ruleName) },
    ]);
    assert.equal(calls.length, before);
    allow = true;
    applyStatus = 409;
    await fix.listeners.click();
    assert.equal(toasts.at(-1), STRINGS.network.changed);
    assert.equal(
      calls.some(
        (call) =>
          call[0] === '/api/servers/1/firewall' && calls.indexOf(call) > calls.findIndex((item) => item[1] === 'POST'),
      ),
      true,
    );
    const posted = calls.filter((call) => call[1] === 'POST');
    assert.equal(posted[0][0], '/api/servers/1/firewall/apply');
    assert.equal(posted[0][2], JSON.stringify({ token: 'tok', rule: ruleName }));
    applyStatus = 200;
    const again = fixButtons(component.children[2])[0];
    await again.listeners.click();
    assert.equal(toasts.at(-1), STRINGS.network.applied);
    const lastPost = calls.findLastIndex((call) => call[1] === 'POST');
    assert.ok(calls.slice(lastPost + 1).some((call) => call[0] === '/api/servers/1/firewall'));
    state.kind = 'unchecked';
    const unchecked = (await open()).children[2];
    assert.equal(fixButtons(unchecked).length, 0);
    assert.equal(unchecked.children[1].textContent, STRINGS.network.unchecked);
    state.kind = 'drifted';
    state.service = true;
    const serviceSection = (await open()).children[2];
    assert.equal(fixButtons(serviceSection).length, 0);
    assert.equal(
      serviceSection.children[1].children[0].textContent,
      `${ruleName}: ${STRINGS.network.driftProblems.ports}`,
    );
    state.service = false;
    state.kind = 'matched';
    const matchedSection = (await open()).children[2];
    assert.equal(matchedSection.children[1].textContent, STRINGS.network.driftOk);
    assert.equal(matchedSection.children[1].className, undefined);
    assert.equal(fixButtons(matchedSection).length, 0);
  } finally {
    globalThis.HTMLElement = old.HTMLElement;
    globalThis.customElements = old.customElements;
    globalThis.document = old.document;
    globalThis.fetch = old.fetch;
    delete globalThis.NetworkComponent;
  }
});
