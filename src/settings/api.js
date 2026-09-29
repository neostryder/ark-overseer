import { DriftError, RESOLVE_JOB, keysOf, DRIFT_MESSAGES } from './drift.js';

const ACTIVE = new Set(['running', 'starting', 'unknown']);

// The routes for settings that changed outside ARK Overseer. `messages` is the app's API_MESSAGES, and
// `fileJobRunning` says whether a job that changes the server's files is queued or running.
export function registerDriftRoutes({
  router,
  db,
  drift,
  jobs,
  supervisor,
  protectedRoute,
  must,
  error,
  serverRow,
  messages,
  fileJobRunning,
}) {
  const fromError = (cause) =>
    cause instanceof DriftError ? error(cause.status, cause.message, { code: cause.code }) : cause;
  const running = (server) => ACTIVE.has(supervisor.status(server.id)?.observedState);
  // No await between this check and the enqueue that follows it, so two requests cannot both find the server free.
  const assertFree = (server) => {
    const busy = db
      .prepare("SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND (server_id = ? OR install_id = ?) LIMIT 1")
      .get(server.id, server.install_id);
    if (busy) throw error(409, messages.jobRunning);
  };
  const ACTIONS = new Set(['adopt', 'revert', 'merge']);

  router.add('GET', '/api/servers/:id/settings/drift', async ({ params }) => {
    const server = must(serverRow(db, params.id));
    const state = await drift.checkDrift(server, { force: true });
    return { ...state, keepAfterStop: drift.keepEnabled(server), serverRunning: running(server) };
  });

  router.add(
    'POST',
    '/api/servers/:id/settings/drift/seen',
    protectedRoute('server.settings.drift_seen', 'server', ({ params }) => {
      must(serverRow(db, params.id));
      return drift.markSeen(params.id);
    }),
  );

  router.add(
    'POST',
    '/api/servers/:id/settings/drift/resolve',
    protectedRoute(
      (ctx) =>
        ACTIONS.has(ctx.body?.action) ? `server.settings.drift_${ctx.body.action}` : 'server.settings.drift_resolve',
      'server',
      async ({ params, body }) => {
        const server = must(serverRow(db, params.id));
        // A restore swaps settings files one by one, and a change in the middle would mix with it.
        if (fileJobRunning(server.id)) throw error(409, messages.jobRunning);
        try {
          assertFree(server);
          if (body.action === 'adopt') return await drift.adopt(server, body.liveSha256);
          const plan = await drift.planFor(server, body);
          // Another request may have queued a job while the plan was being made, so the server is looked at again with
          // no await before the job is queued.
          assertFree(server);
          const job = jobs.enqueue(
            RESOLVE_JOB,
            {
              action: plan.action,
              liveSha256: body.liveSha256,
              ...(plan.action === 'merge'
                ? {
                    choices: body.choices.map(({ file, section, key, choice }) => ({ file, section, key, choice })),
                  }
                : {}),
            },
            { serverId: server.id, installId: server.install_id },
          );
          return { ...job, keys: keysOf(plan.entries), serverRunning: running(server) };
        } catch (cause) {
          throw fromError(cause);
        }
      },
      (ctx, result) => ({ action: ctx.body?.action ?? null, keys: result?.keys ?? [] }),
    ),
  );

  router.add(
    'PUT',
    '/api/servers/:id/settings/drift/keep',
    protectedRoute(
      'server.settings.keep_after_stop',
      'server',
      ({ params, body }) => {
        must(serverRow(db, params.id));
        if (typeof body.enabled !== 'boolean') throw error(400, DRIFT_MESSAGES.badKeepOption);
        return drift.setKeepAfterStop(params.id, body.enabled);
      },
      (ctx) => ({ enabled: ctx.body?.enabled }),
    ),
  );
}
