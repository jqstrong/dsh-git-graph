/**
 * Route-level tests for the Host half: the Cordis plugin shape, request
 * validation, the JSON envelope/headers, explicit-`cwd` handling and
 * `sessionId` → working-directory resolution through the optional services.
 *
 * The Host Connection service is faked, so these tests run without DSH while
 * exercising the exact `fetch` handler Connection would call.
 */

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { apply, inject, ROUTE_PATH } from '../index.js';
import { isParamErrorCode, validateExplicitCwd } from '../host/session.js';
import { commitAll, createFixtureRoot, initRepo, writeFixtureFile } from './helpers.mjs';

/** @type {{root: string, cleanup: () => void}} */
let fixture;
/** @type {string} */
let repo;
/** @type {string} */
let repoReal;
/** @type {string} */
let headSha;
/** @type {any} */
let route;

before(() => {
	fixture = createFixtureRoot();
	repo = join(fixture.root, 'route repo');
	initRepo(repo);
	writeFixtureFile(repo, 'a.txt', 'one\n');
	commitAll(repo, 'first commit');
	writeFixtureFile(repo, 'a.txt', 'two\n');
	headSha = commitAll(repo, 'second commit');
	repoReal = realpathSync.native(repo);

	const routes = [];
	const ctx = {
		effect(run) {
			return run();
		},
		connection: {
			fetch: {
				register(definition) {
					routes.push(definition);
					return () => {};
				},
			},
		},
		get() {
			return undefined;
		},
		logger: { warn() {} },
	};
	apply(ctx);
	route = routes[0];
});

after(() => fixture.cleanup());

/**
 * Fake Cordis context with a captured route and optional Host services.
 * @param {Record<string, unknown>} [services]
 */
function makeCtx(services = {}) {
	const routes = [];
	const ctx = {
		effect(run) {
			return run();
		},
		connection: {
			fetch: {
				register(definition) {
					routes.push(definition);
					return () => {};
				},
			},
		},
		get(name) {
			return services[name];
		},
		logger: { warn() {} },
	};
	apply(ctx);
	return { ctx, route: routes[0] };
}

/** Build one GET request for the plugin route. */
function makeRequest(params, options = {}) {
	const url = new URL(`http://127.0.0.1:6503${ROUTE_PATH}`);
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(name, value);
	}
	return new Request(url, options);
}

/** Call the route handler and decode its JSON envelope. */
async function call(target, params, options) {
	const response = await target.fetch(makeRequest(params, options));
	const text = await response.text();
	return { response, body: JSON.parse(text), text };
}

describe('plugin shape', () => {
	test('injects only connection', () => {
		assert.deepEqual(inject, ['connection']);
	});

	test('registers the exact GET route', () => {
		assert.equal(route.path, ROUTE_PATH);
		assert.equal(ROUTE_PATH, '/api/plugin/git-graph');
		assert.deepEqual(route.methods, ['GET']);
		assert.equal(route.requestBody, 'buffered');
		assert.equal(typeof route.fetch, 'function');
	});
});

describe('responses', () => {
	test('serves op=repo with the content headers', async () => {
		const { response, body } = await call(route, { op: 'repo', cwd: repo });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.isRepo, true);
		assert.equal(body.value.root, repoReal);
		assert.equal(body.value.cwd, repoReal);
	});

	test('serves op=refs / op=log / op=commit / op=diff', async () => {
		const refs = await call(route, { op: 'refs', cwd: repo });
		assert.equal(refs.body.ok, true, JSON.stringify(refs.body));
		assert.equal(refs.body.value.branches.length, 1);

		const log = await call(route, { op: 'log', cwd: repo });
		assert.equal(log.body.ok, true, JSON.stringify(log.body));
		assert.equal(log.body.value.commits.length, 2);
		assert.equal(log.body.value.commits[0].sha, headSha);

		const commit = await call(route, { op: 'commit', cwd: repo, sha: headSha.slice(0, 7) });
		assert.equal(commit.body.ok, true, JSON.stringify(commit.body));
		assert.equal(commit.body.value.sha, headSha);
		assert.equal(commit.body.value.files[0].status, 'M');

		const diff = await call(route, { op: 'diff', cwd: repo, sha: headSha, path: 'a.txt' });
		assert.equal(diff.body.ok, true, JSON.stringify(diff.body));
		assert.equal(diff.body.value.hunks.length, 1);
		assert.deepEqual(
			diff.body.value.hunks[0].lines.map((line) => line.kind),
			['del', 'add'],
		);
	});

	test('business errors are HTTP 200 with ok:false', async () => {
		const nonRepo = join(fixture.root, 'not-a-repo');
		writeFixtureFile(nonRepo, 'readme.txt', 'x\n');
		const { response, body } = await call(route, { op: 'repo', cwd: nonRepo });
		assert.equal(response.status, 200);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'not-a-repository');
	});

	test('non-GET methods answer 405', async () => {
		const response = await route.fetch(makeRequest({ op: 'repo', cwd: repo }, { method: 'POST' }));
		assert.equal(response.status, 405);
		const body = await response.json();
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'method-not-allowed');
	});
});

describe('parameter validation', () => {
	const cases = [
		[{ cwd: repo }, 'invalid-op'],
		[{ op: 'fetch', cwd: repo }, 'invalid-op'],
		[{ op: 'log', cwd: repo, limit: '0' }, 'invalid-limit'],
		[{ op: 'log', cwd: repo, limit: 'abc' }, 'invalid-limit'],
		[{ op: 'log', cwd: repo, limit: '2001' }, 'invalid-limit'],
		[{ op: 'log', cwd: repo, skip: '-1' }, 'invalid-skip'],
		[{ op: 'log', cwd: repo, ref: 'master' }, 'invalid-ref'],
		[{ op: 'log', cwd: repo, ref: 'refs/stash' }, 'invalid-ref'],
		[{ op: 'commit', cwd: repo }, 'invalid-sha'],
		[{ op: 'commit', cwd: repo, sha: 'zzz' }, 'invalid-sha'],
		[{ op: 'diff', cwd: repo, sha: headSha }, 'invalid-path'],
		[{ op: 'diff', cwd: repo, sha: headSha, path: '../a.txt' }, 'invalid-path'],
		[{ op: 'diff', cwd: repo, sha: headSha, path: 'a.txt', oldPath: '../b.txt' }, 'invalid-path'],
		[{ op: 'repo' }, 'cwd-invalid'],
		[{ op: 'repo', cwd: 'relative/path' }, 'cwd-invalid'],
		[{ op: 'repo', cwd: join(fixture.root, 'missing') }, 'cwd-invalid'],
		[{ op: 'repo', cwd: 'C:\\x\u0000y' }, 'cwd-invalid'],
		[{ op: 'repo', sessionId: '  ' }, 'cwd-invalid'],
	];

	for (const [params, expectedCode] of cases) {
		test(`rejects ${JSON.stringify(params)} with ${expectedCode}`, async () => {
			const { response, body } = await call(route, params);
			assert.equal(response.status, 400, JSON.stringify(body));
			assert.equal(body.ok, false);
			assert.equal(body.error.code, expectedCode);
			assert.ok(!body.error.stack, 'no stack traces in responses');
		});
	}

	test('unknown commits are business errors, not 400s', async () => {
		const { response, body } = await call(route, { op: 'commit', cwd: repo, sha: 'deadbeef' });
		assert.equal(response.status, 200);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'unknown-commit');
	});
});

describe('working directory resolution', () => {
	test('explicit cwd wins and skips session lookups', async () => {
		let observed = 0;
		const { route: fakeRoute } = makeCtx({
			sessionQuery: {
				observeSession: async () => {
					observed += 1;
					throw new Error('session lookup must not run when cwd is explicit');
				},
			},
			agents: { get: () => ({ session: { header: { cwd: 'D:\\elsewhere' } } }) },
		});
		const { body } = await call(fakeRoute, { op: 'repo', cwd: repo, sessionId: 'ignored' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, repoReal);
		assert.equal(observed, 0);
	});

	test('resolves sessionId through a live agent working directory without ensure()', async () => {
		let ensureCalls = 0;
		let observed = 0;
		const agent = { session: { header: { cwd: 'D:\\stale-header' } } };
		const { route: fakeRoute } = makeCtx({
			agents: { get: (sessionId) => (sessionId === 'live-session' ? agent : undefined) },
			workingDirectory: {
				get() {
					return repo;
				},
				ensure() {
					ensureCalls += 1;
					throw new Error('workingDirectory.ensure must not be called by the viewer');
				},
				defaultDirectory: 'D:\\default',
			},
			sessionQuery: {
				observeSession: async () => {
					observed += 1;
					throw new Error('durable observation must not be needed');
				},
			},
		});
		const { body } = await call(fakeRoute, { op: 'repo', sessionId: 'live-session' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, repoReal);
		assert.equal(ensureCalls, 0);
		assert.equal(observed, 0);
	});

	test('uses the live agent header cwd when no workingDirectory service exists', async () => {
		const agent = { session: { header: { cwd: repo } } };
		const { route: fakeRoute } = makeCtx({ agents: { get: () => agent } });
		const { body } = await call(fakeRoute, { op: 'repo', sessionId: 'cold-free-session' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, repoReal);
	});

	test('falls back to the durable session observation and disposes it', async () => {
		let disposed = false;
		const { route: fakeRoute } = makeCtx({
			sessionQuery: {
				observeSession: async (sessionId) => {
					assert.equal(sessionId, 'stored-session');
					return {
						header: { cwd: 'D:\\old' },
						projections: { values: { workingDirectory: repo } },
						[Symbol.dispose]() {
							disposed = true;
						},
					};
				},
			},
		});
		const { body } = await call(fakeRoute, { op: 'log', sessionId: 'stored-session' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.commits.length, 2);
		assert.equal(disposed, true);
	});

	test('falls through a vanished live directory to the durable observation', async () => {
		const vanished = join(fixture.root, 'vanished-directory');
		const agent = { session: { header: { cwd: vanished } } };
		const { route: fakeRoute } = makeCtx({
			agents: { get: () => agent },
			workingDirectory: {
				get() {
					return vanished;
				},
				defaultDirectory: vanished,
			},
			sessionQuery: {
				observeSession: async () => ({
					header: { cwd: repo },
					projections: { values: {} },
					[Symbol.dispose]() {},
				}),
			},
		});
		const { body } = await call(fakeRoute, { op: 'repo', sessionId: 'moved-session' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, repoReal);
	});

	test('reports session-not-found when no service can resolve the session', async () => {
		const { route: fakeRoute } = makeCtx({});
		const { response, body } = await call(fakeRoute, { op: 'repo', sessionId: 'unknown-session' });
		assert.equal(response.status, 200);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'session-not-found');
	});

	test('reports session-not-found when the observation throws', async () => {
		const { route: fakeRoute } = makeCtx({
			sessionQuery: {
				observeSession: async () => {
					throw new Error('session "missing" not found');
				},
			},
		});
		const { response, body } = await call(fakeRoute, { op: 'repo', sessionId: 'missing' });
		assert.equal(response.status, 200);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'session-not-found');
	});

	test('an unknown session never falls back to the deployment default directory', async () => {
		// Regression: a failed observation (unknown session) must not silently read
		// `workingDirectory.defaultDirectory` and answer for a wrong directory.
		const { route: fakeRoute } = makeCtx({
			workingDirectory: { defaultDirectory: repo },
			sessionQuery: {
				observeSession: async () => {
					const error = new Error('session "session-does-not-exist" not found');
					error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
					throw error;
				},
			},
		});
		const { response, body } = await call(fakeRoute, { op: 'repo', sessionId: 'session-does-not-exist' });
		assert.equal(response.status, 200);
		assert.equal(body.ok, false, JSON.stringify(body));
		assert.equal(body.error.code, 'session-not-found');
	});

	test('a known session without a recorded directory uses the default directory', async () => {
		const { route: fakeRoute } = makeCtx({
			workingDirectory: { defaultDirectory: repo },
			sessionQuery: {
				observeSession: async () => ({
					header: {},
					projections: { values: {} },
					[Symbol.dispose]() {},
				}),
			},
		});
		const { body } = await call(fakeRoute, { op: 'repo', sessionId: 'known-session' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, repoReal);
	});

	test('a composition without the durable session service may use the default directory', async () => {
		const { route: fakeRoute } = makeCtx({ workingDirectory: { defaultDirectory: repo } });
		const { body } = await call(fakeRoute, { op: 'repo', sessionId: 'session-with-no-lookup' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, repoReal);
	});

	test('does not leak a stack trace for session failures', async () => {
		const { route: fakeRoute } = makeCtx({
			sessionQuery: {
				observeSession: async () => {
					throw new Error('boom');
				},
			},
		});
		const { text } = await call(fakeRoute, { op: 'repo', sessionId: 'x' });
		assert.ok(!text.includes('    at '), 'response text must not contain a stack trace');
	});
});

describe('validateExplicitCwd', () => {
	test('accepts a real absolute directory and returns its real path', () => {
		const result = validateExplicitCwd(repo);
		assert.equal(result.ok, true);
		assert.equal(result.value, repoReal);
	});

	test('rejects relative, missing, file and NUL paths', () => {
		for (const value of ['relative', join(fixture.root, 'missing'), join(repo, 'a.txt'), 'C:\\a\u0000b', '', '   ']) {
			const result = validateExplicitCwd(value);
			assert.equal(result.ok, false, `must reject ${JSON.stringify(value)}`);
			assert.equal(result.error.code, 'cwd-invalid');
		}
	});

	test('classifies parameter error codes', () => {
		assert.equal(isParamErrorCode('cwd-invalid'), true);
		assert.equal(isParamErrorCode('invalid-path'), true);
		assert.equal(isParamErrorCode('not-a-repository'), false);
		assert.equal(isParamErrorCode('session-not-found'), false);
	});
});
