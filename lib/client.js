/**
 * Browser half of `dsh-default-workspace`: the GUI panel.
 *
 * This is a hand-written bundle for DSH's lazy-CJS client loader — no build step.
 * The contract, taken from the real bundles in this build:
 *
 * - `window.__ModuleLoader__.load({ id, factory })` where `id` equals the package
 *   name; a mismatch makes the Host fail the whole boot graph.
 * - The factory receives `require` for the platform's frozen module table; only
 *   `react` is needed here.
 * - `module.exports` is a plain Cordis plugin: `{ name, inject, apply }`. The
 *   service names in `inject` are what makes `ctx.slots` / `ctx.locale` readable
 *   inside `apply`.
 *
 * The panel talks to the Host through the three JSON routes in `web.js`, calling
 * them document-relative so the same code works under the browser's root mount and
 * inside the Electron shell.
 */
window.__ModuleLoader__.load({
  id: 'dsh-default-workspace',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Package identity; also the sidebar panel id and the locale namespace. */
    const ID = 'dsh-default-workspace';
    /** Route base published by the Host half; resolved document-relative. */
    const API = 'dsh-default-workspace/api';
    /** Sidebar top-left panel row (drawn by the shell itself). */
    const PANEL_SLOT = 'sidebar.panellist';
    /** Main-area panel, selected by the row above through `key`. */
    const MAIN_SLOT = 'main';
    /** How long a "click again to confirm" stays armed. */
    const ARM_MS = 6000;

    const DICT = {
      zh: {
        title: '默认工作区',
        navLabel: '工作区',
        current: '当前默认工作区',
        path: '路径',
        exists: '目录存在',
        sessions: '已存会话',
        live: '正在运行',
        logs: '会话日志',
        logsValue: '{total} 个 · {readable} 可读 · {unreadable} 需修复',
        liveNone: '无',
        liveValue: '{count} 个',
        yes: '是',
        no: '否',
        target: '切换到',
        targetHint: '绝对路径。不存在的目录会被创建。',
        placeholder: 'D:\\dsh',
        moveFiles: '移动目录内容',
        migrateSessions: '同时搬迁已存会话日志',
        moveFilesHint: '目录里有文件时勾选；有会话正在旧目录工作时会被拒绝。',
        preview: '预览',
        apply: '切换',
        applyArmed: '再点一次以确认',
        repairScan: '检查日志',
        repairRun: '修复日志',
        repairArmed: '再点一次以修复',
        refresh: '刷新',
        busy: '处理中…',
        output: '结果',
        unreadableHint: '有 {count} 个会话日志的首帧不是一行 header，宿主会静默跳过它们——点「修复日志」。',
        workspace: '工作区',
        defaultMark: '默认',
        empty: '（还没有结果）',
        failed: '失败',
        rpcUnavailable: '面板无法与宿主通信：请求失败。',
      },
      en: {
        title: 'Default workspace',
        navLabel: 'Workspace',
        current: 'Current default workspace',
        path: 'Path',
        exists: 'Directory exists',
        sessions: 'Stored sessions',
        live: 'Live now',
        logs: 'Session logs',
        logsValue: '{total} total · {readable} readable · {unreadable} to repair',
        liveNone: 'none',
        liveValue: '{count}',
        yes: 'yes',
        no: 'no',
        target: 'Switch to',
        targetHint: 'An absolute path. A missing directory is created.',
        placeholder: 'D:\\dsh',
        moveFiles: 'Move directory contents',
        migrateSessions: 'Relocate stored session logs too',
        moveFilesHint: 'Tick it when the directory holds files; refused while a live session works there.',
        preview: 'Preview',
        apply: 'Switch',
        applyArmed: 'Click again to confirm',
        repairScan: 'Check logs',
        repairRun: 'Repair logs',
        repairArmed: 'Click again to repair',
        refresh: 'Refresh',
        busy: 'Working…',
        output: 'Result',
        unreadableHint: '{count} stored log(s) do not start with a single header frame — the Host skips them silently. Use “Repair logs”.',
        workspace: 'Workspace',
        defaultMark: 'default',
        empty: '(nothing yet)',
        failed: 'failed',
        rpcUnavailable: 'The panel cannot reach the Host: the request failed.',
      },
    };

    /** Fallback translator until the locale service answers. */
    let t = (key, ...args) => {
      const value = DICT.zh[key] ?? DICT.en[key] ?? key;
      return typeof value === 'function' ? value(...args) : value;
    };

    /** Fill `{name}` placeholders in a translated string. */
    function fmt(key, vars) {
      return String(t(key)).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''));
    }

    const CSS = `
.dshdw-root{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;max-width:880px;padding:24px;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit)}
.dshdw-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dshdw-card{display:flex;flex-direction:column;gap:4px;padding:16px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,12px)}
.dshdw-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px;padding:3px 0;font-size:13px;line-height:20px}
.dshdw-label{color:var(--dsw-alias-label-tertiary,rgba(140,140,150,1))}
.dshdw-value{color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.dshdw-mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dshdw-field{display:flex;gap:8px;align-items:center}
.dshdw-input{flex:1;box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px}
.dshdw-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgba(77,107,254,.75)));outline-offset:1px}
.dshdw-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dshdw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dshdw-btn:disabled{opacity:.5;cursor:default}
.dshdw-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill,rgba(77,107,254,1));color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshdw-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,rgba(77,107,254,.85))}
.dshdw-btn[data-armed=true]{border-color:var(--dsw-alias-state-warn-primary,#d29922);color:var(--dsw-alias-state-warn-primary,#d29922)}
.dshdw-check{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}
.dshdw-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(140,140,150,1))}
.dshdw-hint[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dshdw-hint[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}
.dshdw-out{margin:0;padding:12px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto}
.dshdw-out[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}
.dshdw-actions{display:flex;gap:8px;flex-wrap:wrap}
`;

    /** Inject the stylesheet once per page; return an uninstaller. */
    function installCss() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.querySelector(`style[data-plugin-css="${ID}"]`);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.pluginCss = ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /** One labelled row of the status card. */
    function Row({ label, children, mono = false }) {
      return h(
        'div',
        { className: 'dshdw-row' },
        h('span', { className: 'dshdw-label' }, label),
        h('span', { className: mono ? 'dshdw-value dshdw-mono' : 'dshdw-value' }, children),
      );
    }

    /** Sidebar glyph: a folder with a star, drawn from the current ink colour. */
    function PanelGlyph(props) {
      const size = props?.size ?? 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4c.4 0 .8.16 1.06.44L8.2 4.7h4.3A1.5 1.5 0 0 1 14 6.2v5.3A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8 6.6l.72 1.46 1.6.23-1.16 1.13.27 1.6L8 10.26l-1.43.76.27-1.6-1.16-1.13 1.6-.23L8 6.6Z',
          fill: 'currentColor',
          opacity: props?.active === true ? 1 : 0.75,
        }),
      );
    }

    /** A button that arms for a second click before it fires. */
    function ArmedButton({ label, armedLabel, variant, armed, disabled, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dshdw-btn',
          'data-variant': variant,
          'data-armed': armed ? 'true' : undefined,
          disabled,
          onClick,
        },
        armed ? armedLabel : label,
      );
    }

    /** The panel itself. `rpc` is `{ status, switch, repair }` bound to the Host. */
    function Panel({ rpc }) {
      const [status, setStatus] = React.useState({ phase: 'loading', value: undefined, error: undefined });
      const [target, setTarget] = React.useState('');
      const [moveFiles, setMoveFiles] = React.useState(false);
      const [migrateSessions, setMigrateSessions] = React.useState(true);
      const [busy, setBusy] = React.useState(undefined);
      const [output, setOutput] = React.useState(undefined);
      const [armed, setArmed] = React.useState(undefined);

      const load = React.useCallback(async () => {
        setStatus({ phase: 'loading', value: undefined, error: undefined });
        if (rpc === undefined) {
          setStatus({ phase: 'failed', value: undefined, error: t('rpcUnavailable') });
          return;
        }
        try {
          setStatus({ phase: 'ready', value: await rpc.status(), error: undefined });
        } catch (error) {
          setStatus({ phase: 'failed', value: undefined, error: message(error) });
        }
      }, [rpc]);

      React.useEffect(() => {
        void load();
      }, [load]);

      // A stray armed button must not stay armed forever.
      React.useEffect(() => {
        if (armed === undefined) return undefined;
        const timer = setTimeout(() => setArmed(undefined), ARM_MS);
        return () => clearTimeout(timer);
      }, [armed]);

      const run = async (kind, task) => {
        setBusy(kind);
        setArmed(undefined);
        try {
          const value = await task();
          setOutput({ tone: 'ok', text: value?.text ?? JSON.stringify(value, undefined, 2) });
          if (kind !== 'preview') await load();
        } catch (error) {
          setOutput({ tone: 'error', text: message(error) });
        } finally {
          setBusy(undefined);
        }
      };

      const value = status.value;
      const logs = value?.logs;
      const unreadable = logs?.unreadable ?? 0;
      const targetPath = target.trim();

      return h(
        'div',
        { className: 'dshdw-root' },
        h('h2', { className: 'dshdw-title' }, t('title')),

        status.phase === 'failed'
          ? h('p', { className: 'dshdw-hint', 'data-tone': 'error' }, status.error)
          : h(
              'div',
              { className: 'dshdw-card' },
              h(Row, { label: t('current'), mono: true }, value?.defaultWorkspace?.path ?? '…'),
              h(Row, { label: t('exists') }, value?.defaultWorkspace?.exists === true ? t('yes') : t('no')),
              h(Row, { label: t('sessions') }, String(value?.defaultWorkspace?.sessions ?? '…')),
              h(Row, { label: t('live') }, value === undefined ? '…' : liveText(value.defaultWorkspace?.liveSessions?.length ?? 0)),
              h(Row, { label: t('logs') }, logs === undefined ? '…' : fmt('logsValue', { total: logs.total, readable: logs.readable, unreadable })),
              unreadable > 0 ? h('p', { className: 'dshdw-hint', 'data-tone': 'warn' }, fmt('unreadableHint', { count: unreadable })) : null,
            ),

        h(
          'div',
          { className: 'dshdw-card' },
          h(Row, { label: t('target') }, h('span', { className: 'dshdw-hint' }, t('targetHint'))),
          h(
            'div',
            { className: 'dshdw-field' },
            h('input', {
              className: 'dshdw-input',
              type: 'text',
              value: target,
              placeholder: t('placeholder'),
              spellCheck: false,
              onChange: (event) => setTarget(event.currentTarget.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdw-btn',
                disabled: targetPath.length === 0 || busy !== undefined,
                onClick: () => void run('preview', () => rpc.switchTo({ path: targetPath, moveFiles, migrateSessions, dryRun: true })),
              },
              t('preview'),
            ),
            h(ArmedButton, {
              label: t('apply'),
              armedLabel: t('applyArmed'),
              variant: 'primary',
              armed: armed === 'apply',
              disabled: targetPath.length === 0 || busy !== undefined,
              onClick: () => {
                if (armed !== 'apply') {
                  setArmed('apply');
                  return;
                }
                void run('apply', () => rpc.switchTo({ path: targetPath, moveFiles, migrateSessions, dryRun: false }));
              },
            }),
          ),
          h(
            'label',
            { className: 'dshdw-check' },
            h('input', { type: 'checkbox', checked: moveFiles, onChange: (event) => setMoveFiles(event.currentTarget.checked) }),
            t('moveFiles'),
          ),
          h('p', { className: 'dshdw-hint' }, t('moveFilesHint')),
          h(
            'label',
            { className: 'dshdw-check' },
            h('input', { type: 'checkbox', checked: migrateSessions, onChange: (event) => setMigrateSessions(event.currentTarget.checked) }),
            t('migrateSessions'),
          ),
        ),

        h(
          'div',
          { className: 'dshdw-actions' },
          h(
            'button',
            { type: 'button', className: 'dshdw-btn', disabled: busy !== undefined, onClick: () => void load() },
            t('refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshdw-btn',
              disabled: busy !== undefined,
              onClick: () => void run('scan', () => rpc.repair({ dryRun: true })),
            },
            t('repairScan'),
          ),
          h(ArmedButton, {
            label: t('repairRun'),
            armedLabel: t('repairArmed'),
            armed: armed === 'repair',
            disabled: busy !== undefined,
            onClick: () => {
              if (armed !== 'repair') {
                setArmed('repair');
                return;
              }
              void run('repair', () => rpc.repair({ dryRun: false }));
            },
          }),
          busy === undefined ? null : h('span', { className: 'dshdw-hint' }, t('busy')),
        ),

        h(
          'div',
          { className: 'dshdw-card' },
          h(Row, { label: t('output') }, h('span', { className: 'dshdw-hint' }, t('empty'))),
          h('pre', { className: 'dshdw-out', 'data-tone': output?.tone }, output?.text ?? ''),
        ),
      );
    }

    /** "none" or a count, in the active language. */
    function liveText(count) {
      return count === 0 ? t('liveNone') : fmt('liveValue', { count });
    }

    /** Turn any thrown value into a human line. */
    function message(error) {
      if (error === undefined || error === null) return String(error);
      if (typeof error === 'string') return error;
      return error.message ?? String(error);
    }

    /**
     * Bind the panel's three calls to the Host's JSON routes.
     *
     * URLs are document-relative on purpose: the shell serves the GUI with
     * `<base href="./">`, and the desktop shell forwards these same requests, so an
     * absolute path would be wrong under a sub-path mount.
     */
    function bindApi() {
      const post = async (route, params) => {
        const query = new URLSearchParams(params).toString();
        const url = query.length === 0 ? `${API}/${route}` : `${API}/${route}?${query}`;
        const response = await fetch(url, { method: 'POST', cache: 'no-store' });
        const body = await response.json().catch(() => undefined);
        if (response.ok !== true || body?.ok !== true) {
          const error = new Error(body?.error ?? `HTTP ${response.status}`);
          error.code = response.status;
          throw error;
        }
        return body;
      };
      const bit = (value) => (value === true ? '1' : '0');
      return {
        status: () => post('status', {}),
        switchTo: (payload) =>
          post('switch', {
            path: payload.path,
            moveFiles: bit(payload.moveFiles),
            migrateSessions: bit(payload.migrateSessions !== false),
            dryRun: bit(payload.dryRun),
          }),
        repair: (payload) => post('repair', { dryRun: bit(payload.dryRun !== false) }),
      };
    }

    /**
     * Register the sidebar row, the main panel and the settings row.
     * @param ctx - the client Cordis context.
     */
    function apply(ctx) {
      const slots = ctx?.slots ?? (typeof ctx?.get === 'function' ? ctx.get('slots') : undefined);
      if (slots === undefined || typeof slots.inject !== 'function') return;

      const locale = ctx?.locale ?? (typeof ctx?.get === 'function' ? ctx.get('locale') : undefined);
      try {
        if (typeof locale?.register === 'function' && typeof locale?.bind === 'function') {
          locale.register(ID, DICT);
          const bound = locale.bind(ID);
          if (typeof bound === 'function') t = bound;
        }
      } catch {
        /* keep the fallback translator */
      }

      const rpc = bindApi();

      const disposers = [];
      const panel = () => h(Panel, { rpc });
      disposers.push(ctx.effect(() => installCss(), `${ID}.css`));

      disposers.push(
        slots.inject(PANEL_SLOT, () =>
          slots.register({ name: PANEL_SLOT, id: ID, order: 40, label: () => t('navLabel') }, PanelGlyph),
        ),
      );
      disposers.push(slots.inject(MAIN_SLOT, () => slots.register({ name: MAIN_SLOT, key: ID }, panel)));

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose();
          } catch {
            /* a slot that is already gone needs no cleanup */
          }
        }
      }, `${ID}.slots`);
    }

    exports.name = ID;
    exports.inject = ['slots', 'locale'];
    exports.apply = apply;
    return module.exports;
  },
});
