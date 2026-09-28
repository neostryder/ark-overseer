export async function saveAllWorlds({ db, supervisor, rcon, getRconPassword, timeoutMs = 30000, log = console.error }) {
  const servers = db
    .prepare('SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id ORDER BY s.id')
    .all()
    .filter((server) => supervisor.status(server.id)?.observedState === 'running');
  const deadline = Date.now() + timeoutMs;
  // Each save is on its own: a missing settings file or a refused connection on one server never
  // stops the others, and never stops ARK Overseer from shutting down.
  const saves = servers.map(async (server) => {
    let password = '';
    try {
      password = await getRconPassword(server);
      await rcon({
        host: '127.0.0.1',
        port: server.rcon_port,
        password,
        command: 'SaveWorld',
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      const message = `SaveWorld failed for ${server.name}: ${error.message}`;
      log(password ? message.split(password).join('[redacted]') : message);
    }
  });
  let timer;
  await Promise.race([
    Promise.all(saves),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
