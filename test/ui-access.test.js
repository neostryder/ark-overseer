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
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
}

test('the Access settings component renders saved values and sends them on save', async () => {
  const old = {
    HTMLElement: globalThis.HTMLElement,
    customElements: globalThis.customElements,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  const calls = [];
  globalThis.HTMLElement = class extends NodeElement {
    constructor() {
      super('custom-element');
    }
  };
  globalThis.customElements = { define: (_name, component) => (globalThis.AccessComponent = component) };
  globalThis.document = {
    createElement: (tag) => new NodeElement(tag),
    querySelector: () => ({ show: () => {} }),
  };
  globalThis.fetch = async (path, options = {}) => {
    calls.push([path, options.method, options.body ? JSON.parse(options.body) : null]);
    const data =
      options.method === 'PUT'
        ? { teamDomain: 'rpgm.cloudflareaccess.com', aud: 'a'.repeat(64) }
        : { enabled: true, teamDomain: 'rpgm.cloudflareaccess.com', aud: 'a'.repeat(64) };
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    await import('../public/js/components/ao-access-settings.js');
    const component = new globalThis.AccessComponent();
    await component.connectedCallback();
    const card = component.children[0];
    assert.equal(card.children[0].textContent, STRINGS.access.title);
    assert.equal(card.children[1].textContent, STRINGS.access.help);
    const actualForm = card.children[2];
    assert.equal(actualForm.tagName, 'form');
    const inputs = actualForm.children.slice(0, 2).map((label) => label.children[1]);
    assert.deepEqual(
      inputs.map((input) => input.value),
      ['rpgm.cloudflareaccess.com', 'a'.repeat(64)],
    );
    await actualForm.listeners.submit({ preventDefault() {} });
    assert.deepEqual(calls, [
      ['/api/access', 'GET', null],
      ['/api/access', 'PUT', { teamDomain: 'rpgm.cloudflareaccess.com', aud: 'a'.repeat(64) }],
    ]);
    assert.equal(actualForm.children[2].textContent, STRINGS.access.save);
  } finally {
    globalThis.HTMLElement = old.HTMLElement;
    globalThis.customElements = old.customElements;
    globalThis.document = old.document;
    globalThis.fetch = old.fetch;
    delete globalThis.AccessComponent;
  }
});
