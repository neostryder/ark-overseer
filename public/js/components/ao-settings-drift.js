import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import {
  groupDifferences,
  bannerText,
  foundText,
  describeDifference,
  setChoice,
  keepChoices,
  choiceList,
  choiceSummary,
  choiceKey,
  actionStates,
  runningNote,
  findResolveJob,
  isBusy,
} from '../lib/drift.js';

const POLL_MS = 2000;
const LIVE = ['queued', 'running'];

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const toast = (text) => document.querySelector('ao-toast')?.show(text);

// The banner on the Settings page for settings that changed outside ARK Overseer, the review of them, and the option
// that puts ARK Overseer's values back after a shutdown. The page keeps one of these and moves it between draws.
export class AoSettingsDrift extends HTMLElement {
  connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    if (!this.started) {
      this.started = true;
      this.className = 'drift-host';
      this.choices = {};
      this.open = false;
      this.busy = false;
      this.blocked = false;
      this.load();
    } else {
      if (this.followId && !this.pollTimer) this.poll();
      this.watchBusy();
    }
  }
  disconnectedCallback() {
    clearTimeout(this.pollTimer);
    clearTimeout(this.busyTimer);
    this.pollTimer = null;
    this.busyTimer = null;
  }

  // ---- reading ----

  async load() {
    try {
      this.state = await api.get(`/api/servers/${this.serverId}/settings/drift`);
      this.error = '';
    } catch (error) {
      this.error = error.message || STRINGS.drift.failed;
    }
    this.choices = keepChoices(this.state?.differences, this.choices);
    if (!this.state?.changed) this.open = false;
    if (!this.followId) await this.resume();
    this.render();
    this.watchBusy();
  }
  // A put-back that was already running for this server (started from here or by the automatic revert) is followed.
  // Any other job only makes the server report the files as busy.
  async resume() {
    try {
      const live = findResolveJob(await api.get(`/api/jobs?serverId=${this.serverId}`));
      if (live) this.follow(live.id, live.message || STRINGS.drift.queued);
    } catch {
      /* the buttons stay usable; the server refuses a second job anyway */
    }
  }
  // While another job owns the files the buttons are off. The state is read again until that job ends, and the open
  // review then shows the files as they are.
  watchBusy() {
    clearTimeout(this.busyTimer);
    this.busyTimer = null;
    if (!this.state?.busy || this.followId || !this.isConnected) return;
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      if (this.isConnected) this.load();
    }, POLL_MS);
  }
  refresh() {
    return this.load();
  }
  setBlocked(blocked) {
    this.blocked = Boolean(blocked);
    this.updateActions();
  }

  // ---- drawing ----

  render() {
    const d = STRINGS.drift;
    this.replaceChildren();
    this.buttons = null;
    this.summaryNode = null;
    this.blockedNode = null;
    this.noticeNode = null;
    this.jobNode = null;
    // The changes come first, since they are what needs attention; the standing option sits under them.
    if (this.error) this.append(el('p', this.error, 'error-message'));
    const state = this.state;
    if (state?.busy && !this.busy && !state.changed) this.append(el('p', d.busy, 'muted'));
    if (state?.changed) this.append(this.banner());
    this.append(this.keepOption());
    this.updateActions();
  }
  keepOption() {
    const d = STRINGS.drift;
    const box = el('div', undefined, 'card drift-keep');
    const label = el('label', undefined, 'check-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.state?.keepAfterStop);
    input.disabled = !this.state;
    const text = el('span', d.keepAfterStop);
    label.append(input, text);
    const help = el('small', d.keepAfterStopHelp, 'muted');
    const error = el('p', '', 'error-message');
    error.setAttribute('aria-live', 'polite');
    input.addEventListener('change', async () => {
      input.disabled = true;
      error.textContent = '';
      try {
        await api.put(`/api/servers/${this.serverId}/settings/drift/keep`, { enabled: input.checked });
        this.state = { ...this.state, keepAfterStop: input.checked };
        toast(d.keepSaved);
      } catch (cause) {
        input.checked = !input.checked;
        error.textContent = cause.message;
      }
      input.disabled = false;
    });
    box.append(label, help, error);
    return box;
  }
  banner() {
    const d = STRINGS.drift;
    const state = this.state;
    const box = el('section', undefined, 'card drift-banner');
    box.setAttribute('role', 'status');
    const summary = el('div', undefined, 'drift-summary');
    const words = el('div', undefined, 'drift-words');
    words.append(
      el('strong', bannerText(state.differences.length)),
      el('span', foundText(state.detectedAt, state.afterStop), 'muted'),
    );
    const review = el('button', this.open ? d.reviewHide : d.review, 'button primary');
    review.setAttribute('aria-expanded', String(this.open));
    review.addEventListener('click', () => this.toggle());
    summary.append(words, review);
    box.append(summary);
    this.noticeNode = el('p', undefined, 'drift-notice');
    this.noticeNode.setAttribute('aria-live', 'polite');
    this.jobNode = el('p', undefined, 'drift-job muted');
    this.jobNode.setAttribute('role', 'status');
    box.append(this.jobNode, this.noticeNode);
    if (this.open) box.append(this.panel());
    this.showNotice(this.notice);
    this.showBusy();
    return box;
  }
  toggle() {
    this.open = !this.open;
    // Opening the review counts as looking: the marker beside the server goes.
    if (this.open && !this.state.seen) {
      this.state = { ...this.state, seen: true };
      api.post(`/api/servers/${this.serverId}/settings/drift/seen`, {}).catch(() => {});
    }
    this.render();
  }
  panel() {
    const d = STRINGS.drift;
    const state = this.state;
    const panel = el('div', undefined, 'drift-panel');
    panel.append(el('p', d.panelIntro, 'muted'));
    let index = 0;
    for (const group of groupDifferences(state.differences)) {
      const file = el('div', undefined, 'diff-file');
      file.append(el('h3', group.file, 'diff-name'));
      if (group.whole) file.append(this.row(group.whole, index++));
      for (const section of group.sections) {
        file.append(el('h4', section.name || d.noSection, 'diff-section'));
        for (const item of section.items) file.append(this.row(item, index++));
      }
      panel.append(file);
    }
    this.summaryNode = el('p', undefined, 'drift-choices-left muted');
    this.summaryNode.setAttribute('aria-live', 'polite');
    panel.append(this.summaryNode);

    const actions = el('div', undefined, 'drift-actions');
    const adopt = el('button', d.keepCurrent, 'button secondary');
    adopt.addEventListener('click', () => this.act('adopt'));
    const revert = el('button', d.putBack, 'button secondary');
    revert.addEventListener('click', () => this.act('revert'));
    const merge = el('button', d.applyChoices, 'button primary');
    merge.addEventListener('click', () => this.act('merge'));
    this.buttons = { adopt, revert, merge };
    actions.append(adopt, revert, merge);
    panel.append(actions, el('small', d.keepCurrentHelp, 'muted'), el('small', d.putBackHelp, 'muted'));
    panel.append(el('small', d.safetyNote, 'muted'));
    const running = runningNote(state.serverRunning);
    if (running) panel.append(el('small', running, 'drift-running'));
    this.blockedNode = el('small', d.unsavedBlock, 'muted');
    panel.append(this.blockedNode);
    return panel;
  }
  // One difference, with the two values side by side (stacked on a narrow screen) and a choice between them.
  row(difference, index) {
    const d = STRINGS.drift;
    const shown = describeDifference(difference);
    const line = el('div', undefined, `diff-row ${difference.kind}`);
    const head = el('div', undefined, 'drift-row-head');
    if (difference.key) head.append(el('strong', difference.key, 'diff-key'));
    head.append(el('span', shown.kind, 'diff-kind'));
    line.append(head);
    if (shown.note) line.append(el('p', shown.note, 'muted drift-note'));
    const name = `drift-choice-${index}`;
    const choices = el('div', undefined, 'drift-choices');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', d.choiceLabel.replace('{key}', difference.key || difference.file));
    for (const [side, heading, value, missing, action] of [
      ['baseline', d.baselineValue, shown.baseline, shown.baselineMissing, d.useBaseline],
      ['live', d.currentValue, shown.current, shown.currentMissing, d.useCurrent],
    ]) {
      const label = el('label', undefined, 'drift-choice');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = side;
      radio.checked = this.choices[choiceKey(difference)] === side;
      radio.addEventListener('change', () => {
        this.choices = setChoice(this.choices, difference, side);
        this.updateActions();
      });
      const text = el('span', undefined, 'drift-choice-text');
      text.append(el('small', heading, 'muted'));
      if (value !== null) text.append(el('code', value, missing ? 'muted' : ''));
      text.append(el('span', action, 'drift-choice-action'));
      label.append(radio, text);
      choices.append(label);
    }
    line.append(choices);
    return line;
  }

  // ---- what the buttons can do right now ----

  updateActions() {
    const state = this.state;
    if (this.summaryNode && state) this.summaryNode.textContent = choiceSummary(state.differences, this.choices);
    if (!this.buttons || !state) return;
    const enabled = actionStates({
      differences: state.differences,
      choices: this.choices,
      busy: isBusy({ following: this.busy, state }),
      blocked: this.blocked,
    });
    for (const [key, button] of Object.entries(this.buttons)) button.disabled = !enabled[key];
    if (this.blockedNode) this.blockedNode.hidden = !this.blocked;
  }
  showNotice(notice) {
    this.notice = notice ?? null;
    if (!this.noticeNode) return;
    this.noticeNode.textContent = notice?.text ?? '';
    this.noticeNode.className = notice?.error ? 'drift-notice error-message' : 'drift-notice muted';
    this.noticeNode.hidden = !notice;
  }
  showBusy() {
    if (!this.jobNode) return;
    this.jobNode.textContent = this.busy ? this.busyText : '';
    this.jobNode.hidden = !this.busy;
  }
  setBusy(busy, text = '') {
    this.busy = busy;
    this.busyText = text;
    this.showBusy();
    this.updateActions();
  }

  // ---- acting ----

  async act(action) {
    const d = STRINGS.drift;
    const [title, message, confirm] = {
      adopt: [d.keepTitle, d.keepConfirm, d.keepNow],
      revert: [d.putBackTitle, d.putBackConfirm, d.putBackNow],
      merge: [d.applyTitle, d.applyConfirm, d.applyNow],
    }[action];
    const notes = [message, this.state.serverRunning && action !== 'adopt' ? d.runningNote : ''].filter(Boolean);
    if (!(await document.querySelector('ao-dialog').ask(title, notes.join(' '), confirm))) return;
    const body = { action, liveSha256: this.state.liveSha256 };
    if (action === 'merge') body.choices = choiceList(this.state.differences, this.choices);
    this.showNotice(null);
    this.setBusy(true, d.working);
    try {
      const result = await api.post(`/api/servers/${this.serverId}/settings/drift/resolve`, body);
      if (action === 'adopt') {
        this.setBusy(false);
        toast(d.kept);
        this.choices = {};
        await this.load();
        this.announce();
        return;
      }
      this.follow(result.id, d.queued);
    } catch (error) {
      this.setBusy(false);
      // The files changed after the last look: the differences are read again so the next choice is made on them.
      if (error.code === 'changed') await this.load();
      this.showNotice({ text: error.message, error: true });
    }
  }
  follow(jobId, first) {
    this.followId = jobId;
    this.setBusy(true, first);
    this.poll();
  }
  poll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get(`/api/jobs?serverId=${this.serverId}`)).find((item) => item.id === this.followId);
        if (job && !LIVE.includes(job.state)) {
          await this.finished(job);
          return;
        }
        if (job) this.setBusy(true, job.message || this.busyText);
      } catch {
        /* a failed poll is tried again */
      }
      this.poll();
    }, POLL_MS);
  }
  async finished(job) {
    const d = STRINGS.drift;
    const failure = { cancelled: d.jobCancelled, interrupted: d.jobInterrupted };
    this.followId = null;
    this.busy = false;
    const notice =
      job.state !== 'succeeded'
        ? { text: job.error || failure[job.state] || d.jobFailed, error: true }
        : job.message
          ? { text: job.message, error: false }
          : null;
    if (job.state === 'succeeded') {
      toast(d.done);
      this.choices = {};
    }
    this.notice = notice;
    await this.load();
    this.announce();
  }
  // The page reads its values again after a put-back.
  announce() {
    this.dispatchEvent(new CustomEvent('drift-resolved', { bubbles: true }));
  }
}
customElements.define('ao-settings-drift', AoSettingsDrift);
