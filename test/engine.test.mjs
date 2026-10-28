// Offline harness: exercise the switch engine against a fake registry that
// mirrors the Host's WorkspaceRegistry/WorkspaceEntity semantics.
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { describeStatus, planSwitch, applySwitch, repairLogs, samePath, scanLogHealth } from '../lib/switch.js';
import { decodeLog, inspectLog } from '../lib/zstd-multi.js';
import { encodeSegment, logFilename, projectKey, sessionDir } from '../lib/paths.js';

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-default-workspace-engine-'));
const assertions = [];
function check(label, condition, detail) {
  assertions.push({ label, ok: Boolean(condition), detail });
  if (!condition) console.error(`FAIL ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

class FakeEntity {
  constructor(host, id, record) {
    this.host = host;
    this.id = id;
    this.record = record;
  }
  get path() { return this.record.path; }
  get title() { return this.record.title; }
  get sessionIds() { return this.record.sessionIds.filter((id) => this.host.candidateMatches(id, this.record.path)); }
  async mutate(fn) {
    const changed = fn(this.record);
    const sessionIds = changed.sessionIds.filter((id) => this.host.candidateMatches(id, changed.path));
    this.record = { ...changed, sessionIds, updatedAt: new Date().toISOString() };
    this.host.table().records.set(this.id, this.record);
  }
}

class FakeRegistry {
  constructor(records, defaultId) {
    this.state = { defaultWorkspaceId: defaultId, workspaceIds: [...records.keys()] };
    this.paths = new Map();
    this.missing = new Set();
    this.records = new Map(records);
    this.entities = new Map();
    const host = {
      table: () => ({ records: this.records, update: async (id, fn) => fn(this.records.get(id)) }),
      candidateMatches: (id, path) => this.paths.get(id) === path || this.missing.has(id),
      rememberSessionPath: (id, path) => {
        this.paths.set(id, path);
        this.missing.delete(id);
      },
    };
    this.host = host;
    for (const [id, record] of this.records) this.entities.set(id, new FakeEntity(host, id, record));
  }
  get(id) { return this.entities.get(id); }
  list() { return this.state.workspaceIds.map((id) => this.entities.get(id)); }
}

function storedLog(header, events, { plain = false, frames = 3 } = {}) {
  const headerLine = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
  const eventLines = events.map((event) => Buffer.from(JSON.stringify(event) + '\n', 'utf8'));
  if (plain) return Buffer.concat([headerLine, ...eventLines]);
  const parts = [zstdCompressSync(headerLine)];
  const perFrame = Math.ceil(eventLines.length / Math.max(1, frames - 1)) || 1;
  for (let index = 0; index < eventLines.length; index += perFrame) {
    parts.push(zstdCompressSync(Buffer.concat(eventLines.slice(index, index + perFrame))));
  }
  return Buffer.concat(parts);
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  const root = join(ROOT, 'sessions');
  const oldPath = join(ROOT, 'old-ws');
  const newPath = join(ROOT, 'new-ws');
  await mkdir(root, { recursive: true });
  await mkdir(join(oldPath, 'nested'), { recursive: true });
  await writeFile(join(oldPath, 'a.txt'), 'alpha');
  await writeFile(join(oldPath, 'nested', 'b.txt'), 'beta');

  const liveId = 'session-live';
  const deadId = 'session-dead';
  const plainId = 'session-plain';
  const staleId = 'session-other-path';
  const brokenId = 'session-broken';

  for (const [id, compressed, cwd] of [
    [liveId, true, oldPath],
    [deadId, true, oldPath],
    [plainId, false, oldPath],
    [staleId, true, join(ROOT, 'somewhere-else')],
  ]) {
    const dir = sessionDir(root, cwd, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, logFilename(4, compressed ? 'zstd' : 'plain')),
      storedLog(
        { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd, agentPreset: 'standard' },
        [
          { type: 'session/start', n: 1 },
          { type: 'user/message', text: 'héllo — unicode 世界' },
          { type: 'assistant/message', n: 3 },
        ],
        { plain: !compressed },
      ),
    );
  }

  // A log whose header shares one frame with the events: the Host skips it silently.
  {
    const dir = sessionDir(root, oldPath, brokenId);
    await mkdir(dir, { recursive: true });
    const headerLine = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: brokenId, createdAt: 2, isSeeded: false, delegationDepth: 0, cwd: oldPath }) + String.fromCharCode(10), 'utf8');
    const events = Buffer.from([{ type: 'user/message', text: 'single frame' }, { type: 'assistant/message', n: 2 }].map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    await writeFile(join(dir, logFilename()), zstdCompressSync(Buffer.concat([headerLine, events])));
  }

  const records = new Map([
    ['ws-default', { path: oldPath, title: 'default-workspace', createdAt: 1, updatedAt: 1, sessionIds: [liveId, deadId, plainId, brokenId] }],
    ['ws-other', { path: join(ROOT, 'other-ws'), title: 'other', createdAt: 1, updatedAt: 1, sessionIds: [] }],
  ]);
  const registry = new FakeRegistry(records, 'ws-default');
  for (const id of [liveId, deadId, plainId, brokenId]) registry.host.rememberSessionPath(id, oldPath);
  // `liveId` models a live Conversation: its log is on disk and listed, but the Host holds it open.
  const sessions = { list: () => [{ id: liveId, header: { cwd: oldPath } }] };
  const persistence = {
    root,
    list: async () => [liveId, deadId, plainId, brokenId, staleId].map((id) => ({
      header: { id, cwd: id === staleId ? join(ROOT, 'somewhere-else') : oldPath },
      sizeBytes: 1,
    })),
  };

  // --- status -------------------------------------------------------------
  const status = await describeStatus({ registry, sessions, persistence, sessionsRoot: root });
  check('status reports the default path', status.defaultWorkspace.path === oldPath, status.defaultWorkspace);
  check('status lists live sessions of the default path', status.defaultWorkspace.liveSessions.length === 1, status.defaultWorkspace.liveSessions);
  check('status counts durable sessions including the broken log', status.defaultWorkspace.sessions === 4, status.defaultWorkspace.sessions);
  check('status flags the log whose first frame is not a header frame', status.logs.unreadable === 1 && status.logs.unreadableIds[0] === brokenId, status.logs);
  const brokenHealth = await scanLogHealth(root);
  check('health scan separates readable from unreadable logs', brokenHealth.total === 5 && brokenHealth.readable === 4, [brokenHealth.total, brokenHealth.readable]);

  // --- plan refuses to move files under a live Session --------------------
  let refused = false;
  try {
    await planSwitch({ registry, sessions, persistence, path: newPath, moveFiles: true });
  } catch (error) {
    refused = /live Session/.test(error.message);
  }
  check('plan refuses moveFiles while a live Session works in the old directory', refused);

  // --- plan refuses a path owned by another workspace ---------------------
  let claimed = false;
  try {
    await planSwitch({ registry, sessions, persistence, path: join(ROOT, 'other-ws') });
  } catch (error) {
    claimed = /already owned/.test(error.message);
  }
  check('plan refuses a path already owned by another workspace', claimed);

  // --- dry run ------------------------------------------------------------
  const plan = await planSwitch({ registry, sessions, persistence, path: newPath });
  check('plan marks dead sessions for relocation', plan.sessions.map((item) => item.id).sort().join(',') === [deadId, plainId, brokenId].sort().join(','), plan.sessions);
  check('plan skips the live session', plan.liveSkipped.length === 1 && plan.liveSkipped[0] === liveId, plan.liveSkipped);
  check('plan ignores sessions of other paths', !plan.sessions.some((item) => item.id === staleId));
  check('dry run leaves the record alone', registry.get('ws-default').path === oldPath);

  // --- apply --------------------------------------------------------------
  const beforeDead = await readFile(join(sessionDir(root, oldPath, deadId), logFilename()));
  const beforePlain = await readFile(join(sessionDir(root, oldPath, plainId), logFilename(4, 'plain')));
  const beforeBroken = inspectLog(await readFile(join(sessionDir(root, oldPath, brokenId), logFilename()))).rest;
  const report = await applySwitch({ registry, persistence, plan, moveFiles: false, migrateSessions: true });
  check('record path updated', registry.get('ws-default').path === newPath, registry.get('ws-default').path);
  check('report lists every relocated session', report.migratedSessions.length === 3, report.migratedSessions.map((item) => item.id));

  const afterDead = await readFile(join(sessionDir(root, newPath, deadId), logFilename()));
  const afterPlain = await readFile(join(sessionDir(root, newPath, plainId), logFilename(4, 'plain')));
  const headerDead = JSON.parse(decodeLog(afterDead).text.subarray(0, decodeLog(afterDead).text.indexOf(0x0a)).toString('utf8'));
  check('compressed log header cwd rewritten', samePath(headerDead.cwd, newPath), headerDead.cwd);
  const before = decodeLog(beforeDead);
  const after = decodeLog(afterDead);
  check('compressed log keeps its frame count', before.frames.length === after.frames.length, [before.frames.length, after.frames.length]);
  check(
    'compressed log keeps every event byte',
    before.text.subarray(before.text.indexOf(0x0a) + 1).equals(after.text.subarray(after.text.indexOf(0x0a) + 1)),
  );
  const headerPlain = JSON.parse(afterPlain.toString('utf8').split('\n')[0]);
  check('plaintext log header cwd rewritten', samePath(headerPlain.cwd, newPath), headerPlain.cwd);
  check('plaintext log keeps every event byte', beforePlain.toString('utf8').split('\n').slice(1).join('\n') === afterPlain.toString('utf8').split('\n').slice(1).join('\n'));

  const afterBroken = await readFile(join(sessionDir(root, newPath, brokenId), logFilename()));
  const brokenReport = inspectLog(afterBroken);
  check('a single-frame log becomes readable by the Host', brokenReport.readable === true, brokenReport.reason);
  check('re-framing splits the header out of the shared frame', brokenReport.frames >= 2, brokenReport.frames);
  check('re-framed log keeps the new header cwd', samePath(brokenReport.header.cwd, newPath), brokenReport.header.cwd);
  check('re-framing keeps every event byte', brokenReport.rest.equals(beforeBroken));

  const oldDirs = await readdir(projectKeyDir(root, oldPath)).catch(() => []);
  check('old project directory keeps only the live session', oldDirs.join(',') === encodeSegment(liveId), oldDirs);
  const backup = join(root, '..', 'backups');
  const backups = await readdir(backup);
  check('originals retired into a backup tree', backups.length === 1 && backups[0].startsWith('session-cwd-migration-'), backups);
  const backed = await readdir(join(backup, backups[0], projectKey(oldPath)));
  check('backup holds every retired session directory', backed.length === 3, backed);

  // the live session was pruned from the record because its cwd no longer matches
  check('live session left attached to the old path is dropped from the record', !registry.get('ws-default').record.sessionIds.includes(liveId), registry.get('ws-default').record.sessionIds);
  check('relocated sessions stay attached', [deadId, plainId].every((id) => registry.get('ws-default').record.sessionIds.includes(id)), registry.get('ws-default').record.sessionIds);

  // --- second call: unknown target is created, noop detection works ------
  const deeper = join(ROOT, 'created', 'on-demand');
  const plan2 = await planSwitch({ registry, sessions, persistence, path: newPath });
  check('switching to the current path is a no-op', plan2.noop === true);
  const third = await applySwitch({
    registry,
    persistence,
    plan: await planSwitch({ registry, sessions, persistence, path: deeper }),
    moveFiles: false,
    migrateSessions: true,
  });
  check('a missing target directory is created', (await stat(deeper)).isDirectory());
  check('no sessions of the previous path are migrated twice', third.migratedSessions.length === 0, third.migratedSessions);

  // --- repair an in-place broken log -------------------------------------
  const repairRoot = join(ROOT, 'repair-sessions');
  const repairCwd = join(ROOT, 'repair-ws');
  const repairId = 'session-needs-reframe';
  const repairDir = sessionDir(repairRoot, repairCwd, repairId);
  await mkdir(repairDir, { recursive: true });
  const repairHeader = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: repairId, createdAt: 3, isSeeded: false, delegationDepth: 0, cwd: repairCwd }) + String.fromCharCode(10), 'utf8');
  const repairEvents = Buffer.from(JSON.stringify({ type: 'user/message', text: 'repair me' }) + String.fromCharCode(10), 'utf8');
  await writeFile(join(repairDir, logFilename()), zstdCompressSync(Buffer.concat([repairHeader, repairEvents])));
  const repairPlan = await repairLogs({ root: repairRoot, dryRun: true });
  check('repair dry run changes nothing', repairPlan.dryRun === true && repairPlan.unreadable === 1 && (await readdir(repairDir)).length === 1, repairPlan);
  const repaired = await repairLogs({ root: repairRoot });
  check('repair re-frames the unreadable log', repaired.repaired.length === 1 && repaired.failed.length === 0, repaired);
  const repairedLog = inspectLog(await readFile(join(repairDir, logFilename())));
  check('repaired log is readable and keeps its header', repairedLog.readable === true && repairedLog.header.id === repairId, repairedLog.reason);
  const repairBackups = await readdir(join(repairRoot, '..', 'backups'));
  check('repair retires the original into a backup tree', repairBackups.some((name) => name.startsWith('session-reframe-')), repairBackups);
  const cleanRun = await repairLogs({ root: repairRoot });
  check('a second repair run finds nothing to do', cleanRun.unreadable === 0 && cleanRun.repaired.length === 0, cleanRun);


  // --- a record spelling that realpath resolves elsewhere is the same directory ---
  // (GitHub's Windows runners hand mkdtemp an 8.3 short name, so the stored path and
  // the realpath of the same directory differ; a junction reproduces that shape here.)
  const realDir = join(ROOT, 'real-spelling');
  const linkDir = join(ROOT, 'link-spelling');
  await mkdir(realDir, { recursive: true });
  try {
    await symlink(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasId = 'session-alias';
    const aliasRoot = join(ROOT, 'alias-sessions');
    const aliasTarget = join(ROOT, 'alias-target');
    const aliasDir = sessionDir(aliasRoot, linkDir, aliasId);
    await mkdir(aliasDir, { recursive: true });
    await writeFile(
      join(aliasDir, logFilename()),
      storedLog(
        { type: 'session', version: 4, id: aliasId, createdAt: 4, isSeeded: false, delegationDepth: 0, cwd: linkDir },
        [{ type: 'user/message', text: 'alias' }],
      ),
    );
    const aliasRecords = new Map([['ws-alias', { path: linkDir, title: 'alias', createdAt: 1, updatedAt: 1, sessionIds: [aliasId] }]]);
    const aliasRegistry = new FakeRegistry(aliasRecords, 'ws-alias');
    aliasRegistry.host.rememberSessionPath(aliasId, linkDir);
    const aliasPersistence = { root: aliasRoot, list: async () => [{ header: { id: aliasId, cwd: linkDir }, sizeBytes: 1 }] };
    const aliasPlan = await planSwitch({ registry: aliasRegistry, sessions: { list: () => [] }, persistence: aliasPersistence, path: linkDir });
    check('a record path that realpath resolves elsewhere is recognised as the current path', aliasPlan.noop === true, aliasPlan);
    const aliasRealPlan = await planSwitch({ registry: aliasRegistry, sessions: { list: () => [] }, persistence: aliasPersistence, path: realDir });
    check('the canonical spelling of the record path is a no-op too', aliasRealPlan.noop === true, aliasRealPlan);

    // The stored header is keyed by the alias spelling while comparisons run on the
    // canonical one: the Session must still be found, moved, and re-headered.
    const aliasMovePlan = await planSwitch({ registry: aliasRegistry, sessions: { list: () => [] }, persistence: aliasPersistence, path: aliasTarget });
    check('an aliased record still finds its Sessions for relocation', aliasMovePlan.sessions.length === 1 && aliasMovePlan.sessions[0].id === aliasId, aliasMovePlan.sessions);
    const aliasReport = await applySwitch({
      registry: aliasRegistry,
      persistence: aliasPersistence,
      plan: aliasMovePlan,
      moveFiles: false,
      migrateSessions: true,
    });
    check('an aliased Session is relocated', aliasReport.migratedSessions.length === 1, aliasReport);
    const aliasMoved = inspectLog(await readFile(join(sessionDir(aliasRoot, aliasTarget, aliasId), logFilename())));
    check('the relocated log carries the new cwd', aliasMoved.readable === true && samePath(aliasMoved.header.cwd, aliasTarget), aliasMoved.header);
  } catch (error) {
    check('a symlinked temp directory is available for the alias scenario', false, String(error));
  }

  await rm(ROOT, { recursive: true, force: true });
  const failures = assertions.filter((item) => !item.ok);
  console.log(`\n${assertions.length - failures.length}/${assertions.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

function projectKeyDir(root, cwd) {
  return join(root, projectKey(cwd));
}

await main();
