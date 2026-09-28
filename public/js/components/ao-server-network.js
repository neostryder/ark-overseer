import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
export class AoServerNetwork extends HTMLElement {
  async connectedCallback() {
    this.id = this.getAttribute('server-id');
    await this.load();
  }
  async load() {
    this.replaceChildren();
    this.textContent = STRINGS.app.loading;
    try {
      [this.server, this.firewall] = await Promise.all([
        api.get(`/api/servers/${this.id}`),
        api.get(`/api/servers/${this.id}/firewall`),
      ]);
      this.render();
    } catch (error) {
      this.replaceChildren();
      const p = document.createElement('p');
      p.textContent = error.message;
      const retry = document.createElement('button');
      retry.className = 'button secondary';
      retry.textContent = STRINGS.app.retry;
      retry.addEventListener('click', () => this.load());
      this.append(p, retry);
    }
  }
  render() {
    this.replaceChildren();
    this.className = 'screen';
    const h = document.createElement('h1');
    h.textContent = STRINGS.network.title;
    this.append(h);
    const form = document.createElement('form');
    form.className = 'card form-grid';
    this.inputs = {};
    // The API reads ports as snake_case columns and takes them back as camelCase.
    for (const [key, column, label] of [
      ['gamePort', 'game_port', STRINGS.network.game],
      ['queryPort', 'query_port', STRINGS.network.query],
      ['rconPort', 'rcon_port', STRINGS.network.rcon],
    ]) {
      const wrap = document.createElement('label');
      wrap.className = 'field-label';
      wrap.textContent = label;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = 1;
      input.max = 65535;
      input.value = this.server[column] ?? '';
      wrap.append(input);
      form.append(wrap);
      this.inputs[key] = input;
    }
    const peer = document.createElement('p');
    const showPeer = () => {
      const game = this.inputs.gamePort.value;
      peer.textContent = `${STRINGS.network.peer}: ${game === '' ? STRINGS.network.peerUnknown : Number(game) + 1}`;
    };
    this.inputs.gamePort.addEventListener('input', showPeer);
    showPeer();
    form.append(peer);
    const suggest = document.createElement('button');
    suggest.type = 'button';
    suggest.className = 'button secondary';
    suggest.textContent = STRINGS.network.suggest;
    suggest.addEventListener('click', async () => {
      message.textContent = '';
      suggest.disabled = true;
      try {
        const proposal = await api.get('/api/ports/suggest');
        for (const key of Object.keys(this.inputs))
          if (proposal[key] !== undefined) this.inputs[key].value = proposal[key];
        showPeer();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        suggest.disabled = false;
      }
    });
    const save = document.createElement('button');
    save.className = 'button primary';
    save.textContent = STRINGS.network.save;
    const message = document.createElement('p');
    message.className = 'error-message';
    form.append(suggest, save, message);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      save.disabled = true;
      try {
        await api.put(
          `/api/servers/${this.id}/ports`,
          Object.fromEntries(
            Object.entries(this.inputs).map(([key, input]) => [key, input.value === '' ? null : Number(input.value)]),
          ),
        );
        await this.load();
      } catch (error) {
        message.textContent = error.message;
        if (error.conflicts)
          for (const item of error.conflicts) {
            const row = document.createElement('p');
            row.textContent = `${item.port}: ${item.reason}`;
            message.append(row);
          }
      } finally {
        save.disabled = false;
      }
    });
    this.append(form);
    const section = document.createElement('section');
    section.className = 'card';
    const fh = document.createElement('h2');
    fh.textContent = STRINGS.network.firewall;
    section.append(fh);
    for (const rule of this.firewall.rules || []) {
      const p = document.createElement('p');
      p.textContent = `${rule.name}: ${rule.coveredBy ? `${STRINGS.network.coveredBy} ${rule.coveredBy}` : STRINGS.network.noRule}`;
      section.append(p);
    }
    if (this.firewall.script) {
      const pre = document.createElement('pre');
      pre.textContent = this.firewall.script;
      section.append(pre);
      const apply = document.createElement('button');
      apply.className = 'button primary';
      apply.append(icon('shield'), STRINGS.network.apply);
      const outcome = document.createElement('p');
      outcome.setAttribute('aria-live', 'polite');
      apply.addEventListener('click', async () => {
        if (!(await document.querySelector('ao-dialog').ask(STRINGS.network.firewall, STRINGS.network.confirmApply)))
          return;
        apply.disabled = true;
        outcome.textContent = '';
        try {
          const result = await api.post(`/api/servers/${this.id}/firewall/apply`, { token: this.firewall.token });
          if (result.applied) {
            await this.load();
            document.querySelector('ao-toast').show(STRINGS.network.applied);
            return;
          }
          outcome.textContent = STRINGS.network.notApplied;
          if (result.log) {
            const log = document.createElement('pre');
            log.textContent = result.log;
            outcome.append(log);
          }
        } catch (error) {
          if (error.status === 409) {
            await this.load();
            document.querySelector('ao-toast').show(STRINGS.network.changed);
          } else outcome.textContent = error.message;
        }
        apply.disabled = false;
      });
      section.append(apply, outcome);
    }
    const note = document.createElement('p');
    note.textContent = STRINGS.network.rconNote;
    section.append(note);
    this.append(section);
  }
}
customElements.define('ao-server-network', AoServerNetwork);
