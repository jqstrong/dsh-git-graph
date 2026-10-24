/**
 * Working-directory resolution for `@local/dsh-git-graph`.
 *
 * The plugin is deliberately activated with `inject = ['connection']` only, so
 * a missing optional service can never keep the whole Host half inactive. The
 * services needed here are all looked up lazily through `ctx.get(...)`:
 *
 * - `agents`            — live Agent lookup by session id (`agents.get(id)`).
 * - `workingDirectory`  — the session working-directory service
 *                         (`ensure(agent, signal)`, `defaultDirectory`).
 * - `sessionQuery`      — durable session reads (`observeSession(id)`).
 *
 * Resolution order (SPEC §2/§3 + Lead contract):
 *   1. an explicit `cwd` query parameter always wins — a directory chosen in the
 *      client's native directory picker; it must be an existing absolute
 *      directory (resolved to its real path);
 *   2. otherwise `sessionId` → live Agent → `workingDirectory.ensure(agent)`;
 *   3. fallback → `sessionQuery.observeSession(sessionId)` projections/header;
 *   4. fallback → `workingDirectory.defaultDirectory`;
 *   5. nothing usable → `{ code: 'session-not-found' }`.
 *
 * Every result is `{ ok: true, value } | { ok: false, error }`, matching the
 * git-core envelope so `index.js` can forward it unchanged.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/** Error codes that mean "the request itself is malformed" (HTTP 400). */
export const PARAM_ERROR_CODES = Object.freeze(new Set([
	'invalid-op',
	'invalid-url',
	'invalid-sha',
	'invalid-limit',
	'invalid-skip',
	'invalid-ref',
	'invalid-path',
	'invalid-depth',
	'invalid-max',
	'cwd-invalid',
	'method-not-allowed',
]));

/** Whether an error envelope describes a bad request parameter (HTTP 400). */
export function isParamErrorCode(code) {
	return typeof code === 'string' && PARAM_ERROR_CODES.has(code);
}

/** @returns {{ok: true, value: unknown}} */
function ok(value) {
	return { ok: true, value };
}

/** @returns {{ok: false, error: {code: string, message: string}}} */
function fail(code, message, extra) {
	const error = { code, message };
	if (extra !== undefined) Object.assign(error, extra);
	return { ok: false, error };
}

/** Lazily read one optional Host service. */
function serviceOf(ctx, name) {
	if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined;
	try {
		return ctx.get(name);
	} catch {
		return undefined;
	}
}

/**
 * Validate the explicit `cwd` query parameter.
 *
 * Only real directories are accepted; symlinks are resolved to their real path
 * so equal directories compare equal in the client's cache keys.
 *
 * @param {unknown} value - raw query value.
 * @returns {{ok: true, value: string} | {ok: false, error: object}}
 */
export function validateExplicitCwd(value) {
	if (typeof value !== 'string' || value.trim() === '') {
		return fail('cwd-invalid', 'cwd must be a non-empty absolute path');
	}
	if (value.includes('\u0000')) return fail('cwd-invalid', 'cwd must not contain NUL');
	if (!isAbsolute(value)) return fail('cwd-invalid', `cwd must be an absolute path: ${value}`);
	let real;
	try {
		// `realpathSync.native` normalises 8.3 names and junctions on Windows.
		real = realpathSync.native(resolvePath(value));
	} catch {
		return fail('cwd-invalid', `cwd is not an existing directory: ${value}`);
	}
	try {
		if (!statSync(real).isDirectory()) {
			return fail('cwd-invalid', `cwd is not a directory: ${value}`);
		}
	} catch {
		return fail('cwd-invalid', `cwd is not an accessible directory: ${value}`);
	}
	return ok(real);
}

/** Dispose a `sessionQuery.observeSession` observation (it is a sync disposable). */
function disposeObservation(observation) {
	if (observation === null || typeof observation !== 'object') return;
	try {
		if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]();
		else if (typeof observation.dispose === 'function') observation.dispose();
	} catch {
		// A failed release of a read-only observation is not worth failing the request.
	}
}

/** Validate a session-derived directory (it may have disappeared since the session ran). */
function acceptSessionCwd(cwd, sessionId) {
	if (typeof cwd !== 'string' || cwd.length === 0) {
		return fail('session-not-found', `session "${sessionId}" has no working directory`);
	}
	let real;
	try {
		real = realpathSync.native(resolvePath(cwd));
	} catch {
		return fail('cwd-invalid', `session "${sessionId}" working directory does not exist: ${cwd}`);
	}
	try {
		if (!statSync(real).isDirectory()) {
			return fail('cwd-invalid', `session "${sessionId}" working directory is not a directory: ${cwd}`);
		}
	} catch {
		return fail('cwd-invalid', `session "${sessionId}" working directory is not accessible: ${cwd}`);
	}
	return ok(real);
}

/**
 * Resolve the working directory addressed by one request.
 *
 * @param {object} ctx - Host plugin context.
 * @param {{cwd?: string|null, sessionId?: string|null, signal?: AbortSignal}} options
 * @returns {Promise<{ok: true, value: {cwd: string, source: 'cwd'|'session'}} | {ok: false, error: object}>}
 */
export async function resolveCwd(ctx, options = {}) {
	const explicit = typeof options.cwd === 'string' ? options.cwd : '';
	if (explicit !== '') {
		const validation = validateExplicitCwd(explicit);
		if (!validation.ok) return validation;
		return ok({ cwd: validation.value, source: 'cwd' });
	}

	const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
	if (sessionId === '') {
		return fail('cwd-invalid', 'either cwd or sessionId must be provided');
	}

	return resolveSessionCwd(ctx, sessionId, options.signal);
}

/**
 * Resolve `sessionId` → working directory through the optional Host services.
 *
 * This is a *viewer*: it must never mutate session state. Therefore the live
 * path uses `workingDirectory.get(session)` — a pure projection read — and NOT
 * `workingDirectory.ensure(agent)`, which can commit a `working-directory/change`
 * event and inject a model-visible user notice. Directory existence is checked
 * here with `realpath`/`stat` only.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {AbortSignal|undefined} signal
 */
async function resolveSessionCwd(ctx, sessionId, signal) {
	void signal;
	const agents = serviceOf(ctx, 'agents');
	const workingDirectory = serviceOf(ctx, 'workingDirectory');
	const sessionQuery = serviceOf(ctx, 'sessionQuery');

	let liveAgent;
	if (agents !== undefined && typeof agents.get === 'function') {
		try {
			liveAgent = agents.get(sessionId);
		} catch {
			liveAgent = undefined;
		}
	}

	/** First validated-but-unusable candidate, reported only if all fallbacks fail. */
	/** @type {{ok: false, error: object} | null} */
	let invalidCandidate = null;

	// 1. Live Agent: `get` reads the committed projection without filesystem IO
	//    (and without the durable writes `ensure` may perform).
	const liveCandidates = [];
	if (liveAgent !== undefined && liveAgent !== null) {
		if (typeof workingDirectory?.get === 'function') {
			try {
				liveCandidates.push(workingDirectory.get(liveAgent.session));
			} catch {
				// Fall through to the header.
			}
		}
		liveCandidates.push(liveAgent.session?.header?.cwd);
	}
	for (const candidate of liveCandidates) {
		if (typeof candidate !== 'string' || candidate.length === 0) continue;
		const accepted = acceptSessionCwd(candidate, sessionId);
		if (accepted.ok) return ok({ cwd: accepted.value, source: 'session' });
		if (invalidCandidate === null) invalidCandidate = accepted;
	}

	// 2. Durable session observation (cold sessions, or a vanished live cwd).
	let observationAttempted = false;
	let observationSucceeded = false;
	let observationError = null;
	const durableCandidates = [];
	if (sessionQuery !== undefined && typeof sessionQuery.observeSession === 'function') {
		observationAttempted = true;
		/** @type {object|null} */
		let observation = null;
		try {
			observation = await sessionQuery.observeSession(sessionId);
			observationSucceeded = true;
			const values = observation?.projections?.values;
			const projected = values !== null && typeof values === 'object' ? values.workingDirectory : undefined;
			durableCandidates.push(projected);
			durableCandidates.push(observation?.header?.cwd);
		} catch (error) {
			observationError = error;
		} finally {
			disposeObservation(observation);
		}
	}
	for (const candidate of durableCandidates) {
		if (typeof candidate !== 'string' || candidate.length === 0) continue;
		const accepted = acceptSessionCwd(candidate, sessionId);
		if (accepted.ok) return ok({ cwd: accepted.value, source: 'session' });
		if (invalidCandidate === null) invalidCandidate = accepted;
	}

	// 3. Deployment default, but only when it cannot mask an unknown session:
	//    - the session is known but has no recorded directory (observation
	//      succeeded without a cwd), or
	//    - the durable session service is unavailable in this Host composition
	//      (then a live Agent is the only session check we can make).
	//    A failed observation (unknown session) must stay `session-not-found`
	//    instead of silently reading the deployment's default directory.
	const knownSession = (liveAgent !== undefined && liveAgent !== null) || observationSucceeded;
	const fallbackAllowed = !observationAttempted || (observationSucceeded && knownSession);
	if (fallbackAllowed && workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string') {
		const candidate = workingDirectory.defaultDirectory;
		if (typeof candidate === 'string' && candidate.length > 0) {
			const accepted = acceptSessionCwd(candidate, sessionId);
			if (accepted.ok) return ok({ cwd: accepted.value, source: 'session' });
			if (invalidCandidate === null) invalidCandidate = accepted;
		}
	}

	if (invalidCandidate !== null) return invalidCandidate;
	if (observationError !== null) {
		return fail(
			'session-not-found',
			`session "${sessionId}" could not be resolved: ${observationError instanceof Error ? observationError.message : String(observationError)}`,
		);
	}
	return fail('session-not-found', `session "${sessionId}" was not found`);
}
