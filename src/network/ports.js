import { transaction } from '../db/transaction.js';

export function serverPorts(server) {
  const ports = [
    { protocol: 'udp', port: server.game_port, role: 'game' },
    { protocol: 'udp', port: server.game_port + 1, role: 'peer' },
  ];
  if (server.query_port != null) ports.push({ protocol: 'udp', port: server.query_port, role: 'query' });
  if (server.rcon_port != null) ports.push({ protocol: 'tcp', port: server.rcon_port, role: 'rcon' });
  return ports;
}

function proposalPorts(p) {
  const ports = [
    { protocol: 'udp', port: p.gamePort, role: 'game' },
    { protocol: 'udp', port: p.gamePort + 1, role: 'peer' },
  ];
  if (p.queryPort != null) ports.push({ protocol: 'udp', port: p.queryPort, role: 'query' });
  if (p.rconPort != null) ports.push({ protocol: 'tcp', port: p.rconPort, role: 'rcon' });
  return ports;
}

export function findConflicts(db, { hostId, proposal, excludeServerId = null, listeners = [], ignorePids = [] }) {
  const proposed = proposalPorts(proposal);
  const conflicts = [];
  for (const item of proposed) {
    // A port that arrives as a string is refused rather than coerced, so a caller can never store
    // "7777" and have it compare unequal to 7777 later.
    const max = item.role === 'game' ? 65534 : 65535;
    if (!Number.isInteger(item.port) || item.port < 1024 || item.port > max) {
      conflicts.push({
        ...item,
        reason:
          item.role === 'game' && item.port > 65534
            ? 'peer port would exceed 65535'
            : 'port is outside the valid range',
      });
    }
  }
  if (conflicts.some((c) => c.role === 'game')) return conflicts;
  for (let i = 0; i < proposed.length; i++)
    for (let j = i + 1; j < proposed.length; j++) {
      if (proposed[i].protocol === proposed[j].protocol && proposed[i].port === proposed[j].port)
        conflicts.push({ ...proposed[j], reason: `conflicts with this server's ${proposed[i].role} port` });
    }
  const servers = db
    .prepare(
      'SELECT id, name, game_port, query_port, rcon_port FROM servers WHERE host_id = ? AND (? IS NULL OR id != ?)',
    )
    .all(hostId, excludeServerId, excludeServerId);
  for (const item of proposed) {
    for (const server of servers) {
      const held = serverPorts(server).find((entry) => entry.protocol === item.protocol && entry.port === item.port);
      if (held) conflicts.push({ ...item, reason: `used by ${server.name} as its ${held.role} port` });
    }
    for (const listener of listeners) {
      if (
        listener.protocol === item.protocol &&
        listener.port === item.port &&
        !ignorePids.includes(listener.pid) &&
        !(listener.protocol === 'tcp' && listener.state !== 'LISTENING')
      ) {
        conflicts.push({ ...item, reason: `in use by process ${listener.pid}` });
      }
    }
  }
  return conflicts;
}

export function allocatePorts(db, options) {
  const { hostId, withQuery = true, withRcon = true } = options;
  const used = (proposal) => findConflicts(db, { ...options, proposal }).length > 0;
  let gamePort;
  for (let p = 7777; p <= 65534; p += 2)
    if (!used({ gamePort: p, queryPort: null, rconPort: null })) {
      gamePort = p;
      break;
    }
  if (gamePort === undefined) throw new Error('No game port is available');
  const result = { gamePort, queryPort: null, rconPort: null };
  if (withQuery) {
    for (let p = 27015; p <= 65535; p++)
      if (!used({ ...result, queryPort: p })) {
        result.queryPort = p;
        break;
      }
    if (result.queryPort === null) throw new Error('No query port is available');
  }
  if (withRcon) {
    for (let p = 27020; p <= 65535; p++)
      if (!used({ ...result, rconPort: p })) {
        result.rconPort = p;
        break;
      }
    if (result.rconPort === null) throw new Error('No RCON port is available');
  }
  return result;
}

export function assignPorts(db, serverId, proposal, { listeners = [], ignorePids = [] } = {}) {
  return transaction(db, () => {
    const server = db.prepare('SELECT host_id FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new Error(`Server ${serverId} does not exist`);
    const conflicts = findConflicts(db, {
      hostId: server.host_id,
      proposal,
      excludeServerId: serverId,
      listeners,
      ignorePids,
    });
    if (conflicts.length) {
      const error = new Error(
        conflicts.map((c) => `${c.protocol.toUpperCase()} ${c.port} (${c.role}): ${c.reason}`).join('; '),
      );
      error.conflicts = conflicts;
      throw error;
    }
    db.prepare('UPDATE servers SET game_port = ?, query_port = ?, rcon_port = ?, updated_at = ? WHERE id = ?').run(
      proposal.gamePort,
      proposal.queryPort ?? null,
      proposal.rconPort ?? null,
      new Date().toISOString(),
      serverId,
    );
  });
}
