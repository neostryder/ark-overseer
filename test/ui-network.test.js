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

test('the network page shows firewall drift and says when the rules match', async () => {
  const old = {
    HTMLElement: globalThis.HTMLElement,
    customElements: globalThis.customElements,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  let drifted = true;
  const server = { game_port: 7777, query_port: 27015, rcon_port: 27020 };
  const ruleName = 'ARK Overseer - One [1] - Game';
  globalThis.HTMLElement = class extends NodeElement {
    constructor() {
      super('custom-element');
    }
  };
  globalThis.customElements = { define: (_name, component) => (globalThis.NetworkComponent = component) };
  globalThis.document = { createElement: (tag) => new NodeElement(tag) };
  globalThis.fetch = async (path) => {
    const firewall = {
      rules: [{ name: ruleName, coveredBy: null }],
      script: null,
      checked: true,
      localRulesIgnored: false,
      token: null,
      drift: drifted
        ? {
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
          }
        : { checked: true, localRulesIgnored: false, ok: true, rules: [] },
    };
    const payloads = { '/api/servers/1': server, '/api/servers/1/firewall': firewall, '/api/host': { service: false } };
    return { ok: true, status: 200, json: async () => payloads[path] };
  };
  try {
    await import('../public/js/components/ao-server-network.js');
    const open = async () => {
      const component = new globalThis.NetworkComponent();
      component.setAttribute('server-id', '1');
      await component.connectedCallback();
      return component.children[2];
    };
    const driftedSection = await open();
    assert.equal(driftedSection.children[0].textContent, STRINGS.network.firewall);
    assert.equal(driftedSection.children[1].className, 'wizard-warning');
    assert.equal(driftedSection.children[1].textContent, `${ruleName}: ${STRINGS.network.driftProblems.ports}`);
    drifted = false;
    const matchedSection = await open();
    assert.equal(matchedSection.children[1].textContent, STRINGS.network.driftOk);
    assert.equal(matchedSection.children[1].className, undefined);
  } finally {
    globalThis.HTMLElement = old.HTMLElement;
    globalThis.customElements = old.customElements;
    globalThis.document = old.document;
    globalThis.fetch = old.fetch;
    delete globalThis.NetworkComponent;
  }
});
