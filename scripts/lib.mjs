/**
 * Shared helpers for the @local/dsh-git-graph install / verify / uninstall scripts.
 *
 * Deliberately dependency-free (node: builtins only) and Windows-aware. These
 * scripts replicate the safe steps of the DSH profile plugin manager without
 * touching the DSH installation itself:
 *   - back up package.json / pnpm-lock.yaml / cordis.patch.yml before writes
 *   - take the exact profile lock the plugin manager uses (package.json.lock)
 *   - write files atomically (tmp + rename)
 *   - run the bundled Node + pnpm the desktop app itself uses
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@local/dsh-git-graph';
export const LETTER_ID = 'git-graph';

export const DEFAULT_PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
export const DEFAULT_BASE_URL = 'http://127.0.0.1:6503';
export const BACKUP_DIR_NAME = '.git-graph-install-backup';

/** Resolve `os.homedir()/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies`. */
export function runtimeDependenciesDir() {
  return path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies');
}

/** Locate the bundled node/pnpm pair the desktop app uses for profile installs. */
export function detectRuntime(overrides = {}) {
  const deps = runtimeDependenciesDir();
  const bundledNode = path.join(deps, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const bundledPnpm = path.join(deps, 'pnpm', 'bin', 'pnpm.mjs');
  const nodeExe = overrides.node ?? (fs.existsSync(bundledNode) ? bundledNode : process.execPath);
  const pnpmMjs = overrides.pnpm ?? (fs.existsSync(bundledPnpm) ? bundledPnpm : undefined);
  if (pnpmMjs === undefined || !fs.existsSync(pnpmMjs)) {
    throw new Error(
      'cannot locate the bundled pnpm.mjs. Expected it at\n  ' + bundledPnpm +
      '\nPass --pnpm <path-to-pnpm.mjs>.',
    );
  }
  const version = spawnSync(nodeExe, [pnpmMjs, '--version'], { encoding: 'utf8', windowsHide: true });
  const nodeVersion = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true });
  return {
    nodeExe,
    pnpmMjs,
    nodeVersion: nodeVersion.status === 0 ? nodeVersion.stdout.trim() : 'unknown',
    pnpmVersion: version.status === 0 ? version.stdout.trim() : 'unknown',
  };
}

/** `E:\a\b` -> `E:/a/b` (pnpm records link dependencies with forward slashes). */
export function toPosixPath(value) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Compare two filesystem paths on Windows case-insensitively, both separators accepted. */
export function samePath(left, right) {
  const normalize = (value) => toPosixPath(path.resolve(value)).toLowerCase();
  return normalize(left) === normalize(right);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write a UTF-8 file atomically (sibling tmp file + rename). */
export function writeAtomic(file, text) {
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, text, 'utf8');
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/** Serialize a manifest in the shape the profile already uses (2-space JSON, trailing newline). */
export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Take the same lock file the DSH plugin manager takes for this profile
 * (`withFileLock(join(profileDir, 'package.json'))` -> `package.json.lock`).
 * Returns a release function. Stale locks whose recorded pid is gone are removed.
 */
export function acquireProfileLock(profileDir) {
  const lockPath = path.join(profileDir, 'package.json.lock');
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), tool: PACKAGE_NAME });
  const open = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, payload, 'utf8');
    fs.closeSync(fd);
  };
  try {
    open();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holder;
    try { holder = readJson(lockPath); } catch { holder = undefined; }
    const pid = Number(holder?.pid);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) {
      throw new Error(
        `profile is locked by another operation (${lockPath}, pid ${pid}, ${holder?.startedAt ?? 'unknown time'}).\n` +
        'Wait for the DSH plugin manager operation to finish, then retry.',
      );
    }
    fs.rmSync(lockPath, { force: true });
    open();
  }
  return () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ } };
}

/** Snapshot the profile files this tool touches; returns the backup directory. */
export function backupProfile(profileDir, files) {
  const dir = path.join(profileDir, BACKUP_DIR_NAME, timestamp());
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) {
    const source = path.join(profileDir, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, name));
  }
  return dir;
}

export function restoreBackup(backupDir, profileDir, files) {
  for (const name of files) {
    const saved = path.join(backupDir, name);
    const target = path.join(profileDir, name);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, target);
    else fs.rmSync(target, { force: true });
  }
}

/** Run the bundled pnpm inside the profile. */
export function runPnpm(runtime, profileDir, args, { dryRun = false } = {}) {
  const printable = [runtime.nodeExe, runtime.pnpmMjs, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
  if (dryRun) {
    console.log(`[dry-run] (cwd ${profileDir}) ${printable}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  console.log(`\n$ ${printable}\n  (cwd ${profileDir})`);
  const result = spawnSync(runtime.nodeExe, [runtime.pnpmMjs, ...args], {
    cwd: profileDir,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1 };
}

export function parseArgs(argv) {
  const args = {
    profile: DEFAULT_PROFILE_DIR,
    package: DEFAULT_PACKAGE_DIR,
    base: DEFAULT_BASE_URL,
    yes: false,
    dryRun: true,
    lockfileOnly: false,
    node: undefined,
    pnpm: undefined,
    cookie: undefined,
    session: undefined,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
      index += 1;
      return value;
    };
    switch (token) {
      case '--profile': args.profile = path.resolve(next()); break;
      case '--package': args.package = path.resolve(next()); break;
      case '--base': args.base = next().replace(/\/+$/, ''); break;
      case '--yes': args.yes = true; args.dryRun = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--lockfile-only': args.lockfileOnly = true; break;
      case '--node': args.node = path.resolve(next()); break;
      case '--pnpm': args.pnpm = path.resolve(next()); break;
      case '--cookie': args.cookie = next(); break;
      case '--session': args.session = next(); break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown argument ${JSON.stringify(token)} (try --help)`);
    }
  }
  return args;
}

export function printHelp(script, lines) {
  console.log(`\n${script}\n\nOptions:\n  --profile <dir>   DSH profile dir (default: ${DEFAULT_PROFILE_DIR})\n` + lines.join('\n') + '\n');
}

/** Validate the plugin package itself; returns a list of problems (empty = healthy). */
export function inspectPluginPackage(packageDir) {
  const problems = [];
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return [`missing ${manifestPath}`];
  const manifest = readJson(manifestPath);
  if (manifest.name !== PACKAGE_NAME) problems.push(`package.json name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(PACKAGE_NAME)}`);
  const clientExport = manifest.exports?.['./client'];
  const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default;
  if (typeof clientPath !== 'string') problems.push('package.json exports["./client"] is missing');
  else if (!fs.existsSync(path.join(packageDir, clientPath))) problems.push(`client bundle ${clientPath} does not exist yet`);
  const entryExport = manifest.exports?.['.'];
  const entryPath = typeof entryExport === 'string' ? entryExport : entryExport?.default;
  if (typeof entryPath !== 'string') problems.push('package.json exports["."] is missing');
  else if (!fs.existsSync(path.join(packageDir, entryPath))) problems.push(`host entry ${entryPath} does not exist yet`);
  if (manifest.dsh?.bundle?.patch === undefined) problems.push('package.json dsh.bundle.patch is missing');
  else if (!fs.existsSync(path.join(packageDir, manifest.dsh.bundle.patch))) problems.push(`bundle patch ${manifest.dsh.bundle.patch} does not exist`);
  if (manifest.dsh?.client?.platform !== 'web') problems.push('package.json dsh.client.platform must be "web"');
  if (typeof manifest.dsh?.client?.immediately !== 'boolean') problems.push('package.json dsh.client.immediately must be a boolean');
  if (!fs.existsSync(path.join(packageDir, 'index.js'))) problems.push('index.js is missing');
  const localeDir = path.join(packageDir, 'locale');
  if (fs.existsSync(localeDir)) {
    for (const file of fs.readdirSync(localeDir).filter((name) => name.endsWith('.json'))) {
      try {
        const locale = readJson(path.join(localeDir, file));
        if (locale?.meta?.title === undefined) problems.push(`locale/${file} has no meta.title (plugin row will fall back to the package name)`);
        if (locale?.meta?.description === undefined) problems.push(`locale/${file} has no meta.description`);
      } catch (error) {
        problems.push(`locale/${file} is not valid JSON: ${error.message}`);
      }
    }
  }
  return problems;
}

/** Inspect the profile selection state for this package. */
export function inspectProfile(profileDir, packageDir) {
  const manifestPath = path.join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  const dependencies = manifest.dependencies ?? {};
  const declared = dependencies[PACKAGE_NAME];
  const expected = `link:${toPosixPath(packageDir)}`;
  const declaredPath = typeof declared === 'string' && declared.startsWith('link:') ? declared.slice('link:'.length) : undefined;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return {
    manifest,
    declared,
    expected,
    dependencyPresent: declared !== undefined,
    dependencyMatches: declaredPath !== undefined && samePath(declaredPath, packageDir),
    bundleListed: bundles.includes(PACKAGE_NAME),
    bundles,
  };
}
