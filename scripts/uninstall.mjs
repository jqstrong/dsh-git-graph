#!/usr/bin/env node
/**
 * Uninstall @local/dsh-git-graph from a DSH desktop profile.
 *
 *   1. validate the profile and current install state
 *   2. take the profile package.json lock
 *   3. back up package.json / pnpm-lock.yaml / cordis.patch.yml
 *   4. remove the dependency AND the dsh.profile.bundles row in ONE write
 *      (HMR then drops the bundle layer immediately)
 *   5. run the bundled pnpm install to prune node_modules; restore backups on failure
 *
 * Default is a dry run; pass --yes to write. Re-running on a clean profile is a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGE_NAME,
  acquireProfileLock,
  backupProfile,
  detectRuntime,
  inspectProfile,
  parseArgs,
  printHelp,
  restoreBackup,
  runPnpm,
  serializeJson,
  writeAtomic,
} from './lib.mjs';

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp('uninstall.mjs -- remove @local/dsh-git-graph from a DSH profile', [
      '  --yes               perform writes (default: dry run)',
      '  --node <exe>        node executable (default: DSH bundled node)',
      '  --pnpm <pnpm.mjs>   pnpm entry (default: DSH bundled pnpm)',
    ]);
    return 0;
  }
  const profileDir = args.profile;
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    console.error(`uninstall: profile ${profileDir} has no package.json`);
    return 1;
  }
  const state = inspectProfile(profileDir, args.package);
  if (!state.dependencyPresent && !state.bundleListed) {
    console.log('uninstall: not installed in this profile; nothing to do.');
    return 0;
  }

  const runtime = detectRuntime({ node: args.node, pnpm: args.pnpm });
  console.log(`uninstall: profile ${profileDir}`);
  console.log(`uninstall: remove dependency ${JSON.stringify(state.declared ?? '(absent)')}`);
  console.log(`uninstall: remove bundle row ${PACKAGE_NAME} (listed: ${state.bundleListed})`);

  if (args.dryRun) {
    console.log('\n[dry-run] plan:');
    console.log('  1. remove dependencies["@local/dsh-git-graph"] and the dsh.profile.bundles row in ONE write');
    console.log('  2. run: pnpm install --prefer-offline');
    console.log('\n[dry-run] nothing written; re-run with --yes to apply.');
    return 0;
  }

  let release;
  let backupDir;
  try {
    release = acquireProfileLock(profileDir);
    backupDir = backupProfile(profileDir, PROFILE_FILES);
    console.log(`uninstall: backup ${backupDir}`);

    const current = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    if (current.dependencies !== undefined) delete current.dependencies[PACKAGE_NAME];
    const bundles = current.dsh?.profile?.bundles;
    if (Array.isArray(bundles)) current.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
    writeAtomic(path.join(profileDir, 'package.json'), serializeJson(current));
    console.log('uninstall: removed dependency and bundle selection');

    const result = runPnpm(runtime, profileDir, ['install', '--prefer-offline']);
    if (result.status !== 0) throw new Error(`pnpm exited with code ${result.status}`);

    console.log('\nuninstall: OK. The bundle layer is removed on the next HMR reconcile (or page refresh).');
    return 0;
  } catch (error) {
    console.error(`\nuninstall: FAILED — ${error.message}`);
    if (backupDir !== undefined) {
      restoreBackup(backupDir, profileDir, PROFILE_FILES);
      console.error(`uninstall: restored package.json / pnpm-lock.yaml / cordis.patch.yml from ${backupDir}`);
    }
    return 1;
  } finally {
    release?.();
  }
}

process.exitCode = main();
