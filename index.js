/**
 * Host half of `@local/dsh-git-graph`.
 *
 * Registers exactly one authenticated GET route — `/api/plugin/git-graph` — on
 * DSH's Host Connection service and serves the read-only git payloads from
 * `host/git-core.js` as JSON envelopes:
 *
 *   { ok: true,  value: { … } }
 *   { ok: false, error: { code, message } }
 *
 * Parameters are validated strictly before any git process runs; a malformed
 * request answers HTTP 400, every git-level failure is a business error inside
 * an HTTP 200 envelope (SPEC §3), and no stack trace ever reaches the browser.
 *
 * The plugin only injects `connection`: the working-directory services are
 * optional lookups in `host/session.js`, so a composition without them keeps
 * this plugin active and still serves explicit `cwd` requests.
 */

import {
	discoverRepos,
	inspectRepo,
	isRefFilter,
	isSafeRepoPath,
	isSha,
	LIMITS,
	listRefs,
	normalizeLogOptions,
	readCommit,
	readDiff,
	readLog,
} from './host/git-core.js';
import { isParamErrorCode, resolveCwd } from './host/session.js';

/** Exact route path registered inside Connection's authentication fence. */
export const ROUTE_PATH = '/api/plugin/git-graph';

/** The only route methods; GET has no request body. */
const ROUTE_METHODS = Object.freeze(['GET']);

/** Operations served by this route (SPEC §3). */
const OPERATIONS = Object.freeze(new Set(['repo', 'refs', 'log', 'commit', 'diff', 'repos']));

/**
 * Only `connection` is required. `agents` / `workingDirectory` / `sessionQuery`
 * are optional lookups so the plugin never stays inactive in a slimmer Host.
 */
export const inject = ['connection'];

/**
 * Register the route on the Host Connection service.
 * @param {object} ctx - Cordis Host plugin context carrying `connection`.
 */
export function apply(ctx) {
	ctx.effect(() => ctx.connection.fetch.register({
		path: ROUTE_PATH,
		methods: [...ROUTE_METHODS],
		requestBody: 'buffered',
		fetch: (request) => handleRequest(ctx, request),
	}), 'git-graph: GET /api/plugin/git-graph');
}

/* ------------------------------------------------------------------------- *
 * HTTP plumbing
 * ------------------------------------------------------------------------- */

/** JSON response with the SPEC headers (no-store, UTF-8, JSON only). */
function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		},
	});
}

/** Publish one `{ok:false}` envelope, using HTTP 400 for bad parameters. */
function errorResponse(error) {
	return jsonResponse(isParamErrorCode(error?.code) ? 400 : 200, { ok: false, error });
}

/** Log an unexpected failure without ever echoing its stack to the client. */
function warn(ctx, message) {
	try {
		if (ctx !== null && typeof ctx === 'object' && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
			ctx.logger.warn(message);
			return;
		}
	} catch {
		// Logging must never fail a request.
	}
	try {
		console.warn(message);
	} catch {
		// ignore
	}
}

/** Read one optional query parameter; absent and empty both mean "not given". */
function queryParam(searchParams, name) {
	const value = searchParams.get(name);
	if (value === null || value === '') return null;
	return value;
}

/** Strict unsigned-integer parse for query parameters. */
function parseUnsignedParam(searchParams, name) {
	const raw = searchParams.get(name);
	if (raw === null || raw === '') return { ok: true, value: undefined };
	if (!/^\d+$/.test(raw)) return { ok: false, error: { code: `invalid-${name}`, message: `${name} must be a non-negative integer` } };
	return { ok: true, value: Number(raw) };
}

/**
 * Strict bounded-integer parse with a default, used by `op=repos` (SPEC §3.6).
 * Non-integers and out-of-range values are rejected with `invalid-<name>`.
 */
function parseBoundedParam(searchParams, name, fallback, min, max) {
	const raw = searchParams.get(name);
	if (raw === null || raw === '') return { ok: true, value: fallback };
	const message = `${name} must be an integer between ${min} and ${max}`;
	if (!/^\d+$/.test(raw)) return { ok: false, error: { code: `invalid-${name}`, message } };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		return { ok: false, error: { code: `invalid-${name}`, message } };
	}
	return { ok: true, value };
}

/* ------------------------------------------------------------------------- *
 * Request handling
 * ------------------------------------------------------------------------- */

/**
 * Handle one GET `/api/plugin/git-graph` request.
 *
 * Exported for tests: the Host test suite drives it with a fake Cordis context
 * and real `Request`/`Response` objects, no running DSH needed.
 *
 * @param {object} ctx - Host plugin context (only optional services are read).
 * @param {Request} request - WHATWG request supplied by Connection.
 * @returns {Promise<Response>}
 */
export async function handleRequest(ctx, request) {
	try {
		if (request.method !== 'GET') {
			// The route only registers GET; this is a defensive 405 for direct callers.
			return jsonResponse(405, { ok: false, error: { code: 'method-not-allowed', message: 'only GET is supported' } });
		}

		let url;
		try {
			url = new URL(request.url);
		} catch {
			return errorResponse({ code: 'invalid-url', message: 'request url is not a valid URL' });
		}
		const searchParams = url.searchParams;

		const op = queryParam(searchParams, 'op');
		if (op === null) return errorResponse({ code: 'invalid-op', message: 'missing required query parameter: op' });
		if (!OPERATIONS.has(op)) {
			return errorResponse({ code: 'invalid-op', message: `unsupported op: ${op}` });
		}

		const params = validateOperationParams(op, searchParams);
		if (!params.ok) return errorResponse(params.error);

		// Explicit `cwd` wins over `sessionId`; no parameter at all is a 400.
		const cwdResult = await resolveCwd(ctx, {
			cwd: queryParam(searchParams, 'cwd'),
			sessionId: queryParam(searchParams, 'sessionId'),
			signal: request.signal,
		});
		if (!cwdResult.ok) return errorResponse(cwdResult.error);
		const cwd = cwdResult.value.cwd;

		const result = await runOperation(op, cwd, params.value);
		if (!result.ok) return errorResponse(result.error);
		return jsonResponse(200, result);
	} catch (error) {
		warn(ctx, `git-graph: unhandled host failure: ${error instanceof Error ? error.message : String(error)}`);
		return jsonResponse(500, {
			ok: false,
			error: { code: 'internal-error', message: 'the git-graph host handler failed' },
		});
	}
}

/**
 * Validate the operation-specific query parameters.
 * @returns {{ok: true, value: object} | {ok: false, error: object}}
 */
function validateOperationParams(op, searchParams) {
	if (op === 'repo' || op === 'refs') return { ok: true, value: {} };

	if (op === 'repos') {
		const depth = parseBoundedParam(
			searchParams,
			'depth',
			LIMITS.reposDepthDefault,
			LIMITS.reposDepthMin,
			LIMITS.reposDepthMax,
		);
		if (!depth.ok) return depth;
		const max = parseBoundedParam(
			searchParams,
			'max',
			LIMITS.reposMaxDefault,
			LIMITS.reposMaxMin,
			LIMITS.reposMaxMax,
		);
		if (!max.ok) return max;
		return { ok: true, value: { depth: depth.value, max: max.value } };
	}

	if (op === 'log') {
		const limit = parseUnsignedParam(searchParams, 'limit');
		if (!limit.ok) return limit;
		const skip = parseUnsignedParam(searchParams, 'skip');
		if (!skip.ok) return skip;
		const ref = queryParam(searchParams, 'ref');
		if (ref !== null && !isRefFilter(ref)) {
			return { ok: false, error: { code: 'invalid-ref', message: 'ref must be --all or a refs/(heads|tags|remotes)/… name' } };
		}
		const normalized = normalizeLogOptions({ limit: limit.value, skip: skip.value });
		if (!normalized.ok) return normalized;
		return { ok: true, value: { ...normalized.value, ref } };
	}

	if (op === 'commit') {
		const sha = queryParam(searchParams, 'sha');
		if (sha === null) return { ok: false, error: { code: 'invalid-sha', message: 'missing required query parameter: sha' } };
		if (!isSha(sha)) return { ok: false, error: { code: 'invalid-sha', message: 'sha must be 7 to 40 hexadecimal characters' } };
		return { ok: true, value: { sha } };
	}

	// op === 'diff'
	const sha = queryParam(searchParams, 'sha');
	if (sha === null) return { ok: false, error: { code: 'invalid-sha', message: 'missing required query parameter: sha' } };
	if (!isSha(sha)) return { ok: false, error: { code: 'invalid-sha', message: 'sha must be 7 to 40 hexadecimal characters' } };
	const path = queryParam(searchParams, 'path');
	if (path === null) return { ok: false, error: { code: 'invalid-path', message: 'missing required query parameter: path' } };
	if (!isSafeRepoPath(path)) return { ok: false, error: { code: 'invalid-path', message: 'path must be a safe repository-relative path' } };
	const oldPath = queryParam(searchParams, 'oldPath');
	if (oldPath !== null && !isSafeRepoPath(oldPath)) {
		return { ok: false, error: { code: 'invalid-path', message: 'oldPath must be a safe repository-relative path' } };
	}
	return { ok: true, value: { sha, path, oldPath: oldPath ?? undefined } };
}

/** Dispatch one validated operation to the read-only git engine. */
function runOperation(op, cwd, params) {
	switch (op) {
		case 'repo':
			return inspectRepo(cwd);
		case 'refs':
			return listRefs(cwd);
		case 'log':
			return readLog(cwd, { limit: params.limit, skip: params.skip, ref: params.ref });
		case 'commit':
			return readCommit(cwd, params.sha);
		case 'diff':
			return readDiff(cwd, params.sha, params.path, params.oldPath);
		case 'repos':
			return discoverRepos(cwd, { depth: params.depth, max: params.max });
		default:
			return Promise.resolve({ ok: false, error: { code: 'invalid-op', message: `unsupported op: ${String(op)}` } });
	}
}
