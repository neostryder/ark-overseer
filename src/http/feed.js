// A feed that tells open browsers when the server list may have changed. It carries no data: a browser that
// hears "changed" fetches /api/servers again. Changes that land close together are sent as one event.
export function createChangeFeed({ heartbeatMs = 15000, settleMs = 100 } = {}) {
  const clients = new Set();
  let settling = null;

  function notify() {
    if (settling || !clients.size) return;
    settling = setTimeout(() => {
      settling = null;
      for (const client of clients) client.write('event: changed\ndata: {}\n\n');
    }, settleMs);
    settling.unref?.();
  }

  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // A browser that reconnects after a gap has missed events, so every new stream opens with one.
    res.write('event: changed\ndata: {}\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref?.();
    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(res);
      res.off('close', cleanup);
      res.off('error', cleanup);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
  }

  return { notify, stream };
}
