/**
 * dsh-default-workspace — inspect, repair, and relocate DSH's default Workspace.
 *
 * The Host half is one tool (`default_workspace`) plus the JSON routes the GUI panel
 * calls; the interesting parts live in `switch.js` (record rewrite, directory move,
 * session log relocation) and `zstd-multi.js` (multi-frame logs and re-framing). The
 * browser half is `client.js`, served by the client-modules plugin.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDefaultWorkspaceTool } from './tool.js';
import { registerWebRoutes } from './web.js';

export const name = 'dsh-default-workspace';

export const inject = [];

/**
 * Register the tool and, when a web server is composed, the panel's JSON routes.
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

  // The GUI panel talks to these three routes. The handlers ask the platform's
  // trust fence first, so a route is only reachable from the DSH page itself.
  ctx.inject(['webServer'], (scope) => {
    registerWebRoutes(scope, { dependencies, sessionsRoot });
  });
}
