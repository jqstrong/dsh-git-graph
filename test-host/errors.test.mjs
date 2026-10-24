/**
 * Error-path and repository-state tests for the read-only git engine:
 * non-repository directories, empty repositories, detached HEAD, dirty trees,
 * bare repositories, invalid option values and a missing git executable.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { inspectRepo, listRefs, normalizeLogOptions, readCommit, readDiff, readLog } from '../host/git-core.js';
import {
	buildDetachedRepo,
	buildDirtyRepo,
	buildEmptyRepo,
	createFixtureRoot,
	git,
	initRepo,
	revParse,
	writeFixtureFile,
} from './helpers.mjs';

/** @type {{root: string, cleanup: () => void}} */
let fixture;
/** @type {string} */
let emptyRepo;
/** @type {string} */
let detached;
/** @type {string} */
let dirtyRepo;
/** @type {string} */
let nonRepo;
/** @type {string} */
let smallRepo;

before(() => {
	fixture = createFixtureRoot();
	nonRepo = join(fixture.root, 'plain directory');
	writeFixtureFile(fixture.root, 'plain directory/readme.txt', 'not a repository\n');

	emptyRepo = buildEmptyRepo(join(fixture.root, 'empty-repo'));
	({ dir: detached } = buildDetachedRepo(join(fixture.root, 'detached-repo')));
	dirtyRepo = buildDirtyRepo(join(fixture.root, 'dirty-repo'));

	smallRepo = initRepo(join(fixture.root, 'small-repo'));
	writeFixtureFile(smallRepo, 'a.txt', 'a\n');
	git(smallRepo, ['add', '-A']);
	git(smallRepo, ['commit', '-q', '-m', 'one']);
});

after(() => fixture.cleanup());

describe('not a repository', () => {
	test('inspectRepo returns a typed not-a-repository error', async () => {
		const result = await inspectRepo(nonRepo);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'not-a-repository');
		assert.ok(result.error.message.length > 0);
		assert.equal(result.error.cwd, nonRepo);
	});

	test('every read operation reports not-a-repository', async () => {
		for (const result of [
			await listRefs(nonRepo),
			await readLog(nonRepo),
			await readCommit(nonRepo, 'deadbeef'),
			await readDiff(nonRepo, 'deadbeef', 'a.txt'),
		]) {
			assert.equal(result.ok, false);
			assert.equal(result.error.code, 'not-a-repository');
		}
	});

	test('bare repositories are reported as not-a-repository', async () => {
		const bare = join(fixture.root, 'bare.git');
		git(fixture.root, ['init', '-q', '--bare', bare]);
		const result = await inspectRepo(bare);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'not-a-repository');
	});

	test('reports cwd-invalid for missing or non-directory cwds', async () => {
		const missing = await inspectRepo(join(fixture.root, 'does-not-exist'));
		assert.equal(missing.ok, false);
		assert.equal(missing.error.code, 'cwd-invalid');

		const filePath = join(nonRepo, 'readme.txt');
		const notDirectory = await inspectRepo(filePath);
		assert.equal(notDirectory.ok, false);
		assert.equal(notDirectory.error.code, 'cwd-invalid');

		const emptyString = await inspectRepo('');
		assert.equal(emptyString.ok, false);
		assert.equal(emptyString.error.code, 'cwd-invalid');

		const notString = await inspectRepo(42);
		assert.equal(notString.ok, false);
		assert.equal(notString.error.code, 'cwd-invalid');
	});

	test('maps a missing git executable to git-not-found', async () => {
		const savedPath = process.env.PATH;
		const savedPathExt = process.env.PATHEXT;
		process.env.PATH = '';
		delete process.env.PATHEXT;
		try {
			const result = await inspectRepo(smallRepo);
			assert.equal(result.ok, false);
			assert.equal(result.error.code, 'git-not-found');
		} finally {
			process.env.PATH = savedPath;
			if (savedPathExt === undefined) delete process.env.PATHEXT;
			else process.env.PATHEXT = savedPathExt;
		}
	});
});

describe('empty repository', () => {
	test('inspectRepo reports the unborn HEAD and empty flag', async () => {
		const result = await inspectRepo(emptyRepo);
		assert.equal(result.ok, true, JSON.stringify(result));
		const repo = result.value;
		assert.equal(repo.isRepo, true);
		assert.equal(repo.empty, true);
		assert.equal(repo.head.type, 'unborn');
		assert.equal(repo.head.sha, null);
		assert.equal(repo.head.shortSha, null);
		assert.equal(repo.head.name, 'master');
		assert.equal(repo.upstream, null);
		assert.equal(repo.ahead, 0);
		assert.equal(repo.behind, 0);
		assert.equal(repo.dirtyFiles, 0);
		assert.equal(repo.branchCount, 0);
		assert.equal(repo.tagCount, 0);
		assert.equal(repo.remoteCount, 0);
		assert.match(repo.gitVersion, /^\d+\.\d+/);
	});

	test('refs and log are empty rather than failing', async () => {
		const refs = await listRefs(emptyRepo);
		assert.equal(refs.ok, true, JSON.stringify(refs));
		assert.equal(refs.value.head.type, 'unborn');
		assert.equal(refs.value.head.sha, null);
		assert.deepEqual(refs.value.branches, []);
		assert.deepEqual(refs.value.remotes, []);
		assert.deepEqual(refs.value.tags, []);
		assert.deepEqual(refs.value.remotesList, []);

		const log = await readLog(emptyRepo);
		assert.equal(log.ok, true, JSON.stringify(log));
		assert.equal(log.value.headSha, null);
		assert.deepEqual(log.value.commits, []);
		assert.equal(log.value.hasMore, false);
	});
});

describe('detached HEAD', () => {
	test('inspectRepo reports a detached head with short-sha name', async () => {
		const result = await inspectRepo(detached);
		assert.equal(result.ok, true, JSON.stringify(result));
		const repo = result.value;
		assert.equal(repo.head.type, 'detached');
		assert.equal(repo.head.sha, revParse(detached, 'HEAD'));
		assert.equal(repo.head.shortSha, repo.head.sha.slice(0, 7));
		assert.equal(repo.head.name, repo.head.shortSha);
		assert.equal(repo.upstream, null);
		assert.equal(repo.empty, false);
	});

	test('the log starts at the detached head', async () => {
		const result = await readLog(detached);
		assert.equal(result.ok, true);
		assert.equal(result.value.headSha, revParse(detached, 'HEAD'));
		// The default view is all refs: the detached HEAD plus the local `master`.
		assert.equal(result.value.commits.length, 2);
		const headCommit = result.value.commits.find((commit) => commit.sha === revParse(detached, 'HEAD'));
		assert.ok(headCommit !== undefined);
	});
});

describe('dirty working tree', () => {
	test('counts modified, deleted and untracked entries', async () => {
		const result = await inspectRepo(dirtyRepo);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.value.dirtyFiles, 3);
	});
});

describe('log option validation', () => {
	test('normalizeLogOptions enforces the documented ranges', () => {
		assert.deepEqual(normalizeLogOptions({}), { ok: true, value: { limit: 300, skip: 0 } });
		assert.deepEqual(normalizeLogOptions({ limit: '5', skip: '2' }), { ok: true, value: { limit: 5, skip: 2 } });
		for (const limit of [0, -1, 1.5, 2_001, 'abc', '']) {
			const result = normalizeLogOptions({ limit });
			assert.equal(result.ok, false, `limit ${String(limit)} must be rejected`);
			assert.equal(result.error.code, 'invalid-limit');
		}
		for (const skip of [-1, 1.5, 'abc']) {
			const result = normalizeLogOptions({ skip });
			assert.equal(result.ok, false, `skip ${String(skip)} must be rejected`);
			assert.equal(result.error.code, 'invalid-skip');
		}
	});

	test('readLog rejects out-of-range limits', async () => {
		const result = await readLog(smallRepo, { limit: 2_001 });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'invalid-limit');
	});
});
