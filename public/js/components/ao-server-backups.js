import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { byteSize } from '../lib/format.js';
import { icon } from '../lib/icon.js';
import { mapName } from '../lib/wizard.js';
import {
  SCOPES,
  isSafety,
  canDelete,
  groupByDay,
  availableScopes,
  firstScope,
  filterPlayers,
  limitRows,
  confirmLabel,
  countdownMarks,
  restoreNotes,
} from '../lib/backups.js';

const POLL_MS = 2000;
const LIVE = ['queued', 'running'];
const ACTIVE = ['running', 'starting', 'unknown'];
const NOTE_MAX = 200;
const NAME_MAX = 64;

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
const stamp = (iso) => new Date(iso).toLocaleString();
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fileCount = (n) => (n === 1 ? STRINGS.backups.filesOne : fill(STRINGS.backups.files, { count: n }));
const toast = (text) => document.querySelector('ao-toast')?.show(text);

export class AoServerBackups extends HTMLElement {
  async connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    await this.load();
  }
  disconnectedCallback() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.restoreDialog?.remove();
  }
  async load() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.replaceChildren(el('p', STRINGS.backups.loading));
    try {
      [this.server, this.schedules, this.backups, this.snapshots] = await Promise.all([
        api.get(`/api/servers/${this.serverId}`),
        api.get(`/api/servers/${this.serverId}/schedules`),
        api.get(`/api/servers/${this.serverId}/backups`),
        api.get(`/api/servers/${this.serverId}/settings-snapshots`),
      ]);
      this.render();
      await this.resume();
    } catch (error) {
      const retry = el('button', STRINGS.app.retry, 'button secondary');
      retry.addEventListener('click', () => this.load());
      this.replaceChildren(el('p', error.message || STRINGS.backups.failed, 'error-message'), retry);
    }
  }
  render() {
    const b = STRINGS.backups;
    this.className = 'screen backups-screen';
    this.replaceChildren(el('h1', b.title), el('p', b.intro, 'muted'));
    // Every button that starts a job is kept here, so one running job switches them all off.
    this.jobButtons = [];
    this.timelineHost = el('section', undefined, 'card backup-timeline-card');
    this.snapshotHost = el('section', undefined, 'card snapshot-card');

    const actions = el('section', undefined, 'card backup-actions-card');
    const now = el('button', undefined, 'button primary');
    now.append(icon('add'), b.backUpNow);
    now.addEventListener('click', () => this.backUpNow());
    this.jobButtons.push(now);
    this.jobNode = el('p', undefined, 'backup-job muted');
    this.jobNode.setAttribute('role', 'status');
    this.noticeNode = el('p', undefined, 'backup-notice');
    this.noticeNode.setAttribute('aria-live', 'polite');
    actions.append(now, this.jobNode, this.noticeNode);
    this.append(actions, this.timelineHost, this.snapshotHost);
    this.renderTimeline();
    this.renderSnapshots();
    this.showNotice(this.notice);
    this.setBusy(Boolean(this.busy), this.busyText);
  }

  // ---- the job that is running, if any ----

  showNotice(notice) {
    this.notice = notice ?? null;
    if (!this.noticeNode) return;
    this.noticeNode.textContent = notice?.text ?? '';
    this.noticeNode.className = notice?.error ? 'backup-notice error-message' : 'backup-notice muted';
    this.noticeNode.hidden = !notice;
  }
  // While a job is queued or running for this server, the buttons that start one are off and the step shows.
  setBusy(busy, text = '') {
    this.busy = busy;
    this.busyText = text;
    for (const button of this.jobButtons ?? []) button.disabled = busy || button.dataset.unavailable === 'true';
    if (!this.jobNode) return;
    this.jobNode.textContent = busy ? text : '';
    this.jobNode.hidden = !busy;
  }
  async resume() {
    try {
      const jobs = await api.get(`/api/jobs?serverId=${this.serverId}`);
      const live = jobs.find((job) => LIVE.includes(job.state));
      if (live) this.follow(live.id, live.message || STRINGS.backups.jobQueued);
    } catch {
      /* the buttons stay usable; the server refuses a second job anyway */
    }
  }
  follow(jobId, first) {
    this.setBusy(true, first);
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get(`/api/jobs?serverId=${this.serverId}`)).find((item) => item.id === jobId);
        if (job && !LIVE.includes(job.state)) {
          await this.finished(job);
          return;
        }
        if (job) this.setBusy(true, job.message || first);
      } catch {
        /* a failed poll is tried again */
      }
      this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }
  async finished(job) {
    const b = STRINGS.backups;
    const failure = { cancelled: b.jobCancelled, interrupted: b.jobInterrupted };
    this.busy = false;
    this.notice =
      job.state !== 'succeeded'
        ? { text: job.error || failure[job.state] || b.jobFailed, error: true }
        : job.message
          ? { text: job.message, error: false }
          : null;
    if (job.state === 'succeeded' && job.kind === 'server.backup') toast(b.backedUp);
    await this.load();
  }
  async start(request, first) {
    this.showNotice(null);
    this.setBusy(true, first);
    try {
      const job = await request();
      this.follow(job.id, first);
      return job;
    } catch (error) {
      this.setBusy(false);
      this.showNotice({ text: error.message, error: true });
      return null;
    }
  }
  backUpNow() {
    return this.start(() => api.post(`/api/servers/${this.serverId}/backups`, {}), STRINGS.backups.backingUp);
  }

  // ---- the backup timeline ----

  renderTimeline() {
    const b = STRINGS.backups;
    const card = this.timelineHost;
    card.replaceChildren();
    if (!this.backups.length) card.append(el('p', b.none));
    for (const group of groupByDay(this.backups)) {
      card.append(
        el(
          'h2',
          group.date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          'backup-day',
        ),
      );
      const list = el('ul', undefined, 'backup-timeline');
      for (const item of group.items) list.append(this.entry(item));
      card.append(list);
    }
    this.pruneButtons();
  }
  // Buttons of rows that were drawn again are dropped from the list of those a running job switches off.
  pruneButtons() {
    this.jobButtons = this.jobButtons.filter((button) => button.isConnected);
  }
  entry(item) {
    const b = STRINGS.backups;
    const row = el('li', undefined, 'backup-entry');
    const head = el('div', undefined, 'backup-head');
    head.append(el('strong', clock(item.created_at), 'backup-time'));
    head.append(el('span', STRINGS.automation.reasons[item.reason] ?? item.reason, 'badge'));
    if (isSafety(item.reason)) {
      const safety = el('span', b.safety, 'badge safety');
      safety.title = b.safetyHelp;
      head.append(safety);
    }
    const map = item.map ? mapName(item.map) : b.unknownMap;
    row.append(
      head,
      el('span', [map, byteSize(item.size_bytes), fileCount(item.fileCount)].join(', '), 'muted backup-meta'),
    );
    const note = el('p', item.note ?? '', 'backup-note');
    note.hidden = !item.note;
    row.append(note);
    if (!item.restorable)
      row.append(el('p', fill(b.cannotRestore, { reason: item.problem ?? '' }), 'muted backup-problem'));

    const time = stamp(item.created_at);
    const buttons = el('div', undefined, 'backup-actions');
    const restore = el('button', b.restore, 'button primary');
    restore.setAttribute('aria-label', fill(b.restoreLabel, { time }));
    restore.dataset.unavailable = String(!item.restorable);
    restore.addEventListener('click', () => this.openRestore(item, restore));
    this.jobButtons.push(restore);
    const edit = el('button', item.note ? b.noteEdit : b.noteAdd, 'button quiet');
    edit.addEventListener('click', () => this.editNote(item, row, note, edit));
    buttons.append(restore, edit);
    if (canDelete(item.reason)) {
      const remove = el('button', b.deleteBackup, 'button quiet');
      remove.setAttribute('aria-label', fill(b.deleteLabel, { time }));
      remove.addEventListener('click', () => this.removeBackup(item));
      buttons.append(remove);
    }
    row.append(buttons);
    return row;
  }
  editNote(item, row, noteNode, trigger) {
    const b = STRINGS.backups;
    const form = el('div', undefined, 'note-form');
    const input = document.createElement('input');
    input.maxLength = NOTE_MAX;
    input.value = item.note ?? '';
    const label = el('label', undefined, 'field-label');
    label.append(el('span', b.noteLabel), input, el('small', b.noteHelp));
    const error = el('p', '', 'error-message');
    error.setAttribute('aria-live', 'polite');
    const save = el('button', b.noteSave, 'button primary');
    const cancel = el('button', b.noteCancel, 'button quiet');
    const done = () => {
      form.remove();
      trigger.hidden = false;
      trigger.focus();
    };
    cancel.addEventListener('click', done);
    save.addEventListener('click', async () => {
      save.disabled = true;
      error.textContent = '';
      try {
        const saved = await api.patch(`/api/servers/${this.serverId}/backups/${item.id}`, { note: input.value });
        item.note = saved.note;
        noteNode.textContent = saved.note ?? '';
        noteNode.hidden = !saved.note;
        trigger.textContent = saved.note ? b.noteEdit : b.noteAdd;
        toast(b.noteSaved);
        done();
      } catch (cause) {
        error.textContent = cause.message;
        save.disabled = false;
      }
    });
    const buttons = el('div', undefined, 'button-row');
    buttons.append(save, cancel);
    form.append(label, error, buttons);
    trigger.hidden = true;
    row.append(form);
    input.focus();
  }
  async removeBackup(item) {
    const b = STRINGS.backups;
    const time = stamp(item.created_at);
    if (!(await document.querySelector('ao-dialog').ask(b.deleteTitle, fill(b.deleteConfirm, { time }), b.deleteNow)))
      return;
    try {
      await api.del(`/api/servers/${this.serverId}/backups/${item.id}`, {});
      toast(b.deleted);
      this.backups = await api.get(`/api/servers/${this.serverId}/backups`);
      this.renderTimeline();
      this.setBusy(Boolean(this.busy), this.busyText);
    } catch (error) {
      this.showNotice({ text: error.message, error: true });
    }
  }

  // ---- the restore dialog ----

  async openRestore(item, opener) {
    const b = STRINGS.backups;
    let details, server;
    try {
      [details, server] = await Promise.all([
        api.get(`/api/servers/${this.serverId}/backups/${item.id}`),
        api.get(`/api/servers/${this.serverId}`),
      ]);
    } catch (error) {
      this.showNotice({ text: error.message || b.detailsFailed, error: true });
      return;
    }
    const running = ACTIVE.includes(server.status?.observedState);
    const marks = countdownMarks(this.schedules);
    const available = availableScopes(details);
    const backupMap = details.map;
    const mapLabel = backupMap ? mapName(backupMap) : b.unknownMap;
    const currentLabel = mapName(server.map);
    const chosen = { profiles: new Set(), tribes: new Set() };
    let scope = firstScope(available);
    let query = '';

    const dialog = el('dialog', undefined, 'dialog restore-dialog');
    dialog.setAttribute('aria-labelledby', 'restore-dialog-title');
    const title = el('h2', b.restoreTitle);
    title.id = 'restore-dialog-title';
    const from = el('p', fill(b.restoreFrom, { time: stamp(item.created_at), map: mapLabel }), 'muted');

    // The scope choices.
    const fieldset = el('fieldset', undefined, 'scope-list');
    fieldset.append(el('legend', b.scopeLegend));
    const radios = new Map();
    for (const key of SCOPES) {
      const label = el('label', undefined, 'scope-option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'restore-scope';
      radio.value = key;
      radio.checked = key === scope;
      radio.disabled = !available[key];
      radio.addEventListener('change', () => {
        scope = key;
        update();
      });
      const text = el('span', undefined, 'scope-text');
      text.append(el('strong', b.scopes[key]), el('small', available[key] ? b.scopeHelp[key] : b.unavailable, 'muted'));
      label.append(radio, text);
      radios.set(key, radio);
      fieldset.append(label);
    }

    // The players and tribes to pick from.
    const picker = el('div', undefined, 'player-picker');
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.autocomplete = 'off';
    const filterLabel = el('label', undefined, 'field-label');
    filterLabel.append(el('span', b.filter), filter);
    const lists = el('div', undefined, 'player-lists');
    const count = el('p', '', 'muted');
    count.setAttribute('aria-live', 'polite');
    picker.append(filterLabel, lists, count);
    const column = (heading, items, selected, empty) => {
      const box = el('div', undefined, 'player-column');
      box.append(el('h3', heading));
      if (!items.length) {
        box.append(el('p', empty, 'muted'));
        return box;
      }
      const { rows: shown, total } = limitRows(filterPlayers(items, query));
      if (!total) box.append(el('p', b.noMatches, 'muted'));
      const list = el('div', undefined, 'player-rows');
      for (const player of shown) {
        const row = el('label', undefined, 'check-row player-row');
        const tick = document.createElement('input');
        tick.type = 'checkbox';
        tick.checked = selected.has(player.id);
        tick.addEventListener('change', () => {
          if (tick.checked) selected.add(player.id);
          else selected.delete(player.id);
          update();
        });
        row.append(
          tick,
          el(
            'span',
            fill(b.idLine, {
              id: player.id,
              size: byteSize(player.size),
              time: player.modifiedAt ? stamp(player.modifiedAt) : STRINGS.status.unknown,
            }),
          ),
        );
        list.append(row);
      }
      box.append(list);
      if (total > shown.length) box.append(el('p', fill(b.moreMatches, { shown: shown.length, total }), 'muted'));
      return box;
    };
    const drawLists = () => {
      lists.replaceChildren(
        column(b.profilesHeading, details.profiles, chosen.profiles, b.noProfiles),
        column(b.tribesHeading, details.tribes, chosen.tribes, b.noTribes),
      );
    };
    filter.addEventListener('input', () => {
      query = filter.value;
      drawLists();
    });

    // What will happen, the outcome of the choices so far.
    const notes = el('ul', undefined, 'restore-notes');
    const error = el('p', '', 'error-message');
    error.setAttribute('aria-live', 'polite');
    const cancel = el('button', b.cancel, 'button secondary');
    const confirm = el('button', undefined, 'button primary');
    const actions = el('div', undefined, 'button-row');
    actions.append(cancel, confirm);
    const picked = () => chosen.profiles.size + chosen.tribes.size;
    const update = () => {
      picker.hidden = scope !== 'players';
      notes.replaceChildren(
        ...restoreNotes({
          scope,
          running,
          marks,
          backupMap,
          currentMap: server.map,
          mapLabel,
          currentLabel,
        }).map((text) => el('li', text)),
      );
      const total = picked();
      count.textContent = total === 1 ? b.chosenOne : fill(b.chosen, { count: total });
      confirm.textContent = confirmLabel(scope);
      confirm.disabled = scope === 'players' && total === 0;
      error.textContent = '';
    };
    drawLists();
    update();

    const finish = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
      this.restoreDialog = null;
      opener?.focus?.();
    };
    cancel.addEventListener('click', finish);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish();
    });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      error.textContent = '';
      const body = { scope };
      if (scope === 'players') {
        body.profiles = [...chosen.profiles];
        body.tribes = [...chosen.tribes];
      }
      try {
        const job = await api.post(`/api/servers/${this.serverId}/backups/${item.id}/restore`, body);
        finish();
        this.showNotice(null);
        this.follow(job.id, b.queued);
      } catch (cause) {
        error.textContent = cause.message;
        confirm.disabled = false;
      }
    });

    dialog.append(title, from, fieldset, picker, notes, error, actions);
    this.restoreDialog?.remove();
    this.restoreDialog = dialog;
    this.append(dialog);
    dialog.showModal();
    (radios.get(scope) ?? cancel).focus();
  }

  // ---- settings snapshots ----

  renderSnapshots() {
    const b = STRINGS.backups;
    const card = this.snapshotHost;
    card.replaceChildren(el('h2', b.snapshots), el('p', b.snapshotsHelp, 'muted'));
    const form = el('div', undefined, 'snapshot-form');
    const input = document.createElement('input');
    input.maxLength = NAME_MAX;
    const label = el('label', undefined, 'field-label');
    label.append(el('span', b.snapshotName), input, el('small', b.snapshotNameHelp));
    const error = el('p', '', 'error-message');
    error.setAttribute('aria-live', 'polite');
    const save = el('button', undefined, 'button primary');
    save.append(icon('check'), b.snapshotSave);
    const submit = async () => {
      save.disabled = true;
      error.textContent = '';
      try {
        await api.post(`/api/servers/${this.serverId}/settings-snapshots`, { name: input.value });
        toast(b.snapshotSaved);
        await this.reloadSnapshots();
      } catch (cause) {
        error.textContent = cause.message;
        save.disabled = false;
      }
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    form.append(label, save, error);
    card.append(form);
    if (!this.snapshots.length) card.append(el('p', b.snapshotNone));
    else {
      const list = el('ul', undefined, 'snapshot-list');
      for (const snapshot of this.snapshots) list.append(this.snapshotRow(snapshot));
      card.append(list);
    }
    this.pruneButtons();
  }
  async reloadSnapshots() {
    this.snapshots = await api.get(`/api/servers/${this.serverId}/settings-snapshots`);
    this.renderSnapshots();
    this.setBusy(Boolean(this.busy), this.busyText);
  }
  snapshotRow(snapshot) {
    const b = STRINGS.backups;
    const row = el('li', undefined, 'snapshot-row');
    const head = el('div', undefined, 'snapshot-head');
    const name = el('strong', snapshot.name, 'snapshot-name');
    head.append(
      name,
      el(
        'span',
        fill(b.snapshotFiles, { files: fileCount(snapshot.files), time: stamp(snapshot.created_at) }),
        'muted',
      ),
    );
    row.append(head);
    if (!snapshot.usable) row.append(el('p', b.snapshotUnusable, 'muted'));
    const panel = el('div', undefined, 'snapshot-panel');
    panel.hidden = true;
    const buttons = el('div', undefined, 'snapshot-actions');

    const compare = el('button', b.compare, 'button secondary');
    compare.setAttribute('aria-label', fill(b.compareLabel, { name: snapshot.name }));
    compare.disabled = !snapshot.usable;
    compare.addEventListener('click', () => this.toggleCompare(snapshot, compare, panel));

    const restore = el('button', b.snapshotRestore, 'button primary');
    restore.setAttribute('aria-label', fill(b.snapshotRestoreLabel, { name: snapshot.name }));
    restore.dataset.unavailable = String(!snapshot.usable);
    restore.addEventListener('click', () => this.restoreSnapshot(snapshot));
    this.jobButtons.push(restore);

    const rename = el('button', b.snapshotRename, 'button quiet');
    rename.setAttribute('aria-label', fill(b.snapshotRenameLabel, { name: snapshot.name }));
    rename.addEventListener('click', () => this.renameSnapshot(snapshot, row, rename));

    const remove = el('button', b.snapshotDelete, 'button quiet');
    remove.setAttribute('aria-label', fill(b.snapshotDeleteLabel, { name: snapshot.name }));
    remove.addEventListener('click', () => this.deleteSnapshot(snapshot));

    buttons.append(compare, restore, rename, remove);
    row.append(buttons, panel);
    return row;
  }
  async toggleCompare(snapshot, button, panel) {
    const b = STRINGS.backups;
    if (!panel.hidden) {
      panel.hidden = true;
      button.textContent = b.compare;
      return;
    }
    panel.hidden = false;
    button.textContent = b.compareHide;
    panel.replaceChildren(el('p', b.comparing, 'muted'));
    try {
      const diff = await api.get(`/api/servers/${this.serverId}/settings-snapshots/${snapshot.id}/diff`);
      panel.replaceChildren(this.diffView(snapshot, diff));
    } catch (error) {
      panel.replaceChildren(el('p', error.message, 'error-message'));
    }
  }
  // The differences by file and section, snapshot value beside current value, stacked on a narrow screen.
  diffView(snapshot, diff) {
    const b = STRINGS.backups;
    const view = el('div', undefined, 'diff');
    if (!diff.files.length) {
      view.append(el('p', b.compareSame));
      return view;
    }
    view.append(el('p', fill(b.compareSummary, { name: snapshot.name }), 'muted'));
    const whole = { only_in_snapshot: b.onlyInSnapshot, only_live: b.onlyLive, changed: b.fileChanged };
    for (const file of diff.files) {
      const box = el('div', undefined, 'diff-file');
      box.append(el('h3', file.file, 'diff-name'));
      if (!file.sections.length) box.append(el('p', whole[file.status], 'muted'));
      for (const section of file.sections) {
        box.append(el('h4', section.section || b.noSection, 'diff-section'));
        for (const [kind, label, items] of [
          ['changed', b.changed, section.changed],
          ['added', b.added, section.added],
          ['removed', b.removed, section.removed],
        ])
          for (const change of items) {
            const line = el('div', undefined, `diff-row ${kind}`);
            line.append(el('strong', change.key, 'diff-key'), el('span', label, 'diff-kind'));
            const values = el('div', undefined, 'diff-values');
            for (const [heading, value] of [
              [b.snapshotValue, change.old],
              [b.currentValue, change.current],
            ]) {
              const cell = el('div', undefined, 'diff-cell');
              cell.append(
                el('small', heading, 'muted'),
                el('code', value ?? b.valueNone, value === null ? 'muted' : ''),
              );
              values.append(cell);
            }
            line.append(values);
            box.append(line);
          }
      }
      view.append(box);
    }
    return view;
  }
  async restoreSnapshot(snapshot) {
    const b = STRINGS.backups;
    let running;
    try {
      const server = await api.get(`/api/servers/${this.serverId}`);
      running = ACTIVE.includes(server.status?.observedState);
    } catch (error) {
      this.showNotice({ text: error.message, error: true });
      return;
    }
    const message = [b.snapshotRestoreConfirm, running ? b.snapshotRestoreRunning : b.snapshotRestoreStopped].join(' ');
    const values = { name: snapshot.name };
    if (
      !(await document
        .querySelector('ao-dialog')
        .ask(fill(b.snapshotRestoreTitle, values), message, b.snapshotRestoreNow))
    )
      return;
    await this.start(
      () => api.post(`/api/servers/${this.serverId}/settings-snapshots/${snapshot.id}/restore`, {}),
      b.snapshotRestoring,
    );
  }
  renameSnapshot(snapshot, row, trigger) {
    const b = STRINGS.backups;
    const form = el('div', undefined, 'note-form');
    const input = document.createElement('input');
    input.maxLength = NAME_MAX;
    input.value = snapshot.name;
    const label = el('label', undefined, 'field-label');
    label.append(el('span', b.snapshotName), input, el('small', b.snapshotNameHelp));
    const error = el('p', '', 'error-message');
    error.setAttribute('aria-live', 'polite');
    const save = el('button', b.snapshotRenameSave, 'button primary');
    const cancel = el('button', b.cancel, 'button quiet');
    const done = () => {
      form.remove();
      trigger.hidden = false;
      trigger.focus();
    };
    cancel.addEventListener('click', done);
    save.addEventListener('click', async () => {
      save.disabled = true;
      error.textContent = '';
      try {
        await api.patch(`/api/servers/${this.serverId}/settings-snapshots/${snapshot.id}`, { name: input.value });
        toast(b.snapshotRenamed);
        // The buttons in the row name the snapshot, so the list is drawn again with the new name.
        await this.reloadSnapshots();
      } catch (cause) {
        error.textContent = cause.message;
        save.disabled = false;
      }
    });
    const buttons = el('div', undefined, 'button-row');
    buttons.append(save, cancel);
    form.append(label, error, buttons);
    trigger.hidden = true;
    row.append(form);
    input.focus();
  }
  async deleteSnapshot(snapshot) {
    const b = STRINGS.backups;
    const values = { name: snapshot.name };
    if (
      !(await document
        .querySelector('ao-dialog')
        .ask(b.snapshotDeleteTitle, fill(b.snapshotDeleteConfirm, values), b.snapshotDeleteNow))
    )
      return;
    try {
      await api.del(`/api/servers/${this.serverId}/settings-snapshots/${snapshot.id}`, {});
      toast(b.snapshotDeleted);
      await this.reloadSnapshots();
    } catch (error) {
      this.showNotice({ text: error.message, error: true });
    }
  }
}
customElements.define('ao-server-backups', AoServerBackups);
