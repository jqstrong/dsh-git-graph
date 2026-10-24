/**
 * Semantic tests for the read-only git engine (`host/git-core.js`) against a
 * purpose-built repository: Chinese/emoji/spaced paths, multiline messages,
 * branches, a merge, tags, a rename, a binary file, a missing final newline and
 * a diff large enough to hit the truncation budget.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
	clearCommitCache,
	inspectRepo,
	isRefFilter,
	isSafeRepoPath,
	isSha,
	listRefs,
	parseUnifiedDiff,
	readCommit,
	readDiff,
	readLog,
	runGit,
} from '../host/git-core.js';
import { at, buildMainRepo, commitAll, createFixtureRoot, initRepo, writeFixtureFile } from './helpers.mjs';

/** @type {{root: string, cleanup: () => void}} */
let fixture;
/** @type {string} */
let cwd;
/** @type {Record<string, string>} */
let shas;

before(() => {
	fixture = createFixtureRoot();
	const built = buildMainRepo(join(fixture.root, 'main repo'));
	cwd = built.dir;
	shas = built.shas;
});

after(() => fixture.cleanup());

/* ------------------------------------------------------------------------- *
 * op=repo
 * ------------------------------------------------------------------------- */

describe('inspectRepo', () => {
	test('summarizes the main repository', async () => {
		const result = await inspectRepo(cwd);
		assert.equal(result.ok, true, JSON.stringify(result));
		const repo = result.value;
		assert.equal(repo.isRepo, true);
		assert.equal(repo.empty, false);
		assert.equal(repo.cwd, cwd);
		assert.equal(repo.root, cwd);
		assert.equal(repo.head.type, 'branch');
		assert.equal(repo.head.name, 'master');
		assert.equal(repo.head.sha, shas.c10);
		assert.equal(repo.head.shortSha, shas.c10.slice(0, 7));
		assert.equal(repo.upstream, 'origin/master');
		assert.ok(repo.ahead > 0, `ahead was ${repo.ahead}`);
		assert.equal(repo.behind, 0);
		assert.equal(repo.dirtyFiles, 0);
		assert.match(repo.gitVersion, /^\d+\.\d+/);
		assert.equal(repo.branchCount, 2);
		assert.equal(repo.tagCount, 2);
		assert.equal(repo.remoteCount, 1);
	});

	test('is deterministic', async () => {
		const first = await inspectRepo(cwd);
		const second = await inspectRepo(cwd);
		assert.deepEqual(first, second);
	});

	test('runs from a subdirectory and reports the repository root', async () => {
		const subdirectory = join(cwd, 'src', '模块');
		const result = await inspectRepo(subdirectory);
		assert.equal(result.ok, true);
		assert.equal(result.value.cwd, subdirectory);
		assert.equal(result.value.root, cwd);
	});
});

/* ------------------------------------------------------------------------- *
 * op=refs
 * ------------------------------------------------------------------------- */

describe('listRefs', () => {
	test('lists head, branches, remote branches, tags and remotes', async () => {
		const result = await listRefs(cwd);
		assert.equal(result.ok, true, JSON.stringify(result));
		const refs = result.value;

		assert.equal(refs.head.type, 'branch');
		assert.equal(refs.head.name, 'master');
		assert.equal(refs.head.sha, shas.c10);

		assert.equal(refs.branches.length, 2);
		assert.equal(refs.branches[0].name, 'master');
		assert.equal(refs.branches[0].isHead, true, 'HEAD branch sorts first');
		assert.equal(refs.branches[0].fullName, 'refs/heads/master');
		assert.equal(refs.branches[0].upstream, 'origin/master');
		assert.ok(refs.branches[0].ahead > 0);
		assert.equal(refs.branches[0].behind, 0);
		assert.ok(refs.branches[0].subject.length > 0);
		assert.equal(refs.branches[0].authorName, '测试 用户');
		assert.equal(typeof refs.branches[0].committedAt, 'number');
		assert.equal(refs.branches[0].sha, shas.c10);
		const feature = refs.branches.find((branch) => branch.name === 'feature/中文分支');
		assert.ok(feature !== undefined, 'Chinese branch name must be listed');
		assert.equal(feature.isHead, false);
		assert.equal(feature.sha, shas.c3);
		assert.equal(feature.upstream, null);
		assert.equal(feature.ahead, 0);
		assert.equal(feature.behind, 0);

		// `refs/remotes/origin/HEAD` is a symbolic ref and must not become a pill.
		assert.equal(refs.remotes.length, 1);
		const remote = refs.remotes[0];
		assert.equal(remote.name, 'origin/master');
		assert.equal(remote.remote, 'origin');
		assert.equal(remote.branch, 'master');
		assert.equal(remote.sha, shas.c4);
		assert.equal(remote.isHead, false);

		// Tags sort by creatordate desc: the annotated tag was tagged much later.
		assert.equal(refs.tags.length, 2);
		assert.equal(refs.tags[0].name, 'v1.0.0');
		assert.equal(refs.tags[0].annotated, true);
		assert.equal(refs.tags[0].sha, shas.c2, 'annotated tag is peeled to its commit');
		assert.equal(refs.tags[0].shortSha, shas.c2.slice(0, 7));
		assert.equal(refs.tags[0].subject, 'feat: 添加中文与表情路径');
		assert.equal(refs.tags[1].name, '轻量-标签');
		assert.equal(refs.tags[1].annotated, false);
		assert.equal(refs.tags[1].sha, shas.c1);

		assert.deepEqual(refs.remotesList, [{ name: 'origin', url: 'https://example.invalid/demo.git' }]);
	});

	test('is deterministic', async () => {
		const first = await listRefs(cwd);
		const second = await listRefs(cwd);
		assert.deepEqual(first, second);
	});
});

/* ------------------------------------------------------------------------- *
 * op=log
 * ------------------------------------------------------------------------- */

describe('readLog', () => {
	test('returns the full topological list by default', async () => {
		const result = await readLog(cwd);
		assert.equal(result.ok, true, JSON.stringify(result));
		const log = result.value;
		assert.equal(log.headSha, shas.c10);
		assert.equal(log.commits.length, 10);
		assert.equal(log.hasMore, false);
		assert.equal(log.commits[0].sha, shas.c10);
		assert.equal(log.commits[0].shortSha, shas.c10.slice(0, 7));
		assert.equal(log.commits[0].subject, 'perf: 大文件提交');
		assert.equal(log.commits[0].body, '');
		assert.equal(log.commits[0].author.name, '测试 用户');
		assert.equal(log.commits[0].author.email, 'tester@example.com');
		assert.equal(log.commits[0].author.time, Math.floor(Date.parse(at(100)) / 1000));
		assert.deepEqual(log.commits[0].parents, [shas.c9]);
	});

	test('marks the merge commit with both parents', async () => {
		const result = await readLog(cwd);
		const merge = result.value.commits.find((commit) => commit.sha === shas.merge);
		assert.ok(merge !== undefined);
		assert.equal(merge.parents.length, 2);
		assert.equal(merge.parents[0], shas.c4, 'first parent is master');
		assert.equal(merge.parents[1], shas.c3, 'second parent is the feature branch');
		assert.match(merge.subject, /合并 feature/);
	});

	test('decorates commits with branches, remotes and tags', async () => {
		const result = await readLog(cwd);
		const bySha = new Map(result.value.commits.map((commit) => [commit.sha, commit]));

		const head = bySha.get(shas.c10);
		assert.deepEqual(head.refs, [{ name: 'master', kind: 'branch', head: true }]);

		const remoteCommit = bySha.get(shas.c4);
		assert.deepEqual(remoteCommit.refs, [{ name: 'origin/master', kind: 'remote' }]);

		const tagged = bySha.get(shas.c2).refs.find((ref) => ref.kind === 'tag');
		assert.deepEqual(tagged, { name: 'v1.0.0', kind: 'tag' });
		const lightweight = bySha.get(shas.c1).refs.find((ref) => ref.kind === 'tag');
		assert.deepEqual(lightweight, { name: '轻量-标签', kind: 'tag' });
	});

	test('respects limit and skip', async () => {
		const full = await readLog(cwd);
		const pageOne = await readLog(cwd, { limit: 3 });
		assert.equal(pageOne.value.commits.length, 3);
		assert.equal(pageOne.value.hasMore, true);
		assert.deepEqual(
			pageOne.value.commits.map((commit) => commit.sha),
			full.value.commits.slice(0, 3).map((commit) => commit.sha),
		);

		const pageTwo = await readLog(cwd, { limit: 2, skip: 2 });
		assert.equal(pageTwo.value.commits.length, 2);
		assert.equal(pageTwo.value.hasMore, true);
		assert.deepEqual(
			pageTwo.value.commits.map((commit) => commit.sha),
			full.value.commits.slice(2, 4).map((commit) => commit.sha),
		);

		const lastPage = await readLog(cwd, { limit: 3, skip: 8 });
		assert.deepEqual(
			lastPage.value.commits.map((commit) => commit.sha),
			full.value.commits.slice(8).map((commit) => commit.sha),
		);
		assert.equal(lastPage.value.hasMore, false, 'zero commits after the page still reports no extra row');
	});

	test('filters by ref', async () => {
		const branch = await readLog(cwd, { ref: 'refs/heads/feature/中文分支' });
		assert.equal(branch.ok, true, JSON.stringify(branch));
		assert.deepEqual(
			branch.value.commits.map((commit) => commit.sha),
			[shas.c3, shas.c2, shas.c1],
		);

		const tag = await readLog(cwd, { ref: 'refs/tags/v1.0.0' });
		assert.equal(tag.ok, true);
		assert.deepEqual(tag.value.commits.map((commit) => commit.sha), [shas.c2, shas.c1]);

		const all = await readLog(cwd, { ref: '--all' });
		const plain = await readLog(cwd);
		assert.deepEqual(all, plain, '--all is the default all-refs view');
	});

	test('reports invalid and unknown refs', async () => {
		const invalid = await readLog(cwd, { ref: 'not a ref' });
		assert.equal(invalid.ok, false);
		assert.equal(invalid.error.code, 'invalid-ref');

		const unknown = await readLog(cwd, { ref: 'refs/heads/不存在' });
		assert.equal(unknown.ok, false);
		assert.equal(unknown.error.code, 'unknown-ref');
	});

	test('is deterministic', async () => {
		const first = await readLog(cwd, { limit: 50 });
		const second = await readLog(cwd, { limit: 50 });
		assert.deepEqual(first, second);
	});

	test('serializes concurrent calls', async () => {
		const results = await Promise.all([
			readLog(cwd, { limit: 2 }),
			readLog(cwd, { limit: 2 }),
			readLog(cwd, { limit: 2 }),
			readLog(cwd, { limit: 2 }),
		]);
		for (const result of results) {
			assert.equal(result.ok, true);
			assert.equal(result.value.commits.length, 2);
		}
		assert.deepEqual(results[0], results[3]);
	});
});

/* ------------------------------------------------------------------------- *
 * op=commit
 * ------------------------------------------------------------------------- */

describe('readCommit', () => {
	test('returns metadata, stats and files for the big commit', async () => {
		const result = await readCommit(cwd, shas.c10);
		assert.equal(result.ok, true, JSON.stringify(result));
		const commit = result.value;
		assert.equal(commit.sha, shas.c10);
		assert.equal(commit.shortSha, shas.c10.slice(0, 7));
		assert.deepEqual(commit.parents, [shas.c9]);
		assert.equal(commit.subject, 'perf: 大文件提交');
		assert.equal(commit.body, '');
		assert.ok(Array.isArray(commit.refs));
		assert.equal(commit.refs.some((ref) => ref.kind === 'branch' && ref.head === true), true);
		assert.deepEqual(commit.stats, { files: 1, additions: 6000, deletions: 0 });
		assert.equal(commit.files.length, 1);
		assert.deepEqual(commit.files[0], {
			status: 'A',
			path: 'big.txt',
			oldPath: null,
			additions: 6000,
			deletions: 0,
			binary: false,
		});
	});

	test('diffs a merge commit against its first parent', async () => {
		const result = await readCommit(cwd, shas.merge);
		assert.equal(result.ok, true);
		const commit = result.value;
		assert.equal(commit.parents.length, 2);
		assert.equal(commit.files.length, 1);
		assert.equal(commit.files[0].path, 'feature.txt');
		assert.equal(commit.files[0].status, 'A');
		assert.equal(commit.files[0].additions, 1);
	});

	test('detects the rename with similarity and oldPath', async () => {
		const result = await readCommit(cwd, shas.c6);
		assert.equal(result.ok, true, JSON.stringify(result));
		const commit = result.value;
		assert.equal(commit.subject, 'refactor: 重命名深层文件');
		assert.equal(commit.files.length, 1);
		const file = commit.files[0];
		assert.equal(file.status, 'R');
		assert.equal(file.path, 'src/模块/深层/嵌套/目录/重命名 文件.txt');
		assert.equal(file.oldPath, 'src/模块/深层/嵌套/目录/文件 名.txt');
		assert.equal(file.binary, false);
		assert.equal(file.additions, 1);
		assert.equal(file.deletions, 1);
		assert.ok(file.similarity >= 50, `similarity was ${file.similarity}`);
		assert.deepEqual(commit.stats, { files: 1, additions: 1, deletions: 1 });
	});

	test('flags binary files without line counts', async () => {
		const result = await readCommit(cwd, shas.c7);
		assert.equal(result.ok, true);
		const file = result.value.files[0];
		assert.equal(file.path, 'bin/data.bin');
		assert.equal(file.binary, true);
		assert.equal(file.additions, null);
		assert.equal(file.deletions, null);
		assert.deepEqual(result.value.stats, { files: 1, additions: 0, deletions: 0 });
	});

	test('handles the root commit', async () => {
		const result = await readCommit(cwd, shas.c1);
		assert.equal(result.ok, true);
		const commit = result.value;
		assert.deepEqual(commit.parents, []);
		assert.equal(commit.subject, '初始提交：项目骨架');
		assert.equal(commit.body, '');
		assert.equal(commit.files.length, 3);
		assert.deepEqual(
			commit.files.map((file) => file.status),
			['A', 'A', 'A'],
		);
		const paths = commit.files.map((file) => file.path);
		assert.ok(paths.includes('README.md'));
		assert.ok(paths.includes('文档/说明 一.txt'));
		assert.ok(paths.includes('src/模块/代码.txt'));
		assert.ok(commit.stats.additions > 0);
		assert.equal(commit.stats.files, 3);
	});

	test('exposes the multiline body and unicode/emoji paths', async () => {
		const result = await readCommit(cwd, shas.c2);
		assert.equal(result.ok, true);
		const commit = result.value;
		assert.equal(commit.subject, 'feat: 添加中文与表情路径');
		assert.equal(commit.body, '这一行是正文第一行\n第二行正文');
		const paths = commit.files.map((file) => file.path);
		assert.ok(paths.includes('资源/🎉 庆祝.txt'), `paths: ${paths.join(', ')}`);
		assert.ok(commit.refs.some((ref) => ref.kind === 'tag' && ref.name === 'v1.0.0'));
		assert.equal(commit.author.name, '测试 用户');
		assert.equal(commit.author.time, Math.floor(Date.parse(at(10)) / 1000));
	});

	test('reports file modifications around a missing final newline', async () => {
		const added = await readCommit(cwd, shas.c8);
		assert.equal(added.ok, true);
		assert.equal(added.value.files[0].status, 'A');
		assert.equal(added.value.files[0].path, '尾部无换行.txt');

		const modified = await readCommit(cwd, shas.c9);
		assert.equal(modified.ok, true);
		assert.equal(modified.value.files[0].status, 'M');
		assert.equal(modified.value.files[0].additions, 1);
		assert.equal(modified.value.files[0].deletions, 1);
	});

	test('accepts an abbreviated sha and is cache-independent', async () => {
		const abbreviated = await readCommit(cwd, shas.c6.slice(0, 7));
		assert.equal(abbreviated.ok, true);
		assert.equal(abbreviated.value.sha, shas.c6);

		const cached = await readCommit(cwd, shas.c6);
		clearCommitCache();
		const recomputed = await readCommit(cwd, shas.c6);
		assert.deepEqual(cached, recomputed);
		assert.equal(Object.isFrozen(recomputed), false);
	});

	test('rejects unknown and malformed shas', async () => {
		const unknown = await readCommit(cwd, 'deadbeef');
		assert.equal(unknown.ok, false);
		assert.equal(unknown.error.code, 'unknown-commit');

		const malformed = await readCommit(cwd, 'not-a-sha');
		assert.equal(malformed.ok, false);
		assert.equal(malformed.error.code, 'invalid-sha');
	});
});

/* ------------------------------------------------------------------------- *
 * op=diff
 * ------------------------------------------------------------------------- */

/** Verify every parsed line number against the hunk counters. */
function assertLineNumbers(hunk) {
	let oldLine = hunk.oldStart;
	let newLine = hunk.newStart;
	for (const line of hunk.lines) {
		if (line.kind === 'context') {
			assert.equal(line.oldLine, oldLine);
			assert.equal(line.newLine, newLine);
			oldLine += 1;
			newLine += 1;
		} else if (line.kind === 'add') {
			assert.equal(line.oldLine, null);
			assert.equal(line.newLine, newLine);
			newLine += 1;
		} else if (line.kind === 'del') {
			assert.equal(line.newLine, null);
			assert.equal(line.oldLine, oldLine);
			oldLine += 1;
		} else {
			assert.fail(`unexpected line kind: ${line.kind}`);
		}
	}
}

describe('readDiff', () => {
	test('parses the rename diff with correct line numbers and paths', async () => {
		const path = 'src/模块/深层/嵌套/目录/重命名 文件.txt';
		const result = await readDiff(cwd, shas.c6, path);
		assert.equal(result.ok, true, JSON.stringify(result));
		const diff = result.value;
		assert.equal(diff.path, path);
		assert.equal(diff.oldPath, 'src/模块/深层/嵌套/目录/文件 名.txt');
		assert.equal(diff.binary, false);
		assert.equal(diff.truncated, false);
		assert.equal(diff.hunks.length, 1);
		const hunk = diff.hunks[0];
		assert.match(hunk.header, /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
		assertLineNumbers(hunk);
		const deleted = hunk.lines.filter((line) => line.kind === 'del');
		const added = hunk.lines.filter((line) => line.kind === 'add');
		assert.deepEqual(deleted.map((line) => line.text), ['line 5']);
		assert.deepEqual(added.map((line) => line.text), ['line 5 changed']);
	});

	test('accepts a matching oldPath and rejects a mismatching one', async () => {
		const path = 'src/模块/深层/嵌套/目录/重命名 文件.txt';
		const matching = await readDiff(cwd, shas.c6, path, 'src/模块/深层/嵌套/目录/文件 名.txt');
		assert.equal(matching.ok, true);

		const mismatched = await readDiff(cwd, shas.c6, path, 'src/其他文件.txt');
		assert.equal(mismatched.ok, false);
		assert.equal(mismatched.error.code, 'invalid-path');
	});

	test('returns binary diffs without hunks', async () => {
		const result = await readDiff(cwd, shas.c7, 'bin/data.bin');
		assert.equal(result.ok, true);
		assert.equal(result.value.binary, true);
		assert.deepEqual(result.value.hunks, []);
		assert.equal(result.value.truncated, false);
	});

	test('diffs a file added in the root commit', async () => {
		const result = await readDiff(cwd, shas.c1, 'README.md');
		assert.equal(result.ok, true, JSON.stringify(result));
		const diff = result.value;
		assert.equal(diff.hunks.length, 1);
		assert.equal(diff.hunks[0].oldStart, 0);
		assert.equal(diff.hunks[0].oldLines, 0);
		assert.ok(diff.hunks[0].lines.every((line) => line.kind === 'add'));
		assert.equal(diff.hunks[0].lines[0].text, '# 项目标题');
		assertLineNumbers(diff.hunks[0]);
	});

	test('diffs an emoji file path', async () => {
		const result = await readDiff(cwd, shas.c2, '资源/🎉 庆祝.txt');
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.value.binary, false);
		assert.equal(result.value.hunks.length, 1);
		assert.deepEqual(result.value.hunks[0].lines.map((line) => line.text), ['庆祝内容']);
	});

	test('diffs a merge commit against its first parent', async () => {
		const result = await readDiff(cwd, shas.merge, 'feature.txt');
		assert.equal(result.ok, true);
		assert.equal(result.value.hunks.length, 1);
		assert.deepEqual(result.value.hunks[0].lines.map((line) => line.kind), ['add']);
		assert.equal(result.value.hunks[0].lines[0].text, 'feature by 中文分支');
	});

	test('handles the missing-final-newline markers', async () => {
		const result = await readDiff(cwd, shas.c9, '尾部无换行.txt');
		assert.equal(result.ok, true, JSON.stringify(result));
		const lines = result.value.hunks.flatMap((hunk) => hunk.lines);
		assert.deepEqual(
			lines.map((line) => [line.kind, line.text]),
			[['del', 'abc'], ['add', 'abcd']],
		);
		for (const hunk of result.value.hunks) assertLineNumbers(hunk);
	});

	test('truncates oversized diffs and keeps the front', async () => {
		const result = await readDiff(cwd, shas.c10, 'big.txt');
		assert.equal(result.ok, true, JSON.stringify(result));
		const diff = result.value;
		assert.equal(diff.truncated, true);
		assert.equal(diff.hunks.length, 1);
		const addedLines = diff.hunks[0].lines.filter((line) => line.kind === 'add');
		assert.ok(addedLines.length > 4_000, `kept ${addedLines.length} lines`);
		assert.ok(addedLines.length <= 5_000, `kept ${addedLines.length} lines`);
		assert.equal(addedLines[0].text, 'big line 1');
	});

	test('rejects paths that are not part of the commit', async () => {
		const notInCommit = await readDiff(cwd, shas.c10, 'README.md');
		assert.equal(notInCommit.ok, false);
		assert.equal(notInCommit.error.code, 'invalid-path');

		const traversal = await readDiff(cwd, shas.c10, '../README.md');
		assert.equal(traversal.ok, false);
		assert.equal(traversal.error.code, 'invalid-path');

		const absolute = await readDiff(cwd, shas.c10, 'E:/README.md');
		assert.equal(absolute.ok, false);
		assert.equal(absolute.error.code, 'invalid-path');

		const badSha = await readDiff(cwd, 'nope', 'README.md');
		assert.equal(badSha.ok, false);
		assert.equal(badSha.error.code, 'invalid-sha');
	});

	test('resolves an abbreviated sha', async () => {
		const result = await readDiff(cwd, shas.c6.slice(0, 8), 'src/模块/深层/嵌套/目录/重命名 文件.txt');
		assert.equal(result.ok, true);
	});

	test('kills an oversized diff stream and reports truncation', async () => {
		const hugeFixture = createFixtureRoot();
		try {
			const dir = initRepo(join(hugeFixture.root, 'huge repo'));
			writeFixtureFile(
				dir,
				'huge.txt',
				Array.from({ length: 6_000 }, (_, index) => `line ${index + 1} ${'x'.repeat(700)}\n`).join(''),
			);
			const sha = commitAll(dir, 'huge commit');
			const started = Date.now();
			const result = await readDiff(dir, sha, 'huge.txt');
			const elapsed = Date.now() - started;
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.equal(result.value.truncated, true);
			assert.ok(elapsed < 15_000, `took ${elapsed}ms`);
			assert.ok(result.value.hunks.length >= 1, 'the partial diff is still usable');
			assert.ok(result.value.hunks.flatMap((hunk) => hunk.lines).length > 0);
		} finally {
			hugeFixture.cleanup();
		}
	});
});

/* ------------------------------------------------------------------------- *
 * parseUnifiedDiff unit cases + parameter validators
 * ------------------------------------------------------------------------- */

describe('parseUnifiedDiff', () => {
	test('parses a hand-written multi-hunk patch', () => {
		const patch = [
			'diff --git a/x.txt b/x.txt',
			'index 1111111..2222222 100644',
			'--- a/x.txt',
			'+++ b/x.txt',
			'@@ -1,3 +1,4 @@ header context',
			' one',
			'-two',
			'+two changed',
			'+two and a half',
			' three',
			'@@ -10,2 +11,2 @@',
			' ten',
			'-eleven',
			'+eleven changed',
			'\\ No newline at end of file',
			'',
		].join('\n');
		const parsed = parseUnifiedDiff(patch);
		assert.equal(parsed.binary, false);
		assert.equal(parsed.truncated, false);
		assert.equal(parsed.hunks.length, 2);
		assert.equal(parsed.hunks[0].header, '@@ -1,3 +1,4 @@ header context');
		assert.equal(parsed.hunks[0].oldStart, 1);
		assert.equal(parsed.hunks[0].oldLines, 3);
		assert.equal(parsed.hunks[0].newLines, 4);
		assert.deepEqual(
			parsed.hunks[0].lines.map((line) => line.kind),
			['context', 'del', 'add', 'add', 'context'],
		);
		assertLineNumbers(parsed.hunks[0]);
		assertLineNumbers(parsed.hunks[1]);
		assert.equal(parsed.hunks[1].oldStart, 10);
	});

	test('detects binary markers', () => {
		const parsed = parseUnifiedDiff('diff --git a/a.bin b/a.bin\nBinary files /dev/null and b/a.bin differ\n');
		assert.equal(parsed.binary, true);
		assert.deepEqual(parsed.hunks, []);
	});

	test('enforces the character budget independently of the line budget', () => {
		const longLine = 'x'.repeat(20_000);
		const body = Array.from({ length: 120 }, () => `+${longLine}`).join('\n');
		const patch = `--- a/x\n+++ b/x\n@@ -0,0 +1,120 @@\n${body}\n`;
		const parsed = parseUnifiedDiff(patch);
		assert.equal(parsed.truncated, true);
		assert.ok(parsed.hunks.length >= 1);
		const kept = parsed.hunks.flatMap((hunk) => hunk.lines).length;
		assert.ok(kept < 120, `kept ${kept} lines`);
		assert.ok(kept > 0);
	});
});

describe('parameter helpers', () => {
	test('sha validation', () => {
		assert.equal(isSha('0123456789abcdef0123456789abcdef01234567'), true);
		assert.equal(isSha('abc1234'), true);
		assert.equal(isSha('abc123'), false);
		assert.equal(isSha('xyz1234'), false);
		assert.equal(isSha(42), false);
	});

	test('ref validation', () => {
		assert.equal(isRefFilter('--all'), true);
		assert.equal(isRefFilter('refs/heads/master'), true);
		assert.equal(isRefFilter('refs/heads/feature/中文分支'), true);
		assert.equal(isRefFilter('refs/tags/v1.0.0'), true);
		assert.equal(isRefFilter('refs/remotes/origin/master'), true);
		assert.equal(isRefFilter('refs/stash'), false);
		assert.equal(isRefFilter('master'), false);
		assert.equal(isRefFilter('--all --exec=rm'), false);
		assert.equal(isRefFilter('refs/heads/x\n--output=/tmp/x'), false);
	});

	test('repository path validation', () => {
		assert.equal(isSafeRepoPath('src/a.txt'), true);
		assert.equal(isSafeRepoPath('资源/🎉 庆祝.txt'), true);
		assert.equal(isSafeRepoPath('../etc/passwd'), false);
		assert.equal(isSafeRepoPath('/etc/passwd'), false);
		assert.equal(isSafeRepoPath('E:/x.txt'), false);
		assert.equal(isSafeRepoPath('a\u0000b'), false);
		assert.equal(isSafeRepoPath(''), false);
	});

	test('runGit refuses mutating commands', async () => {
		await assert.rejects(() => runGit(cwd, ['commit', '-m', 'nope']), /refusing non read-only git command/);
		await assert.rejects(() => runGit(cwd, ['checkout', 'master']), /refusing non read-only git command/);
		await assert.rejects(() => runGit(cwd, []), /non-empty argument list/);
	});
});
