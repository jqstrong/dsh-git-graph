/**
 * Shared fixtures for the Host test suite.
 *
 * Every test file builds its own throwaway repository under a `mkdtemp`
 * directory in the OS temp folder and deletes it afterwards. Fixture
 * construction may write (it is a scratch repo); the code under test is
 * strictly read-only.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
/** Fixtures live outside the package tree so the plugin's own checkout can be a git repo. */
export const FIXTURES_ROOT = join(tmpdir(), 'dsh-git-graph-fixtures');

const FIXTURE_ENV = Object.freeze({
	...process.env,
	GIT_OPTIONAL_LOCKS: '0',
	GIT_TERMINAL_PROMPT: '0',
	LC_ALL: 'C',
	LANG: 'C',
	GIT_CONFIG_NOSYSTEM: '1',
});

/** Fixed clock so commit dates (and therefore log ordering) are deterministic. */
const BASE_TIME = Date.parse('2023-01-01T08:00:00+08:00');

/** ISO timestamp `minutes` after the fixed base clock. */
export function at(minutes) {
	return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

/**
 * Run one fixture git command; throws on failure (fixtures must be right).
 * @param {string} cwd
 * @param {string[]} args
 * @param {{env?: object}} [options]
 * @returns {string} stdout
 */
export function git(cwd, args, options = {}) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...FIXTURE_ENV, ...options.env },
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/**
 * Create one isolated fixture root and return it with a cleanup callback.
 * @returns {{root: string, cleanup: () => void}}
 */
export function createFixtureRoot() {
	mkdirSync(FIXTURES_ROOT, { recursive: true });
	const root = mkdtempSync(join(FIXTURES_ROOT, 'case-'));
	return {
		root,
		cleanup() {
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			} catch {
				// A leftover directory in the OS temp folder is harmless.
			}
		},
	};
}

/** `git init` plus the local identity/config every fixture needs. */
export function initRepo(dir, options = {}) {
	mkdirSync(dir, { recursive: true });
	git(dir, ['init', '-q', '-b', options.branch ?? 'master']);
	git(dir, ['config', 'user.name', '测试 用户']);
	git(dir, ['config', 'user.email', 'tester@example.com']);
	git(dir, ['config', 'core.autocrlf', 'false']);
	git(dir, ['config', 'commit.gpgsign', 'false']);
	git(dir, ['config', 'tag.gpgsign', 'false']);
	return dir;
}

/** Write one UTF-8 fixture file, creating parent directories. */
export function writeFixtureFile(dir, relativePath, content) {
	const absolute = join(dir, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
	return relativePath;
}

/** Write one byte-exact fixture file (test content must be valid UTF-8 text). */
export function writeFixtureBytes(dir, relativePath, bytes) {
	const absolute = join(dir, relativePath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, bytes);
	return relativePath;
}

/** `git add -A` + commit with a fixed identity/date; returns the commit sha. */
export function commitAll(dir, message, options = {}) {
	git(dir, ['add', '-A']);
	const env = {};
	if (options.when !== undefined) {
		env.GIT_AUTHOR_DATE = options.when;
		env.GIT_COMMITTER_DATE = options.when;
	}
	git(dir, ['commit', '-q', '--no-gpg-sign', '-m', message], { env });
	return revParse(dir, 'HEAD');
}

/** Resolve one revision to its full sha. */
export function revParse(dir, revision) {
	return git(dir, ['rev-parse', revision]).trim();
}

/**
 * The main fixture: ten commits covering Chinese/emoji/spaced paths, multiline
 * messages, a feature branch with a Chinese name, a `--no-ff` merge, a detected
 * rename, a binary file, a missing-final-newline file, a 6000-line file (diff
 * truncation), two tags (annotated + lightweight) and a remote-tracking setup.
 *
 * @param {string} dir
 * @returns {{dir: string, shas: Record<string, string>}}
 */
export function buildMainRepo(dir) {
	initRepo(dir);

	writeFixtureFile(dir, 'README.md', '# 项目标题\n\n第一段。\n');
	writeFixtureFile(dir, '文档/说明 一.txt', '第一行\n第二行\n');
	writeFixtureFile(dir, 'src/模块/代码.txt', 'alpha\nbeta\n');
	const c1 = commitAll(dir, '初始提交：项目骨架', { when: at(0) });

	writeFixtureFile(dir, 'README.md', '# 项目标题\n\n第一段。\n第二段（新增）。\n');
	writeFixtureFile(
		dir,
		'src/模块/深层/嵌套/目录/文件 名.txt',
		Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join(''),
	);
	writeFixtureFile(dir, '资源/🎉 庆祝.txt', '庆祝内容\n');
	const c2 = commitAll(dir, 'feat: 添加中文与表情路径\n\n这一行是正文第一行\n第二行正文', { when: at(10) });

	// Annotated tag whose tagger date is much later than all commits (tag sort key).
	git(
		dir,
		['tag', '-a', 'v1.0.0', '-m', '发布 1.0.0\n\n标签正文', c2],
		{ env: { GIT_COMMITTER_DATE: '2024-06-01T12:00:00+08:00' } },
	);
	git(dir, ['tag', '轻量-标签', c1], { env: { GIT_COMMITTER_DATE: at(20) } });

	git(dir, ['checkout', '-q', '-b', 'feature/中文分支', c2]);
	writeFixtureFile(dir, 'feature.txt', 'feature by 中文分支\n');
	const c3 = commitAll(dir, 'feature: 分支功能', { when: at(30) });

	git(dir, ['checkout', '-q', 'master']);
	writeFixtureFile(dir, 'fix.txt', 'hotfix\n');
	const c4 = commitAll(dir, 'fix: 主分支修复', { when: at(40) });

	git(dir, ['merge', '-q', '--no-ff', '-m', '合并 feature/中文分支\n\n合并正文', 'feature/中文分支'], {
		env: { GIT_AUTHOR_DATE: at(50), GIT_COMMITTER_DATE: at(50) },
	});
	const merge = revParse(dir, 'HEAD');

	git(dir, ['mv', 'src/模块/深层/嵌套/目录/文件 名.txt', 'src/模块/深层/嵌套/目录/重命名 文件.txt']);
	writeFixtureFile(
		dir,
		'src/模块/深层/嵌套/目录/重命名 文件.txt',
		Array.from({ length: 10 }, (_, index) => `line ${index + 1}${index === 4 ? ' changed' : ''}\n`).join(''),
	);
	const c6 = commitAll(dir, 'refactor: 重命名深层文件', { when: at(60) });

	writeFixtureBytes(dir, 'bin/data.bin', Buffer.from([0, 1, 2, 3, 255, 254, 0, 7]));
	const c7 = commitAll(dir, 'chore: 添加二进制资源\n\n二进制正文', { when: at(70) });

	// Files without a trailing newline exercise the "\ No newline" marker path.
	writeFileSync(join(dir, '尾部无换行.txt'), 'abc', 'utf8');
	const c8 = commitAll(dir, 'test: 无结尾换行', { when: at(80) });
	writeFileSync(join(dir, '尾部无换行.txt'), 'abcd', 'utf8');
	const c9 = commitAll(dir, 'test: 修改无结尾换行', { when: at(90) });

	// 6000 added lines → one diff larger than the 5000-line parse budget.
	writeFixtureFile(dir, 'big.txt', Array.from({ length: 6_000 }, (_, index) => `big line ${index + 1}\n`).join(''));
	const c10 = commitAll(dir, 'perf: 大文件提交', { when: at(100) });

	// Remote-tracking refs without any network access.
	git(dir, ['remote', 'add', 'origin', 'https://example.invalid/demo.git']);
	git(dir, ['update-ref', 'refs/remotes/origin/master', c4]);
	git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
	git(dir, ['branch', '--set-upstream-to=origin/master', 'master']);

	return {
		dir,
		shas: { c1, c2, c3, c4, merge, c6, c7, c8, c9, c10 },
	};
}

/** A freshly `git init`-ed repository with no commits. */
export function buildEmptyRepo(dir) {
	return initRepo(dir);
}

/** A repository whose HEAD is detached at a commit. */
export function buildDetachedRepo(dir) {
	initRepo(dir);
	writeFixtureFile(dir, 'a.txt', 'a\n');
	const first = commitAll(dir, 'first', { when: at(0) });
	writeFixtureFile(dir, 'b.txt', 'b\n');
	const second = commitAll(dir, 'second', { when: at(10) });
	git(dir, ['checkout', '-q', '--detach', first]);
	return { dir, detachedSha: first, headBefore: second };
}

/** A repository with exactly three dirty working-tree entries. */
export function buildDirtyRepo(dir) {
	initRepo(dir);
	writeFixtureFile(dir, 'tracked.txt', 'one\n');
	writeFixtureFile(dir, 'deleted.txt', 'gone\n');
	commitAll(dir, 'base', { when: at(0) });
	writeFixtureFile(dir, 'tracked.txt', 'two\n');
	rmSync(join(dir, 'deleted.txt'));
	writeFixtureFile(dir, 'untracked 新.txt', '新\n');
	return dir;
}
