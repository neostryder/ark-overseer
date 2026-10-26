import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { durationInputs, extendLabel } from '../lib/idle.js';

const POLL_MS = 30 * 1000;

// Shows each server that has been running with nobody on it and is waiting for an answer: save and shut it down, or
// leave it running for a while longer. The same prompt goes to phones and Telegram; whichever answers first wins.
export class AoIdleBanner extends HTMLElement {
  connectedCallback() {
    this.hidden = true;
    this.rows = [];
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.onVisible = () => {
      if (!document.hidden) this.refresh();
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }
  async refresh() {
    let pending;
    try {
      pending = (await api.get('/api/idle')).pending;
    } catch {
      return;
    }
    // A prompt being answered here keeps its row, so typing in it is not interrupted by a refresh.
    if (this.typing && pending.length === this.rows.length) return;
    this.rows = pending;
    this.render();
  }
  render() {
    this.replaceChildren();
    this.hidden = !this.rows.length;
    this.className = 'idle-banner';
    for (const row of this.rows) this.append(this.card(row));
  }
  card(row) {
    const card = document.createElement('section');
    card.className = 'card form-stack idle-prompt';
    card.setAttribute('role', 'status');
    const text = document.createElement('p');
    text.textContent = row.text;
    const answer = async (body) => {
      try {
        const result = await api.post(`/api/servers/${row.serverId}/idle`, body);
        document.querySelector('ao-toast')?.show(result.message);
      } catch (error) {
        document.querySelector('ao-toast')?.show(error.message);
      }
      this.typing = false;
      await this.refresh();
    };
    const shutdown = document.createElement('button');
    shutdown.className = 'button primary';
    shutdown.textContent = STRINGS.idle.shutdown;
    shutdown.addEventListener('click', () => {
      shutdown.disabled = true;
      answer({ action: 'shutdown' });
    });
    const extend = document.createElement('button');
    extend.className = 'button secondary';
    const time = durationInputs({
      value: row.extend.value,
      unit: row.extend.unit,
      onChange: (chosen) => {
        this.typing = true;
        extend.textContent = chosen.value ? extendLabel(chosen.value, chosen.unit) : STRINGS.idle.needNumber;
        extend.disabled = !chosen.value;
      },
    });
    extend.textContent = extendLabel(row.extend.value, row.extend.unit);
    extend.addEventListener('click', () => {
      const chosen = time.read();
      if (!chosen.value) return;
      extend.disabled = true;
      answer({ action: 'extend', ...chosen });
    });
    const timeRow = document.createElement('div');
    timeRow.className = 'button-row idle-time';
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = STRINGS.idle.timeLabel;
    const fields = document.createElement('div');
    fields.className = 'button-row';
    fields.append(time.number, time.select);
    label.append(fields);
    timeRow.append(label);
    card.append(text, shutdown, timeRow, extend);
    if (row.autoShutdownAt) {
      const when = document.createElement('p');
      when.className = 'muted';
      when.textContent = `${STRINGS.idle.autoAt} ${new Date(row.autoShutdownAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
      card.append(when);
    }
    return card;
  }
}
customElements.define('ao-idle-banner', AoIdleBanner);
