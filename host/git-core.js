/**
 * Read-only git engine for `@local/dsh-git-graph`.
 *
 * This module is deliberately free of any DSH (DeepSeek Harness) import: it only
 * spawns `git` through `node:child_process` and returns plain JSON-serializable
 * values, so `node --test test-host` can exercise it without a Host process.
 *
 * Every operation returns a *result envelope* shaped exactly like the HTTP
 * contract documented in README.md (`/api/plugin/git-graph`):
 *
 *   { ok: true,  value: <payload> }
 *   { ok: false, error: { code, message, ...extra } }
 *
 * The HTTP layer (`index.js`) can therefore forward a result verbatim.
 *
 * Safety properties:
 * - read-only: only the commands in {@link ALLOWED_COMMANDS} are ever executed;
 *   the allowlist is checked for every call, and all commands run with
 *   `GIT_OPTIONAL_LOCKS=0` / `GIT_TERMINAL_PROMPT=0` so git never takes optional
 *   locks, never prompts, and never rewrites the index.
 * - bounded: every command has a timeout and an output cap; log/refs are paged
 *   and capped; a single-file diff is parsed only up to a line/byte budget.
 * - serialized: all git child processes run through one FIFO queue, so one
 *   request cannot flood the Host with concurrent git processes.
 * - locale/encoding pinned: `LC_ALL=C`, `i18n.logOutputEncoding=UTF-8`,
 *   `core.quotepath=false`, `--no-pager`, colors disabled. Paths and messages
 *   therefore arrive as plain UTF-8 (no octal quoting) and stable English.
 */

import { execFile, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

/** Hard limits for one git invocation / one response payload. */
export const LIMITS = Object.freeze({
	/** Timeout for a single git child process (SPEC §4.2). */
	gitTimeoutMs: 15_000,
	/** execFile maxBuffer for regular commands (SPEC §4.2). */
	maxBufferBytes: 32 * 1024 * 1024,
	/** Stderr bytes kept in an error message. */
	stderrBytes: 2 * 1024,
	/** Refs kept per group in `op=refs` (SPEC §3.2). */
	refsPerGroup: 200,
	/** Refs read for sha→ref decorations in `op=log` / `op=commit`. */
	decorationRefs: 2_000,
	/** Default `op=log` limit (SPEC §3.3). */
	logLimitDefault: 300,
	/** Maximum accepted `op=log` limit (SPEC §3.3). */
	logLimitMax: 2_000,
	/** Diff lines kept in `op=diff` (SPEC §3.5). */
	diffMaxLines: 5_000,
	/** Diff characters kept in `op=diff` (SPEC §3.5: ~1.5 MB). */
	diffMaxChars: 1_536 * 1_024,
	/** Maximum stdout bytes streamed for a diff before the child is killed. */
	diffStreamChars: 4 * 1024 * 1024,
	/** Default `op=repos` recursion depth, relative to the session directory (SPEC §3.6). */
	reposDepthDefault: 4,
	/** Minimum accepted `op=repos` depth (SPEC §3.6). */
	reposDepthMin: 1,
	/** Maximum accepted `op=repos` depth (SPEC §3.6). */
	reposDepthMax: 6,
	/** Default number of repositories returned by `op=repos` (SPEC §3.6). */
	reposMaxDefault: 50,
	/** Minimum accepted `op=repos` repository count (SPEC §3.6). */
	reposMaxMin: 1,
	/** Maximum accepted `op=repos` repository count (SPEC §3.6). */
	reposMaxMax: 200,
	/** Directories visited by one `op=repos` scan before it stops (SPEC §3.6: maxDirs). */
	reposMaxDirs: 2_000,
	/** Wall-clock budget of one `op=repos` scan in milliseconds (SPEC §3.6: ≤ 3000 ms). */
	reposDeadlineMs: 3_000,
});

/* ------------------------------------------------------------------------- *
 * Result envelopes
 * ------------------------------------------------------------------------- */

/** @returns {{ok: true, value: unknown}} */
function ok(value) {
	return { ok: true, value };
}

/**
 * @param {string} code - stable machine-readable error code.
 * @param {string} message - human-readable English message (client localizes).
 * @param {object} [extra] - extra fields merged into the error object.
 * @returns {{ok: false, error: {code: string, message: string}}}
 */
function fail(code, message, extra) {
	const error = { code, message };
	if (extra !== undefined) Object.assign(error, extra);
	return { ok: false, error };
}

/* ------------------------------------------------------------------------- *
 * Subprocess plumbing
 * ------------------------------------------------------------------------- */

/** Global git options prepended to every command. */
const BASE_ARGS = Object.freeze([
	'--no-pager',
	'-c', 'core.quotepath=false',
	'-c', 'color.ui=false',
	'-c', 'i18n.logOutputEncoding=UTF-8',
]);

/**
 * Commands this module may execute. Everything else is a programming error:
 * the plugin is read-only by construction, and this allowlist keeps it that way
 * even if a future caller passes user-controlled args.
 */
const ALLOWED_COMMANDS = new Set([
	'--version',
	'rev-parse',
	'rev-list',
	'symbolic-ref',
	'status',
	'for-each-ref',
	'remote',
	'log',
	'show',
	'diff',
	'diff-tree',
]);

/** Environment for every git child: no locks, no prompts, stable English. */
function gitEnv() {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
		LANG: 'C',
	};
}

/** Keep only a short prefix of stderr for error messages. */
function truncate(text, length) {
	return text.length <= length ? text : `${text.slice(0, length)}…`;
}

/**
 * Translate one `execFile` failure into the plugin's error vocabulary.
 * @param {NodeJS.ErrnoException & {killed?: boolean, signal?: string}} error
 * @param {{code?: string|number|null}} [meta]
 * @returns {{code: string, message: string}}
 */
function classifyFailure(error, meta = {}) {
	if (error.code === 'ENOENT') {
		return { code: 'git-not-found', message: 'git executable was not found on PATH' };
	}
	if (error.killed === true || (typeof error.signal === 'string' && error.signal.length > 0)) {
		return {
			code: 'git-timeout',
			message: `git command exceeded its ${LIMITS.gitTimeoutMs} ms timeout`,
		};
	}
	if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
		return {
			code: 'git-failed',
			message: `git output exceeded the ${LIMITS.maxBufferBytes} byte buffer`,
		};
	}
	const exit = typeof meta.exitCode === 'number' ? meta.exitCode : error.code;
	const stderr = typeof meta.stderr === 'string' ? meta.stderr.trim() : '';
	const suffix = stderr === '' ? '' : `: ${truncate(stderr, LIMITS.stderrBytes)}`;
	return { code: 'git-failed', message: `git exited with code ${String(exit)}${suffix}` };
}

/* ------------------------------------------------------------------------- *
 * Serialized execution queue
 * ------------------------------------------------------------------------- */

/** Tail of the global FIFO; every child process waits for the previous one. */
let queueTail = Promise.resolve();

/**
 * Run one task after every previously queued task settled.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
	const run = queueTail.then(() => task());
	queueTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * Assert the command is read-only, then run it through the serial queue.
 * @param {string} cwd - working directory of the git process.
 * @param {string[]} args - git arguments (without the global options).
 * @param {{timeoutMs?: number, maxBuffer?: number}} [options]
 * @returns {Promise<{status: number, stdout: string, stderr: string, error?: {code: string, message: string}}>}
 *   never rejects for a git failure; `error` is present exactly when the
 *   command could not run or exited non-zero.
 */
export function runGit(cwd, args, options = {}) {
	if (!Array.isArray(args) || args.length === 0) {
		return Promise.reject(new TypeError('git-core: runGit needs a non-empty argument list'));
	}
	if (!ALLOWED_COMMANDS.has(args[0])) {
		return Promise.reject(new TypeError(`git-core: refusing non read-only git command "${args[0]}"`));
	}
	const timeout = options.timeoutMs ?? LIMITS.gitTimeoutMs;
	const maxBuffer = options.maxBuffer ?? LIMITS.maxBufferBytes;
	return enqueue(() => execGit(cwd, args, timeout, maxBuffer));
}

/** One `execFile('git', …)` call; classifies failures instead of throwing. */
function execGit(cwd, args, timeout, maxBuffer) {
	return new Promise((settle) => {
		execFile(
			'git',
			[...BASE_ARGS, ...args],
			{
				cwd,
				timeout,
				maxBuffer,
				windowsHide: true,
				encoding: 'utf8',
				env: gitEnv(),
			},
			(error, stdout, stderr) => {
				const out = typeof stdout === 'string' ? stdout : '';
				const err = typeof stderr === 'string' ? stderr : '';
				if (error === null || error === undefined) {
					settle({ status: 0, stdout: out, stderr: err });
					return;
				}
				const exitCode = typeof error.code === 'number' ? error.code : -1;
				settle({
					status: exitCode,
					stdout: out,
					stderr: err,
					error: classifyFailure(error, { exitCode, stderr: err }),
				});
			},
		);
	});
}

/**
 * Run one git command and resolve to stdout (throw-free for git failures).
 * @returns {Promise<{ok: true, stdout: string} | {ok: false, error: object}>}
 */
async function gitText(cwd, args, options) {
	const result = await runGit(cwd, args, options);
	if (result.error !== undefined) return { ok: false, error: result.error };
	return { ok: true, stdout: result.stdout };
}

/** Whether one runGit result was an environment failure (git missing/hung), not a normal exit. */
function isEnvironmentFailure(result) {
	return result.error !== undefined && (result.error.code === 'git-not-found' || result.error.code === 'git-timeout');
}

/** First environment failure among results, if any. */
function firstEnvironmentFailure(results) {
	for (const result of results) {
		if (isEnvironmentFailure(result)) return result;
	}
	return null;
}

/**
 * Best-effort stdout: non-zero exits are treated as "absent" (e.g. no HEAD in
 * an empty repository) while environment failures still propagate.
 * @returns {string | null}
 */
function optionalStdout(result) {
	if (!result.error) return result.stdout;
	return null;
}

/* ------------------------------------------------------------------------- *
 * Validation helpers (shared with index.js)
 * ------------------------------------------------------------------------- */

/** 7..40 hex characters (SPEC §3.4/§3.5). */
export const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;

/**
 * Revision whitelist for `op=log&ref=` (SPEC §4.3).
 *
 * The spec's ASCII class is widened to allow non-ASCII (e.g. Chinese) branch
 * names, which git allows. A leading `refs/` keeps the argument from being
 * parsed as a revision option, and control characters / path-ish metacharacters
 * are still rejected.
 */
export const REF_PATTERN = /^(?:--all|refs\/(?:heads|tags|remotes)\/[^\u0000-\u0020~^:?*[\\]+)$/;

/** Whether `value` is a valid commit sha query parameter. */
export function isSha(value) {
	return typeof value === 'string' && SHA_PATTERN.test(value);
}

/** Whether `value` is a valid `ref` filter (`--all` or `refs/...`). */
export function isRefFilter(value) {
	return typeof value === 'string' && REF_PATTERN.test(value);
}

/**
 * Whether `value` is a safe repository-relative path (no NUL, no absolute path,
 * no drive letter, no `..` traversal). Git pathspecs are not filesystem paths,
 * but rejecting traversal attempts early keeps the API tight.
 */
export function isSafeRepoPath(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return false;
	if (value.includes('\u0000')) return false;
	if (/^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) return false;
	const segments = value.split('/');
	if (segments.some((segment) => segment === '..')) return false;
	return true;
}

/**
 * Resolve and validate the working directory used by an operation.
 * @returns {{ok: true, value: string} | {ok: false, error: object}}
 */
function resolveDirectory(cwd) {
	if (typeof cwd !== 'string' || cwd.length === 0) {
		return fail('cwd-invalid', 'working directory must be a non-empty absolute path');
	}
	if (cwd.includes('\u0000')) return fail('cwd-invalid', 'working directory must not contain NUL');
	const absolute = resolvePath(cwd);
	let info;
	try {
		info = statSync(absolute);
	} catch {
		return fail('cwd-invalid', `working directory does not exist: ${absolute}`, { cwd: absolute });
	}
	if (!info.isDirectory()) {
		return fail('cwd-invalid', `working directory is not a directory: ${absolute}`, { cwd: absolute });
	}
	return ok(absolute);
}

/** Normalize formatting of a numeric-ish ref field. */
function toUnixSeconds(value) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Parse `%(upstream:track,nobracket)` output into ahead/behind counts. */
function parseTrack(track) {
	const aheadMatch = /ahead\s+(\d+)/.exec(track);
	const behindMatch = /behind\s+(\d+)/.exec(track);
	return {
		ahead: aheadMatch === null ? 0 : Number(aheadMatch[1]),
		behind: behindMatch === null ? 0 : Number(behindMatch[1]),
	};
}

/** Deterministic plain-string comparison (no locale/ICU dependence). */
function compareStrings(left, right) {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Short sha used by every payload. */
function shortShaOf(sha) {
	return sha.slice(0, 7);
}

const NOT_A_REPOSITORY = /not a git repository/i;

/**
 * Convert one failed runGit result into the typed error an operation should
 * return, preserving the `not-a-repository` distinction for every operation
 * (not only `op=repo`).
 * @param {{stderr?: string, error?: {code: string, message: string}}} result
 * @param {string} cwd
 * @returns {{ok: false, error: object}}
 */
function typedFailure(result, cwd) {
	if (NOT_A_REPOSITORY.test(result.stderr ?? '')) {
		return fail('not-a-repository', `not a git repository: ${cwd}`, { cwd });
	}
	return fail(result.error?.code ?? 'git-failed', result.error?.message ?? 'git command failed');
}

/* ------------------------------------------------------------------------- *
 * git log / for-each-ref format strings
 * ------------------------------------------------------------------------- */

/** `git log` single-record format (fields separated by NUL). */
const LOG_FORMAT = [
	'%H', // 0 sha
	'%h', // 1 short sha
	'%P', // 2 parents
	'%an', // 3 author name
	'%ae', // 4 author email
	'%at', // 5 author time
	'%cn', // 6 committer name
	'%ce', // 7 committer email
	'%ct', // 8 committer time
	'%s', // 9 subject
].join('%x00') + '%x00';

/** `git for-each-ref` decoration format (fields separated by NUL). */
const DECORATION_FORMAT = [
	'%(refname)', // 0 full ref name
	'%(objectname)', // 1 object sha (tag object for annotated tags)
	'%(refname:short)', // 2 short name
	'%(objecttype)', // 3 commit | tag
	'%(*objectname)', // 4 peeled object sha (commit for annotated tags)
].join('%00');

/** `git for-each-ref` full format for `op=refs` (fields separated by NUL). */
const REFS_FORMAT = [
	'%(objectname)', // 0
	'%(refname)', // 1
	'%(refname:short)', // 2
	'%(upstream:short)', // 3
	'%(upstream:track,nobracket)', // 4
	'%(committerdate:unix)', // 5
	'%(authorname)', // 6
	'%(subject)', // 7
	'%(*objectname)', // 8
	'%(creatordate:unix)', // 9
	'%(*committerdate:unix)', // 10
	'%(*subject)', // 11
	'%(objecttype)', // 12
].join('%00');

/* ------------------------------------------------------------------------- *
 * op=repo
 * ------------------------------------------------------------------------- */

/**
 * Inspect the repository that contains `cwd` (SPEC §3.1).
 * @param {string} cwd - session working directory or explicitly picked directory.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
 */
export async function inspectRepo(cwd) {
	const directory = resolveDirectory(cwd);
	if (!directory.ok) return directory;
	const dir = directory.value;

	const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
	if (isEnvironmentFailure(inside)) return fail(inside.error.code, inside.error.message);
	if (inside.error !== undefined) {
		if (NOT_A_REPOSITORY.test(inside.stderr)) {
			return fail('not-a-repository', `not a git repository: ${dir}`, { cwd: dir });
		}
		return fail(inside.error.code, inside.error.message);
	}
	if (inside.stdout.trim() !== 'true') {
		// A bare repository answers `false`; sessions and the directory picker
		// address work trees, so this is the same user-facing state.
		return fail('not-a-repository', `not inside a git work tree: ${dir}`, { cwd: dir });
	}

	const [rootResult, branchResult, headResult, versionResult, statusResult, refsResult, remotesResult] =
		await Promise.all([
			runGit(dir, ['rev-parse', '--show-toplevel']),
			runGit(dir, ['symbolic-ref', '--short', 'HEAD']),
			runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
			runGit(dir, ['--version']),
			runGit(dir, ['status', '--porcelain']),
			runGit(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes']),
			runGit(dir, ['remote', '-v']),
		]);

	const environmentFailure = firstEnvironmentFailure([
		rootResult, branchResult, headResult, versionResult, statusResult, refsResult, remotesResult,
	]);
	if (environmentFailure !== null) {
		return fail(environmentFailure.error.code, environmentFailure.error.message);
	}

	if (rootResult.error !== undefined || rootResult.stdout.trim() === '') {
		return fail('git-failed', 'could not resolve the repository root', { cwd: dir });
	}
	const root = resolvePath(rootResult.stdout.trim());

	if (statusResult.error !== undefined) {
		return typedFailure(statusResult, dir);
	}
	if (refsResult.error !== undefined) {
		return typedFailure(refsResult, dir);
	}

	const headName = optionalStdout(branchResult)?.trim() || null;
	const headSha = optionalStdout(headResult)?.trim() || null;
	const headShortSha = headSha === null ? null : shortShaOf(headSha);

	/** @type {{type: string, name: string|null, sha: string|null, shortSha: string|null}} */
	let head;
	if (headSha !== null) {
		head = {
			type: headName === null ? 'detached' : 'branch',
			name: headName ?? headShortSha,
			sha: headSha,
			shortSha: headShortSha,
		};
	} else {
		head = { type: 'unborn', name: headName ?? 'HEAD', sha: null, shortSha: null };
	}

	// Refs by namespace: one command powers the three counters and empty detection.
	const refNames = refsResult.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
	let branchCount = 0;
	let tagCount = 0;
	const remoteRefs = new Set();
	for (const refName of refNames) {
		if (refName.startsWith('refs/heads/')) branchCount += 1;
		else if (refName.startsWith('refs/tags/')) tagCount += 1;
		else if (refName.startsWith('refs/remotes/')) remoteRefs.add(refName);
	}

	const remotesList = parseRemoteList(optionalStdout(remotesResult) ?? '');
	const remotePrefixes = new Set();
	for (const refName of remoteRefs) {
		const rest = refName.slice('refs/remotes/'.length);
		const slash = rest.indexOf('/');
		if (slash > 0) remotePrefixes.add(rest.slice(0, slash));
	}
	const remoteCount = remotesList.length > 0 ? remotesList.length : remotePrefixes.size;

	// Upstream / ahead-behind (absent for detached and unborn HEADs).
	let upstream = null;
	let ahead = 0;
	let behind = 0;
	if (headSha !== null) {
		const upstreamResult = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
		if (isEnvironmentFailure(upstreamResult)) {
			return fail(upstreamResult.error.code, upstreamResult.error.message);
		}
		const upstreamName = optionalStdout(upstreamResult)?.trim() ?? '';
		if (upstreamName !== '') {
			upstream = upstreamName;
			const countResult = await runGit(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
			if (isEnvironmentFailure(countResult)) {
				return fail(countResult.error.code, countResult.error.message);
			}
			if (!countResult.error) {
				const [left, right] = countResult.stdout.trim().split(/\s+/);
				ahead = Number(left) || 0;
				behind = Number(right) || 0;
			}
		}
	}

	const dirtyLines = statusResult.stdout.split('\n').filter((line) => line !== '').length;
	const versionMatch = /git version\s+(\S+)/.exec(optionalStdout(versionResult) ?? '');

	return ok({
		cwd: dir,
		root,
		isRepo: true,
		empty: headSha === null && refNames.length === 0,
		head,
		upstream,
		ahead,
		behind,
		dirtyFiles: dirtyLines,
		gitVersion: versionMatch === null ? null : versionMatch[1],
		branchCount,
		tagCount,
		remoteCount,
	});
}

/**
 * Parse `git remote -v` into `{name, url}` records (fetch URL preferred).
 * @param {string} text
 * @returns {{name: string, url: string}[]}
 */
function parseRemoteList(text) {
	const lines = text.split('\n').filter((line) => line.trim() !== '');
	const byName = new Map();
	for (const line of lines) {
		const match = /^(\S+)\t(.+?)\s+\((fetch|push)\)$/.exec(line.trim());
		if (match === null) continue;
		const [, name, url, kind] = match;
		const current = byName.get(name);
		if (current === undefined) byName.set(name, { name, url, fetch: kind === 'fetch' });
		else if (kind === 'fetch') {
			current.url = url;
			current.fetch = true;
		}
	}
	return [...byName.values()]
		.sort((left, right) => compareStrings(left.name, right.name))
		.map(({ name, url }) => ({ name, url }));
}

/* ------------------------------------------------------------------------- *
 * Ref decorations shared by op=log / op=commit
 * ------------------------------------------------------------------------- */

/**
 * Read the sha→refs map used to decorate commits (one `for-each-ref` call,
 * SPEC §3.3: do not run one command per commit).
 *
 * @param {string} cwd
 * @returns {Promise<{ok: true, value: {refsBySha: Map<string, object[]>, headBranch: string|null}}
 *   | {ok: false, error: object}>}
 */
async function readDecorations(cwd) {
	const [refsResult, branchResult] = await Promise.all([
		runGit(cwd, ['for-each-ref', '--format=' + DECORATION_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags']),
		runGit(cwd, ['symbolic-ref', '--short', 'HEAD']),
	]);
	const environmentFailure = firstEnvironmentFailure([refsResult, branchResult]);
	if (environmentFailure !== null) {
		return fail(environmentFailure.error.code, environmentFailure.error.message);
	}
	if (refsResult.error !== undefined) return typedFailure(refsResult, cwd);
	const headBranch = optionalStdout(branchResult)?.trim() || null;

	/** @type {Map<string, {name: string, kind: string, head?: true}[]>} */
	const refsBySha = new Map();
	let seen = 0;
	for (const line of refsResult.stdout.split('\n')) {
		if (line === '' || seen >= LIMITS.decorationRefs) continue;
		const fields = line.split('\u0000');
		if (fields.length < 5) continue;
		const [refName, objectSha, shortName, objectType, peeledSha] = fields;
		let sha;
		let kind;
		let name;
		if (refName.startsWith('refs/heads/')) {
			sha = objectSha;
			kind = 'branch';
			name = shortName;
		} else if (refName.startsWith('refs/remotes/')) {
			// Symbolic `refs/remotes/<remote>/HEAD` gets no pill.
			if (refName.endsWith('/HEAD')) continue;
			sha = objectSha;
			kind = 'remote';
			name = shortName;
		} else if (refName.startsWith('refs/tags/')) {
			sha = peeledSha === '' ? objectSha : peeledSha;
			kind = 'tag';
			name = shortName;
		} else {
			continue;
		}
		seen += 1;
		const decoration = kind === 'branch' && name === headBranch
			? { name, kind, head: true }
			: { name, kind };
		const list = refsBySha.get(sha);
		if (list === undefined) refsBySha.set(sha, [decoration]);
		else list.push(decoration);
	}
	return ok({ refsBySha, headBranch });
}

/** Look up the decorations of one commit. */
function refsFor(refsBySha, sha) {
	const list = refsBySha.get(sha);
	return list === undefined ? [] : list.map((decoration) => ({ ...decoration }));
}

/* ------------------------------------------------------------------------- *
 * op=refs
 * ------------------------------------------------------------------------- */

/**
 * List branches, remote branches, tags and remotes (SPEC §3.2).
 * @param {string} cwd
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
 */
export async function listRefs(cwd) {
	const directory = resolveDirectory(cwd);
	if (!directory.ok) return directory;
	const dir = directory.value;

	const [refsResult, branchResult, headResult, remotesResult] = await Promise.all([
		runGit(dir, ['for-each-ref', '--format=' + REFS_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags']),
		runGit(dir, ['symbolic-ref', '--short', 'HEAD']),
		runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
		runGit(dir, ['remote', '-v']),
	]);
	const environmentFailure = firstEnvironmentFailure([refsResult, branchResult, headResult, remotesResult]);
	if (environmentFailure !== null) {
		return fail(environmentFailure.error.code, environmentFailure.error.message);
	}
	if (refsResult.error !== undefined) return typedFailure(refsResult, dir);
	const headBranch = optionalStdout(branchResult)?.trim() || null;
	const headSha = optionalStdout(headResult)?.trim() || null;
	const headType = headSha === null ? 'unborn' : headBranch === null ? 'detached' : 'branch';
	const head = {
		type: headType,
		name: headBranch ?? (headSha === null ? 'HEAD' : shortShaOf(headSha)),
		sha: headSha,
	};

	const branches = [];
	const remotes = [];
	/** @type {{name: string, sha: string, shortSha: string, subject: string, annotated: boolean, committedAt: number|null, sortKey: number, order: number}[]} */
	const tags = [];
	let seen = 0;

	for (const line of refsResult.stdout.split('\n')) {
		if (line === '') continue;
		const fields = line.split('\u0000');
		if (fields.length < 13) continue;
		const [
			objectSha, refName, shortName, upstream, track, committedAtRaw,
			authorName, subject, peeledSha, creatorDateRaw, peeledCommitterDateRaw, peeledSubject,
			objectType,
		] = fields;
		seen += 1;

		if (refName.startsWith('refs/heads/')) {
			const { ahead, behind } = parseTrack(track);
			branches.push({
				name: shortName,
				fullName: refName,
				isHead: shortName === headBranch,
				sha: objectSha,
				shortSha: shortShaOf(objectSha),
				upstream: upstream === '' ? null : upstream,
				ahead,
				behind,
				subject,
				authorName,
				committedAt: toUnixSeconds(committedAtRaw),
			});
		} else if (refName.startsWith('refs/remotes/')) {
			if (refName.endsWith('/HEAD')) continue;
			const slash = shortName.indexOf('/');
			if (slash <= 0) continue;
			remotes.push({
				name: shortName,
				remote: shortName.slice(0, slash),
				branch: shortName.slice(slash + 1),
				sha: objectSha,
				isHead: false,
				subject,
				authorName,
				committedAt: toUnixSeconds(committedAtRaw),
			});
		} else if (refName.startsWith('refs/tags/')) {
			const annotated = objectType === 'tag';
			const targetSha = peeledSha === '' ? objectSha : peeledSha;
			const committedAt = toUnixSeconds(peeledCommitterDateRaw)
				?? toUnixSeconds(committedAtRaw)
				?? toUnixSeconds(creatorDateRaw);
			tags.push({
				name: shortName,
				sha: targetSha,
				shortSha: shortShaOf(targetSha),
				subject: annotated ? (peeledSubject === '' ? subject : peeledSubject) : subject,
				annotated,
				committedAt,
				sortKey: toUnixSeconds(creatorDateRaw) ?? 0,
				order: seen,
			});
		}
	}

	branches.sort((left, right) => {
		if (left.isHead !== right.isHead) return left.isHead ? -1 : 1;
		const timeDelta = (right.committedAt ?? 0) - (left.committedAt ?? 0);
		if (timeDelta !== 0) return timeDelta;
		return compareStrings(left.name, right.name);
	});
	remotes.sort((left, right) => {
		const remoteDelta = compareStrings(left.remote, right.remote);
		if (remoteDelta !== 0) return remoteDelta;
		return compareStrings(left.name, right.name);
	});
	tags.sort((left, right) => {
		const timeDelta = right.sortKey - left.sortKey;
		if (timeDelta !== 0) return timeDelta;
		return compareStrings(left.name, right.name);
	});

	const remotesList = parseRemoteList(optionalStdout(remotesResult) ?? '');

	return ok({
		head,
		branches: branches.slice(0, LIMITS.refsPerGroup),
		remotes: remotes.slice(0, LIMITS.refsPerGroup),
		tags: tags.slice(0, LIMITS.refsPerGroup).map(({ sortKey, order, ...tag }) => {
			void sortKey;
			void order;
			return tag;
		}),
		remotesList,
	});
}

/* ------------------------------------------------------------------------- *
 * op=log
 * ------------------------------------------------------------------------- */

/**
 * Validate and normalize the `op=log` options.
 * @param {{limit?: unknown, skip?: unknown}} [options]
 * @returns {{ok: true, value: {limit: number, skip: number}} | {ok: false, error: object}}
 */
export function normalizeLogOptions(options = {}) {
	const limit = options.limit === undefined || options.limit === null
		? LIMITS.logLimitDefault
		: Number(options.limit);
	const skip = options.skip === undefined || options.skip === null ? 0 : Number(options.skip);
	if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.logLimitMax) {
		return fail('invalid-limit', `limit must be an integer between 1 and ${LIMITS.logLimitMax}`);
	}
	if (!Number.isInteger(skip) || skip < 0) {
		return fail('invalid-skip', 'skip must be a non-negative integer');
	}
	return ok({ limit, skip });
}

/**
 * Read one page of commits (SPEC §3.3).
 * @param {string} cwd
 * @param {{limit?: number, skip?: number, ref?: string|null}} [options]
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
 */
export async function readLog(cwd, options = {}) {
	const directory = resolveDirectory(cwd);
	if (!directory.ok) return directory;
	const normalized = normalizeLogOptions(options);
	if (!normalized.ok) return normalized;
	const { limit, skip } = normalized.value;

	let ref = options.ref;
	if (ref === undefined || ref === null || ref === '') ref = null;
	else if (ref === '--all') ref = null; // `--all` means "all refs except stash": our default.
	else if (!isRefFilter(ref)) return fail('invalid-ref', 'ref must be --all or a refs/(heads|tags|remotes)/… name');

	const dir = directory.value;

	const [headResult, decorationResult] = await Promise.all([
		runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
		readDecorations(dir),
	]);
	if (isEnvironmentFailure(headResult)) return fail(headResult.error.code, headResult.error.message);
	if (!decorationResult.ok) return decorationResult;
	const headSha = optionalStdout(headResult)?.trim() || null;
	const { refsBySha } = decorationResult.value;

	// `--all` semantics minus refs/stash: HEAD + every branch/tag/remote-tracking ref.
	const revisionArgs = ref === null
		? [...(headSha === null ? [] : ['HEAD']), '--branches', '--tags', '--remotes']
		: [ref];

	const args = [
		'log',
		'--topo-order',
		'--date-order',
		...(skip === 0 ? [] : [`--skip=${skip}`]),
		'-n', String(limit + 1),
		`--format=${LOG_FORMAT}`,
		...revisionArgs,
	];
	const logResult = await runGit(dir, args);
	if (isEnvironmentFailure(logResult)) return fail(logResult.error.code, logResult.error.message);
	if (logResult.error !== undefined || logResult.status !== 0) {
		if (NOT_A_REPOSITORY.test(logResult.stderr)) return typedFailure(logResult, dir);
		if (ref !== null) return fail('unknown-ref', `cannot read commits for ${ref}`);
		return fail('git-failed', logResult.error?.message ?? 'git log failed');
	}

	const rows = logResult.stdout.split('\n').filter((line) => line !== '');
	const hasMore = rows.length > limit;
	const commits = [];
	for (const row of rows.slice(0, limit)) {
		const fields = row.split('\u0000');
		if (fields.length < 10) continue;
		const [sha, shaShort, parentsRaw, authorName, authorEmail, authorTime, committerName, committerEmail, committerTime, subject] = fields;
		commits.push({
			sha,
			shortSha: shaShort,
			parents: parentsRaw.trim() === '' ? [] : parentsRaw.trim().split(' '),
			author: { name: authorName, email: authorEmail, time: Number(authorTime) || 0 },
			committer: { name: committerName, email: committerEmail, time: Number(committerTime) || 0 },
			subject,
			body: '',
			refs: refsFor(refsBySha, sha),
		});
	}

	return ok({ headSha, commits, hasMore });
}

/* ------------------------------------------------------------------------- *
 * op=commit + op=diff shared file-list helpers
 * ------------------------------------------------------------------------- */

/**
 * Arguments for the commit-vs-first-parent file list. Root commits diff against
 * the empty tree through `diff-tree --root`; every other commit diffs against
 * its first parent (SPEC §3.4/§3.5, merge commits included).
 * @param {string[]} parents
 * @param {string} sha
 * @param {'--name-status'|'--numstat'} format
 * @returns {string[]}
 */
function fileListArgs(parents, sha, format) {
	if (parents.length === 0) {
		return ['diff-tree', '-r', '--root', '-M', '-C', '--no-commit-id', format, '-z', sha];
	}
	return ['diff', '-M', '-C', format, '-z', parents[0], sha];
}

/**
 * Parse NUL-terminated `--name-status -z` output.
 * @param {string} text
 * @returns {{status: string, path: string, oldPath: string|null, similarity?: number}[]}
 */
function parseNameStatus(text) {
	const tokens = text.split('\u0000');
	const entries = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === '') continue;
		const letter = token[0];
		if (letter === 'R' || letter === 'C') {
			const oldPath = tokens[index + 1];
			const path = tokens[index + 2];
			if (oldPath === undefined || path === undefined) break;
			const score = Number(token.slice(1));
			const entry = { status: letter, path, oldPath };
			if (Number.isInteger(score) && score > 0) entry.similarity = score;
			entries.push(entry);
			index += 2;
		} else {
			const path = tokens[index + 1];
			if (path === undefined) break;
			entries.push({ status: letter, path, oldPath: null });
			index += 1;
		}
	}
	return entries;
}

/**
 * Parse NUL-terminated `--numstat -z` output.
 * @param {string} text
 * @returns {{path: string, oldPath: string|null, additions: number|null, deletions: number|null, binary: boolean}[]}
 */
function parseNumstat(text) {
	const tokens = text.split('\u0000');
	const entries = [];
	const pattern = /^(\d+|-)\t(\d+|-)\t(.*)$/s;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === '') continue;
		const match = pattern.exec(token);
		if (match === null) continue;
		const binary = match[1] === '-' || match[2] === '-';
		const additions = binary ? null : Number(match[1]);
		const deletions = binary ? null : Number(match[2]);
		if (match[3] !== '') {
			entries.push({ path: match[3], oldPath: null, additions, deletions, binary });
		} else {
			const oldPath = tokens[index + 1];
			const path = tokens[index + 2];
			if (oldPath === undefined || path === undefined) break;
			entries.push({ path, oldPath, additions, deletions, binary });
			index += 2;
		}
	}
	return entries;
}

/**
 * Build the `files` list of one commit (status + line counts + rename info).
 * @param {string} cwd
 * @param {string} sha
 * @param {string[]} parents
 * @returns {Promise<{ok: true, value: object[]} | {ok: false, error: object}>}
 */
async function readCommitFiles(cwd, sha, parents) {
	const [nameStatusResult, numstatResult] = await Promise.all([
		runGit(cwd, fileListArgs(parents, sha, '--name-status')),
		runGit(cwd, fileListArgs(parents, sha, '--numstat')),
	]);
	const environmentFailure = firstEnvironmentFailure([nameStatusResult, numstatResult]);
	if (environmentFailure !== null) {
		return fail(environmentFailure.error.code, environmentFailure.error.message);
	}
	if (nameStatusResult.error !== undefined) return typedFailure(nameStatusResult, cwd);
	if (numstatResult.error !== undefined) return typedFailure(numstatResult, cwd);

	const statsByPath = new Map();
	for (const entry of parseNumstat(numstatResult.stdout)) statsByPath.set(entry.path, entry);

	return ok(parseNameStatus(nameStatusResult.stdout).map((entry) => {
		const stats = statsByPath.get(entry.path) ?? (entry.oldPath === null ? undefined : statsByPath.get(entry.oldPath));
		const binary = stats?.binary === true;
		const file = {
			status: entry.status,
			path: entry.path,
			oldPath: entry.oldPath,
			additions: binary ? null : stats?.additions ?? null,
			deletions: binary ? null : stats?.deletions ?? null,
			binary,
		};
		if (entry.similarity !== undefined) file.similarity = entry.similarity;
		return file;
	}));
}

/**
 * Commit detail cache. Git history is immutable, so a bounded cache removes the
 * extra file-list commands when the user clicks a commit and then one of its
 * files (`op=diff` re-validates the path against the cached file list).
 * @type {Map<string, object>}
 */
const commitCache = new Map();
const COMMIT_CACHE_CAPACITY = 64;

function cacheCommit(cwd, value) {
	const key = `${cwd}\u0000${value.sha}`;
	commitCache.delete(key);
	commitCache.set(key, value);
	while (commitCache.size > COMMIT_CACHE_CAPACITY) {
		const oldest = commitCache.keys().next();
		if (oldest.done === true) break;
		commitCache.delete(oldest.value);
	}
}

function cachedCommit(cwd, sha) {
	return commitCache.get(`${cwd}\u0000${sha}`);
}

/** Drop cached commit details (tests / long-lived hosts). */
export function clearCommitCache() {
	commitCache.clear();
}

/**
 * Resolve a possibly-abbreviated commit sha to its canonical 40-char form.
 * @returns {Promise<{ok: true, value: string} | {ok: false, error: object}>}
 */
async function resolveCommitSha(cwd, sha) {
	const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
	if (isEnvironmentFailure(result)) return fail(result.error.code, result.error.message);
	if (result.error !== undefined && NOT_A_REPOSITORY.test(result.stderr)) return typedFailure(result, cwd);
	const resolved = optionalStdout(result)?.trim() ?? '';
	if (result.error !== undefined || !/^[0-9a-f]{40,64}$/.test(resolved)) {
		return fail('unknown-commit', `unknown commit: ${sha}`);
	}
	return ok(resolved);
}

/* ------------------------------------------------------------------------- *
 * op=commit
 * ------------------------------------------------------------------------- */

/** `git show -s` commit format; `%B` (raw body) is the last field. */
const COMMIT_FORMAT = [
	'%H', '%h', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s', '%B',
].join('%x00');

/**
 * Read one commit's metadata, refs, stats and changed files (SPEC §3.4).
 * @param {string} cwd
 * @param {string} sha - full or abbreviated commit sha.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
 */
export async function readCommit(cwd, sha) {
	const directory = resolveDirectory(cwd);
	if (!directory.ok) return directory;
	if (!isSha(sha)) return fail('invalid-sha', 'sha must be 7 to 40 hexadecimal characters');
	const dir = directory.value;

	const resolved = await resolveCommitSha(dir, sha);
	if (!resolved.ok) return resolved;
	const fullSha = resolved.value;

	const [showResult, decorationResult] = await Promise.all([
		runGit(dir, ['show', '-s', `--format=${COMMIT_FORMAT}`, fullSha]),
		readDecorations(dir),
	]);
	if (isEnvironmentFailure(showResult)) return fail(showResult.error.code, showResult.error.message);
	if (!decorationResult.ok) return decorationResult;

	if (showResult.error !== undefined || showResult.status !== 0) {
		if (NOT_A_REPOSITORY.test(showResult.stderr)) return typedFailure(showResult, dir);
		return fail('unknown-commit', `unknown commit: ${sha}`);
	}
	const fields = showResult.stdout.split('\u0000');
	if (fields.length < 11) return fail('git-failed', 'git show returned a truncated commit record');
	const [
		shaFull, shaShort, parentsRaw, authorName, authorEmail, authorTime,
		committerName, committerEmail, committerTime, subject, rawBody,
	] = fields;
	const parents = parentsRaw.trim() === '' ? [] : parentsRaw.trim().split(' ');

	// %B is the raw message; expose everything after the subject line as `body`.
	const message = rawBody.replace(/\n+$/, '');
	const firstBreak = message.indexOf('\n');
	const body = firstBreak === -1 ? '' : message.slice(firstBreak + 1).replace(/^\n+/, '').replace(/\n+$/, '');

	const filesResult = await readCommitFiles(dir, fullSha, parents);
	if (!filesResult.ok) return filesResult;
	const files = filesResult.value;

	let additions = 0;
	let deletions = 0;
	for (const file of files) {
		if (file.binary) continue;
		additions += file.additions ?? 0;
		deletions += file.deletions ?? 0;
	}

	const value = {
		sha: shaFull,
		shortSha: shaShort,
		parents,
		author: { name: authorName, email: authorEmail, time: Number(authorTime) || 0 },
		committer: { name: committerName, email: committerEmail, time: Number(committerTime) || 0 },
		subject,
		body,
		refs: refsFor(decorationResult.value.refsBySha, shaFull),
		stats: { files: files.length, additions, deletions },
		files,
	};
	cacheCommit(dir, value);
	return ok(value);
}

/* ------------------------------------------------------------------------- *
 * op=diff
 * ------------------------------------------------------------------------- */

/**
 * Parse one unified diff into the SPEC §3.5 hunk/line shape.
 *
 * Only the first file section is interpreted; `op=diff` always scopes git to a
 * single path. Extra file headers are ignored. `\ No newline at end of file`
 * markers carry no line numbers and are therefore skipped.
 *
 * @param {string} text
 * @param {{maxLines?: number, maxChars?: number}} [limits]
 * @returns {{binary: boolean, truncated: boolean, hunks: object[]}}
 */
export function parseUnifiedDiff(text, limits = {}) {
	const maxLines = limits.maxLines ?? LIMITS.diffMaxLines;
	const maxChars = limits.maxChars ?? LIMITS.diffMaxChars;
	/** @type {object[]} */
	const hunks = [];
	let binary = false;
	let truncated = false;
	let current = null;
	let retainedChars = 0;
	let consumedLines = 0;
	const lines = text.split('\n');
	let oldLine = 0;
	let newLine = 0;
	for (const line of lines) {
		if (consumedLines >= maxLines || retainedChars >= maxChars) {
			truncated = true;
			break;
		}
		consumedLines += 1;
		retainedChars += line.length + 1;

		if (line.startsWith('@@')) {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
			if (match === null) continue;
			current = {
				header: line,
				oldStart: Number(match[1]),
				oldLines: match[2] === undefined ? 1 : Number(match[2]),
				newStart: Number(match[3]),
				newLines: match[4] === undefined ? 1 : Number(match[4]),
				lines: [],
			};
			hunks.push(current);
			oldLine = current.oldStart;
			newLine = current.newStart;
			continue;
		}
		if (current === null) {
			if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) binary = true;
			continue;
		}
		const kind = line[0];
		if (kind === ' ') {
			current.lines.push({ kind: 'context', oldLine, newLine, text: line.slice(1) });
			oldLine += 1;
			newLine += 1;
		} else if (kind === '+') {
			current.lines.push({ kind: 'add', oldLine: null, newLine, text: line.slice(1) });
			newLine += 1;
		} else if (kind === '-') {
			current.lines.push({ kind: 'del', oldLine, newLine: null, text: line.slice(1) });
			oldLine += 1;
		} else if (kind === '\\') {
			// "\ No newline at end of file": no line number, no line.
			continue;
		} else {
			// Next file header or unexpected trailer: stop interpreting this hunk.
			current = null;
		}
	}
	if (hunks.length === 0 && !binary && text.length > 0 && !truncated) {
		// A non-empty diff without hunks is normally a mode/type change only.
		truncated = false;
	}
	return { binary, truncated, hunks };
}

/**
 * Stream one git command with a hard stdout budget, killing the child once the
 * budget is reached (a huge single-file diff must not buffer forever).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{status: number, stdout: string, stderr: string, truncated: boolean, error?: object}>}
 */
function streamGit(cwd, args) {
	if (!ALLOWED_COMMANDS.has(args[0])) {
		return Promise.reject(new TypeError(`git-core: refusing non read-only git command "${args[0]}"`));
	}
	return enqueue(() => new Promise((settle) => {
		let child;
		try {
			child = spawn('git', [...BASE_ARGS, ...args], {
				cwd,
				windowsHide: true,
				env: gitEnv(),
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			settle({
				status: -1,
				stdout: '',
				stderr: '',
				truncated: false,
				error: { code: 'git-failed', message: `could not spawn git: ${String(error.message ?? error)}` },
			});
			return;
		}

		let stdout = '';
		let stderr = '';
		let truncated = false;
		let finished = false;
		/** @type {NodeJS.Timeout | undefined} */
		let timer;

		const finish = (result) => {
			if (finished) return;
			finished = true;
			if (timer !== undefined) clearTimeout(timer);
			settle(result);
		};

		timer = setTimeout(() => {
			truncated = true;
			try {
				child.kill();
			} catch {
				// The child is already gone.
			}
			finish({
				status: -1,
				stdout,
				stderr,
				truncated,
				error: { code: 'git-timeout', message: `git command exceeded its ${LIMITS.gitTimeoutMs} ms timeout` },
			});
		}, LIMITS.gitTimeoutMs);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			if (finished) return;
			if (stdout.length + chunk.length > LIMITS.diffStreamChars) {
				stdout += chunk.slice(0, Math.max(0, LIMITS.diffStreamChars - stdout.length));
				truncated = true;
				try {
					child.kill();
				} catch {
					// Already gone.
				}
				finish({ status: -1, stdout, stderr, truncated });
				return;
			}
			stdout += chunk;
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => {
			if (stderr.length < LIMITS.stderrBytes) stderr += chunk;
		});
		child.on('error', (error) => {
			finish({
				status: -1,
				stdout,
				stderr,
				truncated,
				error: classifyFailure(error),
			});
		});
		child.on('close', (code) => {
			if (finished) return;
			const status = typeof code === 'number' ? code : -1;
			const error = status === 0 || truncated ? undefined : classifyFailure({ code: status }, { exitCode: status, stderr });
			finish({ status, stdout, stderr, truncated, ...(error === undefined ? {} : { error }) });
		});
	}));
}

/**
 * Read the unified diff of one changed file in one commit (SPEC §3.5).
 *
 * The path is validated against the commit's own file list so a crafted request
 * cannot address an arbitrary pathspec (no path injection).
 *
 * @param {string} cwd
 * @param {string} sha
 * @param {string} path - new path of the file, as returned by op=commit.
 * @param {string|undefined} [oldPath] - old path for renames (from op=commit).
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
 */
export async function readDiff(cwd, sha, path, oldPath) {
	const directory = resolveDirectory(cwd);
	if (!directory.ok) return directory;
	if (!isSha(sha)) return fail('invalid-sha', 'sha must be 7 to 40 hexadecimal characters');
	if (!isSafeRepoPath(path)) return fail('invalid-path', 'path must be a safe repository-relative path');
	if (oldPath !== undefined && oldPath !== null && oldPath !== '' && !isSafeRepoPath(oldPath)) {
		return fail('invalid-path', 'oldPath must be a safe repository-relative path');
	}
	const dir = directory.value;

	const resolved = await resolveCommitSha(dir, sha);
	if (!resolved.ok) return resolved;
	const fullSha = resolved.value;

	// Parents: reuse the cached commit detail, otherwise one `rev-list` call.
	let parents;
	const cached = cachedCommit(dir, fullSha);
	if (cached !== undefined) {
		parents = cached.parents;
	} else {
		const parentsResult = await runGit(dir, ['rev-list', '--parents', '-n', '1', fullSha]);
		if (isEnvironmentFailure(parentsResult)) return fail(parentsResult.error.code, parentsResult.error.message);
		if (parentsResult.error !== undefined) {
			if (NOT_A_REPOSITORY.test(parentsResult.stderr)) return typedFailure(parentsResult, dir);
			return fail('unknown-commit', `unknown commit: ${sha}`);
		}
		const parts = parentsResult.stdout.trim().split(/\s+/);
		parents = parts.slice(1);
	}

	// Validate the addressed path against the commit's real file list.
	let files;
	if (cached !== undefined) {
		files = cached.files;
	} else {
		const filesResult = await readCommitFiles(dir, fullSha, parents);
		if (!filesResult.ok) return filesResult;
		files = filesResult.value;
	}
	const target = files.find((file) => file.path === path);
	if (target === undefined) {
		return fail('invalid-path', `path is not part of commit ${fullSha.slice(0, 7)}: ${path}`);
	}
	if (oldPath !== undefined && oldPath !== null && oldPath !== '' && target.oldPath !== null && oldPath !== target.oldPath) {
		return fail('invalid-path', `oldPath does not match commit ${fullSha.slice(0, 7)}: ${oldPath}`);
	}

	// Known-binary file: no text diff to fetch.
	if (target.binary && cached !== undefined) {
		return ok({
			path,
			oldPath: target.oldPath ?? null,
			binary: true,
			truncated: false,
			hunks: [],
		});
	}

	const serverOldPath = target.oldPath ?? null;
	const patchArgs = parents.length === 0
		? ['show', '--root', '--format=', '--no-color', '--unified=3', fullSha, '--', path]
		: [
			'diff', '--no-color', '--unified=3', '-M', '-C', parents[0], fullSha,
			'--', ...(serverOldPath === null || serverOldPath === path ? [path] : [serverOldPath, path]),
		];

	const streamed = await streamGit(dir, patchArgs);
	if (streamed.error !== undefined) {
		return fail(streamed.error.code, streamed.error.message);
	}

	const parsed = parseUnifiedDiff(streamed.stdout, {
		maxLines: LIMITS.diffMaxLines,
		maxChars: LIMITS.diffMaxChars,
	});
	return ok({
		path,
		oldPath: serverOldPath,
		binary: parsed.binary,
		truncated: parsed.truncated || streamed.truncated,
		hunks: parsed.hunks,
	});
}

/* ------------------------------------------------------------------------- *
 * op=repos
 * ------------------------------------------------------------------------- */

/**
 * Directory names that `op=repos` never descends into (SPEC §3.6).
 *
 * Matched case-insensitively because Windows file systems are: skipping is a
 * safety/performance rule, and a `Node_Modules` decoy must be ignored as well.
 * Any dot-prefixed directory (including `.git`) is skipped by the prefix check,
 * so the explicit `.git` entry is documentation rather than load-bearing.
 */
const REPOS_SKIP_DIRS = Object.freeze(new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'out',
	'target',
	'coverage',
	'.next',
	'.nuxt',
	'.turbo',
	'.venv',
	'venv',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.gradle',
	'bower_components',
]));

/** Whether one scanned directory name must never be descended into. */
function isSkippedScanDir(name) {
	return name.startsWith('.') || REPOS_SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Whether a directory is a repository root: it contains a `.git` entry.
 *
 * `.git` may be a directory (normal repository) or a file (linked worktree,
 * submodule). `statSync` follows a symlinked `.git`, which is harmless here.
 * @param {string} dirPath
 */
function isRepoRoot(dirPath) {
	try {
		statSync(join(dirPath, '.git'));
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate and normalize the `op=repos` options (SPEC §3.6).
 *
 * The HTTP layer validates the query parameters as well; this is the defensive
 * core-level counterpart (same pattern as {@link normalizeLogOptions}), so
 * direct callers of {@link discoverRepos} get the same error codes.
 *
 * @param {{depth?: unknown, max?: unknown}} [options]
 * @returns {{ok: true, value: {depth: number, max: number}} | {ok: false, error: object}}
 */
export function normalizeRepoScanOptions(options = {}) {
	const depth = options.depth === undefined || options.depth === null
		? LIMITS.reposDepthDefault
		: Number(options.depth);
	const max = options.max === undefined || options.max === null
		? LIMITS.reposMaxDefault
		: Number(options.max);
	if (!Number.isInteger(depth) || depth < LIMITS.reposDepthMin || depth > LIMITS.reposDepthMax) {
		return fail('invalid-depth', `depth must be an integer between ${LIMITS.reposDepthMin} and ${LIMITS.reposDepthMax}`);
	}
	if (!Number.isInteger(max) || max < LIMITS.reposMaxMin || max > LIMITS.reposMaxMax) {
		return fail('invalid-max', `max must be an integer between ${LIMITS.reposMaxMin} and ${LIMITS.reposMaxMax}`);
	}
	return ok({ depth, max });
}

/**
 * Read the HEAD of one discovered repository, never failing the whole scan.
 *
 * SPEC §3.6 names the one-call form
 * `git -C <path> rev-parse --show-toplevel --abbrev-ref HEAD --short HEAD`, but
 * that command cannot return the sha: `--abbrev-ref` is a *mode* flag for all
 * revisions of the invocation, so the trailing `--short HEAD` prints the branch
 * name again (verified on git 2.5x). The intent — one small read per repository
 * giving branch/detached/unborn plus the commit sha — is therefore implemented
 * with the two equivalent read-only commands below (two queued child processes,
 * both from the SPEC §4 allow-list); `--show-toplevel` is unnecessary because the
 * repository root is by construction the directory that contains `.git`.
 *
 * Shape (SPEC §3.6): `{type: 'branch'|'detached'|'unborn', name, sha, shortSha}`
 * or `null` when the repository cannot be read (corrupt/missing object store).
 *
 * @param {string} repoPath
 * @returns {Promise<{type: string, name: string, sha: string|null, shortSha: string|null} | null>}
 */
async function readRepoHead(repoPath) {
	const [branchResult, headResult] = await Promise.all([
		// `-q` makes a detached HEAD a silent exit 1 instead of an error message.
		runGit(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']),
		runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']),
	]);
	if (isEnvironmentFailure(branchResult) || isEnvironmentFailure(headResult)) return null;
	const branch = optionalStdout(branchResult)?.trim() || null;
	const sha = optionalStdout(headResult)?.trim() || null;
	if (sha === null) {
		// No resolvable HEAD while HEAD still points at a branch name: an unborn
		// repository (`git init` with no commit). If even the symbolic ref cannot
		// be read the repository is broken, and the contract allows `null`.
		if (branch === null) return null;
		return { type: 'unborn', name: branch, sha: null, shortSha: null };
	}
	const shortSha = shortShaOf(sha);
	return {
		type: branch === null ? 'detached' : 'branch',
		name: branch ?? shortSha,
		sha,
		shortSha,
	};
}

/**
 * Recursively discover Git repositories below a working directory (SPEC §3.6).
 *
 * Traversal is a bounded breadth-first walk:
 * - a directory containing `.git` (directory *or* file: worktree/submodule) is a
 *   repository root and is not descended into (a repository is a discovery leaf,
 *   so submodules and vendored repositories inside it do not flood the list);
 * - `.git`, dot-prefixed hidden directories, build/dependency directories and
 *   symbolic links (junctions included, which prevents cycles) are skipped;
 * - `repos` only contains roots *strictly below* `cwd`; `cwd` itself is reported
 *   through `cwdRepo` (the `inspectRepo` projection);
 * - results are collected shallow-first (BFS) and returned sorted by `rel`.
 *
 * Bounds and the meaning of the `scanned.*LimitHit` flags:
 * - `maxDirs` (2000) visited directories: once the budget is exhausted (or the
 *   `deadlineMs` wall clock of 3000 ms is reached) the walk stops with
 *   `dirLimitHit: true` and returns the repositories found so far;
 * - `max` returned repositories: as soon as `max` repositories were collected the
 *   walk stops with `countLimitHit: true` (there may be more);
 * - `depth`: a directory lying exactly at the depth limit is not descended into;
 *   `depthLimitHit: true` means at least one such directory existed, i.e. deeper
 *   repositories may exist (the flag is conservative for empty directories).
 *
 * The timings are measured for the whole call (directory walk + HEAD reads).
 * `options.maxDirs` and `options.deadlineMs` are internal test hooks: the HTTP
 * layer never passes them, so production always uses the SPEC §3.6 budgets.
 *
 * @param {string} cwd - session working directory or explicitly picked directory.
 * @param {{depth?: number, max?: number, maxDirs?: number, deadlineMs?: number}} [options]
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
 */
export async function discoverRepos(cwd, options = {}) {
	const directory = resolveDirectory(cwd);
	if (!directory.ok) return directory;
	const normalized = normalizeRepoScanOptions(options);
	if (!normalized.ok) return normalized;
	const { depth, max } = normalized.value;
	const maxDirs = Number.isInteger(options.maxDirs) && options.maxDirs > 0
		? options.maxDirs
		: LIMITS.reposMaxDirs;
	const deadlineMs = typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs) && options.deadlineMs >= 0
		? options.deadlineMs
		: LIMITS.reposDeadlineMs;

	const dir = directory.value;
	const started = Date.now();
	const deadline = started + deadlineMs;

	// `cwdRepo` reuses the `op=repo` projection verbatim: a cwd that is not a
	// repository is a normal discovery input, not an error (SPEC §3.6).
	const inspected = await inspectRepo(dir);
	/** @type {{isRepo: boolean, root: string|null, head: object|null, empty: boolean}} */
	let cwdRepo;
	if (inspected.ok) {
		cwdRepo = {
			isRepo: true,
			root: inspected.value.root,
			head: inspected.value.head,
			empty: inspected.value.empty,
		};
	} else if (inspected.error?.code === 'not-a-repository') {
		cwdRepo = { isRepo: false, root: null, head: null, empty: false };
	} else {
		// git missing / timed out / cwd vanished: the same failure `op=repo` reports.
		return inspected;
	}

	/** @type {{path: string, rel: string, name: string, depth: number, head?: object|null}[]} */
	const found = [];
	/** @type {{path: string, rel: string, depth: number}[]} */
	const queue = [{ path: dir, rel: '', depth: 0 }];
	let directories = 0;
	let depthLimitHit = false;
	let countLimitHit = false;
	let dirLimitHit = false;
	let stopped = false;

	for (let queueIndex = 0; queueIndex < queue.length && !stopped; queueIndex += 1) {
		// Deadline and directory budget are checked before each directory, so a
		// scan that exactly consumes its budget without remaining work is not
		// reported as limited.
		if (Date.now() >= deadline) {
			dirLimitHit = true;
			break;
		}
		if (directories >= maxDirs) {
			dirLimitHit = true;
			break;
		}
		const current = queue[queueIndex];
		directories += 1;
		/** @type {import('node:fs').Dirent[]} */
		let entries;
		try {
			entries = readdirSync(current.path, { withFileTypes: true });
		} catch {
			// A directory that disappeared or is unreadable must not fail the scan.
			continue;
		}
		// Deterministic BFS order (and therefore deterministic max/limit cut-offs).
		entries.sort((left, right) => compareStrings(left.name, right.name));
		for (const entry of entries) {
			// Symlinks/junctions are never followed: that both skips linked trees
			// and makes directory cycles impossible.
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (isSkippedScanDir(entry.name)) continue;
			const childPath = join(current.path, entry.name);
			const childRel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`;
			const childDepth = current.depth + 1;
			if (isRepoRoot(childPath)) {
				found.push({ path: childPath, rel: childRel, name: entry.name, depth: childDepth });
				// Repositories are discovery leaves: do not descend into them.
				if (found.length >= max) {
					countLimitHit = true;
					stopped = true;
					break;
				}
				continue;
			}
			if (childDepth >= depth) {
				// Its children would lie beyond the depth limit, so it is not
				// descended into; deeper repositories may exist.
				depthLimitHit = true;
				continue;
			}
			queue.push({ path: childPath, rel: childRel, depth: childDepth });
		}
	}

	// One HEAD read per discovered repository; failures only null that head.
	for (const repo of found) {
		if (Date.now() >= deadline) {
			dirLimitHit = true;
			break;
		}
		repo.head = await readRepoHead(repo.path);
	}
	for (const repo of found) {
		if (repo.head === undefined) repo.head = null;
	}
	found.sort((left, right) => compareStrings(left.rel, right.rel));

	return ok({
		cwd: dir,
		cwdRepo,
		repos: found,
		scanned: {
			directories,
			durationMs: Date.now() - started,
			depthLimitHit,
			countLimitHit,
			dirLimitHit,
		},
		limits: { depth, max },
	});
}
