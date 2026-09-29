import { createTell, defaultSleep, runCountdown } from '../scheduler/countdown.js';
import { PLAYER_MESSAGES } from '../scheduler/handlers.js';
import { readLogMarker, waitForReady } from '../supervisor/ready.js';
import { serverPaths } from '../supervisor/launch.js';
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
      const restarted = [];
      for (let index = 0; index < members.length; index++) {
        if (signal.aborted) throw signal.reason;
        const member = members[index];
        if (!stillMember(params.clusterId, member.id)) continue;
        if (!running(member.id)) continue;
        progress(
          index / members.length,
          MESSAGES.progress
            .replace('{action}', MESSAGES.actions.restart)
            .replace('{name}', member.name)
            .replace('{index}', index + 1)
            .replace('{count}', members.length),
        );
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
        if (!stillMember(params.clusterId, member.id)) continue;
        if (!running(member.id)) continue;
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
          restarted.push(member.id);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw new Error(MESSAGES.failedMember.replace('{name}', member.name) + ` ${error.message}`);
        }
        if (signal.aborted) throw signal.reason;
      }
      return { restarted };
    },
    'cluster.start': async ({ params, signal, progress }) => {
      checkActionOptions({ countdownMinutes: params.countdownMinutes, announce: params.announce });
      const { members } = membersFor(params.clusterId);
      const started = [];
      for (let index = 0; index < members.length; index++) {
        if (signal.aborted) throw signal.reason;
        const member = members[index];
        if (!stillMember(params.clusterId, member.id)) continue;
        if (running(member.id)) continue;
        progress(
          index / members.length,
          MESSAGES.progress
            .replace('{action}', MESSAGES.actions.start)
            .replace('{name}', member.name)
            .replace('{index}', index + 1)
            .replace('{count}', members.length),
        );
        await supervisor.start(member.id);
        started.push(member.id);
      }
      return { started };
    },
    'cluster.stop': async ({ params, signal, progress }) => {
      checkActionOptions({ countdownMinutes: params.countdownMinutes, announce: params.announce });
      const { members } = membersFor(params.clusterId);
      const stopped = [];
      for (let index = 0; index < members.length; index++) {
        if (signal.aborted) throw signal.reason;
        const member = members[index];
        if (!stillMember(params.clusterId, member.id)) continue;
        if (!running(member.id)) continue;
        progress(
          index / members.length,
          MESSAGES.progress
            .replace('{action}', MESSAGES.actions.stop)
            .replace('{name}', member.name)
            .replace('{index}', index + 1)
            .replace('{count}', members.length),
        );
        await supervisor.stop(member.id);
        stopped.push(member.id);
      }
      return { stopped };
    },
  };
}
