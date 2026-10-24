#!/usr/bin/env node
/**
 * Verify @local/dsh-git-graph in a DSH desktop profile.
 *
 * Two independent tiers:
 *
 * 1. STATIC — plugin package healthy (client.js/index.js/patch/locale meta) and the
 *    profile declares the link dependency + selects the bundle.
 *
 * 2. RUNTIME (no credentials needed):
 *    - GET /plugins/events is a PUBLIC SSE route; its first frame is
 *      {"type":"graph","graph":{entries:[...]}}. Presence of our package id proves the
 *      profile bundle row loaded, the package manifest parsed, dsh.client is valid and
 *      client.js exists.
 *    - the entry's bundle URL is served PUBLICLY under /plugins/*; fetch it and assert
 *      the registration marker.
 *
 * Route-registration note: an unauthenticated /api request is rejected by the auth
 * fence BEFORE route dispatch, so it always answers 401 regardless of whether our
 * exact route exists. This script therefore does not use 401/404 as a fingerprint.
 * Pass --cookie (copy it manually from DevTools; this script never reads or forges
 * credentials) and --session to additionally call the real API and validate the
 * JSON envelope.
 */
import {
  PACKAGE_NAME,
  detectRuntime,
  inspectPluginPackage,
  inspectProfile,
  parseArgs,
  printHelp,
} from './lib.mjs';

const SSE_TIMEOUT_MS = 8000;
const FUZZY_URL_TIMEOUT_MS = 8000;

function warn(label, detail = '') {
  console.log(`  WARN  ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/** Read the first complete `data:` frame from the public /plugins/events SSE stream. */
async function readBootGraph(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), SSE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/plugins/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) throw new Error(`/plugins/events answered HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('/plugins/events closed before a graph frame');
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!chunk.startsWith('data: ')) continue;
        const frame = JSON.parse(chunk.slice('data: '.length));
        if (frame?.type === 'graph') {
          await reader.cancel().catch(() => {});
          return frame.graph;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one public /plugins resource with a bounded timeout. */
async function fetchPublic(base, documentRelativeUrl) {
  const response = await fetch(`${base}/${String(documentRelativeUrl).replace(/^\/+/, '')}`, {
    signal: AbortSignal.timeout(FUZZY_URL_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp('verify.mjs -- verify @local/dsh-git-graph in a DSH profile', [
      '  --base <url>       running DSH web origin (default: http://127.0.0.1:6503)',
      '  --cookie <cookie>  optional manual browser cookie for a real /api call',
      '  --session <id>     session id used with --cookie (op=repo)',
      '  --json             machine-readable summary',
    ]);
    return 0;
  }

  const results = { static: [], runtime: [], api: null, ok: false };
  const failures = [];
  const record = (tier, ok, label, detail = '') => {
    results[tier].push({ ok, label, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`);
  };

  console.log(`verify: profile ${args.profile}`);
  console.log(`verify: package ${args.package}`);
  console.log(`verify: base    ${args.base}\n`);

  // ------------------------------------------------------------------ static tier
  console.log('static:');
  const packageProblems = inspectPluginPackage(args.package);
  record('static', packageProblems.length === 0, 'plugin package healthy', packageProblems.join('; '));
  try {
    const state = inspectProfile(args.profile, args.package);
    record('static', state.dependencyMatches, 'profile dependency is a link to this package', String(state.declared));
    record('static', state.bundleListed, 'profile selects the bundle in dsh.profile.bundles');
    const runtimeInfo = detectRuntime({ node: args.node, pnpm: args.pnpm });
    record('static', true, 'bundled runtime detected', `node ${runtimeInfo.nodeVersion}, pnpm ${runtimeInfo.pnpmVersion}`);
  } catch (error) {
    record('static', false, 'profile / runtime inspection', error.message);
  }
  console.log('');

  // ---------------------------------------------------------------- runtime tier
  console.log('runtime (public /plugins, no credentials):');
  let entry;
  try {
    const graph = await readBootGraph(args.base);
    const entries = Array.isArray(graph?.entries) ? graph.entries : [];
    entry = entries.find((candidate) => candidate.id === PACKAGE_NAME);
    record('runtime', entry !== undefined, `boot graph contains ${PACKAGE_NAME}`, entry === undefined ? `${entries.length} entries, package absent` : `rev ${graph.rev}`);
    if (entry !== undefined) {
      record('runtime', entry.immediately === true, 'graph row is immediately:true');
      const inject = Array.isArray(entry.inject) ? entry.inject : [];
      record('runtime', inject.some((name) => name.includes('ui-conversation')), 'graph row injects ui-conversation first', inject.join(', '));
      const bundle = await fetchPublic(args.base, entry.url);
      const bodyOk = bundle.status === 200
        && bundle.text.includes('__ModuleLoader__.load')
        && bundle.text.includes(PACKAGE_NAME)
        && bundle.text.includes('conversation.view');
      record('runtime', bodyOk, 'client bundle is served and registers conversation.view', `HTTP ${bundle.status}, ${bundle.text.length} bytes`);
      if (bundle.status === 200 && !bundle.text.includes('conversation.view')) {
        warn('client bundle does not mention conversation.view yet (client-view half incomplete?)');
      }
    }
  } catch (error) {
    record('runtime', false, 'public boot graph / bundle', error.message);
    warn('is the DSH Web GUI running at this origin?', args.base);
  }

  // ------------------------------------------------------------------- api fence
  console.log('\napi route (fingerprint limitation):');
  try {
    const response = await fetch(`${args.base}/api/plugin/git-graph?op=repo`, {
      signal: AbortSignal.timeout(FUZZY_URL_TIMEOUT_MS),
    });
    const text = await response.text();
    results.api = { status: response.status, body: text.slice(0, 200) };
    if (response.status === 401) {
      console.log('  INFO  unauthenticated /api answers 401 (auth fence runs before route dispatch).');
      console.log('  INFO  This is expected both before and after install; it does NOT prove route registration.');
    } else if (response.status === 403) {
      console.log('  INFO  /api answered 403: Host/Origin fence rejected this caller (unexpected outside a browser).');
    } else {
      console.log(`  INFO  /api answered HTTP ${response.status}`);
    }
  } catch (error) {
    warn('could not probe /api', error.message);
  }

  if (args.cookie !== undefined) {
    console.log('\napi route (authenticated, manual cookie):');
    try {
      const url = new URL(`${args.base}/api/plugin/git-graph`);
      url.searchParams.set('op', 'repo');
      if (args.session !== undefined) url.searchParams.set('sessionId', args.session);
      const response = await fetch(url, {
        headers: { cookie: args.cookie, accept: 'application/json' },
        signal: AbortSignal.timeout(FUZZY_URL_TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      const envelopeOk = response.status === 200 && (parsed?.ok === true || parsed?.ok === false);
      record('runtime', envelopeOk, 'authenticated /api/plugin/git-graph returns the JSON envelope', `HTTP ${response.status}`);
      if (parsed?.ok === true) {
        const value = parsed.value;
        record('runtime', value?.isRepo === true, 'op=repo resolves the session working directory to a git repository', value?.root);
      } else if (parsed?.ok === false) {
        warn('route answered a business error', JSON.stringify(parsed.error));
      }
    } catch (error) {
      record('runtime', false, 'authenticated /api call', error.message);
    }
  } else {
    console.log('  INFO  pass --cookie "<dsh-auth-...=...>" (copied from DevTools) to validate the real API response.');
  }

  // ----------------------------------------------------------------------- summary
  const ok = failures.length === 0;
  results.ok = ok;
  console.log(`\nverify: ${ok ? 'OK' : 'FAILED'} (${results.static.filter((row) => row.ok).length}/${results.static.length} static, ` +
    `${results.runtime.filter((row) => row.ok).length}/${results.runtime.length} runtime)`);
  if (!ok) {
    console.error('\nverify: failures:');
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('\nverify: hints:');
    console.error('  - boot graph missing package: check the profile bundle row, then DSH restart; HMR should recompose.');
    console.error('  - bundle fetch failed: confirm /plugins/* is reachable and the package was installed (link:).');
    console.error('  - tab still missing after install: refresh the page (client HMR usually activates the new bundle live).');
  }
  if (args.json) console.log(`\n${JSON.stringify(results, null, 2)}`);
  return ok ? 0 : 1;
}

process.exitCode = await main();
