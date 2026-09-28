// The in-game warning code that restarts, updates and map changes share.

export function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// Sends one line to the players of a server: as chat, or as a broadcast on screen.
export function createTell({ rcon, getRconPassword }) {
  return async (server, announce, message) =>
    rcon({
      host: '127.0.0.1',
      port: server.rcon_port,
      password: await getRconPassword(server),
      command: `${announce === 'broadcast' ? 'Broadcast' : 'ServerChat'} ${message}`,
    });
}

// Warns every listed server at each mark, waits out the gaps, then waits the last mark's minutes.
// A failed warning is noted in the job message and the countdown goes on.
export async function runCountdown({ tell, sleep }, servers, marks, message, announce, signal, progress) {
  for (let index = 0; index < marks.length; index++) {
    if (signal.aborted) throw signal.reason;
    const minutes = marks[index];
    await Promise.all(
      servers.map((server) =>
        tell(server, announce, message(minutes)).catch((error) =>
          progress(null, `${server.name} did not get the in-game warning: ${error.message}`),
        ),
      ),
    );
    const next = marks[index + 1] ?? 0;
    await sleep((minutes - next) * 60000, signal);
  }
}
