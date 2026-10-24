/**
 * Minimal browser + React stand-in for the `@local/dsh-git-graph` client bundle.
 *
 * The bundle is plain browser JavaScript: it registers a factory on
 * `window.__ModuleLoader__`, pulls React from the page module table and reads
 * `document`/`fetch` at call time. This harness provides those surfaces — a
 * small React runtime with per-component hook state, dependency-aware effects
 * and a settle loop, a DOM stub with a stylesheet sink, and a programmable
 * `fetch` — so the real `client.js` runs unmodified under Node with no npm
 * dependencies.
 *
 * Scope limit: this runtime renders function components and host elements only
 * (no class components, context, portals or reconciliation beyond `<Fragment>`),
 * which is all the bundle uses. Nothing here applies CSS or lays out pixels:
 * appearance is covered by the live page.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** The real bundle source, read once. */
export const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** A `Date` replacement pinned to one instant, for relative-time assertions. */
export function fakeDate(nowMs) {
	return class FakeDate extends Date {
		constructor(...args) {
			if (args.length === 0) super(nowMs);
			else super(...args);
		}
		static now() {
			return nowMs;
		}
	};
}

/** Structural equality of two hook dependency lists. */
function sameDeps(left, right) {
	if (left === right) return true;
	if (!Array.isArray(left) || !Array.isArray(right)) return false;
	if (left.length !== right.length) return false;
	return left.every((value, index) => Object.is(value, right[index]));
}

/** Flatten React children the way the reconciler would. */
function flatten(children) {
	const out = [];
	const visit = (node) => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		out.push(node);
	};
	for (const child of children) visit(child);
	return out.filter((node) => node !== null && node !== undefined && node !== false && node !== true);
}

/**
 * A tiny React runtime: hook state per component type, dependency-aware
 * effects, and a render loop that re-renders until no state setter fires.
 * @returns `{ react, pass, settle, unmount }`.
 */
export function createRenderRuntime() {
	/** @type {Map<unknown, { hooks: unknown[], pendingEffects: object[] }>} */
	const states = new Map();
	let current = null;
	let dirty = false;
	let fragmentType = null;

	/** State cell of the component currently rendering. */
	function stateOf() {
		if (current === null) throw new Error('harness: hook called outside a component render');
		return current;
	}

	const react = {
		get Fragment() {
			return fragmentType;
		},
		createElement(type, props, ...children) {
			return {
				type,
				props: props ?? {},
				children: children.length === 0 ? [] : flatten(children),
			};
		},
		useState(initial) {
			const state = stateOf();
			const index = state.cursor;
			state.cursor += 1;
			if (state.hooks[index] === undefined) {
				state.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
			}
			const cell = state.hooks[index];
			return [cell.value, (next) => {
				const value = typeof next === 'function' ? next(cell.value) : next;
				if (Object.is(value, cell.value)) return;
				cell.value = value;
				dirty = true;
			}];
		},
		useRef(initial) {
			const state = stateOf();
			const index = state.cursor;
			state.cursor += 1;
			if (state.hooks[index] === undefined) state.hooks[index] = { ref: { current: initial } };
			return state.hooks[index].ref;
		},
		useMemo(factory, deps) {
			const state = stateOf();
			const index = state.cursor;
			state.cursor += 1;
			const cell = state.hooks[index];
			if (cell === undefined || !sameDeps(cell.deps, deps)) state.hooks[index] = { value: factory(), deps };
			return state.hooks[index].value;
		},
		useCallback(fn, deps) {
			return react.useMemo(() => fn, deps);
		},
		useEffect(fn, deps) {
			const state = stateOf();
			const index = state.cursor;
			state.cursor += 1;
			state.pendingEffects.push({ index, fn, deps });
		},
		useLayoutEffect(fn, deps) {
			react.useEffect(fn, deps);
		},
	};
	fragmentType = Symbol('Fragment');

	/**
	 * Resolve one element tree: function components run here (with their own
	 * hook cursor), fragments and host elements pass their children through.
	 */
	function resolve(node) {
		if (node === null || node === undefined || typeof node !== 'object') return node;
		if (Array.isArray(node)) return node.map(resolve).flat();
		if (node.type === fragmentType) return resolve(node.children).flat();
		if (typeof node.type === 'function') {
			let state = states.get(node.type);
			if (state === undefined) {
				state = { hooks: [], pendingEffects: [], cursor: 0 };
				states.set(node.type, state);
			}
			const previous = current;
			current = state;
			state.cursor = 0;
			state.pendingEffects = [];
			let output;
			try {
				output = node.type(node.props);
			} finally {
				current = previous;
			}
			return resolve(output);
		}
		return { type: node.type, props: node.props, children: resolve(node.children).flat() };
	}

	/** One render pass plus the effects whose dependencies changed. */
	function pass(component, props) {
		dirty = false;
		for (const state of states.values()) state.pendingEffects = [];
		const previous = current;
		const state = states.get(component) ?? { hooks: [], pendingEffects: [], cursor: 0 };
		states.set(component, state);
		current = state;
		state.cursor = 0;
		state.pendingEffects = [];
		let output;
		try {
			output = component(props);
		} finally {
			current = previous;
		}
		const tree = resolve(output);
		for (const entry of states.values()) {
			const effects = entry.pendingEffects.slice();
			entry.pendingEffects = [];
			for (const effect of effects) {
				const cell = entry.hooks[effect.index] ?? (entry.hooks[effect.index] = {});
				if (Array.isArray(effect.deps) && cell.ran === true && sameDeps(cell.deps, effect.deps)) continue;
				if (typeof cell.cleanup === 'function') cell.cleanup();
				cell.deps = effect.deps;
				cell.ran = true;
				const cleanup = effect.fn();
				cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
			}
		}
		return tree;
	}

	/** Render, flush macrotasks, repeat while state changed. */
	async function settle(component, props, options = {}) {
		const maxRenders = typeof options.maxRenders === 'number' ? options.maxRenders : 90;
		let idle = 0;
		let tree = null;
		for (let round = 0; round < maxRenders; round += 1) {
			tree = pass(component, props);
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
			if (dirty) {
				idle = 0;
				continue;
			}
			idle += 1;
			if (idle >= 2) break;
		}
		return tree;
	}

	return {
		react,
		pass,
		settle,
		async mount(component, props, options) {
			return settle(component, props, options);
		},
		async render(component, props, options) {
			return settle(component, props, options);
		},
		unmount() {
			for (const state of states.values()) {
				for (const cell of state.hooks) {
					if (typeof cell?.cleanup === 'function') cell.cleanup();
					cell.cleanup = undefined;
				}
			}
		},
		get dirty() {
			return dirty;
		},
	};
}

/**
 * Run `client.js` in a fresh VM with the browser surfaces it reads.
 * The plugin factory runs exactly once (its module scope holds the request
 * caches and session memory under test); hook calls are forwarded through a
 * facade to whichever render runtime is currently mounted.
 * @param options - `{ nowMs, width, height, baseURI }`.
 */
export function loadClient(options = {}) {
	const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.parse('2026-08-26T16:00:00+08:00');
	const styleTags = [];
	const created = [];
	/** Document-level listeners installed by the bundle (e.g. outside-click). */
	const documentListeners = [];
	const documentStub = {
		baseURI: typeof options.baseURI === 'string' ? options.baseURI : 'http://127.0.0.1:6503/',
		head: {
			appendChild(tag) {
				styleTags.push(tag);
			},
		},
		body: {},
		createElement() {
			const tag = {
				dataset: {},
				textContent: '',
				removed: false,
				remove() {
					tag.removed = true;
				},
			};
			created.push(tag);
			return tag;
		},
		addEventListener(type, listener) {
			documentListeners.push([type, listener]);
		},
		removeEventListener(type, listener) {
			const index = documentListeners.findIndex(([kind, entry]) => kind === type && entry === listener);
			if (index >= 0) documentListeners.splice(index, 1);
		},
		/** Every listener currently attached to the stub document. */
		listeners: documentListeners,
	};
	const listeners = [];
	const sandbox = {
		console,
		Date: fakeDate(nowMs),
		URL,
		AbortController,
		setTimeout,
		clearTimeout,
		document: documentStub,
		listeners,
		window: {
			__ModuleLoader__: {
				load(value) {
					sandbox.__registration = value;
				},
			},
			__DSH_GIT_GRAPH_TEST__: true,
			innerWidth: typeof options.width === 'number' ? options.width : 1440,
			innerHeight: typeof options.height === 'number' ? options.height : 900,
			addEventListener(type, listener) {
				listeners.push([type, listener]);
			},
			removeEventListener(type, listener) {
				const index = listeners.findIndex(([kind, entry]) => kind === type && entry === listener);
				if (index >= 0) listeners.splice(index, 1);
			},
			setTimeout: (fn, delay) => setTimeout(fn, delay),
			clearTimeout: (id) => clearTimeout(id),
		},
	};
	sandbox.globalThis = sandbox;
	sandbox.window.document = documentStub;
	sandbox.fetch = (url, init) => {
		if (typeof options.fetch === 'function') return options.fetch(url, init);
		throw new Error('harness: no fetch handler installed');
	};
	vm.createContext(sandbox);
	vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });

	const registration = sandbox.__registration;
	const facade = createReactFacade();
	const plugin = registration.factory((specifier) => {
		if (specifier === 'react') return facade.react;
		if (specifier === 'react-dom') return { createPortal: (element) => element };
		throw new Error(`harness: unexpected module "${specifier}"`);
	});
	const internals = sandbox.window.__DSH_GIT_GRAPH_INTERNALS__;
	return { sandbox, registration, plugin, facade, internals, styleTags, created, documentStub, listeners };
}

/** Stable React object handed to the bundle once; hooks follow the mounted runtime. */
export function createReactFacade() {
	let target = null;
	const facade = {
		Fragment: Symbol('Fragment'),
		createElement(...args) {
			if (target === null) throw new Error('harness: no React runtime mounted');
			return target.createElement(...args);
		},
	};
	for (const name of ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useLayoutEffect']) {
		facade[name] = (...args) => {
			if (target === null) throw new Error('harness: no React runtime mounted');
			return target[name](...args);
		};
	}
	return {
		react: facade,
		setTarget(next) {
			target = next;
		},
	};
}

/** Concatenated text of an element subtree. */
export function textOf(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ');
	return (node.children ?? []).map(textOf).filter(Boolean).join(' ');
}

/** First element matching a predicate (depth-first). */
export function find(node, predicate) {
	if (node === null || node === undefined || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = find(child, predicate);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (predicate(node)) return node;
	for (const child of node.children ?? []) {
		const hit = find(child, predicate);
		if (hit !== null) return hit;
	}
	return null;
}

/** Every element matching a predicate (depth-first). */
export function findAll(node, predicate) {
	const hits = [];
	const visit = (current) => {
		if (current === null || current === undefined || typeof current !== 'object') return;
		if (Array.isArray(current)) {
			for (const child of current) visit(child);
			return;
		}
		if (predicate(current)) hits.push(current);
		for (const child of current.children ?? []) visit(child);
	};
	visit(node);
	return hits;
}

/** Elements carrying an exact className. */
export function byClass(tree, className) {
	return findAll(tree, (node) => node.props?.className === className);
}

/**
 * A programmable Host stub: routes each request by its `op` parameter and
 * records every call so tests can assert URLs, cookies and parameters.
 */
export function createHostStub(initial = {}) {
	const handlers = {
		repo: initial.repo,
		refs: initial.refs,
		log: initial.log,
		commit: initial.commit,
		diff: initial.diff,
		repos: initial.repos,
	};
	const calls = [];
	const fetch = async (url, init = {}) => {
		const parsed = new URL(String(url));
		const op = parsed.searchParams.get('op');
		const params = Object.fromEntries(parsed.searchParams.entries());
		calls.push({ url: parsed, op, params, init });
		if (init.signal?.aborted === true) {
			const error = new Error('aborted');
			error.name = 'AbortError';
			throw error;
		}
		const handler = handlers[op];
		const reply = typeof handler === 'function' ? await handler(params) : handler;
		if (reply === undefined) return { ok: true, json: async () => ({ ok: true, value: {} }) };
		if (reply !== null && typeof reply === 'object' && 'envelope' in reply) {
			return { ok: true, json: async () => reply.envelope };
		}
		return { ok: true, json: async () => ({ ok: true, value: reply }) };
	};
	return {
		fetch,
		calls,
		handlers,
		setHandler(op, handler) {
			handlers[op] = handler;
		},
		callsOf(op) {
			return calls.filter((call) => call.op === op);
		},
	};
}

/** One locale translator over the registered dictionaries. */
export function translateFor(dicts, locale) {
	const dict = (dicts ?? {})[locale] ?? (dicts ?? {}).zh ?? {};
	return (key, params) => {
		const template = dict[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
	};
}

/**
 * Mount the real registered view through a mock plugin context.
 * @param env - result of `loadClient`.
 * @param options - `{ host, locale, services, props }`.
 * @returns the render runtime, captured registration surface, host stub, tree.
 */
export async function mountView(env, options = {}) {
	const host = options.host ?? createHostStub();
	const captured = { cleanups: [], dicts: null, options: null, component: null, slotKey: null };
	const locale = options.locale ?? 'zh';
	env.lastRuntime?.unmount();
	const runtime = createRenderRuntime();
	env.lastRuntime = runtime;
	env.facade.setTarget(runtime.react);
	const ctx = {
		locale: {
			register(namespace, dicts) {
				captured.namespace = namespace;
				captured.dicts = dicts;
				return () => {};
			},
			bind(namespace) {
				return translateFor(captured.dicts, locale);
			},
			getSnapshot: () => ({ active: locale, locales: [locale], revision: 1 }),
		},
		effect(fn, label) {
			const cleanup = fn();
			captured.cleanups.push({ label, cleanup });
			return () => {};
		},
		slots: {
			inject(key, callback) {
				captured.slotKey = key;
				return callback();
			},
			register(registerOptions, component) {
				captured.options = registerOptions;
				captured.component = component;
				return () => {};
			},
		},
		get(name) {
			return options.services?.[name];
		},
	};
	env.sandbox.fetch = host.fetch;
	const plugin = env.plugin;
	plugin.apply(ctx);
	const viewProps = { sessionId: 'session-preview-0001', ...(options.props ?? {}) };
	const tree = await runtime.mount(captured.component, viewProps);
	return { runtime, reactStub: runtime, captured, host, ctx, tree, plugin, props: viewProps };
}
