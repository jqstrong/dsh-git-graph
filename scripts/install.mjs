#!/usr/bin/env node
/**
 * Install @local/dsh-git-graph into a DSH desktop profile.
 *
 * Replicates the profile plugin manager's safe sequence without touching the
 * DSH installation:
 *   1. validate the plugin package (client bundle, host entry, patch, locale meta)
 *   2. take the profile package.json lock (same file the plugin manager locks)
 *   3. back up package.json / pnpm-lock.yaml / cordis.patch.yml
 *   4. add `"@local/dsh-git-graph": "link:<package dir>"` to profile dependencies
 *   5. run the bundled node + pnpm 11 (`pnpm install --prefer-offline`) in the profile
 *   6. only after pnpm succeeded, append the bundle to dsh.profile.bundles in ONE write
 *      (the HMR manifest watcher only recomposes when the bundles JSON actually changes)
 *   7. on any failure restore the backups and exit non-zero
 *
 * Default is a dry run; pass --yes to write. Re-running on an installed profile is a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGE_NAME,
  acquireProfileLock,
  backupProfile,
  detectRuntime,
  inspectPluginPackage,
  inspectProfile,
  parseArgs,
  printHelp,
  readJson,
  restoreBackup,
  runPnpm,
  serializeJson,
  toPosixPath,
  writeAtomic,
} from './lib.mjs';

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp('install.mjs -- install @local/dsh-git-graph into a DSH profile', [
      '  --yes               perform writes (default: dry run)',
      '  --lockfile-only     pass --lockfile-only to pnpm (validation on profile copies)',
      '  --node <exe>        node executable (default: DSH bundled node 24.21.0)',
      '  --pnpm <pnpm.mjs>   pnpm entry (default: DSH bundled pnpm 11.28.5)',
      '  --base <url>        unused here (accepted for symmetry with verify.mjs)',
    ]);
    return 0;
  }

  const packageDir = args.package;
  const profileDir = args.profile;
  const problems = inspectPluginPackage(packageDir);
  if (problems.length > 0) {
    console.error('install: the plugin package is not ready:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    console.error(`install: profile ${profileDir} has no package.json`);
    return 1;
  }

  const runtime = detectRuntime({ node: args.node, pnpm: args.pnpm });
  const before = inspectProfile(profileDir, packageDir);
  const dependency = `link:${toPosixPath(packageDir)}`;

  console.log(`install: profile    ${profileDir}`);
  console.log(`install: package    ${packageDir}`);
  console.log(`install: runtime    node ${runtime.nodeVersion} via ${runtime.nodeExe}`);
  console.log(`install:            pnpm ${runtime.pnpmVersion} via ${runtime.pnpmMjs}`);
  console.log(`install: dependency ${PACKAGE_NAME} -> ${dependency}`);
  console.log('');

  if (before.dependencyPresent && !before.dependencyMatches) {
    console.error(`install: ${PACKAGE_NAME} is already declared with a different spec ${JSON.stringify(before.declared)}.`);
    console.error('install: refusing to overwrite it; remove or fix that dependency first.');
    return 1;
  }
  const dependencyDone = before.dependencyMatches;
  const bundleDone = before.bundleListed;
  if (dependencyDone && bundleDone) {
    console.log('install: already installed (dependency and bundle selection both present); nothing to do.');
    return 0;
  }

  if (args.dryRun) {
    console.log('[dry-run] plan:');
    if (!dependencyDone) console.log(`  1. set dependencies["${PACKAGE_NAME}"] = ${JSON.stringify(dependency)}`);
    console.log(`  2. run: pnpm install${args.lockfileOnly ? ' --lockfile-only' : ''} --prefer-offline`);
    if (!bundleDone) console.log(`  3. append ${PACKAGE_NAME} to dsh.profile.bundles`);
    console.log('\n[dry-run] nothing written; re-run with --yes to apply.');
    return 0;
  }

  let release;
  let backupDir;
  try {
    release = acquireProfileLock(profileDir);
    backupDir = backupProfile(profileDir, PROFILE_FILES);
    console.log(`install: backup ${backupDir}`);

    if (!dependencyDone) {
      const next = structuredClone(before.manifest);
      next.dependencies = { ...(next.dependencies ?? {}), [PACKAGE_NAME]: dependency };
      writeAtomic(path.join(profileDir, 'package.json'), serializeJson(next));
      console.log(`install: set ${PACKAGE_NAME} dependency`);
    }

    const pnpmArgs = ['install', '--prefer-offline'];
    if (args.lockfileOnly) pnpmArgs.push('--lockfile-only');
    const result = runPnpm(runtime, profileDir, pnpmArgs);
    if (result.status !== 0) throw new Error(`pnpm exited with code ${result.status}`);

    if (!bundleDone) {
      const current = readJson(path.join(profileDir, 'package.json'));
      const bundles = current.dsh?.profile?.bundles ?? [];
      if (!bundles.includes(PACKAGE_NAME)) {
        if (current.dsh === undefined) current.dsh = {};
        if (current.dsh.profile === undefined) current.dsh.profile = {};
        current.dsh.profile.bundles = [...bundles, PACKAGE_NAME];
        writeAtomic(path.join(profileDir, 'package.json'), serializeJson(current));
        console.log(`install: appended ${PACKAGE_NAME} to dsh.profile.bundles`);
      }
    }

    console.log('\ninstall: OK.');
    console.log('install: HMR watches the profile manifest; the new bundle should recompose within a few seconds.');
    console.log('install: if the Git tab does not appear, refresh the page, then restart DSH as the last resort.');
    console.log('install: verify with: node scripts/verify.mjs');
    return 0;
  } catch (error) {
    console.error(`\ninstall: FAILED — ${error.message}`);
    if (backupDir !== undefined) {
      restoreBackup(backupDir, profileDir, PROFILE_FILES);
      console.error(`install: restored package.json / pnpm-lock.yaml / cordis.patch.yml from ${backupDir}`);
      console.error('install: downloaded node_modules entries may remain; they are inert.');
    }
    return 1;
  } finally {
    release?.();
  }
}

process.exitCode = main();
