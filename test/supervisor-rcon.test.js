import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { rconCommand } from '../src/supervisor/rcon.js';

function packet(id, type, body = '') {
  const text = Buffer.from(body);
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(out.length - 4);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
}
function server(t, handler) {
  const socketServer = net.createServer((socket) => handler(socket));
  socketServer.listen(0, '127.0.0.1');
  t.after(() => socketServer.close());
  return new Promise((resolve) => socketServer.once('listening', () => resolve(socketServer.address().port)));
}
function collect(socket, callback) {
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
    while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
      const size = data.readInt32LE();
      const packetData = data.subarray(4, size + 4);
      data = data.subarray(size + 4);
      callback(socket, packetData.readInt32LE(), packetData.readInt32LE(4), packetData.subarray(8, -2).toString());
    }
  });
}

test('RCON command authenticates and returns the command response body', async (t) => {
  const port = await server(t, (socket) =>
    collect(socket, (client, id, type) => {
      if (type === 3) client.write(packet(id, 2));
      else client.write(packet(id, 0, 'hello'));
    }),
  );
  assert.equal(await rconCommand({ host: '127.0.0.1', port, password: 'secret', command: 'ListPlayers' }), 'hello');
});

test('RCON rejects a wrong password without exposing it', async (t) => {
  const port = await server(t, (socket) =>
    collect(socket, (client, id, type) => {
      if (type === 3) client.write(packet(-1, 2));
    }),
  );
  await assert.rejects(
    rconCommand({ host: '127.0.0.1', port, password: 'hidden', command: 'x' }),
    (error) => error.message === 'RCON authentication failed' && !error.message.includes('hidden'),
  );
});

test('RCON skips an empty response before authentication succeeds', async (t) => {
  const port = await server(t, (socket) =>
    collect(socket, (client, id, type) => {
      if (type === 3) client.write(Buffer.concat([packet(id, 0), packet(id, 2)]));
      else client.write(packet(id, 0, 'ok'));
    }),
  );
  assert.equal(await rconCommand({ host: '127.0.0.1', port, password: 'x', command: 'x' }), 'ok');
});

test('RCON parses packets split across TCP chunks', async (t) => {
  const port = await server(t, (socket) =>
    collect(socket, (client, id, type) => {
      const out = packet(id, type === 3 ? 2 : 0, type === 3 ? '' : 'split');
      if (type === 2) {
        client.write(out.subarray(0, 5));
        setImmediate(() => client.write(out.subarray(5)));
      } else client.write(out);
    }),
  );
  assert.equal(await rconCommand({ host: '127.0.0.1', port, password: 'x', command: 'x' }), 'split');
});

test('RCON parses multiple packets in one TCP chunk', async (t) => {
  const port = await server(t, (socket) =>
    collect(socket, (client, id, type) => {
      if (type === 3) client.write(packet(id, 2));
      else client.write(Buffer.concat([packet(90, 0, 'ignore'), packet(id, 0, 'joined')]));
    }),
  );
  assert.equal(await rconCommand({ host: '127.0.0.1', port, password: 'x', command: 'x' }), 'joined');
});

test('RCON rejects when the server does not answer before timeout', async (t) => {
  const port = await server(t, () => {});
  await assert.rejects(rconCommand({ host: '127.0.0.1', port, password: 'x', command: 'x', timeoutMs: 25 }), /timeout/);
});

// Captures the client sockets rconCommand opens, so a test can check the client closed its own
// socket. The server's view is not reliable: on Windows a client-side destroy over loopback can take
// a long time to show up as 'close' on the server.
function captureSockets(t) {
  const sockets = [];
  const original = net.createConnection;
  net.createConnection = (...args) => {
    const socket = original(...args);
    sockets.push(socket);
    return socket;
  };
  t.after(() => {
    net.createConnection = original;
  });
  return sockets;
}

test('RCON closes its socket after a successful command', async (t) => {
  const port = await server(t, (socket) =>
    collect(socket, (client, id, type) => client.write(packet(id, type === 3 ? 2 : 0, type === 3 ? '' : 'ok'))),
  );
  const sockets = captureSockets(t);
  assert.equal(await rconCommand({ host: '127.0.0.1', port, password: 'x', command: 'x' }), 'ok');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].destroyed, true);
});

test('RCON closes its socket after a timeout', async (t) => {
  const port = await server(t, (socket) => collect(socket, () => {}));
  const sockets = captureSockets(t);
  await assert.rejects(rconCommand({ host: '127.0.0.1', port, password: 'x', command: 'x', timeoutMs: 25 }), /timeout/);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].destroyed, true);
});
