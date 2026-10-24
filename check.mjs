#!/usr/bin/env node
/**
 * `@local/dsh-git-graph` — one-command self-check.
 *
 * Runs the two dependency-free suites in this repository:
 *
 *   1. Host half — real `git` fixtures through `host/git-core.js` and the
 *      `/api/plugin/git-graph` request handler (`test-host/**\/*.test.mjs`).
 *   2. Client half — pure layout/data logic plus a React-stub mount smoke test
 *      of the conversation-view component (`test-client/run.mjs`).
 *
 * Nothing here touches the running DSH process, the user's profile, or the
 * user's repositories: the host fixtures are throwaway repositories created in
 * the OS temp folder and removed afterwards.
 *
 * Usage:
 *   node check.mjs            # both suites
 *   node check.mjs host       # host suite only
 *   node check.mjs client     # client suite only
 *   node check.mjs --verbose  # stream both suites' output in full
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const only = argv.find((arg) => arg === 'host' || arg === 'client');
const runHost = only === undefined || only === 'host';
const runClient = only === undefined || only === 'client';

/** Run one command and return its exit code plus captured output. */
function run(label, command, args, suiteRoot) {
	console.log(`\n── ${label} ─────────────────────────────────────────────────────────`);
	const started = Date.now();
	const result = spawnSync(command, args, {
		cwd: suiteRoot,
		encoding: 'utf8',
		env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
		shell: false,
		maxBuffer: 64 * 1024 * 1024,
	});
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	const tail = `${stdout}${stderr}`.trim().split(/\r?\n/);
	if (verbose || result.status !== 0) {
		for (const line of tail) console.log(line);
	} else {
		const summary = tail.filter((line) => /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)|^RESULT:|^PART |^FAIL |^ok |^not ok /u.test(line));
		for (const line of verbose ? tail : summary) console.log(line);
	}
	if (result.error !== undefined) console.log(`spawn error: ${String(result.error)}`);
	console.log(`── ${label}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${elapsed}s)`);
	return result.status === 0 && result.error === undefined;
}

const results = [];
if (runHost) {
	results.push({
		label: 'host checks',
		pass: run(
			'host · git core + HTTP handler',
			process.execPath,
			['--test', 'test-host/**/*.test.mjs'],
			ROOT,
		),
	});
}
if (runClient) {
	results.push({
		label: 'client checks',
		pass: run('client · layout, data, component mount', process.execPath, ['test-client/run.mjs'], ROOT),
	});
}

const failed = results.filter((entry) => !entry.pass);
console.log('\n══════════════════════════════════════════════════════════════════════');
console.log(`check: ${results.length - failed.length}/${results.length} suite(s) passed`);
if (failed.length > 0) {
	console.log(`check: FAILED — ${failed.map((entry) => entry.label).join(', ')}`);
	process.exitCode = 1;
} else {
	console.log('check: OK');
}
