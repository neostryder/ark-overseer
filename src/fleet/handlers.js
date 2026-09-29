import { checkFleet } from './core.js';
import { MESSAGES as CLUSTER_MESSAGES } from '../clusters/core.js';
import { runMemberSequence } from './sequence.js';
import { createTell, defaultSleep, runCountdown } from '../scheduler/countdown.js';
import { createScheduleHandlers, PLAYER_MESSAGES } from '../scheduler/handlers.js';
import { readLogMarker, waitForReady } from '../supervisor/ready.js';
import { serverPaths } from '../supervisor/launch.js';

export const MESSAGES = {
  progress: '{action} {name}, server {index} of {count}.',
  failed: '{name} did not finish, so the servers after it were left as they are. {reason}',
};

export function createFleetHandlers({
  db,
  dataDir,
  steamcmd,
  supervisor,
  rcon,
  getRconPassword,
  sleep = defaultSleep,
  now = () => Date.now(),
  ready = waitForReady,
  marker = readLogMarker,
}) {
  const tell = createTell({ rcon, getRconPassword });
  const scheduled = createScheduleHandlers({ db, dataDir, steamcmd, supervisor, rcon, getRconPassword, sleep, now });
  const running = (id) => ['running', 'starting', 'unknown'].includes(supervisor.status(id)?.observedState);
  const row = (id) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path, i.source AS install_source FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
      )
      .get(id);
  const wait = async (member, signal, start) => {
    const logPath = serverPaths(member.install_path).logPath;
    const oldMarker = await marker(logPath);
    const since = now();
    await start();
    await ready({ logPath, since, marker: oldMarker, isAlive: () => running(member.id), signal });
  };
  return {
    'fleet.action': async ({ job, params, signal, progress }) => {
      const checked = checkFleet(params, db);
      const announce = checked.announce ?? 'chat';
      const action = checked.action;
      // Cancellation is observed after the current member has finished its action.
      const stepSignal = new AbortController().signal;
      const result = await runMemberSequence({
        members: checked.members,
        signal,
        progress,
        action,
        current: (member) => row(member.id),
        skip: (member) =>
          action === 'start'
            ? running(member.id)
            : action === 'stop' || action === 'restart'
              ? !running(member.id)
              : member.install_source === 'steam-client',
        message: (verb, member, index, count) =>
          MESSAGES.progress
            .replace('{action}', CLUSTER_MESSAGES.actions[verb])
            .replace('{name}', member.name)
            .replace('{index}', index)
            .replace('{count}', count),
        perform: async (member) => {
          try {
            if (action === 'start') await wait(member, stepSignal, () => supervisor.start(member.id));
            else if (action === 'stop') await supervisor.stop(member.id);
            else if (action === 'restart') {
              await runCountdown(
                { tell, sleep },
                [member],
                checked.countdownMinutes ?? [10, 5, 1],
                PLAYER_MESSAGES.restart,
                announce,
                signal,
                progress,
              );
              if (signal.aborted) throw signal.reason;
              if (!running(member.id)) return false;
              await tell(member, announce, PLAYER_MESSAGES.restarting).catch(() => {});
              await wait(member, stepSignal, () => supervisor.restart(member.id));
            } else {
              const wasRunning = running(member.id);
              const logPath = serverPaths(member.install_path).logPath;
              const oldMarker = wasRunning ? await marker(logPath) : null;
              const since = now();
              const updated = await scheduled['install.auto_update']({
                job: { ...job, installId: member.install_id },
                params: checked,
                signal: stepSignal,
                countdownSignal: signal,
                progress,
              });
              if (!updated.updated) return false;
              if (wasRunning) {
                await ready({
                  logPath,
                  since,
                  marker: oldMarker,
                  isAlive: () => running(member.id),
                  signal: stepSignal,
                });
              }
            }
          } catch (error) {
            if (signal.aborted && action === 'restart')
              await tell(member, announce, PLAYER_MESSAGES.cancelled).catch(() => {});
            if (signal.aborted) throw signal.reason;
            throw new Error(MESSAGES.failed.replace('{name}', member.name).replace('{reason}', error.message));
          }
        },
      });
      return { action, completed: result.done, skipped: result.skipped };
    },
  };
}
