/**
 * The GUI panel's wire to the Host: three small JSON routes on the Host's web server.
 *
 * The Host owns the workspace registry, so a browser panel cannot move a Workspace
 * by itself — it needs a transport. `ctx.webServer.register` publishes routes but
 * has no auth of its own, so every handler first asks the platform's own trust
 * fence (`connection.requestRejection`: 401 without the browser's session cookie,
 * 403 for a foreign Origin or a cross-site marker) and only falls back to a
 * loopback + same-origin check when a composition has no `connection` service.
 *
 * Parameters travel in the query string, never a body: the desktop shell forwards a
 * page `fetch` through its own protocol handler, and a URL survives that trip in
 * one piece while a body only adds a failure mode — every parameter here is a path
 * or a boolean.
 */
import { describeStatus, planSwitch, applySwitch, repairLogs } from './switch.js';
import { renderStatus, renderSwitch, renderRepair, plain } from './tool.js';

/** Route base; the client half resolves it document-relative. */
export const API_BASE = '/dsh-default-workspace/api';

/** One route per action. */
export const ROUTES = {
  status: `${API_BASE}/status`,
  switch: `${API_BASE}/switch`,
  repair: `${API_BASE}/repair`,
};

/** Read a query flag: `1`, `true` or `yes` are true. */
function flag(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Build the action table that the routes and the tests share.
 *
 * @param options.dependencies - resolves Host services per call.
 * @param options.sessionsRoot - optional override for the sessions log root.
 * @returns {Record<string, (params: URLSearchParams) => Promise<object>>}
 */
export function createActions({ dependencies, sessionsRoot }) {
  const rootOf = (deps) => sessionsRoot ?? deps.persistence?.root;

  return {
    async status() {
      return { action: 'status', ...(await describeStatus(dependencies())) };
    },

    async switch(params) {
      const path = (params.get('path') ?? '').trim();
      if (path.length === 0) throw new Error('`path` is required: the absolute directory to become the default Workspace');
      const deps = dependencies();
      const moveFiles = flag(params, 'moveFiles', false);
      const migrateSessions = flag(params, 'migrateSessions', true);
      const dryRun = flag(params, 'dryRun', false);
      const plan = await planSwitch({ ...deps, path, moveFiles, migrateSessions, sessionsRoot });
      if (dryRun || plan.noop) {
        return { action: 'switch', dryRun: true, applied: false, text: renderSwitch({ action: 'switch', dryRun: true, plan }), plan };
      }
      const report = await applySwitch({ registry: deps.registry, persistence: deps.persistence, plan, moveFiles, migrateSessions });
      return { action: 'switch', dryRun: false, applied: true, text: renderSwitch({ action: 'switch', dryRun: false, plan, report }), plan, report };
    },

    async repair(params) {
      const deps = dependencies();
      const root = rootOf(deps);
      if (typeof root !== 'string') {
        throw new Error('the sessions log root is unknown: set `sessionsRoot` in the bundle config');
      }
      const report = await repairLogs({ root, dryRun: flag(params, 'dryRun', true) });
      return { action: 'repair', text: renderRepair({ action: 'repair', report }), report };
    },
  };
}

/** The request reached us over loopback. */
function loopbackPeer(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Ask the platform's trust fence, then fall back to a loopback + same-origin check.
 *
 * @returns {401 | 403 | undefined} the rejection status, or `undefined` to proceed.
 */
export function requestRejection(ctx, req) {
  const connection = ctx.get?.('connection');
  if (typeof connection?.requestRejection === 'function') {
    const verdict = connection.requestRejection(req);
    return verdict === 401 || verdict === 403 ? verdict : undefined;
  }
  if (!loopbackPeer(req)) return 403;
  const host = req.headers.host;
  if (host === undefined) return 403;
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host ? undefined : 403;
  } catch {
    return 403;
  }
}

/** Answer with JSON, never cached. */
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Mount the three routes on the Host's web server.
 *
 * @param ctx - the plugin context (must be able to reach `webServer`).
 * @param options.dependencies - resolves Host services per request.
 * @param options.sessionsRoot - optional override for the sessions log root.
 */
export function registerWebRoutes(ctx, { dependencies, sessionsRoot }) {
  const actions = createActions({ dependencies, sessionsRoot });

  for (const [action, path] of Object.entries(ROUTES)) {
    ctx.effect(() => {
      const webServer = ctx.get?.('webServer');
      if (typeof webServer?.register !== 'function') return () => {};
      return webServer.register(
        {
          kind: 'exact',
          path,
          handler: async (req, res) => {
            const rejection = requestRejection(ctx, req);
            if (rejection !== undefined) {
              send(res, rejection, {
                ok: false,
                error:
                  rejection === 401
                    ? 'this request carries no browser session — operate the panel from the DSH page'
                    : 'the platform trust fence rejected this request (host, origin or cross-site marker)',
              });
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' });
              res.end();
              return;
            }
            try {
              const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
              send(res, 200, { ok: true, ...plain(await actions[action](params)) });
            } catch (error) {
              send(res, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        },
        `dsh-default-workspace ${action}`,
      );
    }, `dsh-default-workspace.route:${action}`);
  }
}
