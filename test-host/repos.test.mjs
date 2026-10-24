/**
 * `op=repos` — recursive, bounded discovery of Git repositories below a working
 * directory (SPEC §3.6), tested at both layers:
 *
 * - `host/git-core.js` `discoverRepos()` against real throwaway repositories;
 * - the HTTP handler (`index.js`) for routing, `depth`/`max` validation (HTTP
 *   400 for `invalid-depth` / `invalid-max`) and a passed HTTP 200 envelope.
 *
 * Every fixture lives in a `mkdtemp` directory in the OS temp folder
 * (helpers.mjs) and is removed in `after()`. Nothing here touches a user
 * repository or the DSH profile.
 */

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { handleRequest, ROUTE_PATH } from '../index.js';
import { discoverRepos, LIMITS } from '../host/git-core.js';
import { isParamErrorCode } from '../host/session.js';
import {
	buildDetachedRepo,
	buildEmptyRepo,
	commitAll,
	createFixtureRoot,
	git,
	initRepo,
	writeFixtureFile,
} from './helpers.mjs';

/** Direct fixture inspection returns the raw envelope. */
function discover(cwd, options) {
	return discoverRepos(cwd, options);
}

/** Assert one discoverRepos result is ok and return its value. */
async function discoverValue(cwd, options) {
	const result = await discover(cwd, options);
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.value;
}

/** Fake Cordis context: the handler only reads optional services via `get`. */
function makeCtx(services = {}) {
	return {
		get(name) {
			return services[name];
		},
		logger: { warn() {} },
	};
}

/** Build one GET request for the plugin route. */
function makeRequest(params) {
	const url = new URL(`http://127.0.0.1:6503${ROUTE_PATH}`);
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(name, String(value));
	}
	return new Request(url);
}

/** Call the real handler and decode its JSON envelope. */
async function call(services, params) {
	const response = await handleRequest(makeCtx(services), makeRequest(params));
	const body = await response.json();
	return { response, body };
}

/* ------------------------------------------------------------------------- *
 * Fixture tree
 * ------------------------------------------------------------------------- */

/** @type {{root: string, cleanup: () => void}} */
let fixture;
/** @type {string} — non-repository parent directory holding the workspace. */
let workspace;
/** @type {string} */
let workspaceReal;
/** @type {string} */
let alpha;
/** @type {string} */
let alphaSha;
/** @type {string} */
let beta;
/** @type {string} */
let detachedSha;
/** @type {string} */
let emptyRepo;
/** @type {string} */
let nested;
/** @type {string} */
let nestedSha;

/**
 * workspace/            not a repository (scanned cwd)
 *   alpha/              repository, branch master, tag v1.0.0
 *   beta/               repository, detached HEAD
 *   empty-repo/         repository, unborn HEAD (`git init`, no commit)
 *   group/nested/       repository at depth 2, branch main
 *   node_modules/decoy/ repository, must be skipped
 *   .hidden/decoy/      repository, must be skipped
 *   build/decoy/        repository, must be skipped
 *   plain/inner/        ordinary directories (BFS depth accounting)
 *   emptydir/           empty directory
 */
before(() => {
	fixture = createFixtureRoot();
	workspace = join(fixture.root, 'workspace');
	mkdirSync(workspace, { recursive: true });

	alpha = join(workspace, 'alpha');
	initRepo(alpha, { branch: 'master' });
	writeFixtureFile(alpha, 'README.md', '# alpha\n');
	alphaSha = commitAll(alpha, 'alpha: 初始提交');
	git(alpha, ['tag', 'v1.0.0']);

	beta = join(workspace, 'beta');
	({ detachedSha } = buildDetachedRepo(beta));

	emptyRepo = join(workspace, 'empty-repo');
	buildEmptyRepo(emptyRepo);

	nested = join(workspace, 'group', 'nested');
	initRepo(nested, { branch: 'main' });
	writeFixtureFile(nested, 'nested.txt', 'nested\n');
	nestedSha = commitAll(nested, 'nested: 初始提交');

	for (const decoy of [
		join(workspace, 'node_modules', 'decoy'),
		join(workspace, '.hidden', 'decoy'),
		join(workspace, 'build', 'decoy'),
	]) {
		initRepo(decoy);
	}

	// Ordinary directories, only there to exercise BFS/depth/directory budgets.
	writeFixtureFile(join(workspace, 'plain'), 'readme.txt', 'plain\n');
	mkdirSync(join(workspace, 'plain', 'inner'), { recursive: true });
	mkdirSync(join(workspace, 'emptydir'), { recursive: true });

	// A directory inside the alpha repository, to prove cwd-inside-repository.
	mkdirSync(join(alpha, 'src'), { recursive: true });
	writeFixtureFile(alpha, 'src/code.txt', 'code\n');

	workspaceReal = realpathSync.native(workspace);
});

after(() => fixture.cleanup());

/* ------------------------------------------------------------------------- *
 * discoverRepos — core layer
 * ------------------------------------------------------------------------- */

describe('discoverRepos', () => {
	test('scans the default depth and reports repos sorted by rel', async () => {
		const value = await discoverValue(workspace);

		assert.equal(value.cwd, workspace);
		assert.deepEqual(value.cwdRepo, { isRepo: false, root: null, head: null, empty: false });
		assert.deepEqual(value.repos.map((repo) => repo.rel), [
			'alpha',
			'beta',
			'empty-repo',
			'group/nested',
		]);
		assert.deepEqual(value.repos.map((repo) => repo.name), ['alpha', 'beta', 'empty-repo', 'nested']);
		assert.deepEqual(value.repos.map((repo) => repo.depth), [1, 1, 1, 2]);
		for (const repo of value.repos) {
			assert.ok(isAbsolute(repo.path), `path must be absolute: ${repo.path}`);
			assert.equal(repo.path, join(workspace, ...repo.rel.split('/')));
		}

		// Skipped decoys never appear.
		for (const decoy of ['node_modules/decoy', '.hidden/decoy', 'build/decoy']) {
			assert.ok(!value.repos.some((repo) => repo.rel === decoy), `must skip ${decoy}`);
		}
		// cwd itself is never part of `repos`.
		assert.ok(!value.repos.some((repo) => repo.rel === ''));

		assert.deepEqual(value.limits, { depth: LIMITS.reposDepthDefault, max: LIMITS.reposMaxDefault });
		// cwd, emptydir, group, plain, plain/inner — repository roots are leaves.
		assert.equal(value.scanned.directories, 5);
		assert.equal(value.scanned.depthLimitHit, false);
		assert.equal(value.scanned.countLimitHit, false);
		assert.equal(value.scanned.dirLimitHit, false);
		assert.ok(
			Number.isInteger(value.scanned.durationMs) && value.scanned.durationMs >= 0,
			`durationMs must be a non-negative integer: ${value.scanned.durationMs}`,
		);
	});

	test('reports branch, detached and unborn heads; tags do not change them', async () => {
		const value = await discoverValue(workspace);
		const byRel = new Map(value.repos.map((repo) => [repo.rel, repo]));

		// alpha: ordinary branch (with a tag on HEAD).
		assert.deepEqual(byRel.get('alpha').head, {
			type: 'branch',
			name: 'master',
			sha: alphaSha,
			shortSha: alphaSha.slice(0, 7),
		});
		// beta: detached HEAD → name falls back to the short sha, like op=repo.
		assert.deepEqual(byRel.get('beta').head, {
			type: 'detached',
			name: detachedSha.slice(0, 7),
			sha: detachedSha,
			shortSha: detachedSha.slice(0, 7),
		});
		// empty-repo: `git init` without a commit (HEAD symbolic ref still readable).
		assert.deepEqual(byRel.get('empty-repo').head, {
			type: 'unborn',
			name: 'master',
			sha: null,
			shortSha: null,
		});
		// nested: branch main at depth 2.
		assert.deepEqual(byRel.get('group/nested').head, {
			type: 'branch',
			name: 'main',
			sha: nestedSha,
			shortSha: nestedSha.slice(0, 7),
		});
	});

	test('depth=1 returns only direct children and flags depthLimitHit', async () => {
		const value = await discoverValue(workspace, { depth: 1 });
		assert.deepEqual(value.limits, { depth: 1, max: LIMITS.reposMaxDefault });
		assert.deepEqual(value.repos.map((repo) => repo.rel), ['alpha', 'beta', 'empty-repo']);
		assert.equal(value.scanned.directories, 1);
		assert.equal(value.scanned.depthLimitHit, true);
		assert.equal(value.scanned.countLimitHit, false);
		assert.equal(value.scanned.dirLimitHit, false);
	});

	test('depth=2 reaches the nested repository and still flags the depth limit', async () => {
		const value = await discoverValue(workspace, { depth: 2 });
		assert.deepEqual(value.repos.map((repo) => repo.rel), [
			'alpha',
			'beta',
			'empty-repo',
			'group/nested',
		]);
		assert.deepEqual(value.limits, { depth: 2, max: LIMITS.reposMaxDefault });
		// plain/inner sits exactly at the limit and is not descended into.
		assert.equal(value.scanned.depthLimitHit, true);
	});

	test('max truncates the result and flags countLimitHit', async () => {
		const two = await discoverValue(workspace, { max: 2 });
		assert.deepEqual(two.limits, { depth: LIMITS.reposDepthDefault, max: 2 });
		assert.deepEqual(two.repos.map((repo) => repo.rel), ['alpha', 'beta']);
		assert.equal(two.scanned.countLimitHit, true);
		assert.equal(two.scanned.depthLimitHit, false);

		const one = await discoverValue(workspace, { max: 1 });
		assert.deepEqual(one.repos.map((repo) => repo.rel), ['alpha']);
		assert.equal(one.scanned.countLimitHit, true);
	});

	test('maxDirs budget stops the walk and flags dirLimitHit', async () => {
		// cwd plus `emptydir` are scanned, then the budget is exhausted while
		// `group`/`plain` are still queued.
		const value = await discoverValue(workspace, { maxDirs: 2 });
		assert.equal(value.scanned.directories, 2);
		assert.equal(value.scanned.dirLimitHit, true);
		assert.equal(value.scanned.depthLimitHit, false);
		assert.equal(value.scanned.countLimitHit, false);
		// Everything found before the budget ran out is still returned.
		assert.deepEqual(value.repos.map((repo) => repo.rel), ['alpha', 'beta', 'empty-repo']);
	});

	test('the wall-clock deadline stops the walk and flags dirLimitHit', async () => {
		const value = await discoverValue(workspace, { deadlineMs: 0 });
		assert.equal(value.scanned.dirLimitHit, true);
		assert.equal(value.scanned.directories, 0);
		assert.deepEqual(value.repos, []);
		assert.deepEqual(value.cwdRepo, { isRepo: false, root: null, head: null, empty: false });
	});

	test('cwd inside a repository reports cwdRepo and never lists cwd itself', async () => {
		const value = await discoverValue(alpha);
		assert.equal(value.cwd, alpha);
		assert.equal(value.cwdRepo.isRepo, true);
		assert.equal(value.cwdRepo.root, realpathSync.native(alpha));
		assert.equal(value.cwdRepo.empty, false);
		assert.deepEqual(value.cwdRepo.head, {
			type: 'branch',
			name: 'master',
			sha: alphaSha,
			shortSha: alphaSha.slice(0, 7),
		});
		assert.deepEqual(value.repos, []);
	});

	test('cwd in a subdirectory of a repository resolves the repository root', async () => {
		const value = await discoverValue(join(alpha, 'src'));
		assert.equal(value.cwdRepo.isRepo, true);
		assert.equal(value.cwdRepo.root, realpathSync.native(alpha));
		// Only the src directory is scanned; no repositories live inside it.
		assert.deepEqual(value.repos, []);
		assert.equal(value.scanned.directories, 1);
	});

	test('detects a `.git` file as a repository root (linked worktree)', async () => {
		const local = createFixtureRoot();
		try {
			const mainRepo = join(local.root, 'main-repo');
			initRepo(mainRepo);
			writeFixtureFile(mainRepo, 'a.txt', 'a\n');
			commitAll(mainRepo, 'first');
			const worktree = join(local.root, 'worktree checkout');
			git(mainRepo, ['worktree', 'add', '-q', '-b', 'wt-branch', worktree]);

			const value = await discoverValue(local.root);
			assert.deepEqual(value.repos.map((repo) => repo.rel), ['main-repo', 'worktree checkout']);
			const worktreeRepo = value.repos.find((repo) => repo.rel === 'worktree checkout');
			assert.deepEqual(worktreeRepo.head, {
				type: 'branch',
				name: 'wt-branch',
				sha: worktreeRepo.head.sha,
				shortSha: worktreeRepo.head.shortSha,
			});
			assert.match(worktreeRepo.head.sha, /^[0-9a-f]{40,64}$/);
			assert.equal(worktreeRepo.head.shortSha, worktreeRepo.head.sha.slice(0, 7));
		} finally {
			local.cleanup();
		}
	});

	test('does not follow symbolic links / junctions', async (t) => {
		const local = createFixtureRoot();
		try {
			const linkedRepo = join(local.root, 'linked-repo');
			initRepo(linkedRepo);
			writeFixtureFile(linkedRepo, 'a.txt', 'a\n');
			commitAll(linkedRepo, 'first');

			const cwd = join(local.root, 'scanned');
			mkdirSync(cwd);
			const link = join(cwd, 'linked');
			try {
				// `junction` is the unprivileged directory-link flavour on Windows.
				symlinkSync(linkedRepo, link, 'junction');
			} catch {
				t.skip('this platform cannot create a directory link without privileges');
				return;
			}

			const value = await discoverValue(cwd);
			assert.deepEqual(value.repos, [], 'a linked repository must not be followed');
			assert.equal(value.scanned.directories, 1);
		} finally {
			local.cleanup();
		}
	});

	test('rejects out-of-range and non-integer depth/max options', async () => {
		const cases = [
			[{ depth: 0 }, 'invalid-depth'],
			[{ depth: LIMITS.reposDepthMax + 1 }, 'invalid-depth'],
			[{ depth: 2.5 }, 'invalid-depth'],
			[{ depth: 'abc' }, 'invalid-depth'],
			[{ max: 0 }, 'invalid-max'],
			[{ max: LIMITS.reposMaxMax + 1 }, 'invalid-max'],
			[{ max: 1.5 }, 'invalid-max'],
			[{ max: 'many' }, 'invalid-max'],
		];
		for (const [options, code] of cases) {
			const result = await discover(workspace, options);
			assert.equal(result.ok, false, `must reject ${JSON.stringify(options)}`);
			assert.equal(result.error.code, code);
			assert.equal(typeof result.error.message, 'string');
		}
	});

	test('rejects a missing cwd with the shared cwd-invalid envelope', async () => {
		const missing = join(fixture.root, 'does-not-exist');
		const result = await discover(missing);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'cwd-invalid');
	});
});

/* ------------------------------------------------------------------------- *
 * GET /api/plugin/git-graph?op=repos — HTTP layer
 * ------------------------------------------------------------------------- */

describe('op=repos route', () => {
	test('serves the default discovery envelope with the SPEC headers', async () => {
		const { response, body } = await call({}, { op: 'repos', cwd: workspace });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(body.ok, true, JSON.stringify(body));

		const value = body.value;
		assert.equal(value.cwd, workspaceReal);
		assert.deepEqual(value.cwdRepo, { isRepo: false, root: null, head: null, empty: false });
		assert.deepEqual(value.repos.map((repo) => repo.rel), [
			'alpha',
			'beta',
			'empty-repo',
			'group/nested',
		]);
		assert.deepEqual(value.limits, { depth: 4, max: 50 });
		assert.equal(value.scanned.directories, 5);
		assert.equal(value.scanned.depthLimitHit, false);
		assert.equal(value.scanned.countLimitHit, false);
		assert.equal(value.scanned.dirLimitHit, false);
		assert.equal(typeof value.scanned.durationMs, 'number');

		const alphaRepo = value.repos[0];
		assert.deepEqual(Object.keys(alphaRepo).sort(), ['depth', 'head', 'name', 'path', 'rel']);
		assert.deepEqual(Object.keys(alphaRepo.head).sort(), ['name', 'sha', 'shortSha', 'type']);
		assert.equal(alphaRepo.path, join(workspaceReal, 'alpha'));
	});

	test('passes depth/max through and echoes the effective limits', async () => {
		const depthOne = await call({}, { op: 'repos', cwd: workspace, depth: 1 });
		assert.equal(depthOne.body.ok, true, JSON.stringify(depthOne.body));
		assert.deepEqual(depthOne.body.value.limits, { depth: 1, max: 50 });
		assert.deepEqual(depthOne.body.value.repos.map((repo) => repo.rel), ['alpha', 'beta', 'empty-repo']);
		assert.equal(depthOne.body.value.scanned.depthLimitHit, true);

		const maxTwo = await call({}, { op: 'repos', cwd: workspace, max: 2 });
		assert.equal(maxTwo.body.ok, true, JSON.stringify(maxTwo.body));
		assert.deepEqual(maxTwo.body.value.limits, { depth: 4, max: 2 });
		assert.deepEqual(maxTwo.body.value.repos.map((repo) => repo.rel), ['alpha', 'beta']);
		assert.equal(maxTwo.body.value.scanned.countLimitHit, true);
	});

	test('empty depth/max query values fall back to the defaults', async () => {
		const { body } = await call({}, { op: 'repos', cwd: workspace, depth: '', max: '' });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.deepEqual(body.value.limits, { depth: 4, max: 50 });
	});

	test('invalid depth/max answer HTTP 400 with the new parameter error codes', async () => {
		const cases = [
			[{ depth: '0' }, 'invalid-depth'],
			[{ depth: '7' }, 'invalid-depth'],
			[{ depth: 'abc' }, 'invalid-depth'],
			[{ depth: '1.5' }, 'invalid-depth'],
			[{ depth: '-1' }, 'invalid-depth'],
			[{ depth: '999999999999999999999' }, 'invalid-depth'],
			[{ max: '0' }, 'invalid-max'],
			[{ max: '201' }, 'invalid-max'],
			[{ max: 'xyz' }, 'invalid-max'],
			[{ max: '2.5' }, 'invalid-max'],
		];
		for (const [extra, expectedCode] of cases) {
			const { response, body } = await call({}, { op: 'repos', cwd: workspace, ...extra });
			assert.equal(response.status, 400, `${JSON.stringify(extra)}: ${JSON.stringify(body)}`);
			assert.equal(body.ok, false);
			assert.equal(body.error.code, expectedCode);
			assert.equal(typeof body.error.message, 'string');
			assert.ok(!body.error.stack, 'no stack traces in responses');
		}
	});

	test('classifies the new error codes as parameter errors', () => {
		assert.equal(isParamErrorCode('invalid-depth'), true);
		assert.equal(isParamErrorCode('invalid-max'), true);
	});

	test('resolves sessionId through a live agent working directory', async () => {
		const agent = { session: { header: { cwd: workspace } } };
		const { response, body } = await call(
			{ agents: { get: (sessionId) => (sessionId === 'repos-session' ? agent : undefined) } },
			{ op: 'repos', sessionId: 'repos-session' },
		);
		assert.equal(response.status, 200);
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, workspaceReal);
		assert.deepEqual(body.value.repos.map((repo) => repo.rel), [
			'alpha',
			'beta',
			'empty-repo',
			'group/nested',
		]);
	});

	test('explicit cwd wins over sessionId and skips session lookups', async () => {
		let observed = 0;
		const { body } = await call(
			{
				agents: { get: () => ({ session: { header: { cwd: 'D:\\elsewhere' } } }) },
				sessionQuery: {
					observeSession: async () => {
						observed += 1;
						throw new Error('session lookup must not run when cwd is explicit');
					},
				},
			},
			{ op: 'repos', cwd: workspace, sessionId: 'ignored' },
		);
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwd, workspaceReal);
		assert.equal(observed, 0);
	});

	test('unknown sessions stay a business error (HTTP 200)', async () => {
		const { response, body } = await call({}, { op: 'repos', sessionId: 'missing-session' });
		assert.equal(response.status, 200);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'session-not-found');
	});

	test('an invalid explicit cwd is a parameter error (HTTP 400)', async () => {
		for (const cwd of ['relative/path', join(fixture.root, 'missing'), join(workspace, 'plain', 'readme.txt')]) {
			const { response, body } = await call({}, { op: 'repos', cwd });
			assert.equal(response.status, 400, cwd);
			assert.equal(body.ok, false);
			assert.equal(body.error.code, 'cwd-invalid');
		}
	});

	test('a repository cwd reports cwdRepo.isRepo=true and no sub-repositories', async () => {
		const { body } = await call({}, { op: 'repos', cwd: alpha });
		assert.equal(body.ok, true, JSON.stringify(body));
		assert.equal(body.value.cwdRepo.isRepo, true);
		assert.equal(body.value.cwdRepo.root, realpathSync.native(alpha));
		assert.deepEqual(body.value.repos, []);
	});
});
