/**
 * The `default_workspace` tool definition.
 *
 * Kept apart from the plugin wiring so it can be exercised without the Host: the
 * tests hand it a stub `defineTool` and fake services, which is also how the
 * tool contract (property-table parameters, an `output.render` that returns
 * content blocks, lossless-JSON results) is checked in CI.
 */
import { describeStatus, repairLogs, switchDefaultWorkspace } from './switch.js';

/** Strip `undefined` members: the tool output schema demands lossless JSON. */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Compact, model-readable summary of a status report. */
export function renderStatus(value) {
  const lines = [];
  const current = value.defaultWorkspace;
  if (current === undefined) {
    lines.push('No default Workspace is registered in this profile.');
  } else {
    lines.push(`Default workspace: ${current.title} — ${current.path}`);
    lines.push(
      `  exists: ${current.exists ? 'yes' : 'no'} · sessions: ${current.sessions} · live now: ${current.liveSessions.length}` +
        (current.liveSessions.length > 0 ? ` (${current.liveSessions.join(', ')})` : ''),
    );
  }
  if (value.workspaces.length > 0) {
    lines.push('Registered workspaces:');
    for (const workspace of value.workspaces) {
      lines.push(`  ${workspace.isDefault ? '*' : ' '} ${workspace.path}  ·  ${workspace.title}  ·  ${workspace.sessions} session(s)  ·  live ${workspace.liveSessions}`);
    }
  }
  if (value.logs !== undefined) {
    const logs = value.logs;
    lines.push(`Stored session logs (${logs.root}): ${logs.total} total · ${logs.readable} readable · ${logs.unreadable} unreadable by the Host`);
    if (logs.unreadable > 0) lines.push(`  unreadable: ${logs.unreadableIds.slice(0, 10).join(', ')}${logs.unreadableIds.length > 10 ? ', …' : ''} — run action=repair`);
  }
  return lines.join('\n');
}

/** Compact summary of a plan or an applied switch. */
export function renderSwitch(value) {
  const lines = [];
  if (value.plan?.noop) {
    lines.push(`Default workspace is already ${value.plan.to} — nothing to do.`);
    return lines.join('\n');
  }
  const plan = value.plan;
  lines.push(value.dryRun ? 'DRY RUN — nothing was changed.' : 'Switched the default workspace.');
  lines.push(`  from: ${plan.from}`);
  lines.push(`  to:   ${plan.to}${plan.toExists ? '' : '  (will be created)'}`);
  if (plan.moveFiles.length > 0 || plan.conflicts.length > 0) {
    lines.push(`  file entries to move: ${plan.moveFiles.length}`);
    if (plan.conflicts.length > 0) lines.push(`  name conflicts: ${plan.conflicts.slice(0, 10).join(', ')}${plan.conflicts.length > 10 ? ', …' : ''}`);
  }
  lines.push(`  sessions to relocate: ${plan.sessions.length}`);
  if (plan.liveSkipped.length > 0) lines.push(`  left in place (live sessions): ${plan.liveSkipped.join(', ')}`);
  if (plan.missingLogs.length > 0) lines.push(`  logs not found: ${plan.missingLogs.join(', ')}`);
  for (const note of plan.notes) lines.push(`  note: ${note}`);

  const report = value.report;
  if (report !== undefined) {
    if (report.movedFiles.length > 0) lines.push(`Moved ${report.movedFiles.length} file entr${report.movedFiles.length === 1 ? 'y' : 'ies'} into the new directory.`);
    if (report.migratedSessions.length > 0) {
      lines.push(`Relocated ${report.migratedSessions.length} session log(s); originals kept in ${report.backupDir}`);
    }
    if (report.recordUpdated) lines.push(`Workspace record updated; new sessions now open in ${report.to}.`);
    if (report.droppedSessionIds?.length > 0) {
      lines.push(`Still attached to the old path (not relocatable while live): ${report.droppedSessionIds.join(', ')}`);
    }
    for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  }
  return lines.join('\n');
}

/** Compact summary of a repair run. */
export function renderRepair(value) {
  const lines = [];
  const report = value.report;
  if (report.dryRun) {
    lines.push(`DRY RUN — nothing was changed. ${report.unreadable} of ${report.total} stored log(s) need re-framing.`);
  } else if (report.unreadable === 0) {
    lines.push(`All ${report.total} stored log(s) are readable by the Host — nothing to repair.`);
  } else {
    lines.push(`Re-framed ${report.repaired.length} of ${report.unreadable} stored log(s) · root: ${report.root}`);
  }
  for (const item of report.repaired.slice(0, 20)) {
    lines.push(`  ${item.id}: ${item.wasBytes} → ${item.bytes} bytes (${item.mode})`);
  }
  for (const item of report.failed.slice(0, 10)) lines.push(`  failed ${item.path}: ${item.reason}`);
  if (report.backupDir !== undefined) lines.push(`Originals kept in ${report.backupDir}`);
  return lines.join('\n');
}

/**
 * Build the `default_workspace` tool definition.
 *
 * @param options.defineTool - the Host's `defineTool` (a passthrough in tests).
 * @param options.dependencies - resolve the Host services on every call, so a
 *   service that appears late still works.
 * @param options.sessionsRoot - optional override for the sessions log root.
 * @returns whatever `defineTool` returns.
 */
export function createDefaultWorkspaceTool({ defineTool, dependencies, sessionsRoot }) {
  const rootOf = (deps) => sessionsRoot ?? deps.persistence?.root;

  return defineTool({
    name: 'default_workspace',
    description:
      "Inspect, repair, or change DSH's default Workspace — the folder every new Session opens in. DSH fixes a Workspace path at registration time and offers no API to relocate it, so this tool does the full relocation itself: it rewrites the Workspace record through the running Host's own storage, optionally moves the directory contents, and relocates every stored Session log whose header still points at the old path (the header `cwd` plus the log's project directory, which must stay consistent or the Host refuses to read it). Live Sessions, including the one calling this tool, cannot be relocated and are reported instead. `repair` re-frames stored logs the Host silently skips because their first Zstandard frame is not exactly one header line. Use action=status to look first, action=switch with dryRun=true to preview, and only then apply.",
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'switch', 'repair'],
        required: true,
        description: 'status reads the current default Workspace; switch relocates it; repair re-frames unreadable stored Session logs.',
      },
      path: {
        type: 'string',
        description: 'switch only: the absolute directory that should become the default Workspace. Created when missing.',
      },
      moveFiles: {
        type: 'boolean',
        description:
          'switch only: also move the old default workspace directory contents into the new directory. Refused while any live Session works in the old directory. Default false.',
      },
      migrateSessions: {
        type: 'boolean',
        description:
          'switch only: rewrite stored Session headers from the old path to the new one and move their logs. Default true. Sessions that are live are always left alone.',
      },
      dryRun: {
        type: 'boolean',
        description: 'switch and repair: report what would change without changing anything. Default false.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const text = value.action === 'status' ? renderStatus(value) : value.action === 'repair' ? renderRepair(value) : renderSwitch(value);
        return [{ type: 'text', text }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const deps = dependencies();
      if (args.action === 'status') return plain({ ok: true, action: 'status', ...(await describeStatus(deps)) });
      if (args.action === 'repair') {
        const root = rootOf(deps);
        if (typeof root !== 'string') throw new Error('the sessions root is unknown: pass it through the bundle config (`sessionsRoot`)');
        const report = await repairLogs({ root, dryRun: args.dryRun === true });
        return plain({ action: 'repair', ok: report.failed.length === 0, report });
      }
      if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('switch requires `path`: the absolute directory to become the default Workspace');
      const result = await switchDefaultWorkspace({
        ...deps,
        path: args.path,
        moveFiles: args.moveFiles === true,
        migrateSessions: args.migrateSessions !== false,
        dryRun: args.dryRun === true,
      });
      return plain({ action: 'switch', ...result });
    },
  });
}
