// Route test: the GUI panel reaches the Host through three JSON routes, so the
// action table must refuse a missing path, default every boolean safely, and only
// touch the registry when the caller did not ask for a dry run.
import { mkdir, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { createActions, ROUTES, API_BASE, requestRejection } from '../lib/web.js';
import { logFilename, sessionDir } from '../lib/paths.js';

const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok: Boolean(ok) });
  if (!ok) console.error(`FAIL ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
};

/** A registry stub with the methods the engine reads. */
function registryStub(record) {
  /** One entity over the shared record object, like the Host's own entity. */
  const entity = {
    id: record.id,
    get path() {
      return record.path;
    },
    get title() {
      return record.title;
    },
    get sessionIds() {
      return [];
    },
    async mutate(fn) {
      Object.assign(record, fn(record));
    },
  };
  return {
    list: () => [entity],
    get: (id) => (id === record.id ? entity : undefined),
    state: { defaultWorkspaceId: record.id },
    table: { update: () => {} },
    host: { rememberSessionPath: () => {} },
  };
}

/** One healthy stored log, so `describeStatus` reports a readable root. */
async function seedLog(root, cwd, id, text) {
  const dir = sessionDir(root, cwd, id);
  await mkdir(dir, { recursive: true });
  await (await import('node:fs/promises')).writeFile(join(dir, logFilename(4, 'zstd')), zstdCompressSync(text));
}

/** Lossless JSON: `undefined` anywhere makes the envelope fail validation. */
async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-default-workspace-rpc-'));
  const sessionsRoot = join(root, 'sessions');
  const oldPath = join(root, 'old-ws');
  const newPath = join(root, 'new-ws');
  await mkdir(oldPath, { recursive: true });
  await mkdir(newPath, { recursive: true });
  await seedLog(sessionsRoot, oldPath, 'session-a', '{"type":"session","version":4}\n');

  try {
    const record = { id: 'ws-1', path: oldPath, title: 'default-workspace', sessionIds: ['session-a'] };
    const registry = registryStub(record);
    const persistence = { root: sessionsRoot, list: () => [{ id: 'session-a', header: { cwd: oldPath } }] };
    const actions = createActions({
      dependencies: () => ({ registry, sessions: { get: () => undefined, list: () => [] }, persistence, sessionsRoot }),
      sessionsRoot,
    });
    const params = (query) => new URLSearchParams(query);

    check('three routes are published', Object.keys(ROUTES).join(',') === 'status,switch,repair', ROUTES);
    check('every route sits under the API base', Object.values(ROUTES).every((path) => path.startsWith(API_BASE)), ROUTES);

    const status = await actions.status(params(''));
    check('status answers ok', status.ok === true, status);
    check('status reports the current default', status.defaultWorkspace.path === oldPath, status.defaultWorkspace);
    check('status names itself', status.action === 'status', status.action);

    const plan = await actions.switch(params(`path=${encodeURIComponent(newPath)}&dryRun=1`));
    check('a dry switch applies nothing', plan.applied === false, plan);
    check('a dry switch carries the plan', plan.plan?.noop === false, plan.plan);
    check('a dry switch renders text', /DRY RUN|Preview|preview/.test(plan.text), plan.text?.slice(0, 80));
    check('a dry switch left the record alone', record.path === oldPath, record.path);

    const noop = await actions.switch(params(`path=${encodeURIComponent(oldPath)}`));
    check('switching to the current path is a no-op', noop.plan.noop === true, noop.plan);

    let missing;
    try {
      await actions.switch(params(''));
    } catch (error) {
      missing = String(error.message);
    }
    check('a switch without path is refused', /`path` is required/.test(missing ?? ''), missing);

    const repairDry = await actions.repair(params(''));
    check('repair defaults to a dry run', repairDry.report.dryRun === true, repairDry.report);
    check('repair reports the stored log count', repairDry.report.total === 1, repairDry.report);

    const failing = createActions({
      dependencies: () => {
        throw new Error('workspaceRegistry is unavailable');
      },
    });
    let failed;
    try {
      await failing.status(params(''));
    } catch (error) {
      failed = String(error.message);
    }
    check('a thrown dependency surfaces as an error', /unavailable/.test(failed ?? ''), failed);

    const noRoot = createActions({ dependencies: () => ({ registry, persistence: undefined }), sessionsRoot: undefined });
    let missingRoot;
    try {
      await noRoot.repair(params(''));
    } catch (error) {
      missingRoot = String(error.message);
    }
    check('repair without a sessions root is refused', /sessions log root is unknown/.test(missingRoot ?? ''), missingRoot);

    const rejecting = { get: () => ({ requestRejection: () => 401 }) };
    check('a request without a session is rejected', requestRejection(rejecting, { headers: {} }) === 401, 'not 401');
    const allowing = { get: () => ({ requestRejection: () => undefined }) };
    check('an authorised request passes the fence', requestRejection(allowing, { headers: {} }) === undefined, 'rejected');
    const noConnection = { get: () => undefined };
    check(
      'a non-loopback peer is refused without the platform fence',
      requestRejection(noConnection, { headers: {}, socket: { remoteAddress: '10.0.0.7' } }) === 403,
      'not 403',
    );
    check(
      'a loopback peer passes without the platform fence',
      requestRejection(noConnection, { headers: { host: '127.0.0.1:7026' }, socket: { remoteAddress: '127.0.0.1' } }) === undefined,
      'rejected',
    );

    const failures = checks.filter((item) => !item.ok);
    console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();

