import net from 'node:net';

export function rconCommand({ host, port, password, command, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    let phase = 'auth';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`RCON timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    function send(id, type, body) {
      const text = Buffer.from(body, 'ascii');
      const packet = Buffer.alloc(14 + text.length);
      packet.writeInt32LE(packet.length - 4, 0);
      packet.writeInt32LE(id, 4);
      packet.writeInt32LE(type, 8);
      text.copy(packet, 12);
      socket.write(packet);
    }
    socket.on('connect', () => send(nextId, 3, password));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (size < 10 || buffer.length < size + 4) break;
        const packet = buffer.subarray(4, size + 4);
        buffer = buffer.subarray(size + 4);
        const id = packet.readInt32LE(0);
        const type = packet.readInt32LE(4);
        const body = packet.subarray(8, packet.length - 2).toString('ascii');
        if (phase === 'auth') {
          if (type === 0) continue;
          if (type === 2 && id === -1) return finish(new Error('RCON authentication failed'));
          if (type === 2 && id === nextId) {
            phase = 'command';
            nextId += 1;
            send(nextId, 2, command);
          }
        } else if (type === 0 && id === nextId) {
          return finish(null, body);
        }
      }
    });
    socket.on('error', (error) => finish(new Error(`RCON connection error: ${error.message}`)));
    socket.on('close', () => {
      if (!settled) finish(new Error('RCON socket closed early'));
    });
  });
}
