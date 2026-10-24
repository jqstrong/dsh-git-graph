/**
 * Logic + component checks for the `@local/dsh-git-graph` client bundle.
 *
 * Part 1 drives the pure functions exported through the bundle's test hook:
 * the deterministic lane-graph layout, formatting, filtering, windowing, the
 * session memory, the LRU caches and the Host envelope mapping.
 *
 * Part 2 drives the real Client bundle end-to-end in a Node VM: the Host fetch
 * route is asserted (relative URL, credentials, query parameters), and the real
 * `GitGraphView` component is mounted with a React stub against a scripted Host
 * — first paint, selection, file-diff expansion, search, keyboard navigation,
 * the not-a-repository state, the repository picker fallback and the empty and
 * error states.
 *
 * This is a behaviour check, NOT visual verification: no CSS is applied. The
 * live page (screenshots in `docs/`) covers appearance.
 *
 * Run: node test-client/run.mjs
 */
import assert from 'node:assert/strict';
import { loadClient, mountView, createHostStub, byClass, find, findAll, textOf } from './harness.mjs';

const results = [];

/**
 * Values produced inside the VM belong to another realm, so strict deepEqual
 * (which compares prototypes) rejects them. Compare their JSON shape instead.
 */
const strictDeepEqual = assert.deepEqual;
function deepEqual(actual, expected, message) {
	strictDeepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}
function check(name, fn) {
	try {
		fn();
		results.push(`PASS  ${name}`);
	} catch (error) {
		results.push(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 8).join('\n      ')}`);
		process.exitCode = 1;
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		results.push(`PASS  ${name}`);
	} catch (error) {
		results.push(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 8).join('\n      ')}`);
		process.exitCode = 1;
	}
}

/* ==================================================================== */
/* Fixtures                                                             */
/* ==================================================================== */

const NOW_MS = Date.parse('2026-08-26T16:00:00+08:00');
const NOW_S = Math.floor(NOW_MS / 1000);

/** A commit record with sane defaults. */
function commit(sha, parents, options = {}) {
	return {
		sha,
		parents,
		author: options.author ?? { name: 'alex', email: 'alex@example.com', time: options.time ?? NOW_S - 3600 },
		committer: { name: 'alex', email: 'alex@example.com', time: options.time ?? NOW_S - 3600 },
		subject: options.subject ?? `commit ${sha.slice(0, 4)}`,
		body: options.body ?? '',
		refs: options.refs ?? [],
	};
}

/** Five-commit history with one merge and one branch, used by the UI tests. */
const HEAD_SHA = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const MERGE_SHA = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const FEATURE_SHA = 'cccc3333cccc3333cccc3333cccc3333cccc3333';
const SECOND_SHA = 'dddd4444dddd4444dddd4444dddd4444dddd4444';
const BASE_SHA = 'eeee5555eeee5555eeee5555eeee5555eeee5555';

const LOG_COMMITS = [
	commit(HEAD_SHA, [MERGE_SHA], {
		subject: 'feat: 示例统计按类型汇总在线离线',
		time: NOW_S - 120,
		refs: [{ name: 'master', kind: 'branch', head: true }, { name: 'origin/master', kind: 'remote' }],
	}),
	commit(MERGE_SHA, [SECOND_SHA, FEATURE_SHA], {
		subject: "Merge branch 'feature/demo-1.0' into master",
		time: NOW_S - 7200,
	}),
	commit(SECOND_SHA, [BASE_SHA], {
		subject: 'fix: 修复离线设备统计漏算的问题',
		author: { name: '12345', email: '12345@example.com', time: NOW_S - 9000 },
		time: NOW_S - 9000,
	}),
	commit(FEATURE_SHA, [BASE_SHA], {
		subject: 'feat: demo v1.0 终端列表接口',
		author: { name: '张三', email: 'zhangsan@example.com', time: NOW_S - 86400 * 3 },
		time: NOW_S - 86400 * 3,
		refs: [{ name: 'demo-v1.0', kind: 'branch' }],
	}),
	commit(BASE_SHA, [], {
		subject: 'chore: 初始化项目结构',
		author: { name: '张三', email: 'zhangsan@example.com', time: NOW_S - 86400 * 30 },
		time: NOW_S - 86400 * 30,
		refs: [{ name: 'v1.0', kind: 'tag' }],
	}),
];

const REPO_VALUE = {
	cwd: 'E:\\work\\terminal',
	root: 'E:\\work\\terminal',
	isRepo: true,
	empty: false,
	head: { type: 'branch', name: 'master', sha: HEAD_SHA, shortSha: HEAD_SHA.slice(0, 7) },
	upstream: 'origin/master',
	ahead: 1,
	behind: 2,
	dirtyFiles: 3,
	gitVersion: '2.45.2',
	branchCount: 2,
	tagCount: 1,
	remoteCount: 1,
};

const REFS_VALUE = {
	head: { type: 'branch', name: 'master', sha: HEAD_SHA },
	branches: [
		{ name: 'master', fullName: 'refs/heads/master', isHead: true, sha: HEAD_SHA, shortSha: HEAD_SHA.slice(0, 7), ahead: 1, behind: 0, subject: LOG_COMMITS[0].subject },
		{ name: 'demo-v1.0', fullName: 'refs/heads/demo-v1.0', isHead: false, sha: FEATURE_SHA, shortSha: FEATURE_SHA.slice(0, 7), ahead: 0, behind: 0, subject: LOG_COMMITS[3].subject },
	],
	remotes: [{ name: 'origin/master', remote: 'origin', branch: 'master', sha: HEAD_SHA, isHead: false, subject: LOG_COMMITS[0].subject }],
	tags: [{ name: 'v1.0', sha: BASE_SHA, shortSha: BASE_SHA.slice(0, 7), subject: LOG_COMMITS[4].subject, annotated: false }],
	remotesList: [{ name: 'origin', url: 'git@example.com:team/terminal.git' }],
};

const COMMIT_DETAILS = {
	[HEAD_SHA]: {
		...LOG_COMMITS[0],
		body: '按操作系统维度汇总在线/离线终端数量，并补齐导出接口。',
		refs: [
			{ name: 'master', kind: 'branch', head: true },
			{ name: 'origin/master', kind: 'remote' },
			{ name: 'v1.0', kind: 'tag' },
		],
		stats: { files: 2, additions: 58, deletions: 6 },
		files: [
			{ status: 'M', path: 'src/main/java/com/example/terminal/TerminalStatService.java', oldPath: null, additions: 48, deletions: 6, binary: false },
			{ status: 'R', path: 'src/main/java/com/example/terminal/OsStatDTO.java', oldPath: 'src/main/java/com/example/terminal/StatDTO.java', additions: 10, deletions: 0, binary: false, similarity: 96 },
		],
	},
	[MERGE_SHA]: { ...LOG_COMMITS[1], body: '', stats: { files: 0, additions: 0, deletions: 0 }, files: [] },
	[SECOND_SHA]: { ...LOG_COMMITS[2], body: '', stats: { files: 1, additions: 2, deletions: 2 }, files: [{ status: 'M', path: 'web/src/stat.js', oldPath: null, additions: 2, deletions: 2, binary: false }] },
	[FEATURE_SHA]: { ...LOG_COMMITS[3], body: '', stats: { files: 1, additions: 5, deletions: 0 }, files: [{ status: 'A', path: 'web/src/demo.js', oldPath: null, additions: 5, deletions: 0, binary: false }] },
	[BASE_SHA]: { ...LOG_COMMITS[4], body: '', stats: { files: 0, additions: 0, deletions: 0 }, files: [] },
};

const DIFF_VALUE = {
	path: 'src/main/java/com/example/terminal/TerminalStatService.java',
	oldPath: null,
	binary: false,
	truncated: false,
	hunks: [
		{
			header: '@@ -18,7 +18,9 @@ public class TerminalStatService {',
			oldStart: 18,
			oldLines: 7,
			newStart: 18,
			newLines: 9,
			lines: [
				{ kind: 'context', oldLine: 18, newLine: 18, text: '    public Map<String, Long> statsByOs() {' },
				{ kind: 'context', oldLine: 19, newLine: 19, text: '        Map<String, Long> result = new LinkedHashMap<>();' },
				{ kind: 'del', oldLine: 20, newLine: null, text: '        result.put("windows", countByOs("windows"));' },
				{ kind: 'del', oldLine: 21, newLine: null, text: '        result.put("linux", countByOs("linux"));' },
				{ kind: 'add', oldLine: null, newLine: 20, text: '        for (String os : SUPPORTED_OS) {' },
				{ kind: 'add', oldLine: null, newLine: 21, text: '            result.put(os, countByOs(os));' },
				{ kind: 'add', oldLine: null, newLine: 22, text: '        }' },
				{ kind: 'add', oldLine: null, newLine: 23, text: '        result.put("unknown", countUnknown());' },
				{ kind: 'context', oldLine: 22, newLine: 24, text: '        return result;' },
				{ kind: 'context', oldLine: 23, newLine: 25, text: '    }' },
			],
		},
	],
};

/** Host routes for the happy path. */
function happyHandlers() {
	return {
		repo: REPO_VALUE,
		refs: REFS_VALUE,
		log: { headSha: HEAD_SHA, commits: LOG_COMMITS, hasMore: false },
		commit: (params) => COMMIT_DETAILS[params.sha],
		diff: DIFF_VALUE,
	};
}

/* ==================================================================== */
/* Part 1 — pure logic                                                  */
/* ==================================================================== */

const env = loadClient({ nowMs: NOW_MS });
const internals = env.internals;
assert.ok(internals !== undefined, 'the bundle exposed its test surface');
const { assignLanes, formatTime, filterCommits, statusMeta, buildRefsTree, parseEnvelope, repoStatusOf } = internals;

check('bundle: registers one factory with the package id', () => {
	assert.equal(env.registration.id, '@local/dsh-git-graph');
	assert.equal(typeof env.registration.factory, 'function');
});

check('bundle: the pure surface is complete', () => {
	const expected = [
		'assignLanes', 'graphSegmentPath', 'graphWidth', 'formatTime', 'formatDateTime', 'filterCommits',
		'statusMeta', 'buildRefsTree', 'pickDefaultSha', 'computeWindow', 'mergeCommitPages', 'parseEnvelope',
		'toDisplayError', 'repoStatusOf', 'createGitApi', 'createLru', 'rememberSessionState', 'recallSessionState',
	];
	for (const name of expected) assert.equal(typeof internals[name], 'function', `missing ${name}`);
	assert.ok(Array.isArray(internals.LANE_COLORS) && internals.LANE_COLORS.length === 8, 'eight lane colours');
});

check('lanes: linear history stays on one lane', () => {
	const history = [
		commit('c3', ['c2']),
		commit('c2', ['c1']),
		commit('c1', []),
	];
	const layout = assignLanes(history);
	assert.equal(layout.laneCount, 1);
	deepEqual(layout.rows.map((row) => row.nodeLane), [0, 0, 0]);
	deepEqual(layout.rows.map((row) => row.fresh), [true, false, false]);
	deepEqual(layout.rows[0].segments.map((segment) => segment.kind), ['out']);
	deepEqual(layout.rows[1].segments.map((segment) => segment.kind), ['in', 'out']);
	deepEqual(layout.rows[2].segments.map((segment) => segment.kind), ['in']);
});

check('lanes: a branch and its merge draw out, in and join-out', () => {
	const history = [
		commit('m', ['a', 'b']),
		commit('a', ['base']),
		commit('b', ['base']),
		commit('base', []),
	];
	const layout = assignLanes(history);
	assert.equal(layout.laneCount, 2);
	deepEqual(layout.rows.map((row) => row.nodeLane), [0, 0, 1, 0]);
	deepEqual(layout.rows[0].segments.map((segment) => segment.kind), ['out', 'branch-out']);
	deepEqual(layout.rows[0].segments[1], { kind: 'branch-out', fromLane: 0, toLane: 1, color: 1 });
	deepEqual(layout.rows[1].segments.map((segment) => segment.kind), ['in', 'through', 'out']);
	deepEqual(layout.rows[2].segments.map((segment) => segment.kind), ['in', 'through', 'join-out']);
	assert.equal(layout.rows[2].segments[2].toLane, 0, 'the feature lane rejoins the base lane');
	deepEqual(layout.rows[3].segments.map((segment) => segment.kind), ['in']);
});

check('lanes: an octopus merge forks one lane per parent', () => {
	const history = [
		commit('m', ['p1', 'p2', 'p3']),
		commit('p1', []),
		commit('p2', []),
		commit('p3', []),
	];
	const layout = assignLanes(history);
	assert.equal(layout.laneCount, 3);
	deepEqual(layout.rows[0].segments.map((segment) => segment.kind), ['out', 'branch-out', 'branch-out']);
	deepEqual(layout.rows[0].segments.map((segment) => segment.toLane), [0, 1, 2]);
});

check('lanes: criss-cross history is deterministic and still width-bounded', () => {
	const history = [
		commit('x', ['a', 'b']),
		commit('y', ['b', 'a']),
		commit('a', []),
		commit('b', []),
	];
	const layout = assignLanes(history);
	assert.equal(layout.laneCount, 3);
	assert.equal(layout.rows[1].nodeLane, 2, 'an unexpected commit opens a new lane');
	deepEqual(layout.rows[1].segments.map((segment) => segment.kind), ['through', 'through', 'join-out', 'branch-out']);
	const again = assignLanes(history);
	deepEqual(again, JSON.parse(JSON.stringify(layout)), 'same input, same layout');
});

check('lanes: a truncated history may dangle a parent lane', () => {
	const layout = assignLanes([commit('c2', ['c1']), commit('c1', ['missing'])]);
	assert.equal(layout.laneCount, 1);
	deepEqual(layout.rows[1].segments.map((segment) => segment.kind), ['in', 'out']);
	deepEqual(layout, JSON.parse(JSON.stringify(assignLanes([commit('c2', ['c1']), commit('c1', ['missing'])]))));
});

check('lanes: duplicate parents are deduplicated', () => {
	const layout = assignLanes([commit('m', ['a', 'a']), commit('a', [])]);
	deepEqual(layout.rows[0].segments.map((segment) => segment.kind), ['out']);
	assert.equal(layout.laneCount, 1);
});

check('lanes: several roots close their lanes and the graph narrows', () => {
	const layout = assignLanes([commit('r1', []), commit('r2', []), commit('r3', [])]);
	assert.equal(layout.laneCount, 1, 'each root frees its lane before the next row');
	deepEqual(layout.rows.map((row) => row.fresh), [true, true, true]);
});

check('lanes: an empty history yields an empty layout', () => {
	deepEqual(assignLanes([]), { rows: [], laneCount: 0 });
	deepEqual(assignLanes(null), { rows: [], laneCount: 0 });
});

check('lanes: the gutter width follows the lane count and is capped', () => {
	assert.equal(internals.graphWidth(1), 20);
	assert.equal(internals.graphWidth(2), 34);
	assert.equal(internals.graphWidth(50), 20 + (internals.MAX_GRAPH_LANES - 1) * 14);
});

check('lanes: every segment kind yields its own path shape', () => {
	const paths = [
		['through', 0],
		['in', 0],
		['out', 0],
		['merge-in', 1],
		['branch-out', 2],
		['join-out', 3],
	].map(([kind, toLane]) => internals.graphSegmentPath({ kind, fromLane: 0, toLane }, 26));
	assert.equal(new Set(paths).size, 6);
	assert.match(paths[0], /^M10 0V26$/u);
	assert.match(paths[3], /C/u);
});

check('time: relative below a week, absolute beyond it', () => {
	const tr = (key, params) => (params === undefined ? key : `${key}:${params.count}`);
	assert.equal(formatTime(NOW_S - 20, NOW_S, tr), 'time.justNow');
	assert.equal(formatTime(NOW_S - 5 * 60, NOW_S, tr), 'time.minutesAgo:5');
	assert.equal(formatTime(NOW_S - 3 * 3600, NOW_S, tr), 'time.hoursAgo:3');
	const yesterday = new Date(NOW_S * 1000 - 26 * 3600 * 1000);
	assert.equal(
		formatTime(Math.floor(yesterday.getTime() / 1000), NOW_S, tr),
		`time.yesterday ${String(yesterday.getHours()).padStart(2, '0')}:${String(yesterday.getMinutes()).padStart(2, '0')}`,
	);
	assert.equal(formatTime(NOW_S - 3 * 86400, NOW_S, tr), 'time.daysAgo:3');
	const tenDaysAgo = new Date(NOW_S * 1000 - 10 * 86400 * 1000);
	const expectedTen = `${String(tenDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(tenDaysAgo.getDate()).padStart(2, '0')} ${String(tenDaysAgo.getHours()).padStart(2, '0')}:${String(tenDaysAgo.getMinutes()).padStart(2, '0')}`;
	assert.equal(formatTime(Math.floor(tenDaysAgo.getTime() / 1000), NOW_S, tr), expectedTen);
	const old = new Date(NOW_S * 1000 - 400 * 86400 * 1000);
	assert.match(formatTime(Math.floor(old.getTime() / 1000), NOW_S, tr), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
	assert.equal(formatTime(undefined, NOW_S, tr), '');
});

check('time: absolute detail dates are YYYY/MM/DD HH:mm', () => {
	assert.match(internals.formatDateTime(NOW_S), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/u);
	assert.equal(internals.formatDateTime(0), '');
});

check('filter: subject, author and sha, case-insensitive, token-wise', () => {
	assert.equal(filterCommits(LOG_COMMITS, '').length, 5);
	assert.equal(filterCommits(LOG_COMMITS, '统计').length, 2);
	assert.equal(filterCommits(LOG_COMMITS, '张三').length, 2);
	assert.equal(filterCommits(LOG_COMMITS, 'AAAA1111').length, 1);
	assert.equal(filterCommits(LOG_COMMITS, 'fix 12345').length, 1);
	assert.equal(filterCommits(LOG_COMMITS, 'no-such-thing').length, 0);
	assert.equal(filterCommits(LOG_COMMITS, '').length, LOG_COMMITS.length);
	assert.notEqual(filterCommits(LOG_COMMITS, ''), LOG_COMMITS, 'the empty result is a copy');
});

check('status: letters map to tones and translation keys', () => {
	deepEqual(statusMeta('M'), { letter: 'M', tone: 'M', key: 'status.M' });
	deepEqual(statusMeta('R96'), { letter: 'R', tone: 'R', key: 'status.R' });
	deepEqual(statusMeta('A'), { letter: 'A', tone: 'A', key: 'status.A' });
	deepEqual(statusMeta('Z'), { letter: 'Z', tone: 'Q', key: 'status.Q' });
	deepEqual(statusMeta(undefined), { letter: 'M', tone: 'M', key: 'status.M' });
});

check('refs tree: three groups with refs/... filter values', () => {
	const tree = buildRefsTree(REFS_VALUE);
	assert.equal(tree.groups.length, 3);
	deepEqual(tree.groups.map((group) => group.key), ['branches', 'remotes', 'tags']);
	assert.equal(tree.groups[0].items[0].ref, 'refs/heads/master');
	assert.equal(tree.groups[0].items[0].isHead, true);
	assert.equal(tree.groups[0].items[1].name, 'demo-v1.0');
	assert.equal(tree.groups[1].items[0].ref, 'refs/remotes/origin/master');
	assert.equal(tree.groups[2].items[0].ref, 'refs/tags/v1.0');
	deepEqual(buildRefsTree({}), { head: null, groups: [] });
});

check('refs tree: empty groups are skipped', () => {
	const tree = buildRefsTree({ head: null, branches: [], remotes: [], tags: [] });
	assert.equal(tree.groups.length, 0);
});

check('selection: remembered sha wins, then HEAD, then newest', () => {
	const commits = LOG_COMMITS;
	assert.equal(internals.pickDefaultSha(commits, HEAD_SHA, SECOND_SHA), SECOND_SHA);
	assert.equal(internals.pickDefaultSha(commits, HEAD_SHA, 'gone'), HEAD_SHA);
	assert.equal(internals.pickDefaultSha(commits, 'gone', 'gone'), HEAD_SHA);
	assert.equal(internals.pickDefaultSha([], HEAD_SHA, null), null);
	assert.equal(internals.indexOfSha(commits, MERGE_SHA), 1);
	assert.equal(internals.indexOfSha(commits, 'nope'), -1);
	assert.equal(internals.nextSelectedIndex(-1, 1, 5), 0);
	assert.equal(internals.nextSelectedIndex(4, 1, 5), 4);
	assert.equal(internals.nextSelectedIndex(-1, -1, 5), 4);
});

check('window: short lists render whole, long lists window with padding', () => {
	deepEqual(internals.computeWindow(0, 260, 26, 100, 10), { start: 0, end: 100, topPad: 0, bottomPad: 0, virtual: false });
	const first = internals.computeWindow(0, 260, 26, 1000, 10);
	assert.equal(first.virtual, true);
	assert.equal(first.start, 0);
	assert.equal(first.end, 30);
	assert.equal(first.topPad, 0);
	assert.equal(first.bottomPad, (1000 - 30) * 26);
	const scrolled = internals.computeWindow(2600, 260, 26, 1000, 10);
	assert.equal(scrolled.start, 90);
	assert.equal(scrolled.end, 120);
	assert.equal(scrolled.topPad, 90 * 26);
	assert.equal(internals.computeWindow(0, 260, 26, 0, 10).end, 0);
});

check('paging: pages merge without duplicates', () => {
	const merged = internals.mergeCommitPages(LOG_COMMITS.slice(0, 3), [LOG_COMMITS[2], LOG_COMMITS[4]]);
	assert.equal(merged.length, 4);
	deepEqual(merged.map((entry) => entry.sha), [HEAD_SHA, MERGE_SHA, SECOND_SHA, BASE_SHA]);
});

check('paging: near-bottom scroll requests another page', () => {
	assert.equal(internals.shouldRequestMore(0, 400, 800), false);
	assert.equal(internals.shouldRequestMore(380, 400, 800), true);
	assert.equal(internals.shouldRequestMore(0, 400, 400), false);
});

check('envelope: ok, error and malformed bodies are distinguished', () => {
	deepEqual(parseEnvelope({ ok: true, value: { a: 1 } }), { ok: true, value: { a: 1 } });
	deepEqual(parseEnvelope({ ok: false, error: { code: 'not-a-repository', message: 'nope', cwd: 'E:\\x' } }), {
		ok: false,
		error: { code: 'not-a-repository', message: 'nope', cwd: 'E:\\x' },
	});
	assert.equal(parseEnvelope(null).error.code, 'bad-response');
	assert.equal(parseEnvelope('str').error.code, 'bad-response');
	assert.equal(parseEnvelope({ ok: false }).error.code, 'unknown');
});

check('envelope: failures normalize to display codes', () => {
	deepEqual(internals.toDisplayError({ code: 'git-failed', message: 'boom' }), { code: 'git-failed', message: 'boom' });
	assert.equal(internals.toDisplayError(null).code, 'unknown');
	const abort = new Error('stop');
	abort.name = 'AbortError';
	assert.equal(internals.toDisplayError(abort).code, 'aborted');
	const wrapped = internals.GitGraphError('not-a-repository', 'nope', { cwd: 'E:\\x' });
	assert.equal(wrapped.name, 'GitGraphError');
	assert.equal(wrapped.code, 'not-a-repository');
	assert.equal(wrapped.cwd, 'E:\\x');
});

check('repo: values classify into ready/empty/not-repo/error', () => {
	assert.equal(repoStatusOf({ isRepo: true, empty: false }), 'ready');
	assert.equal(repoStatusOf({ isRepo: true, empty: true }), 'empty');
	assert.equal(repoStatusOf({ isRepo: false }), 'not-repo');
	assert.equal(repoStatusOf(null), 'error');
});

check('memory: the per-session map is bounded', () => {
	const memory = internals.sessionMemory;
	memory.clear();
	for (let index = 0; index < 20; index += 1) internals.rememberSessionState(`s${index}`, { sha: `sha${index}` });
	assert.equal(memory.size, 12);
	assert.equal(internals.recallSessionState('s0').sha, undefined, 'the oldest session was evicted');
	assert.equal(internals.recallSessionState('s19').sha, 'sha19');
	deepEqual(internals.recallSessionState('missing'), {});
	memory.clear();
});

check('cache: LRU evicts the oldest key', () => {
	const lru = internals.createLru(2);
	lru.set('a', 1);
	lru.set('b', 2);
	lru.set('c', 3);
	assert.equal(lru.has('a'), false);
	assert.equal(lru.get('b'), 2);
	assert.equal(lru.size, 2);
});

check('paths: directory split, head truncation and initials', () => {
	const splitPath = internals.splitFilePath('src/main/A.java');
	assert.equal(splitPath.dir, 'src/main/');
	assert.equal(splitPath.base, 'A.java');
	const flatPath = internals.splitFilePath('A.java');
	assert.equal(flatPath.dir, '');
	assert.equal(flatPath.base, 'A.java');
	assert.equal(internals.shortPath('E:\\work\\very\\long\\repo', 12), '…y\\long\\repo');
	assert.equal(internals.shortPath('short', 12), 'short');
	assert.equal(internals.initialsOf('alex'), 'AL');
	assert.equal(internals.initialsOf('张三'), '张', 'CJK names read as one glyph');
	assert.equal(internals.initialsOf('Ada Lovelace'), 'AL');
	assert.equal(internals.initialsOf('12345'), '', 'numeric names defer to the person glyph');
	assert.equal(internals.initialsOf(''), '?');
	assert.equal(internals.isNumericName('12345'), true);
	assert.equal(internals.isNumericName('a12345'), false);
	assert.equal(internals.isNumericName(''), false);
	assert.equal(internals.hasCjkName('张三'), true);
	assert.equal(internals.hasCjkName('alex'), false);
});

check('pills: only whole pills render, the remainder becomes a counter', () => {
	const refs = [
		{ name: 'master', kind: 'branch', head: true },
		{ name: 'origin/master', kind: 'remote' },
		{ name: 'release/1.2', kind: 'branch' },
		{ name: 'v1.0', kind: 'tag' },
		{ name: 'v1.1', kind: 'tag' },
		{ name: 'develop', kind: 'branch' },
	];
	const roomy = internals.planPills(refs, 520);
	assert.equal(roomy.extra, 0);
	deepEqual(roomy.shown.map((ref) => ref.name), refs.map((ref) => ref.name));
	const tight = internals.planPills(refs, 100);
	assert.equal(tight.shown.length, 1, 'only the first whole pill fits the counter reserve');
	assert.equal(tight.extra, 5);
	deepEqual(tight.hidden.map((ref) => ref.name), refs.slice(1).map((ref) => ref.name));
	const none = internals.planPills(refs, 0);
	assert.equal(none.shown.length, 0);
	assert.equal(none.extra, 6);
	assert.equal(internals.planPills([], 400).extra, 0);
	assert.ok(internals.estimatePillWidth('origin/master') > internals.estimatePillWidth('v1.0'));
});

check('columns: the template carries the graph gutter and the four columns', () => {
	assert.equal(internals.columnTemplate(34, false), '34px minmax(0,1fr) 88px 92px 64px');
	assert.equal(internals.columnTemplate(34, true), '34px minmax(0,1fr) 72px 78px 56px');
});

check('stats and refs helpers tolerate missing data', () => {
	const emptyStats = internals.formatStats(undefined);
	assert.equal(emptyStats.additions, 0);
	assert.equal(emptyStats.deletions, 0);
	const numericStats = internals.formatStats({ additions: '12', deletions: 3 });
	assert.equal(numericStats.additions, 12);
	assert.equal(numericStats.deletions, 3);
	assert.equal(internals.countRefsOfKind(LOG_COMMITS[0], 'branch'), 1);
	assert.equal(internals.countRefsOfKind(LOG_COMMITS[0], 'tag'), 0);
	assert.equal(internals.countRefsOfKind({}, 'branch'), 0);
	assert.equal(internals.diffPathKey('sha', 'a.java'), 'sha\u0000a.java');
});

/* ==================================================================== */
/* Part 2 — Host access                                                 */
/* ==================================================================== */

await checkAsync('api: the request is same-origin with credentials and parameters', async () => {
	const host = createHostStub(happyHandlers());
	env.sandbox.fetch = host.fetch;
	const api = internals.createGitApi('session-42');
	const value = await api.request('log', { cwd: 'E:\\work\\terminal', limit: 300, ref: 'refs/heads/master' });
	assert.equal(value.commits.length, LOG_COMMITS.length);
	const call = host.callsOf('log')[0];
	assert.equal(call.url.origin, 'http://127.0.0.1:6503', 'resolved against document.baseURI');
	assert.equal(call.url.pathname, '/api/plugin/git-graph');
	assert.equal(call.url.searchParams.get('op'), 'log');
	assert.equal(call.url.searchParams.get('sessionId'), 'session-42');
	assert.equal(call.url.searchParams.get('cwd'), 'E:\\work\\terminal');
	assert.equal(call.url.searchParams.get('limit'), '300');
	assert.equal(call.url.searchParams.get('ref'), 'refs/heads/master');
	assert.equal(call.init.credentials, 'include');
	assert.equal(call.init.headers.accept, 'application/json');
});

await checkAsync('api: undefined parameters are omitted', async () => {
	const host = createHostStub(happyHandlers());
	env.sandbox.fetch = host.fetch;
	const api = internals.createGitApi('session-42');
	await api.request('repo', { cwd: undefined });
	const call = host.callsOf('repo')[0];
	assert.equal(call.url.searchParams.has('cwd'), false);
	assert.equal(call.url.searchParams.get('op'), 'repo');
});

await checkAsync('api: an error envelope becomes a GitGraphError', async () => {
	const host = createHostStub();
	host.setHandler('repo', { envelope: { ok: false, error: { code: 'not-a-repository', message: 'nope', cwd: 'E:\\plain' } } });
	env.sandbox.fetch = host.fetch;
	const api = internals.createGitApi('session-42');
	await assert.rejects(
		() => api.request('repo', {}),
		(error) => error.code === 'not-a-repository' && error.cwd === 'E:\\plain' && error.name === 'GitGraphError',
	);
});

await checkAsync('api: an unreadable body is a bad-response', async () => {
	env.sandbox.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
	const api = internals.createGitApi('session-42');
	await assert.rejects(() => api.request('repo', {}), (error) => error.code === 'bad-response');
	env.sandbox.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } });
	await assert.rejects(() => internals.createGitApi('session-42').request('repo', {}), (error) => error.code === 'http-502');
});

await checkAsync('api: a transport failure is a network-error, an abort is rethrown', async () => {
	env.sandbox.fetch = async () => { throw new TypeError('offline'); };
	await assert.rejects(() => internals.createGitApi('session-42').request('repo', {}), (error) => error.code === 'network-error');
	env.sandbox.fetch = async () => {
		const error = new Error('stop');
		error.name = 'AbortError';
		throw error;
	};
	await assert.rejects(() => internals.createGitApi('session-42').request('repo', {}), (error) => error.name === 'AbortError');
});

/* ==================================================================== */
/* Part 3 — the mounted view                                            */
/* ==================================================================== */

/**
 * Mount the view with empty module-level caches and session memory, so each
 * scenario sees exactly the requests it causes. The restore test deliberately
 * mounts twice inside one scenario instead.
 */
async function mountFresh(options = {}) {
	internals.commitCache.clear();
	internals.diffCache.clear();
	internals.sessionMemory.clear();
	return mountView(env, options);
}

await checkAsync('view: registers the conversation.view tab with a localized label', async () => {
	const host = createHostStub(happyHandlers());
	const { captured, plugin } = await mountFresh({ host });
	assert.equal(plugin.inject.length, 2);
	deepEqual([...plugin.inject], ['slots', 'locale']);
	assert.equal(captured.slotKey, 'conversation.view');
	assert.equal(captured.options.name, 'conversation.view');
	assert.equal(captured.options.id, 'git-graph');
	assert.equal(captured.options.order, 200);
	assert.equal(captured.options.locale, 'git-graph');
	assert.equal(typeof captured.options.label, 'function');
	assert.equal(captured.options.label(), 'Git');
	assert.ok(captured.dicts.zh !== undefined && captured.dicts.en !== undefined, 'both dictionaries registered');
	assert.ok(env.styleTags.length >= 1, 'a stylesheet was injected');
	const css = env.styleTags[env.styleTags.length - 1].textContent;
	assert.match(css, /\.dshGitGraph_root\{/u);
	assert.match(css, /var\(--dsw-alias-bg-base\)/u);
	assert.match(css, /ui-monospace/u);
	assert.doesNotMatch(css, /background:#fff\b/u, 'no literal page background');
	assert.doesNotMatch(css, /font-family:Arial/u, 'no literal page font');
});

await checkAsync('view: first paint shows the toolbar, graph rows and commit detail', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	const tree = view.tree;
	const text = textOf(tree);
	assert.match(text, /E:\\work\\terminal/u, 'the repository path is in the toolbar');
	assert.match(text, /master/u, 'the HEAD branch chip is rendered');
	assert.match(text, /aaaa111/u, 'the short HEAD sha is rendered');
	assert.match(text, /示例统计按类型汇总在线离线/u, 'commit rows and detail show the subject');
	assert.match(text, /本地分支/u);
	assert.match(text, /远程分支/u);
	assert.match(text, /标签/u);
	const rows = byClass(tree, 'dshGitGraph_row');
	assert.equal(rows.length, LOG_COMMITS.length, 'one row per commit');
	assert.equal(rows[0].props['aria-selected'], true, 'the HEAD commit starts selected');
	assert.equal(rows.filter((row) => row.props['aria-selected'] === true).length, 1);
	const lanes = byClass(tree, 'dshGitGraph_graphSvg');
	assert.equal(lanes.length, LOG_COMMITS.length, 'every row carries its graph gutter');
	assert.equal(find(tree, (node) => node.props?.role === 'tabpanel') !== null, true);
	assert.equal(find(tree, (node) => node.props?.role === 'listbox') !== null, true);
	assert.match(text, /个文件/u, 'the file-stat line is rendered');
	assert.match(text, /TerminalStatService\.java/u, 'the changed-file list is rendered');
	const commitCalls = host.callsOf('commit');
	assert.equal(commitCalls.length, 1, 'exactly one detail request for the initial selection');
	assert.equal(commitCalls[0].params.sha, HEAD_SHA);
});

await checkAsync('view: clicking a commit selects it and loads its detail', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	let rows = byClass(view.tree, 'dshGitGraph_row');
	rows[2].props.onClick();
	const tree = await view.reactStub.render(view.captured.component, view.props);
	rows = byClass(tree, 'dshGitGraph_row');
	assert.equal(rows[2].props['aria-selected'], true);
	const text = textOf(tree);
	assert.match(text, /修复离线设备统计漏算的问题/u);
	assert.ok(host.callsOf('commit').some((call) => call.params.sha === SECOND_SHA), 'detail was requested for the clicked sha');
});

await checkAsync('view: the details avatar uses a person glyph for numeric authors and one CJK glyph', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	/* Row 2 is authored by 12345, row 3 by 张三. */
	byClass(view.tree, 'dshGitGraph_row')[2].props.onClick();
	let tree = await view.reactStub.render(view.captured.component, view.props);
	let avatar = find(tree, (node) => node.props?.className === 'dshGitGraph_avatar');
	assert.ok(avatar !== null, 'the details author chip exists');
	assert.equal(textOf(avatar), '', 'a numeric author has no letter initials');
	assert.equal(avatar.children[0]?.type, 'svg', 'a person glyph replaces the initials');
	byClass(tree, 'dshGitGraph_row')[3].props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	avatar = find(tree, (node) => node.props?.className === 'dshGitGraph_avatar');
	assert.equal(textOf(avatar), '张', 'a CJK author renders one glyph');
});

await checkAsync('view: many refs collapse into a +N counter instead of squeezed pills', async () => {
	const manyRefs = [
		{ name: 'master', kind: 'branch', head: true },
		{ name: 'origin/master', kind: 'remote' },
		{ name: 'release/1.2', kind: 'branch' },
		{ name: 'v1.0', kind: 'tag' },
		{ name: 'v1.1', kind: 'tag' },
		{ name: 'develop', kind: 'branch' },
	];
	const commits = [{ ...LOG_COMMITS[0], refs: manyRefs }, ...LOG_COMMITS.slice(1)];
	const host = createHostStub({
		...happyHandlers(),
		log: { headSha: HEAD_SHA, commits, hasMore: false },
	});
	const view = await mountFresh({ host });
	const pills = findAll(byClass(view.tree, 'dshGitGraph_row')[0], (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dshGitGraph_pill '));
	assert.equal(pills.length, 2, 'one whole pill plus the counter');
	assert.match(textOf(pills[1]), /^\+5$/u);
	assert.equal(pills[1].props.title, 'origin/master、release/1.2、v1.0、v1.1、develop', 'the counter tooltip lists the hidden refs');
});

await checkAsync('view: expanding a file fetches and renders its unified diff', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	const fileRows = byClass(view.tree, 'dshGitGraph_fileRow');
	assert.equal(fileRows.length, 2);
	fileRows[0].props.onClick();
	let tree = await view.reactStub.render(view.captured.component, view.props);
	const diffCalls = host.callsOf('diff');
	assert.equal(diffCalls.length, 1);
	assert.equal(diffCalls[0].params.path, 'src/main/java/com/example/terminal/TerminalStatService.java');
	assert.equal(diffCalls[0].params.sha, HEAD_SHA);
	const added = findAll(tree, (node) => node.props?.className === 'dshGitGraph_diffRow dshGitGraph_diffRowAdd');
	assert.equal(added.length, 4, 'four added lines are rendered');
	const deleted = findAll(tree, (node) => node.props?.className === 'dshGitGraph_diffRow dshGitGraph_diffRowDel');
	assert.equal(deleted.length, 2, 'two deleted lines are rendered');
	assert.match(textOf(tree), /countUnknown/u, 'the diff text is rendered');
	assert.match(textOf(tree), /@@ -18,7 \+18,9 @@/u, 'the hunk header is rendered');
	// Collapsing removes the diff request result from the tree but keeps the cache.
	byClass(tree, 'dshGitGraph_fileRow')[0].props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(byClass(tree, 'dshGitGraph_diffRow').length, 0, 'the diff collapses again');
});

await checkAsync('view: search filters locally and Esc clears it', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	const input = find(view.tree, (node) => node.props?.className === 'dshGitGraph_searchInput');
	assert.ok(input !== null, 'the search box exists');
	input.props.onChange({ target: { value: '张三' } });
	let tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(byClass(tree, 'dshGitGraph_row').length, 2, 'two commits by that author');
	assert.match(textOf(tree), /2 \/ 5 个提交/u);
	const filteredInput = find(tree, (node) => node.props?.className === 'dshGitGraph_searchInput');
	filteredInput.props.onChange({ target: { value: 'zzz-no-match' } });
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(byClass(tree, 'dshGitGraph_row').length, 0);
	assert.match(textOf(tree), /没有匹配的提交/u);
	// Escape on the panel clears the query.
	find(tree, (node) => node.props?.role === 'tabpanel').props.onKeyDown({ key: 'Escape' });
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(byClass(tree, 'dshGitGraph_row').length, LOG_COMMITS.length, 'the filter is cleared');
});

await checkAsync('view: keyboard navigation moves the selection', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	let tree = view.tree;
	const listbox = find(tree, (node) => node.props?.role === 'listbox');
	let prevented = false;
	listbox.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => { prevented = true; } });
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(prevented, true);
	let rows = byClass(tree, 'dshGitGraph_row');
	assert.equal(rows[1].props['aria-selected'], true, 'ArrowDown moves one row down');
	find(tree, (node) => node.props?.role === 'listbox').props.onKeyDown({ key: 'End', preventDefault: () => {} });
	tree = await view.reactStub.render(view.captured.component, view.props);
	rows = byClass(tree, 'dshGitGraph_row');
	assert.equal(rows[rows.length - 1].props['aria-selected'], true, 'End moves to the oldest commit');
});

await checkAsync('view: a ref click refilters the log and resets the selection', async () => {
	const host = createHostStub(happyHandlers());
	host.setHandler('log', (params) => ({
		headSha: HEAD_SHA,
		commits: params.ref === 'refs/tags/v1.0' ? [LOG_COMMITS[4]] : LOG_COMMITS,
		hasMore: false,
	}));
	const view = await mountFresh({ host });
	const tagRow = byClass(view.tree, 'dshGitGraph_refRow').find((row) => textOf(row) === 'v1.0');
	assert.ok(tagRow !== undefined, 'the tag row exists');
	tagRow.props.onClick();
	const tree = await view.reactStub.render(view.captured.component, view.props);
	const logCalls = host.callsOf('log');
	assert.equal(logCalls[logCalls.length - 1].params.ref, 'refs/tags/v1.0');
	assert.equal(byClass(tree, 'dshGitGraph_row').length, 1, 'the filtered log shows one commit');
	assert.match(textOf(tree), /筛选：v1\.0/u, 'the active filter is shown in the toolbar');
	assert.equal(byClass(tree, 'dshGitGraph_row')[0].props['aria-selected'], true);
});

await checkAsync('view: the not-a-repository state offers a retry and a repository picker', async () => {
	const host = createHostStub();
	host.setHandler('repo', {
		envelope: { ok: false, error: { code: 'not-a-repository', message: 'not a git repository', cwd: 'E:\\learn\\temp' } },
	});
	const view = await mountFresh({ host, services: { uiWorkspace: { pickDirectory: async () => null } } });
	const text = textOf(view.tree);
	assert.match(text, /当前会话工作目录不是 Git 仓库/u);
	assert.match(text, /E:\\learn\\temp/u, 'the offending path is shown');
	const buttons = findAll(view.tree, (node) => node.props?.className === 'dshGitGraph_button');
	assert.ok(buttons.some((button) => textOf(button).includes('选择仓库目录')), 'the picker button exists');
	assert.ok(buttons.some((button) => textOf(button).includes('重试')), 'the retry button exists');
});

await checkAsync('view: picking a repository retries with the cwd parameter', async () => {
	const host = createHostStub(happyHandlers());
	let first = true;
	host.setHandler('repo', (params) => {
		if (first && params.cwd === undefined) {
			first = false;
			return { envelope: { ok: false, error: { code: 'not-a-repository', message: 'not a git repository', cwd: 'E:\\learn\\temp' } } };
		}
		if (params.cwd !== 'E:\\work\\terminal') {
			return { envelope: { ok: false, error: { code: 'not-a-repository', message: 'not a git repository', cwd: params.cwd ?? '' } } };
		}
		return REPO_VALUE;
	});
	const picked = 'E:\\work\\terminal';
	const view = await mountFresh({ host, services: { uiWorkspace: { pickDirectory: async () => picked } } });
	assert.match(textOf(view.tree), /当前会话工作目录不是 Git 仓库/u);
	const choose = findAll(view.tree, (node) => node.props?.className === 'dshGitGraph_button')
		.find((button) => textOf(button).includes('选择仓库目录'));
	choose.props.onClick();
	const tree = await view.reactStub.render(view.captured.component, view.props);
	const repoCalls = host.callsOf('repo');
	assert.ok(repoCalls.some((call) => call.params.cwd === picked), 'the picked directory is sent as cwd');
	assert.equal(byClass(tree, 'dshGitGraph_row').length, LOG_COMMITS.length, 'commits load after the pick');
	assert.equal(internals.recallSessionState('session-preview-0001').pickedCwd, picked, 'the pick is remembered per session');
	const logCalls = host.callsOf('log');
	assert.equal(logCalls[logCalls.length - 1].params.cwd, picked, 'log requests follow the picked cwd');
});

await checkAsync('view: an empty repository shows its own state', async () => {
	const host = createHostStub();
	host.setHandler('repo', { ...REPO_VALUE, empty: true, head: { type: 'unborn', name: 'master', sha: undefined, shortSha: undefined } });
	const view = await mountFresh({ host });
	assert.match(textOf(view.tree), /仓库还没有提交/u);
	assert.match(textOf(view.tree), /提交一次后/u);
});

await checkAsync('view: a failed repo read shows the error state and the error code', async () => {
	const host = createHostStub();
	host.setHandler('repo', { envelope: { ok: false, error: { code: 'git-failed', message: 'fatal: bad object' } } });
	const view = await mountFresh({ host });
	const text = textOf(view.tree);
	assert.match(text, /无法读取 Git 数据/u);
	assert.match(text, /git-failed/u);
});

await checkAsync('view: a session-only memory restores the selection on remount', async () => {
	const host = createHostStub(happyHandlers());
	const first = await mountFresh({ host });
	byClass(first.tree, 'dshGitGraph_row')[3].props.onClick();
	await first.reactStub.render(first.captured.component, first.props);
	assert.equal(internals.recallSessionState('session-preview-0001').sha, FEATURE_SHA);
	const second = await mountFresh({ host });
	const rows = byClass(second.tree, 'dshGitGraph_row');
	const selected = rows.find((row) => row.props['aria-selected'] === true);
	assert.ok(selected !== undefined, 'a row is selected');
	assert.match(textOf(second.tree), /demo v1\.0 终端列表接口/u);
});

await checkAsync('view: the stylesheet effect disposes its tag', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host });
	const tag = env.styleTags[env.styleTags.length - 1];
	const entry = view.captured.cleanups.filter((cleanup) => cleanup.label === 'git-graph: stylesheet').pop();
	assert.ok(entry !== undefined, 'a stylesheet disposer exists');
	entry.cleanup();
	assert.equal(tag.removed, true);
});

await checkAsync('view: an occupant-supplied t prop wins over the bound translator', async () => {
	const host = createHostStub(happyHandlers());
	const messages = [];
	const t = (key, params) => {
		messages.push(key);
		return `en:${key}${params === undefined ? '' : `:${JSON.stringify(params)}`}`;
	};
	const view = await mountFresh({ host, props: { t } });
	assert.ok(messages.length > 0, 'the provided translator was called');
	assert.match(textOf(view.tree), /en:refs\.title/u);
});

await checkAsync('view: a missing session and no cwd degrade to a pickable state', async () => {
	const host = createHostStub(happyHandlers());
	const view = await mountFresh({ host, props: { sessionId: '' } });
	assert.match(textOf(view.tree), /无法定位会话工作目录/u);
	assert.equal(host.callsOf('repo').length, 0, 'no request without a session id or cwd');
});

/* ==================================================================== */
/* Part 4 — multi-repository discovery (SPEC §2 / §3.6)                 */
/* ==================================================================== */

const REPOS_CWD = 'E:\\learn\\temp';
const ALPHA_PATH = 'E:\\learn\\temp\\alpha';
const BETA_PATH = 'E:\\learn\\temp\\beta';
const GAMMA_PATH = 'E:\\learn\\temp\\gamma';
const ALPHA_HEAD = { type: 'branch', name: 'main', sha: 'abc1234abc1234abc1234abc1234abc1234abc1', shortSha: 'abc1234' };
const BETA_HEAD = { type: 'detached', sha: 'def5678def5678def5678def5678def5678def5', shortSha: 'def5678' };
const GAMMA_HEAD = { type: 'unborn' };

/** An `op=repos` value: a plain session directory with three repositories below. */
const REPOS_DISCOVERED = {
	cwd: REPOS_CWD,
	cwdRepo: { isRepo: false, root: null, head: null, empty: false },
	repos: [
		{ path: ALPHA_PATH, rel: 'alpha', name: 'alpha', depth: 1, head: ALPHA_HEAD },
		{ path: BETA_PATH, rel: 'beta', name: 'beta', depth: 1, head: BETA_HEAD },
		{ path: GAMMA_PATH, rel: 'gamma', name: 'gamma', depth: 2, head: GAMMA_HEAD },
	],
	scanned: { directories: 12, durationMs: 9, depthLimitHit: false, countLimitHit: false, dirLimitHit: false },
	limits: { depth: 4, max: 50 },
};

/** Host routes for a multi-repository session directory (none of it is a repo). */
function multiRepoHandlers(overrides = {}) {
	return {
		repos: REPOS_DISCOVERED,
		repo: (params) => {
			if (params.cwd === ALPHA_PATH || params.cwd === BETA_PATH || params.cwd === GAMMA_PATH) {
				return { ...REPO_VALUE, cwd: params.cwd, root: params.cwd };
			}
			return { envelope: { ok: false, error: { code: 'not-a-repository', message: 'not a git repository', cwd: REPOS_CWD } } };
		},
		refs: REFS_VALUE,
		log: { headSha: HEAD_SHA, commits: LOG_COMMITS, hasMore: false },
		commit: (params) => COMMIT_DETAILS[params.sha],
		diff: DIFF_VALUE,
		...overrides,
	};
}

/** Repository rows currently rendered under a class name. */
function repoRows(tree, className = 'dshGitGraph_repoItem') {
	return findAll(tree, (node) => node.props?.className === className);
}

/** The toolbar repository trigger button. */
function repoTrigger(tree) {
	return find(tree, (node) => node.props?.className === 'dshGitGraph_repo dshGitGraph_repoTrigger');
}

/** The open repository dropdown, if any. */
function repoMenuOf(tree) {
	return find(tree, (node) => node.props?.role === 'menu');
}

check('repos: the discovery value normalizes with defaults', () => {
	const normalized = internals.normalizeReposValue(REPOS_DISCOVERED);
	deepEqual(normalized.repos.map((repo) => repo.name), ['alpha', 'beta', 'gamma']);
	deepEqual(normalized.repos.map((repo) => repo.rel), ['alpha', 'beta', 'gamma']);
	deepEqual(normalized.repos.map((repo) => repo.depth), [1, 1, 2]);
	assert.equal(normalized.cwd, REPOS_CWD);
	assert.equal(normalized.cwdRepo.isRepo, false);
	assert.equal(normalized.limits.max, 50);
	const partial = internals.normalizeReposValue({ repos: [{ path: 'E:\\x\\repo' }] });
	assert.equal(partial.repos[0].name, 'repo', 'a missing name falls back to the path segment');
	assert.equal(partial.cwd, '');
	assert.equal(partial.cwdRepo.isRepo, false);
	deepEqual(internals.normalizeReposValue(null).repos, []);
	deepEqual(internals.normalizeReposValue('nonsense').repos, []);
	const repoSession = internals.normalizeReposValue({
		cwd: 'E:\\repo',
		cwdRepo: { isRepo: true, root: 'E:\\repo', head: ALPHA_HEAD, empty: false },
	});
	assert.equal(repoSession.cwdRepo.isRepo, true);
	assert.equal(repoSession.cwdRepo.head.name, 'main');
});

check('repos: the menu model marks the active repository', () => {
	const model = internals.buildRepoMenu({ status: 'ready', value: REPOS_DISCOVERED, error: null }, ALPHA_PATH);
	assert.equal(model.status, 'ready');
	assert.equal(model.count, 3);
	assert.equal(model.sessionActive, false);
	assert.equal(model.cwd, REPOS_CWD);
	deepEqual(model.repos.map((repo) => repo.active), [true, false, false]);
	const session = internals.buildRepoMenu({ status: 'ready', value: REPOS_DISCOVERED }, null);
	assert.equal(session.sessionActive, true);
	deepEqual(session.repos.map((repo) => repo.active), [false, false, false]);
	const loading = internals.buildRepoMenu({ status: 'loading' }, null);
	assert.equal(loading.count, 0);
	deepEqual(loading.repos, []);
	assert.equal(internals.samePath('E:\\work\\alpha', 'e:/work/alpha/'), true);
	assert.equal(internals.samePath('E:\\work\\alpha', 'E:\\work\\beta'), false);
	assert.equal(internals.samePath('', ''), false);
	assert.equal(internals.lastPathSegment('E:\\a\\b\\'), 'b');
});

check('repos: HEAD labels handle branch, detached and unborn', () => {
	const tr = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
	assert.equal(internals.describeRepoHead(ALPHA_HEAD, tr), 'main');
	assert.match(internals.describeRepoHead(BETA_HEAD, tr), /repoMenu\.detached/u);
	assert.match(internals.describeRepoHead({ type: 'detached', sha: 'abcdef1234567890' }, tr), /abcdef1/u);
	assert.match(internals.describeRepoHead({ type: 'unborn', name: 'master' }, tr), /repoMenu\.unbornBranch/u);
	assert.match(internals.describeRepoHead({ type: 'branch', name: 'dev' }, tr), /dev/u);
	assert.equal(internals.describeRepoHead(null, tr), '');
	assert.equal(internals.describeRepoHead({ type: 'unborn' }, tr), 'repoMenu.unborn');
});

check('repos: a lone repository auto-selects only from a non-repo session directory', () => {
	const base = { status: 'ready', pickedCwd: null, cwdRepo: { isRepo: false }, repos: [{ path: ALPHA_PATH }] };
	assert.equal(internals.shouldAutoSelectSingleRepo(base), ALPHA_PATH);
	assert.equal(internals.shouldAutoSelectSingleRepo({ ...base, status: 'loading' }), null);
	assert.equal(internals.shouldAutoSelectSingleRepo({ ...base, pickedCwd: BETA_PATH }), null);
	assert.equal(internals.shouldAutoSelectSingleRepo({ ...base, cwdRepo: { isRepo: true } }), null);
	assert.equal(internals.shouldAutoSelectSingleRepo({ ...base, repos: [{ path: ALPHA_PATH }, { path: BETA_PATH }] }), null);
	assert.equal(internals.shouldAutoSelectSingleRepo({ ...base, repos: [] }), null);
	assert.equal(internals.shouldAutoSelectSingleRepo({ ...base, repos: [{ path: '' }] }), null);
	assert.equal(internals.shouldAutoSelectSingleRepo(null), null);
});

await checkAsync('repos: the not-a-repository state lists every discovered repository', async () => {
	const host = createHostStub(multiRepoHandlers());
	const view = await mountFresh({ host });
	const text = textOf(view.tree);
	assert.match(text, /当前会话工作目录不是 Git 仓库/u);
	assert.match(text, /工作目录下的仓库/u);
	assert.match(text, /选择一个仓库查看/u);
	const items = repoRows(view.tree);
	assert.equal(items.length, 3, 'one clickable row per discovered repository');
	assert.match(textOf(items[0]), /alpha/u);
	assert.match(textOf(items[0]), /main/u, 'the branch HEAD of the first repository is shown');
	assert.match(textOf(items[1]), /def5678/u, 'the detached HEAD of the second repository is shown');
	assert.match(textOf(items[2]), /尚无提交/u, 'the unborn repository is labelled');
	const reposCall = host.callsOf('repos')[0];
	assert.equal(reposCall.params.sessionId, 'session-preview-0001');
	assert.equal(reposCall.params.cwd, undefined, 'discovery never sends a cwd');
	assert.equal(host.callsOf('repo').filter((call) => call.params.cwd === undefined).length, 1, 'the session directory itself is probed once');
});

await checkAsync('repos: clicking a listed repository reloads every column with its cwd', async () => {
	const host = createHostStub(multiRepoHandlers());
	const view = await mountFresh({ host });
	repoRows(view.tree)[0].props.onClick();
	const tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(byClass(tree, 'dshGitGraph_row').length, LOG_COMMITS.length, 'commits load for the selected repository');
	assert.ok(host.callsOf('repo').some((call) => call.params.cwd === ALPHA_PATH), 'repo is asked for the repository');
	assert.ok(host.callsOf('refs').length > 0 && host.callsOf('refs').every((call) => call.params.cwd === ALPHA_PATH), 'refs follow the cwd');
	assert.ok(host.callsOf('log').length > 0 && host.callsOf('log').every((call) => call.params.cwd === ALPHA_PATH), 'log follows the cwd');
	assert.ok(host.callsOf('commit').length > 0 && host.callsOf('commit').every((call) => call.params.cwd === ALPHA_PATH), 'commit detail follows the cwd');
	byClass(tree, 'dshGitGraph_fileRow')[0].props.onClick();
	await view.reactStub.render(view.captured.component, view.props);
	assert.ok(host.callsOf('diff').length > 0 && host.callsOf('diff').every((call) => call.params.cwd === ALPHA_PATH), 'diffs follow the cwd');
	assert.equal(internals.recallSessionState('session-preview-0001').pickedCwd, ALPHA_PATH, 'the switch is remembered per session');
	assert.match(textOf(tree), /E:\\learn\\temp\\alpha/u, 'the toolbar shows the active repository');
});

await checkAsync('repos: the toolbar dropdown switches repositories and back to the session directory', async () => {
	const host = createHostStub(multiRepoHandlers());
	const view = await mountFresh({ host });
	let trigger = repoTrigger(view.tree);
	assert.ok(trigger !== null, 'the repository trigger exists');
	assert.equal(trigger.props['aria-haspopup'], 'menu');
	assert.equal(trigger.props['aria-expanded'], false);
	trigger.props.onClick();
	let tree = await view.reactStub.render(view.captured.component, view.props);
	let menu = repoMenuOf(tree);
	assert.ok(menu !== null, 'the dropdown opens');
	assert.equal(repoTrigger(tree).props['aria-expanded'], true);
	const menuText = textOf(menu);
	assert.match(menuText, /会话工作目录/u);
	assert.match(menuText, /工作目录下的仓库（3）/u);
	assert.match(menuText, /alpha/u);
	assert.match(menuText, /beta/u);
	assert.match(menuText, /gamma/u);
	assert.match(menuText, /选择其他目录/u);
	assert.match(menuText, /刷新/u);
	assert.equal(menu.props.role, 'menu');
	const entries = repoRows(menu);
	assert.equal(entries.length, 4, 'the session directory plus the three repositories');
	assert.equal(entries[0].props.role, 'menuitem');
	/* Select the second repository (beta). */
	entries[2].props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(repoMenuOf(tree), null, 'selecting a repository closes the dropdown');
	assert.ok(host.callsOf('repo').some((call) => call.params.cwd === BETA_PATH), 'beta becomes the active cwd');
	assert.equal(internals.recallSessionState('session-preview-0001').pickedCwd, BETA_PATH);
	assert.equal(repoRows(tree).length, 0, 'the not-a-repo list is gone once a repository is active');
	/* Reopen: the menu model marks beta as the current repository. */
	repoTrigger(tree).props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	menu = repoMenuOf(tree);
	assert.ok(menu !== null);
	assert.equal(repoRows(menu)[2].props['data-active'], 'true', 'the active repository is checked');
	assert.equal(repoRows(menu)[0].props['data-active'], 'false', 'the session directory is not current');
	/* Go back to the session working directory. */
	repoRows(menu)[0].props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(repoMenuOf(tree), null);
	assert.equal(host.callsOf('repo').pop().params.cwd, undefined, 'the session directory clears the cwd');
	assert.match(textOf(tree), /当前会话工作目录不是 Git 仓库/u, 'the non-repository state is back');
});

await checkAsync('repos: a lone repository is auto-selected once and survives a remount', async () => {
	const single = { ...REPOS_DISCOVERED, repos: [REPOS_DISCOVERED.repos[0]] };
	const host = createHostStub(multiRepoHandlers({ repos: single }));
	const view = await mountFresh({ host });
	assert.ok(host.callsOf('repo').some((call) => call.params.cwd === ALPHA_PATH), 'the only repository is opened automatically');
	assert.equal(byClass(view.tree, 'dshGitGraph_row').length, LOG_COMMITS.length);
	assert.ok(host.callsOf('log').length > 0 && host.callsOf('log').every((call) => call.params.cwd === ALPHA_PATH));
	assert.equal(internals.recallSessionState('session-preview-0001').pickedCwd, ALPHA_PATH);
	assert.equal(internals.recallSessionState('session-preview-0001').repoAutoDone, true, 'the one-shot flag is remembered');
	/* Remount the same session without clearing the module memory. */
	const before = host.callsOf('repo').length;
	const second = await mountView(env, { host });
	assert.equal(byClass(second.tree, 'dshGitGraph_row').length, LOG_COMMITS.length, 'the remembered repository renders again');
	assert.equal(host.callsOf('repo').length - before, 1, 'the remount opens the remembered cwd exactly once');
});

await checkAsync('repos: returning to the session directory suppresses auto-selection', async () => {
	const single = { ...REPOS_DISCOVERED, repos: [REPOS_DISCOVERED.repos[0]] };
	const host = createHostStub(multiRepoHandlers({ repos: single }));
	const view = await mountFresh({ host });
	assert.equal(internals.recallSessionState('session-preview-0001').pickedCwd, ALPHA_PATH);
	const back = find(view.tree, (node) => node.props?.title === '恢复会话工作目录');
	assert.ok(back !== null, 'the toolbar offers a way back to the session directory');
	const alphaCalls = host.callsOf('repo').filter((call) => call.params.cwd === ALPHA_PATH).length;
	back.props.onClick();
	let tree = await view.reactStub.render(view.captured.component, view.props);
	assert.match(textOf(tree), /当前会话工作目录不是 Git 仓库/u, 'the explicit choice wins over auto-selection');
	assert.equal(host.callsOf('repo').filter((call) => call.params.cwd === ALPHA_PATH).length, alphaCalls, 'auto-selection does not fire again');
	assert.equal(internals.recallSessionState('session-preview-0001').pickedCwd, null);
	/* A remount must honour the explicit choice too. */
	const second = await mountView(env, { host });
	assert.match(textOf(second.tree), /当前会话工作目录不是 Git 仓库/u, 'the remembered explicit choice is kept');
	assert.equal(host.callsOf('repo').filter((call) => call.params.cwd === ALPHA_PATH).length, alphaCalls, 'the remount does not auto-select');
});

await checkAsync('repos: a repository session directory is not replaced by a sub-repository', async () => {
	const subRepo = { path: 'E:\\work\\terminal\\web', rel: 'web', name: 'web', depth: 1, head: ALPHA_HEAD };
	const host = createHostStub(multiRepoHandlers({
		repo: REPO_VALUE,
		repos: {
			cwd: REPO_VALUE.cwd,
			cwdRepo: { isRepo: true, root: REPO_VALUE.root, head: REPO_VALUE.head, empty: false },
			repos: [subRepo],
			scanned: REPOS_DISCOVERED.scanned,
			limits: REPOS_DISCOVERED.limits,
		},
	}));
	const view = await mountFresh({ host });
	assert.equal(byClass(view.tree, 'dshGitGraph_row').length, LOG_COMMITS.length);
	assert.ok(host.callsOf('repo').length > 0 && host.callsOf('repo').every((call) => call.params.cwd === undefined), 'the sub-repository is never auto-selected');
	assert.match(textOf(view.tree), /E:\\work\\terminal/u);
	assert.equal(host.callsOf('repos')[0].params.cwd, undefined);
	repoTrigger(view.tree).props.onClick();
	const tree = await view.reactStub.render(view.captured.component, view.props);
	const menuText = textOf(repoMenuOf(tree));
	assert.match(menuText, /会话工作目录/u);
	assert.match(menuText, /master/u, 'the session directory shows its HEAD branch');
	assert.match(menuText, /web/u, 'the sub-repository is still listed');
});

await checkAsync('repos: a failed discovery scan is readable in both places and retryable', async () => {
	const host = createHostStub(multiRepoHandlers({
		repos: { envelope: { ok: false, error: { code: 'git-failed', message: 'scan failed' } } },
	}));
	const view = await mountFresh({ host });
	assert.match(textOf(view.tree), /当前会话工作目录不是 Git 仓库/u);
	assert.match(textOf(view.tree), /无法探测工作目录下的仓库/u, 'the not-a-repo panel reports the scan failure');
	repoTrigger(view.tree).props.onClick();
	let tree = await view.reactStub.render(view.captured.component, view.props);
	let menu = repoMenuOf(tree);
	assert.match(textOf(menu), /仓库探测失败/u, 'the dropdown reports the scan failure');
	host.setHandler('repos', REPOS_DISCOVERED);
	const retryButton = find(menu, (node) => node.props?.className === 'dshGitGraph_linkButton dshGitGraph_repoRetry');
	assert.ok(retryButton !== null, 'the dropdown offers a retry');
	retryButton.props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	menu = repoMenuOf(tree);
	assert.match(textOf(menu), /alpha/u, 'the retry lists the repositories');
	assert.ok(host.callsOf('repos').length >= 2);
});

await checkAsync('repos: no repositories found keeps the picker and shows the empty text', async () => {
	const host = createHostStub(multiRepoHandlers({ repos: { ...REPOS_DISCOVERED, repos: [] } }));
	const view = await mountFresh({ host });
	const text = textOf(view.tree);
	assert.match(text, /当前会话工作目录不是 Git 仓库/u);
	assert.match(text, /工作目录下未发现 Git 仓库/u);
	assert.equal(repoRows(view.tree).length, 0, 'there is nothing to switch to');
	const buttons = findAll(view.tree, (node) => node.props?.className === 'dshGitGraph_button');
	assert.ok(buttons.some((button) => textOf(button).includes('选择仓库目录')), 'the native picker stays available');
	assert.ok(buttons.some((button) => textOf(button).includes('重试')), 'the retry stays available');
});

await checkAsync('repos: Escape and an outside pointer press close the dropdown', async () => {
	const host = createHostStub(multiRepoHandlers());
	const view = await mountFresh({ host });
	repoTrigger(view.tree).props.onClick();
	let tree = await view.reactStub.render(view.captured.component, view.props);
	assert.ok(repoMenuOf(tree) !== null);
	assert.ok(env.documentStub.listeners.some(([type]) => type === 'pointerdown'), 'an outside-press listener is installed');
	find(tree, (node) => node.props?.role === 'tabpanel').props.onKeyDown({ key: 'Escape' });
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(repoMenuOf(tree), null, 'Escape closes the dropdown');
	assert.equal(env.documentStub.listeners.filter(([type]) => type === 'pointerdown').length, 0, 'the outside-press listener is removed');
	repoTrigger(tree).props.onClick();
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.ok(repoMenuOf(tree) !== null);
	const listener = env.documentStub.listeners.filter(([type]) => type === 'pointerdown').pop();
	listener[1]({ target: null });
	tree = await view.reactStub.render(view.captured.component, view.props);
	assert.equal(repoMenuOf(tree), null, 'the outside press closes the dropdown');
});

await checkAsync('repos: switching sessions never leaks the previous auto-selection', async () => {
	const single = { ...REPOS_DISCOVERED, repos: [REPOS_DISCOVERED.repos[0]] };
	const host = createHostStub({
		repos: (params) => (params.sessionId === 'session-a'
			? single
			: { ...REPOS_DISCOVERED, repos: REPOS_DISCOVERED.repos.slice(0, 2) }),
		repo: (params) => {
			if (params.cwd === ALPHA_PATH) return { ...REPO_VALUE, cwd: params.cwd, root: params.cwd };
			return { envelope: { ok: false, error: { code: 'not-a-repository', message: 'not a git repository', cwd: REPOS_CWD } } };
		},
		refs: REFS_VALUE,
		log: { headSha: HEAD_SHA, commits: LOG_COMMITS, hasMore: false },
		commit: (params) => COMMIT_DETAILS[params.sha],
		diff: DIFF_VALUE,
	});
	const view = await mountFresh({ host, props: { sessionId: 'session-a' } });
	assert.equal(internals.recallSessionState('session-a').pickedCwd, ALPHA_PATH, 'session A auto-selected the lone repository');
	/* Explicitly return to A's session directory before switching away. */
	find(view.tree, (node) => node.props?.title === '恢复会话工作目录').props.onClick();
	await view.reactStub.render(view.captured.component, view.props);
	/* Switch the view to another session, which has two repositories. */
	const tree = await view.reactStub.render(view.captured.component, { ...view.props, sessionId: 'session-b' });
	assert.equal(host.callsOf('repo').filter((call) => call.params.sessionId === 'session-b' && call.params.cwd === ALPHA_PATH).length, 0, 'the previous session auto-selection never leaks');
	assert.notEqual(internals.recallSessionState('session-b').pickedCwd, ALPHA_PATH, 'the new session does not inherit the auto-selection');
	const items = repoRows(tree);
	assert.equal(items.length, 2, 'the new session lists its own repositories');
	assert.match(textOf(tree), /当前会话工作目录不是 Git 仓库/u);
});

/* ==================================================================== */
/* Part 5 — composer-aware height + degraded layout (task-8)            */
/* ==================================================================== */

check('viewport: only composer-sized visible inputs count as the composer', () => {
	const rects = [
		{ top: 20, width: 900, height: 36 },    // above the root → ignored
		{ top: 500, width: 60, height: 36 },    // too narrow → ignored
		{ top: 520, width: 900, height: 12 },   // too flat → ignored
		{ top: 990, width: 900, height: 36 },   // below the viewport → ignored
		{ top: 700, width: 948, height: 36 },
		{ top: 846, width: 948, height: 36 },   // the composer (lowest match)
	];
	assert.equal(internals.composerTopFromRects(rects, 76, 966), 846);
	assert.equal(internals.composerTopFromRects(rects, 76, 800), 700, 'inputs below the viewport do not count');
	assert.equal(internals.composerTopFromRects(rects.slice(0, 2), 76, 966), null, 'a small input is not the composer');
	assert.equal(internals.composerTopFromRects([], 76, 966), null);
	assert.equal(internals.composerTopFromRects(null, 76, 966), null);
	assert.equal(internals.composerTopFromRects([{ top: 846, width: 948, height: 36 }], 800, 966), null, 'above root + 50 is not the composer');
});

check('viewport: the tool window height is clamped above the composer', () => {
	const noComposer = internals.clampAvailableHeight({ viewportHeight: 966, rootTop: 76, ancestorHeight: 890, composerTop: null });
	assert.equal(noComposer, 884, 'without a composer the viewport fallback is used');
	const withComposer = internals.clampAvailableHeight({ viewportHeight: 966, rootTop: 76, ancestorHeight: 890, composerTop: 846 });
	assert.equal(withComposer, 756, '846 − 8 − 76 − 6');
	assert.ok(withComposer < noComposer, 'the composer actively shrinks the tool window');
	const tallAncestor = internals.clampAvailableHeight({ viewportHeight: 966, rootTop: 76, ancestorHeight: 1200, composerTop: 846 });
	assert.equal(tallAncestor, 756, 'a taller ancestor never wins over the composer');
	const lowerComposer = internals.clampAvailableHeight({ viewportHeight: 966, rootTop: 76, ancestorHeight: 890, composerTop: 900 });
	assert.equal(lowerComposer, 810, 'a lower composer allows more height');
	const tinyViewport = internals.clampAvailableHeight({ viewportHeight: 400, rootTop: 360, ancestorHeight: 0, composerTop: 380 });
	assert.equal(tinyViewport, internals.MIN_VIEW_HEIGHT, 'the 300px floor survives the clamp');
	const composerAboveRoot = internals.clampAvailableHeight({ viewportHeight: 966, rootTop: 700, ancestorHeight: 890, composerTop: 300 });
	assert.equal(composerAboveRoot, internals.MIN_VIEW_HEIGHT, 'a composer above the root falls back to the floor');
	const ancestorOnly = internals.clampAvailableHeight({ viewportHeight: 0, rootTop: 0, ancestorHeight: 500, composerTop: null });
	assert.equal(ancestorOnly, 500, 'an ancestor height alone is usable');
	assert.equal(internals.clampAvailableHeight(null), 0);
	assert.equal(internals.clampAvailableHeight({}), 0);
	assert.ok(internals.COMPOSER_GAP >= 4 && internals.COMPOSER_INSET >= 4);
});

await checkAsync('view: the not-a-repository state uses the centered scrollable wrapper', async () => {
	const host = createHostStub(multiRepoHandlers());
	const view = await mountFresh({ host });
	const body = find(view.tree, (node) => node.props?.className === 'dshGitGraph_body');
	assert.ok(body !== null, 'the degraded body exists');
	assert.equal(body.props['data-degraded'], 'true', 'the body is flagged as degraded');
	const inner = find(view.tree, (node) => node.props?.className === 'dshGitGraph_degradedInner');
	assert.ok(inner !== null, 'the centered degraded wrapper exists');
	const panel = find(inner, (node) => node.props?.className === 'dshGitGraph_statePanel');
	assert.ok(panel !== null, 'the state panel is inside the wrapper');
	assert.equal(panel.props.style, undefined, 'the state panel is compact, not a flex grower');
	const repos = find(inner, (node) => node.props?.className === 'dshGitGraph_stateRepos');
	assert.ok(repos !== null, 'the repository list sits inside the same wrapper');
	assert.equal(repoRows(view.tree).length, 3, 'the list itself is unchanged');
});

await checkAsync('view: empty and error states share the degraded wrapper, ready does not', async () => {
	const emptyHost = createHostStub();
	emptyHost.setHandler('repo', { ...REPO_VALUE, empty: true, head: { type: 'unborn', name: 'master' } });
	const emptyView = await mountFresh({ host: emptyHost });
	const emptyBody = find(emptyView.tree, (node) => node.props?.className === 'dshGitGraph_body');
	assert.equal(emptyBody.props['data-degraded'], 'true');
	assert.ok(find(emptyView.tree, (node) => node.props?.className === 'dshGitGraph_degradedInner') !== null);
	assert.ok(find(emptyView.tree, (node) => node.props?.className === 'dshGitGraph_stateRepos') === null, 'an empty repository lists no repositories');

	const errorHost = createHostStub();
	errorHost.setHandler('repo', { envelope: { ok: false, error: { code: 'git-failed', message: 'boom' } } });
	const errorView = await mountFresh({ host: errorHost });
	const errorBody = find(errorView.tree, (node) => node.props?.className === 'dshGitGraph_body');
	assert.equal(errorBody.props['data-degraded'], 'true');
	assert.match(textOf(errorView.tree), /git-failed/u, 'the error code is still rendered');

	const readyView = await mountFresh({ host: createHostStub(happyHandlers()) });
	const readyBody = find(readyView.tree, (node) => node.props?.className === 'dshGitGraph_body');
	assert.equal(readyBody.props['data-degraded'], undefined, 'the three-column body is untouched');
	assert.ok(find(readyView.tree, (node) => node.props?.className === 'dshGitGraph_degradedInner') === null);
});

console.log(results.join('\n'));
console.log(process.exitCode === 1 ? '\nRESULT: failures present' : '\nRESULT: all checks passed');
