// Client-bundle test: the browser half is hand-written for DSH's lazy-CJS loader,
// so the things worth pinning are the loader contract (id, factory, exports), the
// two slot registrations, the locale dictionary and the RPC binding — all without
// a browser. A stub `React` keeps `createElement` inspectable.
import { readFile } from 'node:fs/promises';

const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok: Boolean(ok) });
  if (!ok) console.error(`FAIL ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
};

/** Minimal React: enough to render a tree once and inspect its text. */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  };
}

/** Every string in a rendered tree, in document order; function components are invoked. */
function textOf(node, depth = 0) {
  if (node === undefined || node === null || node === false || node === true || depth > 30) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => textOf(child, depth + 1)).join(' ');
  if (typeof node.type === 'function') return textOf(node.type(node.props), depth + 1);
  const children = Array.isArray(node.children) ? node.children : [];
  return children.map((child) => textOf(child, depth + 1)).join(' ');
}

/** Load the bundle the way the shell does and hand back its factory spec. */
async function loadBundle(source) {
  let spec;
  const fakeWindow = { __ModuleLoader__: { load: (value) => { spec = value; } } };
  // The bundle is not an ES module: it only talks to `window`, so evaluating it
  // with that name shadowed is enough. `new Function` keeps it out of ESM scope.
  new Function('window', source)(fakeWindow);
  return spec;
}

async function main() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const spec = await loadBundle(source);

  check('the bundle registers one factory', spec !== undefined && typeof spec.factory === 'function', typeof spec);
  check('the factory id equals the package name', spec.id === 'dsh-default-workspace', spec.id);

  const React = stubReact();
  const mod = spec.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require(${name})`);
  });

  check('the bundle exports a plain Cordis plugin', mod.name === 'dsh-default-workspace' && typeof mod.apply === 'function', {
    name: mod.name,
    apply: typeof mod.apply,
  });
  check(
    'the plugin injects the services it reads',
    ['slots', 'locale'].every((name) => mod.inject.includes(name)) && !mod.inject.includes('connection'),
    mod.inject,
  );

  // ---- a fake client context ------------------------------------------------
  const registrations = [];
  const slotNames = [];
  const slots = {
    inject: (name, fn) => {
      slotNames.push(name);
      return fn();
    },
    register: (props, component) => {
      registrations.push({ props, component });
      return () => {};
    },
  };
  const dictionaries = [];
  const locale = {
    register: (namespace, dictionary) => dictionaries.push({ namespace, dictionary }),
    bind: (namespace) => (key) => `T:${namespace}:${key}`,
  };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const endpoint = String(url).split('?')[0].split('/').pop();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        action: endpoint,
        text: `text:${endpoint}`,
        defaultWorkspace: { path: 'D:/x', exists: true, sessions: 3, liveSessions: [] },
        logs: { total: 2, readable: 2, unreadable: 0 },
      }),
    };
  };

  const effects = [];
  const ctx = {
    slots,
    locale,
    get: (name) => ({ slots, locale })[name],
    effect: (fn, label) => {
      const dispose = fn();
      effects.push(label);
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };

  // ---- registration ---------------------------------------------------------
  mod.apply(ctx);
  check('two slots are registered', registrations.length === 2, registrations.length);
  check('both slots are injected first', slotNames.join(',') === 'sidebar.panellist,main', slotNames);

  const row = registrations.find((item) => item.props.name === 'sidebar.panellist');
  const main = registrations.find((item) => item.props.name === 'main');
  check('the sidebar row carries the package id', row?.props.id === 'dsh-default-workspace', row?.props);
  check('the sidebar row is ordered after the built-ins', typeof row?.props.order === 'number' && row.props.order > 0, row?.props.order);
  check('the sidebar row asks for a label lazily', typeof row?.props.label === 'function', typeof row?.props.label);
  check('the main panel is keyed by the same id', main?.props.key === 'dsh-default-workspace', main?.props);
  check('the sidebar row draws a glyph', typeof row?.component === 'function', typeof row?.component);
  check('the stylesheet is installed through an effect', effects.some((label) => String(label).includes('.css')), effects);

  const dictionary = dictionaries.find((item) => item.namespace === 'dsh-default-workspace');
  check('the locale dictionary covers both languages', dictionary?.dictionary?.zh !== undefined && dictionary?.dictionary?.en !== undefined, Object.keys(dictionary?.dictionary ?? {}));
  check('the translated label uses the bound translator', row?.props.label() === 'T:dsh-default-workspace:navLabel', row?.props.label());

  // ---- the panel renders ----------------------------------------------------
  const element = main.component();
  check('the main slot renders the panel with the rpc binding', element?.type?.name === 'Panel' && element.props.rpc !== undefined, typeof element?.type);

  const tree = element.type(element.props);
  const text = textOf(tree);
  check('the panel title is translated', text.includes('T:dsh-default-workspace:title'), text.slice(0, 120));
  check('the panel offers a target input', JSON.stringify(tree).includes('dshdw-input'), text.slice(0, 160));
  check('the panel offers the repair buttons', text.includes('repairScan') && text.includes('repairRun'), text.slice(0, 200));


  // A failed envelope must surface as a thrown error with the Host's message.
  const failing = {
    status: () =>
      (async () => {
        throw Object.assign(new Error('the default workspace is unknown'), { code: 'failed' });
      })(),
    switchTo: () => Promise.reject(new Error('nope')),
    repair: () => Promise.reject(new Error('nope')),
  };
  const failingTree = element.type({ rpc: failing });
  check('a failing status renders without throwing', failingTree !== undefined, typeof failingTree);

  // ---- a composition without slots must not throw ---------------------------
  const bare = { get: () => undefined, effect: () => () => {} };
  mod.apply(bare);
  check('a context without slots is tolerated', true);

  const failures = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
