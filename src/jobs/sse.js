// Streams job events to a browser as Server-Sent Events. A reconnecting browser gets a snapshot of
// the queued and running jobs first, rather than a replay of history.
export function streamJobEvents(engine, req, res, { heartbeatMs = 15000, filter = () => true } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  function send(type, data, id) {
    const idLine = id === undefined ? '' : `id: ${id}\n`;
    res.write(`${idLine}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // A slow reader (a background tab, a phone on a weak connection) must not make the server buffer
  // every progress update of an hour-long job. While the socket is backed up, only the newest
  // progress event per job is kept and sent on 'drain'. Lifecycle events are rare and always sent,
  // and each one drops any older progress still held for its job so the order stays right.
  const heldProgress = new Map();

  function flushHeld() {
    const events = [...heldProgress.values()];
    heldProgress.clear();
    for (const event of events) send(event.type, event.job, event.seq);
  }

  const snapshot = engine.list({ state: ['queued', 'running'], limit: null }).filter(filter);
  send('snapshot', { jobs: snapshot });
  const unsubscribe = engine.subscribe((event) => {
    if (!filter(event.job)) return;
    if (event.type === 'progress' && res.writableNeedDrain) {
      heldProgress.set(event.job.id, event);
      return;
    }
    heldProgress.delete(event.job.id);
    send(event.type, event.job, event.seq);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  heartbeat.unref?.();
  res.on('drain', flushHeld);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    heldProgress.clear();
    res.off('close', cleanup);
    res.off('error', cleanup);
    res.off('drain', flushHeld);
  };
  // The response's 'close' is the reliable sign the client went away; a request's 'close' can fire
  // as soon as its (empty) body has been read.
  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}
