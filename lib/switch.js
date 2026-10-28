/**
 * Reading and changing DSH's default Workspace.
 *
 * The Host has no API to relocate a Workspace: its identity is durable and its
 * `path` is immutable by design ("the Host never renames or relocates an
 * existing default"). Three things therefore have to move together, and this
 * module does exactly those three:
 *
 *  1. the Workspace record's `path`, written through the registry's own domain
 *     write chain (`entity.mutate`), so the durable store and the running
 *     registry agree without a restart;
 *  2. the directory contents, when `moveFiles` asks for it;
 *  3. every stored Session whose header `cwd` is the old path — the header's
 *     `cwd` is rewritten and the log is moved into the project directory the
 *     new `cwd` derives, because the Host refuses a log that disagrees with its
 *     header.
 *
 * Sessions serving a live Conversation cannot be relocated (their open log
 * handle, lease, and running tool calls all point at the old tree), so they are
 * reported and left alone.
 */
import { createHash } from 'node:crypto';
import { constants as FS } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { decodeLog, inspectLog, isHeaderFrame, rewriteHeader } from './zstd-multi.js';
import { encodeSegment, isFullyQualifiedPath, logFilename, projectDir, projectKey, sessionDir } from './paths.js';

const BACKUP_DIR_PREFIX = 'session-cwd-migration-';

/** Host instant, used only for backup folder names. */
function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Compare two absolute paths the way the host's own indexes do on this platform. */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `child` is `parent` or lives beneath it. */
export function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsoluteLocal(rel));
}

function isAbsoluteLocal(value) {
  return value.startsWith(sep) || /^[A-Za-z]:/.test(value);
}

/** Resolve a caller-supplied path to the spelling the Host stores. */
export async function canonicalPath(raw, { create = false } = {}) {
  if (!isFullyQualifiedPath(resolve(raw))) throw new Error(`"${raw}" is not an absolute path`);
  const absolute = resolve(raw);
  if (create) await mkdir(absolute, { recursive: true });
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function exists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Every live (loaded) Conversation Session and its working directory. */
function liveSessionsOf(sessions) {
  const list = sessions?.list?.() ?? [];
  const out = [];
  for (const session of list) {
    const cwd = session?.header?.cwd;
    if (typeof session?.id === 'string') out.push({ id: session.id, cwd });
  }
  return out;
}

/** The registry's default Workspace entity, or undefined when none is registered. */
export function defaultEntity(registry) {
  const state = registry?.state ?? registry?.requireState?.();
  const id = state?.defaultWorkspaceId;
  if (typeof id !== 'string') return undefined;
  const entity = registry.get?.(id);
  return entity === undefined ? undefined : { id, entity, state };
}

/** Every stored Session header (id + cwd + size) known to the persistence backend. */
async function storedSessions(persistence) {
  const snapshots = (await persistence.list()) ?? [];
  const out = [];
  for (const snapshot of snapshots) {
    const header = snapshot?.header;
    if (typeof header?.id !== 'string') continue;
    out.push({ id: header.id, cwd: header.cwd, sizeBytes: snapshot.sizeBytes });
  }
  return out;
}

/** Locate one stored Session log, tolerating older generations on disk. */
async function locateLog(root, id, cwd) {
  const dir = sessionDir(root, cwd, id);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const current = logFilename();
  const preferred = names.includes(current) ? current : names.filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name)).sort().at(-1);
  return preferred === undefined ? undefined : { path: join(dir, preferred), filename: preferred, compressed: preferred.endsWith('.zstd'), dir };
}

/** Distinct spellings of the same directory, in the order given. */
function spellingsOf(...values) {
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (out.some((other) => samePath(other, value))) continue;
    out.push(value);
  }
  return out;
}

/** Locate a stored log under any of the spellings that name the same directory. */
async function locateLogAny(root, id, spellings) {
  for (const cwd of spellings) {
    const located = await locateLog(root, id, cwd);
    if (located !== undefined) return { ...located, cwd };
  }
  return undefined;
}

/** Rewrite one stored log's header `cwd`, verifying the rest of the log byte-for-byte. */
function relocateBuffer(buf, compressed, { from, to, id, filename }) {
  if (compressed) {
    const { output, header } = rewriteHeader(buf, (current) => {
      if (!samePath(current.cwd, from)) throw new Error(`log "${filename}" carries cwd "${current.cwd}", expected "${from}"`);
      return { ...current, cwd: to };
    });
    if (header.id !== id) throw new Error(`log "${filename}" carries id "${header.id}", expected "${id}"`);
    const checked = inspectLog(output);
    if (!checked.readable) throw new Error(`rewriting "${filename}" left an unreadable log: ${checked.reason}`);
    const before = decodeLog(buf).text;
    const after = decodeLog(output).text;
    const cut = before.indexOf(0x0a);
    if (cut < 0) throw new Error(`log "${filename}" has no header line`);
    if (!after.subarray(after.indexOf(0x0a) + 1).equals(before.subarray(cut + 1))) {
      throw new Error(`rewriting "${filename}" would change event bytes; refusing`);
    }
    return { output, header };
  }
  const text = buf.toString('utf8');
  const cut = text.indexOf('\n');
  if (cut < 0) throw new Error(`log "${filename}" has no header line`);
  const header = JSON.parse(text.slice(0, cut));
  if (!samePath(header.cwd, from)) throw new Error(`log "${filename}" carries cwd "${header.cwd}", expected "${from}"`);
  if (header.id !== id) throw new Error(`log "${filename}" carries id "${header.id}", expected "${id}"`);
  const nextHeader = { ...header, cwd: to };
  const output = Buffer.from(JSON.stringify(nextHeader) + text.slice(cut), 'utf8');
  return { output, header: nextHeader };
}

/** Write a relocated log atomically into its new Session directory. */
async function writeRelocated(target, output) {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(output);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
}

/**
 * Describe the current default Workspace and the other registered Workspaces.
 * @returns a plain report object.
 */
export async function describeStatus({ registry, sessions, persistence, sessionsRoot }) {
  const found = defaultEntity(registry);
  const live = liveSessionsOf(sessions);
  const liveIds = new Set(live.map((item) => item.id));
  const root = sessionsRoot ?? persistence?.root;
  const health = root === undefined ? undefined : await scanLogHealth(root);
  /** A live Session counts for a Workspace when the Host has it loaded under that path or it is still attached. */
  const liveOf = (entity) => [
    ...new Set([
      ...live.filter((item) => typeof item.cwd === 'string' && samePath(item.cwd, entity.path)).map((item) => item.id),
      ...(entity.sessionIds ?? []).filter((id) => liveIds.has(id)),
    ]),
  ];
  const workspaces = (registry.list?.() ?? []).map((entity) => ({
    id: entity.id,
    title: entity.title,
    path: entity.path,
    isDefault: found?.id === entity.id,
    sessions: entity.sessionIds.length,
    liveSessions: liveOf(entity).length,
  }));
  const logs =
    health === undefined
      ? undefined
      : {
          root,
          total: health.total,
          readable: health.readable,
          unreadable: health.unreadable.length,
          unreadableIds: health.unreadable.map((item) => item.id ?? item.path),
        };
  if (found === undefined) {
    return { ok: true, action: 'status', defaultWorkspace: undefined, workspaces, liveSessions: live.length, logs };
  }
  const path = found.entity.path;
  return {
    ok: true,
    action: 'status',
    defaultWorkspace: {
      id: found.id,
      title: found.entity.title,
      path,
      exists: await isDirectory(path),
      sessions: found.entity.sessionIds.length,
      sessionIds: [...found.entity.sessionIds],
      liveSessions: liveOf(found.entity),
    },
    workspaces,
    liveSessions: live.length,
    logs,
  };
}

/**
 * Work out everything a switch would do, without changing anything.
 * @returns a plan object; throws on a request that cannot be honoured at all.
 */
export async function planSwitch({ registry, sessions, persistence, path, moveFiles = false, migrateSessions = true, sessionsRoot }) {
  const found = defaultEntity(registry);
  if (found === undefined) throw new Error('this profile has no registered default Workspace to relocate');
  const from = found.entity.path;
  const to = await canonicalPath(path, { create: false });
  // The record may hold a spelling that is not the one `realpath` returns (a short
  // 8.3 name, a symlinked documents folder, …). Operations keep using `from` — that
  // spelling is what the stored headers and project directories are keyed by — but
  // every comparison runs on the canonical form, so the same directory is
  // recognised as the same directory.
  const fromCanonical = await canonicalPath(from);
  if (samePath(from, to) || samePath(fromCanonical, to)) {
    return { from, to, noop: true, moveFiles: [], conflicts: [], sessions: [], liveSkipped: [], notes: [] };
  }

  for (const entity of registry.list?.() ?? []) {
    if (entity.id === found.id) continue;
    if (samePath(entity.path, to) || samePath(await canonicalPath(entity.path), to)) {
      throw new Error(`"${to}" is already owned by Workspace "${entity.title}" (${entity.id}); a path may back only one Workspace`);
    }
  }
  if (moveFiles && (isInside(to, fromCanonical) || isInside(fromCanonical, to))) {
    throw new Error(`cannot move "${from}" into "${to}": one path contains the other`);
  }

  const live = liveSessionsOf(sessions);
  const liveIds = new Set(live.map((item) => item.id));
  const notes = [];
  // Stored headers and project directories are keyed by the spelling the Host wrote,
  // which may be any spelling of the same directory (a short 8.3 name, a junction, a
  // symlinked documents folder). Matching therefore compares canonical forms, while
  // lookups still try the raw spellings, because `projectKey` is spelling-sensitive.
  const stored = await storedSessions(persistence);
  const canonicalOf = new Map();
  for (const item of [...stored, ...live]) {
    if (typeof item.cwd === 'string' && !canonicalOf.has(item.id)) canonicalOf.set(item.id, await canonicalPath(item.cwd));
  }
  const belongsToOld = (item) =>
    typeof item.cwd === 'string' &&
    (samePath(item.cwd, from) || samePath(item.cwd, fromCanonical) || samePath(canonicalOf.get(item.id) ?? '', fromCanonical));
  if (moveFiles) {
    const blocking = live.filter((item) => typeof item.cwd === 'string' && isInside(canonicalOf.get(item.id) ?? item.cwd, fromCanonical));
    if (blocking.length > 0) {
      throw new Error(
        `refusing to move files out of "${from}" while ${blocking.length} live Session(s) work there ` +
          `(${blocking.map((item) => item.id).join(', ')}); close them first, or switch with moveFiles=false`,
      );
    }
  }

  const entries = await moveEntries(from, to);
  const root = sessionsRoot ?? persistence?.root;
  const candidates = [];
  if (migrateSessions) {
    for (const item of stored) {
      if (!belongsToOld(item)) continue;
      if (liveIds.has(item.id)) {
        candidates.push({ id: item.id, status: 'live' });
        continue;
      }
      const located = await locateLogAny(root, item.id, spellingsOf(from, fromCanonical, item.cwd));
      if (located === undefined) {
        candidates.push({ id: item.id, status: 'log-missing' });
        notes.push(`Session ${item.id} belongs to "${from}" but its log was not found under "${root}"`);
        continue;
      }
      candidates.push({
        id: item.id,
        status: 'migrate',
        filename: located.filename,
        bytes: (await stat(located.path)).size,
        cwd: located.cwd,
        dir: located.dir,
      });
    }
  } else if (stored.some((item) => belongsToOld(item))) {
    notes.push('migrateSessions=false: Sessions of the old path keep their cwd and will re-group under it');
  }

  const health = root === undefined ? undefined : await scanLogHealth(root);
  if (health !== undefined && health.unreadable.length > 0) {
    notes.push(
      `${health.unreadable.length} stored log(s) under "${root}" carry a first frame that is not exactly one header line; ` +
        'the Host skips those silently — run action=repair',
    );
  }
  const stayingLive = candidates.filter((item) => item.status === 'live').map((item) => item.id);
  const attachedLive = stayingLive.filter((id) => (found.entity.sessionIds ?? []).includes(id));
  if (attachedLive.length > 0) {
    notes.push(
      `${attachedLive.length} live Session(s) stay at "${from}" and drop out of this workspace's session list ` +
        `(${attachedLive.join(', ')}); the Host re-groups them on its next restart`,
    );
  }

  return {
    from,
    to,
    toExists: await isDirectory(to),
    noop: false,
    logHealth: health,
    moveFiles: entries.move,
    conflicts: entries.conflicts,
    blockedMovePaths: entries.blocked,
    sessions: candidates.filter((item) => item.status === 'migrate'),
    liveSkipped: candidates.filter((item) => item.status === 'live').map((item) => item.id),
    missingLogs: candidates.filter((item) => item.status === 'log-missing').map((item) => item.id),
    notes,
    sessionsRoot: root,
  };
}

/** List top-level entries a move would carry over, and the ones that would collide. */
async function moveEntries(from, to) {
  if (!(await isDirectory(from))) return { move: [], conflicts: [], blocked: [] };
  const names = await readdir(from);
  const target = (await isDirectory(to)) ? new Set(await readdir(to)) : new Set();
  const move = [];
  const conflicts = [];
  const blocked = [];
  for (const name of names) {
    if (target.has(name)) conflicts.push(name);
    else move.push(name);
  }
  return { move, conflicts, blocked };
}

/** Move one directory entry, falling back to copy+delete across volumes. */
async function moveEntry(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyRecursive(source, target);
    await rm(source, { recursive: true, force: true });
  }
}

async function copyRecursive(source, target) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) await copyRecursive(join(source, name), join(target, name));
    return;
  }
  await copyFile(source, target);
}

/**
 * Execute a plan: move files, relocate Session logs, then rewrite the record.
 * @returns what actually changed.
 */
export async function applySwitch({ registry, persistence, plan, moveFiles = false, migrateSessions = true }) {
  const found = defaultEntity(registry);
  if (found === undefined) throw new Error('this profile has no registered default Workspace to relocate');
  const { from, to } = plan;
  const report = { action: 'switch', from, to, movedFiles: [], movedBytes: 0, migratedSessions: [], skippedLiveSessions: plan.liveSkipped, missingLogs: plan.missingLogs, warnings: [...plan.notes], recordUpdated: false, backupDir: undefined };

  if (plan.noop) {
    report.noop = true;
    return report;
  }
  await mkdir(to, { recursive: true });

  if (moveFiles) {
    if (plan.conflicts.length > 0) {
      throw new Error(
        `"${to}" already contains ${plan.conflicts.length} entry/entries that also exist in "${from}" ` +
          `(${plan.conflicts.slice(0, 10).join(', ')}${plan.conflicts.length > 10 ? ', …' : ''}); resolve them first, or switch with moveFiles=false`,
      );
    }
    for (const name of plan.moveFiles) {
      const source = join(from, name);
      await moveEntry(source, join(to, name));
      report.movedFiles.push(name);
    }
    try {
      if ((await readdir(from)).length === 0) await rmdir(from);
    } catch {
      /* leave the old directory when it is not empty or is busy */
    }
  }

  const root = plan.sessionsRoot ?? persistence?.root;
  if (migrateSessions && plan.sessions.length > 0) {
    const backupRoot = join(root, '..', 'backups', `${BACKUP_DIR_PREFIX}${stamp()}`);
    report.backupDir = backupRoot;
    for (const item of plan.sessions) {
      // `cwd`/`dir` come from the plan: a Session's log directory is keyed by the
      // spelling of its stored header, which may differ from the record's spelling.
      const spelling = item.cwd ?? from;
      const located = item.dir === undefined ? await locateLog(root, item.id, spelling) : undefined;
      const source = item.dir ?? located?.dir ?? sessionDir(root, spelling, item.id);
      const filename = item.filename ?? located?.filename;
      if (filename === undefined) {
        report.missingLogs.push(item.id);
        continue;
      }
      const buf = await readFile(join(source, filename));
      const compressed = filename.endsWith('.zstd');
      const { output, header } = relocateBuffer(buf, compressed, { from: spelling, to, id: item.id, filename });
      const targetDir = sessionDir(root, to, item.id);
      if (await exists(targetDir)) throw new Error(`refusing to overwrite an existing Session directory "${targetDir}"`);
      await writeRelocated(join(targetDir, filename), output);

      // Verify the artifact on disk before the original is retired.
      const written = await readFile(join(targetDir, filename));
      const decoded = compressed ? decodeLog(written).text : written;
      const expectedHeader = compressed ? decodeLog(buf).text : buf;
      const headerLine = decoded.subarray(0, decoded.indexOf(0x0a));
      const parsed = JSON.parse(headerLine.toString('utf8'));
      if (parsed.id !== item.id || !samePath(parsed.cwd, to)) throw new Error(`verification failed for Session ${item.id}`);
      const expectedCut = expectedHeader.indexOf(0x0a);
      if (!decoded.subarray(decoded.indexOf(0x0a) + 1).equals(expectedHeader.subarray(expectedCut + 1))) {
        throw new Error(`verification failed for Session ${item.id}: event bytes differ`);
      }

      // Retire the old Session directory into the backup tree, keeping it recoverable.
      const backupDir = join(backupRoot, projectKey(spelling));
      await mkdir(backupDir, { recursive: true });
      await rename(source, join(backupDir, encodeSegment(item.id)));
      registry.host?.rememberSessionPath?.(item.id, to);
      report.migratedSessions.push({ id: item.id, bytes: written.length, sha256: createHash('sha256').update(written).digest('hex').slice(0, 16), headerCwd: header.cwd });
    }
  } else if (migrateSessions) {
    report.warnings.push('no stored Session of the old path was eligible for relocation');
  }

  const before = [...found.entity.sessionIds];
  await found.entity.mutate((record) => ({ ...record, path: to }));
  report.recordUpdated = true;
  report.workspaceId = found.id;
  report.title = found.entity.title;
  report.sessionsRemaining = found.entity.sessionIds.length;
  report.droppedSessionIds = before.filter((id) => !found.entity.sessionIds.includes(id));
  return report;
}

/** Every Session log file under the sessions root, two levels deep. */
async function walkSessionLogs(root) {
  const out = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let sessions;
    try {
      sessions = await readdir(join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      let files;
      try {
        files = await readdir(join(root, project.name, session.name));
      } catch {
        continue;
      }
      for (const filename of files) {
        if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(filename)) continue;
        out.push({
          path: join(root, project.name, session.name, filename),
          projectDir: project.name,
          sessionDir: session.name,
          filename,
          compressed: filename.endsWith('.zstd'),
        });
      }
    }
  }
  return out;
}

/**
 * Check that the Host can read every stored Session log.
 *
 * The Host requires the first frame of a log to be exactly one header line
 * (`assertZstdHeaderFrame`); anything else is skipped without a word, which
 * makes a perfectly intact log invisible.
 * @returns `{ total, readable, unreadable: [{ path, id, reason, bytes }] }`.
 */
export async function scanLogHealth(root) {
  if (typeof root !== 'string') return { total: 0, readable: 0, unreadable: [] };
  const logs = await walkSessionLogs(root);
  const unreadable = [];
  let readable = 0;
  for (const log of logs) {
    if (!log.compressed) {
      readable += 1;
      continue;
    }
    const buf = await readFile(log.path);
    let report;
    try {
      report = inspectLog(buf);
    } catch (error) {
      unreadable.push({ path: log.path, id: undefined, reason: String(error?.message ?? error), bytes: buf.length });
      continue;
    }
    if (report.readable) {
      readable += 1;
      continue;
    }
    unreadable.push({ path: log.path, id: report.header?.id, cwd: report.header?.cwd, reason: report.reason, bytes: buf.length });
  }
  return { total: logs.length, readable, unreadable };
}

/**
 * Re-frame stored logs whose first frame holds more than the header line.
 *
 * The rewrite is data-preserving: the header is re-emitted as its own frame, the
 * event bytes are re-emitted as newline-aligned chunks, and the result is decoded
 * again and compared byte-for-byte before the original is retired into a backup.
 * @returns what was (or, in a dry run, would be) repaired.
 */
export async function repairLogs({ root, dryRun = false }) {
  const health = await scanLogHealth(root);
  const report = { action: 'repair', root, dryRun, total: health.total, readable: health.readable, repaired: [], failed: [], unreadable: health.unreadable.length, backupDir: undefined };
  if (dryRun || health.unreadable.length === 0) return report;
  const backupRoot = join(root, '..', 'backups', `session-reframe-${stamp()}`);
  report.backupDir = backupRoot;
  for (const item of health.unreadable) {
    try {
      if (!item.path.endsWith('.zstd')) {
        report.failed.push({ path: item.path, reason: 'only zstd logs are re-framed' });
        continue;
      }
      const buf = await readFile(item.path);
      const { output, header, mode } = rewriteHeader(buf, (current) => current);
      const checked = inspectLog(output);
      if (!checked.readable) {
        report.failed.push({ path: item.path, reason: `re-framed log is still unreadable: ${checked.reason}` });
        continue;
      }
      const before = decodeLog(buf).text;
      const after = decodeLog(output).text;
      const cut = before.indexOf(0x0a);
      if (!after.subarray(after.indexOf(0x0a) + 1).equals(before.subarray(cut + 1))) {
        report.failed.push({ path: item.path, reason: 're-framing would change event bytes' });
        continue;
      }
      const tmp = `${item.path}.tmp-${process.pid}`;
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(output);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const written = await readFile(tmp);
      const verify = inspectLog(written);
      if (!verify.readable || verify.header.id !== header.id) {
        await rm(tmp, { force: true });
        report.failed.push({ path: item.path, reason: 'written log failed verification' });
        continue;
      }
      const backup = join(backupRoot, item.path.slice(root.length).replace(/^[\\/]+/, ''));
      await mkdir(dirname(backup), { recursive: true });
      await rename(item.path, backup);
      await rename(tmp, item.path);
      report.repaired.push({ id: header.id, path: item.path, mode, bytes: output.length, wasBytes: buf.length });
    } catch (error) {
      report.failed.push({ path: item.path, reason: String(error?.message ?? error) });
    }
  }
  return report;
}

/** Convenience wrapper used by the tool: plan, then optionally apply. */
export async function switchDefaultWorkspace({ registry, sessions, persistence, sessionsRoot, path, moveFiles = false, migrateSessions = true, dryRun = false }) {
  const plan = await planSwitch({ registry, sessions, persistence, path, moveFiles, migrateSessions, sessionsRoot });
  if (dryRun || plan.noop) {
    return { ok: true, dryRun: true, plan };
  }
  const report = await applySwitch({ registry, persistence, plan, moveFiles, migrateSessions });
  return { ok: true, dryRun: false, plan, report };
}

export { projectDir, projectKey, sessionDir };
