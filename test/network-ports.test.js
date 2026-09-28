import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { findConflicts, allocatePorts, assignPorts, serverPorts } from '../src/network/ports.js';

// One host with Neo Olympus on the usual ports, plus a second host.
function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const now = new Date().toISOString();
  const h = db.prepare('INSERT INTO hosts(created_at,updated_at,name) VALUES(?,?,?)');
  const host = Number(h.run(now, now, 'local').lastInsertRowid);
  const other = Number(h.run(now, now, 'remote').lastInsertRowid);
  // Each server gets its own install, as the API requires.
  const newInstall = (hostId, name) =>
    Number(
      db
        .prepare('INSERT INTO installs(created_at,updated_at,host_id,path) VALUES(?,?,?,?)')
        .run(now, now, hostId, `C:\\ASA\\${name}`).lastInsertRowid,
    );
  const add = (name, { hostId = host, game = 7777, query = 27015, rcon = 27020 } = {}) =>
    Number(
      db
        .prepare(
          `INSERT INTO servers(created_at,updated_at,host_id,install_id,name,map,session_name,game_port,query_port,rcon_port,settings_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          now,
          now,
          hostId,
          newInstall(hostId, name),
          name,
          'TheIsland',
          name,
          game,
          query,
          rcon,
          '{"ServerAdminPassword":"hunter2"}',
        ).lastInsertRowid,
    );
  const ports = (id) => ({
    ...db.prepare('SELECT game_port, query_port, rcon_port FROM servers WHERE id = ?').get(id),
  });
  return { db, host, other, add, ports };
}
const only = (gamePort, extra = {}) => ({ gamePort, queryPort: null, rconPort: null, ...extra });
const reasons = (conflicts) => conflicts.map((c) => `${c.protocol} ${c.port} ${c.role}: ${c.reason}`);

test('serverPorts lists game, peer and the optional query and RCON ports', () => {
  assert.deepEqual(serverPorts({ game_port: 7777, query_port: null, rcon_port: 27020 }), [
    { protocol: 'udp', port: 7777, role: 'game' },
    { protocol: 'udp', port: 7778, role: 'peer' },
    { protocol: 'tcp', port: 27020, role: 'rcon' },
  ]);
});

test('a proposed game port clashes with another server game port', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  assert.deepEqual(reasons(findConflicts(db, { hostId: host, proposal: only(7777) })), [
    'udp 7777 game: used by Neo Olympus as its game port',
    'udp 7778 peer: used by Neo Olympus as its peer port',
  ]);
});

test('a proposed game port one below clashes through its own peer port', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  assert.deepEqual(reasons(findConflicts(db, { hostId: host, proposal: only(7776) })), [
    'udp 7777 peer: used by Neo Olympus as its game port',
  ]);
});

test('a proposed game port on another server peer port clashes', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  assert.deepEqual(reasons(findConflicts(db, { hostId: host, proposal: only(7778) })), [
    'udp 7778 game: used by Neo Olympus as its peer port',
  ]);
});

test('proposed query and RCON ports clash with another server query and RCON ports', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  assert.deepEqual(
    reasons(findConflicts(db, { hostId: host, proposal: only(9000, { queryPort: 27015, rconPort: 27020 }) })),
    ['udp 27015 query: used by Neo Olympus as its query port', 'tcp 27020 rcon: used by Neo Olympus as its rcon port'],
  );
});

test('the same number on UDP and TCP does not clash', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  assert.deepEqual(findConflicts(db, { hostId: host, proposal: only(9000, { rconPort: 7777, queryPort: 27020 }) }), []);
});

test('a server on another host does not clash', (t) => {
  const { db, host, other, add } = setup(t);
  add('Remote', { hostId: other });
  assert.deepEqual(
    findConflicts(db, { hostId: host, proposal: only(7777, { queryPort: 27015, rconPort: 27020 }) }),
    [],
  );
});

test('the server itself is left out when excludeServerId names it', (t) => {
  const { db, host, add } = setup(t);
  const id = add('Neo Olympus');
  const proposal = only(7777, { queryPort: 27015, rconPort: 27020 });
  assert.equal(findConflicts(db, { hostId: host, proposal }).length, 4);
  assert.deepEqual(findConflicts(db, { hostId: host, proposal, excludeServerId: id }), []);
});

test('a live UDP listener clashes unless its pid is ignored', (t) => {
  const { db, host } = setup(t);
  const listeners = [{ protocol: 'udp', address: '0.0.0.0', port: 7778, state: null, pid: 4004 }];
  assert.deepEqual(reasons(findConflicts(db, { hostId: host, proposal: only(7777), listeners })), [
    'udp 7778 peer: in use by process 4004',
  ]);
  assert.deepEqual(findConflicts(db, { hostId: host, proposal: only(7777), listeners, ignorePids: [4004] }), []);
});

test('a TCP listener clashes only while LISTENING', (t) => {
  const { db, host } = setup(t);
  const proposal = only(9000, { rconPort: 27020 });
  const row = { protocol: 'tcp', address: '0.0.0.0', port: 27020, pid: 33 };
  assert.deepEqual(findConflicts(db, { hostId: host, proposal, listeners: [{ ...row, state: 'ESTABLISHED' }] }), []);
  assert.deepEqual(
    reasons(findConflicts(db, { hostId: host, proposal, listeners: [{ ...row, state: 'LISTENING' }] })),
    ['tcp 27020 rcon: in use by process 33'],
  );
});

test('a proposal whose own ports collide is a conflict', (t) => {
  const { db, host } = setup(t);
  assert.deepEqual(reasons(findConflicts(db, { hostId: host, proposal: only(7777, { queryPort: 7778 }) })), [
    "udp 7778 query: conflicts with this server's peer port",
  ]);
});

test('ports below 1024, a game port of 65535 and a non-integer port are refused', (t) => {
  const { db, host } = setup(t);
  assert.deepEqual(reasons(findConflicts(db, { hostId: host, proposal: only(80) })), [
    'udp 80 game: port is outside the valid range',
    'udp 81 peer: port is outside the valid range',
  ]);
  assert.equal(findConflicts(db, { hostId: host, proposal: only(65535) })[0].reason, 'peer port would exceed 65535');
  assert.equal(findConflicts(db, { hostId: host, proposal: only(65534) }).length, 0);
  assert.equal(
    findConflicts(db, { hostId: host, proposal: only('7777') })[0].reason,
    'port is outside the valid range',
  );
  assert.equal(findConflicts(db, { hostId: host, proposal: only(9000, { rconPort: 1023 }) }).length, 1);
});

test('no conflict reason carries the server settings or a password', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  const all = findConflicts(db, { hostId: host, proposal: only(7777, { queryPort: 27015, rconPort: 27020 }) });
  assert.equal(all.length, 4);
  for (const c of all) assert.doesNotMatch(JSON.stringify(c), /hunter2|ServerAdminPassword|settings/);
});

test('allocatePorts gives 7777, 27015 and 27020 on an empty host', (t) => {
  const { db, host } = setup(t);
  assert.deepEqual(allocatePorts(db, { hostId: host }), { gamePort: 7777, queryPort: 27015, rconPort: 27020 });
});

test('allocatePorts moves past ports another server holds', (t) => {
  const { db, host, add } = setup(t);
  add('Neo Olympus');
  assert.deepEqual(allocatePorts(db, { hostId: host }), { gamePort: 7779, queryPort: 27016, rconPort: 27021 });
});

test('allocatePorts skips a game port whose peer port a listener holds', (t) => {
  const { db, host } = setup(t);
  const listeners = [{ protocol: 'udp', port: 7778, state: null, pid: 8 }];
  assert.equal(allocatePorts(db, { hostId: host, listeners }).gamePort, 7779);
});

test('allocatePorts leaves out the query and RCON ports when not asked for', (t) => {
  const { db, host } = setup(t);
  assert.deepEqual(allocatePorts(db, { hostId: host, withQuery: false, withRcon: false }), {
    gamePort: 7777,
    queryPort: null,
    rconPort: null,
  });
});

test('allocatePorts throws when no game port is free', (t) => {
  const { db, host } = setup(t);
  const listeners = [];
  for (let p = 7777; p <= 65535; p += 2) listeners.push({ protocol: 'udp', port: p, state: null, pid: 9 });
  assert.throws(() => allocatePorts(db, { hostId: host, listeners }), /No game port is available/);
});

test('assignPorts writes the new ports when nothing clashes', (t) => {
  const { db, add, ports } = setup(t);
  const id = add('Neo Olympus');
  assignPorts(db, id, { gamePort: 7781, queryPort: null, rconPort: 27021 });
  assert.deepEqual(ports(id), { game_port: 7781, query_port: null, rcon_port: 27021 });
});

test('assignPorts throws with every conflict and writes nothing', (t) => {
  const { db, add, ports } = setup(t);
  add('Neo Olympus');
  const id = add('Second', { game: 7779, query: 27016, rcon: 27021 });
  const before = ports(id);
  assert.throws(
    () => assignPorts(db, id, { gamePort: 7777, queryPort: 27015, rconPort: 27020 }),
    (error) => {
      assert.equal(error.conflicts.length, 4);
      assert.match(error.message, /UDP 7777 \(game\): used by Neo Olympus as its game port/);
      assert.match(error.message, /TCP 27020 \(rcon\): used by Neo Olympus as its rcon port/);
      return true;
    },
  );
  assert.deepEqual(ports(id), before);
});

test('assignPorts refuses a server that does not exist', (t) => {
  const { db } = setup(t);
  assert.throws(() => assignPorts(db, 99, only(7777)), /Server 99 does not exist/);
});
