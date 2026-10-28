/**
 * dsh-default-workspace — inspect, repair, and relocate DSH's default Workspace.
 *
 * The bundle is a single tool (`default_workspace`); the interesting parts live in
 * `switch.js` (record rewrite, directory move, session log relocation) and
 * `zstd-multi.js` (multi-frame logs and re-framing).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDefaultWorkspaceTool } from './tool.js';

export const name = 'dsh-default-workspace';

export const inject = [];

/**
 * Register the `default_workspace` tool on the Host's tool registry.
 * @param ctx - the plugin context.
 * @param config - bundle config (`sessionsRoot` overrides the derived log root).
 */
export function apply(ctx, config) {
  const sessionsRoot =
    typeof config?.sessionsRoot === 'string' && config.sessionsRoot.length > 0 ? config.sessionsRoot : undefined;

  const dependencies = () => {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new Error('workspaceRegistry is unavailable: the default workspace cannot be read or changed');
    }
    return {
      registry,
      sessions: ctx.get('sessions'),
      persistence: ctx.get('sessionPersistence'),
      sessionsRoot,
    };
  };

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () => scope.tools.register(createDefaultWorkspaceTool({ defineTool, dependencies, sessionsRoot })),
      'dsh-default-workspace.tool',
    );
  });
}
