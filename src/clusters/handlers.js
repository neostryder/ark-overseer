import { createTell, defaultSleep, runCountdown } from '../scheduler/countdown.js';
import { PLAYER_MESSAGES } from '../scheduler/handlers.js';
import { readLogMarker, waitForReady } from '../supervisor/ready.js';
import { serverPaths } from '../supervisor/launch.js';
import { runMemberSequence } from '../fleet/sequence.js';
import {
  applySharedSettings,
  checkActionOptions,
  checkSharedSettings,
  clusterRow,
  memberRows,
  MESSAGES,
  isRunning,
} from './core.js';

export function createClusterHandlers({
  db,
  supervisor,
  drift,
  rcon,
  getRconPassword,
  sleep = defaultSleep,
  now = () => Date.now(),
  ready = waitForReady,
  marker = readLogMarker,
}) {
  const tell = createTell({ rcon, getRconPassword });
  const running = (id) => isRunning(supervisor, id);
  const stillMember = (clusterId, id) => memberRows(db, clusterId).some((member) => member.id === id);
  const membersFor = (id) => {
    const cluster = clusterRow(db, id);
    if (!cluster) throw new Error(MESSAGES.missing);
    return { cluster, members: memberRows(db, id) };
  };
  const sequence = (action, members, params, signal, progress, skip, perform) =>
    runMemberSequence({
      members,
      signal,
      progress,
      action,
      current: (member) => (stillMember(params.clusterId, member.id) ? member : null),
      skip,
      perform,
      message: (verb, member, index, count) =>
        MESSAGES.progress
          .replace('{action}', MESSAGES.actions[verb])
          .replace('{name}', member.name)
          .replace('{index}', index)
          .replace('{count}', count),
    });
  return {
    'server.cluster_apply': async ({ job, params, signal }) => {
      if (signal.aborted) throw signal.reason;
      const member = db
        .prepare(
          'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
        )
        .get(job.serverId);
      if (!member || member.cluster_id !== params.clusterId) return { skipped: true };
      const { cluster } = membersFor(params.clusterId);
      checkSharedSettings(JSON.parse(cluster.settings_json));
      const result = await applySharedSettings({ db, cluster, member, drift, keys: params.keys });
      return { ...result, appliesAtRestart: running(member.id) };
    },
    'cluster.restart': async ({ params, signal, progress }) => {
      checkActionOptions({ countdownMinutes: params.countdownMinutes, announce: params.announce });
      const { members } = membersFor(params.clusterId);
      const result = await sequence(
        'restart',
        members,
        params,
        signal,
        progress,
        (member) => !running(member.id),
        async (member) => {
          const announce = params.announce ?? 'chat';
          try {
            await runCountdown(
              { tell, sleep },
              [member],
              params.countdownMinutes ?? [10, 5, 1],
              PLAYER_MESSAGES.clusterRestart,
              announce,
              signal,
              progress,
            );
          } catch (error) {
            if (signal.aborted) await tell(member, announce, PLAYER_MESSAGES.cancelled).catch(() => {});
            throw error;
          }
          if (signal.aborted) throw signal.reason;
          if (!stillMember(params.clusterId, member.id) || !running(member.id)) return false;
          await tell(member, announce, PLAYER_MESSAGES.clusterRestartNow).catch(() => {});
          const logPath = serverPaths(member.install_path).logPath;
          const oldMarker = await marker(logPath);
          try {
            await supervisor.stop(member.id);
            // Once stopped, a cancellation waits for this member's start command.
            const since = now();
            await supervisor.start(member.id);
            if (signal.aborted) throw signal.reason;
            await ready({ logPath, since, marker: oldMarker, isAlive: () => running(member.id), signal });
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            throw new Error(MESSAGES.failedMember.replace('{name}', member.name) + ` ${error.message}`);
          }
        },
      );
      return { restarted: result.done };
    },
    'cluster.start': async ({ params, signal, progress }) => {
      checkActionOptions({ countdownMinutes: params.countdownMinutes, announce: params.announce });
      const { members } = membersFor(params.clusterId);
      const result = await sequence(
        'start',
        members,
        params,
        signal,
        progress,
        (member) => running(member.id),
        (member) => supervisor.start(member.id),
      );
      return { started: result.done };
    },
    'cluster.stop': async ({ params, signal, progress }) => {
      checkActionOptions({ countdownMinutes: params.countdownMinutes, announce: params.announce });
      const { members } = membersFor(params.clusterId);
      const result = await sequence(
        'stop',
        members,
        params,
        signal,
        progress,
        (member) => !running(member.id),
        (member) => supervisor.stop(member.id),
      );
      return { stopped: result.done };
    },
  };
}
