import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { jobState, jobSummary, relativeTime } from '../lib/format.js';
// A malformed frame is dropped rather than thrown inside the listener.
function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
export class AoJobsPanel extends HTMLElement {
  connectedCallback() {
    this.jobs = new Map();
    this.classList.add('jobs-panel');
    this.connect();
  }
  disconnectedCallback() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.source?.close();
  }
  connect() {
    this.closed = false;
    this.source = new EventSource('/api/jobs/events', { withCredentials: true });
    this.source.addEventListener('snapshot', (event) => {
      const jobs = parse(event.data)?.jobs || [];
      for (const job of jobs) this.jobs.set(job.id, job);
      this.delay = 1000;
      this.render();
    });
    for (const type of ['queued', 'started', 'progress', 'finished'])
      this.source.addEventListener(type, (event) => {
        const job = parse(event.data);
        if (!job?.id) return;
        this.jobs.set(job.id, job);
        this.render();
      });
    this.source.onerror = () => {
      this.source.close();
      const delay = Math.min((this.delay || 1000) * 2, 30000);
      this.delay = delay;
      if (!this.closed) this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
  render() {
    this.replaceChildren();
    const h = document.createElement('h2');
    h.textContent = STRINGS.jobs.title;
    this.append(h);
    const jobs = [...this.jobs.values()];
    const live = jobs.filter((job) => ['queued', 'running'].includes(job.state));
    const finished = jobs
      .filter((job) => !['queued', 'running'].includes(job.state))
      .slice(-20)
      .reverse();
    if (!jobs.length) {
      const empty = document.createElement('p');
      empty.textContent = STRINGS.jobs.empty;
      this.append(empty);
    }
    for (const job of [...live, ...finished]) {
      const row = document.createElement('article');
      row.className = 'job-row';
      const summary = document.createElement('strong');
      summary.textContent = jobSummary(job);
      const state = document.createElement('span');
      state.textContent = job.updatedAt
        ? `${jobState(job.state)} · ${relativeTime(job.updatedAt)}`
        : jobState(job.state);
      row.append(summary, state);
      if (['queued', 'running'].includes(job.state)) {
        const progress = document.createElement('progress');
        progress.max = 1;
        progress.value = Number(job.progress || 0);
        progress.setAttribute('aria-label', jobSummary(job));
        row.append(progress);
        const message = document.createElement('p');
        message.textContent = job.message || '';
        row.append(message);
        if (job.state === 'queued') {
          const cancel = document.createElement('button');
          cancel.className = 'button quiet';
          cancel.textContent = STRINGS.jobs.cancel;
          cancel.addEventListener('click', async () => {
            try {
              await api.post(`/api/jobs/${job.id}/cancel`, {});
            } catch (error) {
              message.textContent = error.message;
            }
          });
          row.append(cancel);
        }
      }
      if (job.error) {
        const error = document.createElement('p');
        error.textContent = job.error;
        row.append(error);
      }
      this.append(row);
    }
  }
}
customElements.define('ao-jobs-panel', AoJobsPanel);
