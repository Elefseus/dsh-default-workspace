// Tool contract test: build the `default_workspace` definition the way the plugin
// does (a stub `defineTool` stands in for the Host's), then drive every action
// against a fake registry that mirrors the Host's WorkspaceRegistry semantics.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { createDefaultWorkspaceTool, plain } from '../lib/tool.js';
import { logFilename, sessionDir } from '../lib/paths.js';

const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok: Boolean(ok) });
  if (!ok) console.error(`FAIL ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
};

class Entity {
  constructor(host, id, record) {
    this.host = host;
    this.id = id;
    this.record = record;
  }
  get path() {
    return this.record.path;
  }
  get title() {
    return this.record.title;
  }
  get sessionIds() {
    return this.record.sessionIds.filter((id) => this.host.paths.get(id) === this.record.path || this.host.missing.has(id));
  }
  async mutate(fn) {
    const changed = fn(this.record);
    const sessionIds = changed.sessionIds.filter((id) => this.host.paths.get(id) === changed.path || this.host.missing.has(id));
    this.record = { ...changed, sessionIds };
  }
}

function fakeRegistry(records, defaultId) {
  const host = {
    paths: new Map(),
    missing: new Set(),
    rememberSessionPath(id, path) {
      host.paths.set(id, path);
    },
  };
  const registry = {
    state: { defaultWorkspaceId: defaultId, workspaceIds: [...records.keys()] },
    host,
    entities: new Map(),
    get(id) {
      return registry.entities.get(id);
    },
    list() {
      return registry.state.workspaceIds.map((id) => registry.entities.get(id));
    },
  };
  for (const [id, record] of records) registry.entities.set(id, new Entity(host, id, record));
  return registry;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-default-workspace-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    const oldPath = join(root, 'old');
    const newPath = join(root, 'new');
    const id = 'session-wiring';
    const dir = sessionDir(sessionsRoot, oldPath, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, logFilename()),
      Buffer.concat([
        zstdCompressSync(
          Buffer.from(
            JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldPath }) + '\n',
          ),
        ),
        zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', text: 'hi' }) + '\n')),
      ]),
    );

    const registry = fakeRegistry(
      new Map([['ws-default', { path: oldPath, title: 'default-workspace', createdAt: 1, updatedAt: 1, sessionIds: [id] }]]),
      'ws-default',
    );
    registry.host.rememberSessionPath(id, oldPath);
    const services = {
      workspaceRegistry: registry,
      sessions: { list: () => [] },
      sessionPersistence: { root: sessionsRoot, list: async () => [{ header: { id, cwd: oldPath }, sizeBytes: 1 }] },
    };

    const tool = createDefaultWorkspaceTool({
      defineTool: (definition) => definition,
      dependencies: () => ({
        registry: services.workspaceRegistry,
        sessions: services.sessions,
        persistence: services.sessionPersistence,
        sessionsRoot: undefined,
      }),
      sessionsRoot: undefined,
    });

    check('tool is named default_workspace', tool.name === 'default_workspace', tool.name);
    check('description explains the relocation', /relocates? .*session/i.test(tool.description), tool.description.slice(0, 60));
    check('action is the only required property', Object.entries(tool.parameters).every(([key, spec]) => (key === 'action') === (spec.required === true)), Object.keys(tool.parameters));
    check('action is an enum of the three verbs', tool.parameters.action.enum?.join(',') === 'status,switch,repair', tool.parameters.action.enum);
    check(
      'switch flags are declared',
      ['path', 'moveFiles', 'migrateSessions', 'dryRun'].every((key) => key in tool.parameters),
      Object.keys(tool.parameters),
    );
    check('declares a json output schema', tool.output?.schema?.type === 'json', tool.output?.schema);
    check('declares a render function', typeof tool.output?.render === 'function');
    check('refuses concurrent execution', tool.isConcurrencySafe?.() === false);

    const statusValue = await tool.execute({ action: 'status' });
    const statusText = tool.output.render({ action: 'status' }, statusValue);
    check('status output is a text block list', Array.isArray(statusText) && statusText[0]?.type === 'text', statusText);
    check('status text names the default path', statusText[0].text.includes(oldPath), statusText[0].text);
    check('status reports one durable session', statusValue.defaultWorkspace.sessions === 1, statusValue.defaultWorkspace);
    check('status is lossless JSON', JSON.stringify(statusValue) === JSON.stringify(plain(statusValue)));

    const dry = await tool.execute({ action: 'switch', path: newPath, dryRun: true });
    check('dry run does not touch the record', registry.get('ws-default').path === oldPath, registry.get('ws-default').path);
    const dryText = tool.output.render({ action: 'switch' }, dry)[0].text;
    check('dry run text marks itself a dry run', dryText.startsWith('DRY RUN'), dryText);
    check('dry run plans one session relocation', dry.plan.sessions.length === 1, dry.plan.sessions);

    const applied = await tool.execute({ action: 'switch', path: newPath });
    const appliedText = tool.output.render({ action: 'switch' }, applied)[0].text;
    check('apply moves the record', registry.get('ws-default').path === newPath, registry.get('ws-default').path);
    check('apply relocates the one session', applied.report.migratedSessions.length === 1, applied.report.migratedSessions);
    check('apply text reports the relocation', /Relocated 1 session log/.test(appliedText), appliedText);
    const relocated = await readdir(sessionDir(sessionsRoot, newPath, id));
    check('relocated log is on disk under the new project dir', relocated.join(',') === logFilename(), relocated);

    const repair = await tool.execute({ action: 'repair', dryRun: true });
    const repairText = tool.output.render({ action: 'repair' }, repair)[0].text;
    check('repair reports a dry run', repairText.startsWith('DRY RUN'), repairText);
    check('repair sees the one healthy log', repair.report.total === 1 && repair.report.unreadable === 0, repair.report);

    let threw = '';
    try {
      await tool.execute({ action: 'switch' });
    } catch (error) {
      threw = error.message;
    }
    check('a switch without path explains the requirement', /requires `path`/.test(threw), threw);

    const failures = checks.filter((item) => !item.ok);
    console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
