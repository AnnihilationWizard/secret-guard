import type { EngineInterface, ProcessRunResult } from 'claude-code'

/** What the mod needs from the host: built from `$` in register, an in-memory fake in tests. */
export type Host = {
  /** Resolves undefined when the command cannot start (not installed) or times out. */
  run: (argv: readonly string[], cwd: string, timeoutMs?: number) => Promise<ProcessRunResult | undefined>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  /**
   * A short folder of the mod's own to check tools from. Run from a project folder, a tool can
   * fail to start for reasons of that folder (a Windows path past 260 characters), which must not
   * read as the tool missing.
   */
  toolDir: string
}

export type Outcome =
  | { kind: 'skip'; reason: string }
  | { kind: 'ok' }
  | { kind: 'added'; message: string }
  | { kind: 'warn'; message: string }

/** The two hook managers secret-guard sets up outside JS/TS projects. */
export type Manager = 'pre-commit' | 'lefthook'

export type GuardOptions = {
  autoInstallHusky: boolean
  /** The manager the user picked with /secret-guard-use, if any. */
  preferredManager?: Manager
}

const MARK = '# secret-guard'

export const PREPARE_SCRIPT = 'husky || true'

/** Husky 8 and older are turned on with `husky install`; run bare, they only print their help. */
const LEGACY_PREPARE_SCRIPT = 'husky install || true'

/** What Husky 8's `husky add` writes ahead of a new hook's commands. */
const LEGACY_HUSKY_HEADER = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\n'

const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml'
const HUSKY_HOOK = '.husky/pre-commit'
const LEFTHOOK_CONFIG = 'lefthook.yml'

/** Every main config name Lefthook reads, relative to the repository root. */
const LEFTHOOK_CONFIGS = ['yml', 'yaml', 'toml', 'json', 'jsonc'].flatMap(ext => [
  `lefthook.${ext}`,
  `.lefthook.${ext}`,
  `.config/lefthook.${ext}`,
])

/** Whether `path` (relative to the repository root) is committed or staged. */
async function isTracked(host: Host, root: string, path: string): Promise<boolean> {
  return succeeded(await host.run(['git', 'ls-files', '--error-unmatch', '--', path], root))
}

/**
 * An uncommitted hook file exists only in this folder: other worktrees and fresh clones lack it.
 * The commands are named one by one: Windows PowerShell 5.1 rejects `&&`. `between` is a command
 * to run after the add.
 */
const commitHint = (path: string, between?: string): string =>
  ` Commit ${path} so other worktrees and clones get it: git add ${path}, then ${between === undefined ? '' : `${between}, then `}git commit`

export function hostFrom($: EngineInterface): Host {
  return {
    run: async (argv, cwd, timeoutMs = 30_000) => {
      try {
        return await $.process.run(argv, { cwd, timeoutMs })
      } catch {
        return undefined
      }
    },
    exists: path => $.fs.exists(path),
    read: async path => (await $.fs.read(path)) as string,
    write: (path, text) => $.fs.write(path, text),
    toolDir: $.plugin.root,
  }
}

const succeeded = (r: ProcessRunResult | undefined): r is ProcessRunResult =>
  r !== undefined && r.exitCode === 0

const failure = (r: ProcessRunResult | undefined): string =>
  (r === undefined ? 'could not run' : r.stderr || r.stdout || `exit ${r.exitCode}`).trim().slice(0, 300)

/**
 * A file's text, or undefined when it is missing or cannot be read. Claude Code refuses some paths
 * (a network location, a device) by throwing rather than answering false, and one such path must
 * not stop the whole check.
 */
async function readText(host: Host, path: string): Promise<string | undefined> {
  try {
    return (await host.exists(path)) ? await host.read(path) : undefined
  } catch {
    return undefined
  }
}

/** Whether a file exists, false when Claude Code refuses to look at the path. */
async function fileExists(host: Host, path: string): Promise<boolean> {
  try {
    return await host.exists(path)
  } catch {
    return false
  }
}

/** Whether a hook manager's command is installed and runs, checked from the mod's own folder. */
export async function isInstalled(host: Host, manager: Manager): Promise<boolean> {
  return succeeded(await runManager(host, manager, manager === 'lefthook' ? ['version'] : ['--version'], host.toolDir))
}

/**
 * Runs a hook manager. On Windows, Lefthook installed with `npm install -g` is a `.cmd` launcher
 * that a process cannot start without a shell, so a run that could not start is tried again through cmd.
 */
async function runManager(
  host: Host,
  manager: Manager,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<ProcessRunResult | undefined> {
  const argv = [manager, ...args]
  const direct = await host.run(argv, cwd, timeoutMs)
  if (direct !== undefined || manager !== 'lefthook' || !isWindows(host)) return direct
  return host.run(['cmd', '/d', '/s', '/c', ...argv], cwd, timeoutMs)
}

/** Where `cwd` stands: in a repository, outside any, or in a folder where commands cannot start. */
export type Location = { kind: 'repo'; root: string } | { kind: 'none' } | { kind: 'unreachable' }

export async function locateProject(host: Host, cwd: string): Promise<Location> {
  const top = await host.run(['git', 'rev-parse', '--show-toplevel'], cwd)
  if (top === undefined) {
    // git could not start here: either it is missing, or this folder stops it starting.
    const git = await host.run(['git', '--version'], host.toolDir)
    return succeeded(git) ? { kind: 'unreachable' } : { kind: 'none' }
  }
  return top.exitCode === 0 ? { kind: 'repo', root: top.stdout.trim() } : { kind: 'none' }
}

export const UNREACHABLE =
  'secret-guard could not run commands in this folder, so this project is not protected. On Windows this happens when the folder path is longer than about 260 characters; move the project to a shorter path.'

/** gitleaks 8.19 introduced `gitleaks git`; older releases only have `protect`. */
export function scanCommand(versionOutput: string): string {
  const m = /(\d+)\.(\d+)/.exec(versionOutput)
  const isLegacy = m !== null && (Number(m[1]) < 8 || (Number(m[1]) === 8 && Number(m[2]) < 19))
  return isLegacy
    ? 'gitleaks protect --staged --redact --verbose'
    : 'gitleaks git --pre-commit --redact --staged --verbose'
}

export function preCommitConfig(scan: string): string {
  return `${MARK}: scan staged changes with the installed gitleaks before each commit
repos:
  - repo: local
    hooks:
      - id: gitleaks
        name: gitleaks
        entry: ${scan}
        language: system
        pass_filenames: false
`
}

export function lefthookConfig(scan: string): string {
  return `${MARK}: scan staged changes with the installed gitleaks before each commit
pre-commit:
  commands:
    gitleaks:
      run: ${scan}
`
}

export function huskyBlock(scan: string): string {
  return `${MARK}: scan staged changes for secrets before each commit
if command -v gitleaks >/dev/null 2>&1; then
  ${scan} || exit 1
else
  echo "gitleaks is not installed; skipping the secret scan (install: https://github.com/gitleaks/gitleaks#installing)" >&2
fi
`
}

/**
 * Puts the block right after the hook's shebang, so it runs before any other command (an exit
 * included). The block takes the file's own line endings, so a CRLF file stays CRLF throughout.
 */
export function prependBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === '') return block
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const text = block.replace(/\r?\n/g, eol)
  if (!existing.startsWith('#!')) return `${text}${existing}`
  const lineEnd = existing.indexOf('\n')
  if (lineEnd < 0) return `${existing}${eol}${text}`
  return `${existing.slice(0, lineEnd + 1)}${text}${existing.slice(lineEnd + 1)}`
}

type PackageManager = { name: string; add: string[] }

async function packageManager(host: Host, root: string): Promise<PackageManager> {
  if (await fileExists(host, `${root}/pnpm-lock.yaml`)) {
    // pnpm refuses to add to a workspace root unless -w is given.
    const workspaceRoot = (await fileExists(host, `${root}/pnpm-workspace.yaml`)) ? ['-w'] : []
    return { name: 'pnpm', add: ['pnpm', 'add', ...workspaceRoot, '-D', 'husky'] }
  }
  if (await fileExists(host, `${root}/yarn.lock`)) return { name: 'yarn', add: ['yarn', 'add', '-D', 'husky'] }
  if ((await fileExists(host, `${root}/bun.lockb`)) || (await fileExists(host, `${root}/bun.lock`))) {
    return { name: 'bun', add: ['bun', 'add', '-d', 'husky'] }
  }
  return { name: 'npm', add: ['npm', 'install', '--save-dev', 'husky'] }
}

/**
 * The core.hooksPath set in the project's own config files (local, worktree, global, system), from
 * `git config --show-scope --get-all` output. Claude Code runs a mod's git with
 * `-c core.hooksPath=/dev/null`, which shows up with the `command` scope and applies only to that
 * one call, so it is ignored.
 */
export function configuredHooksPath(showScopeOutput: string): string | undefined {
  let found: string | undefined
  for (const line of showScopeOutput.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const scope = line.slice(0, tab)
    const value = line.slice(tab + 1).trim()
    if (scope !== 'command' && value !== '') found = value
  }
  return found
}

async function hooksPathSetting(host: Host, root: string): Promise<string | undefined> {
  const r = await host.run(['git', 'config', '--show-scope', '--get-all', 'core.hooksPath'], root)
  return succeeded(r) ? configuredHooksPath(r.stdout) : undefined
}

/**
 * The pre-commit hook in the repository's shared hooks folder, which worktrees and the main
 * checkout share. Found from `--git-common-dir`, not `--git-path hooks/pre-commit`: the latter
 * follows core.hooksPath, which Claude Code sets to the null device for a mod's git, and so names
 * `/dev/null/pre-commit` or `\\.\NUL\pre-commit` instead of the real hook. A project that sets
 * core.hooksPath itself never gets here: both managers stop on it first.
 */
async function installedHook(host: Host, root: string): Promise<string | undefined> {
  const commonDir = await host.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], root)
  return succeeded(commonDir) ? readText(host, `${commonDir.stdout.trim()}/hooks/pre-commit`) : undefined
}

const isPreCommitHook = (hook: string | undefined): boolean => hook !== undefined && /generated by pre-commit/i.test(hook)
const isLefthookHook = (hook: string | undefined): boolean => hook !== undefined && /lefthook/.test(hook)

async function ensurePreCommit(host: Host, root: string, scan: string): Promise<Outcome> {
  if (!(await isInstalled(host, 'pre-commit'))) {
    return { kind: 'skip', reason: 'pre-commit is not installed' }
  }

  const configPath = `${root}/${PRE_COMMIT_CONFIG}`
  const config = await readText(host, configPath)
  if (config !== undefined && !/gitleaks/.test(config)) {
    return {
      kind: 'warn',
      message: `${PRE_COMMIT_CONFIG} has no gitleaks hook. It was left as it is; add the hook yourself.`,
    }
  }

  const hooksPath = await hooksPathSetting(host, root)
  if (hooksPath !== undefined) {
    return {
      kind: 'warn',
      message: `core.hooksPath is set to ${hooksPath}, so pre-commit install would refuse to run. Nothing was changed.`,
    }
  }

  const isHookInstalled = isPreCommitHook(await installedHook(host, root))
  if (config !== undefined && isHookInstalled) {
    return (await isTracked(host, root, PRE_COMMIT_CONFIG))
      ? { kind: 'ok' }
      : { kind: 'warn', message: `${PRE_COMMIT_CONFIG} is not committed.${commitHint(PRE_COMMIT_CONFIG)}` }
  }

  if (config === undefined) await host.write(configPath, preCommitConfig(scan))

  if (!isHookInstalled) {
    const install = await host.run(['pre-commit', 'install'], root, 60_000)
    if (!succeeded(install)) {
      return { kind: 'warn', message: `pre-commit install failed: ${failure(install)}` }
    }
  }
  const done = config !== undefined
    ? 'Ran pre-commit install. The gitleaks hook is active.'
    : isHookInstalled
      ? `The pre-commit hook was installed but ${PRE_COMMIT_CONFIG} was missing, so commits were blocked. Created it with gitleaks.`
      : `Created ${PRE_COMMIT_CONFIG} (gitleaks) and ran pre-commit install.`
  const hint = (await isTracked(host, root, PRE_COMMIT_CONFIG)) ? '' : commitHint(PRE_COMMIT_CONFIG)
  return { kind: 'added', message: `${done}${hint}` }
}

async function ensureLefthook(host: Host, root: string, scan: string, existing: string | undefined): Promise<Outcome> {
  if (!(await isInstalled(host, 'lefthook'))) {
    return existing === undefined
      ? { kind: 'skip', reason: 'lefthook is not installed' }
      : {
          kind: 'warn',
          message: `This project uses Lefthook (${existing}), but lefthook is not installed. Install it, then run lefthook install.`,
        }
  }

  const file = existing ?? LEFTHOOK_CONFIG
  const configPath = `${root}/${file}`
  const config = existing === undefined ? undefined : await readText(host, configPath)
  // Never write over a config that is there but could not be read.
  if (existing !== undefined && config === undefined) {
    return { kind: 'warn', message: `${file} could not be read. Nothing was changed.` }
  }
  if (config !== undefined && !/gitleaks/.test(config)) {
    return {
      kind: 'warn',
      message: `${file} has no gitleaks command. It was left as it is; add one under pre-commit yourself.`,
    }
  }

  const hooksPath = await hooksPathSetting(host, root)
  if (hooksPath !== undefined) {
    return {
      kind: 'warn',
      message: `core.hooksPath is set to ${hooksPath}, so Lefthook would install its hooks there. Nothing was changed.`,
    }
  }

  const isHookInstalled = isLefthookHook(await installedHook(host, root))
  if (config !== undefined && isHookInstalled) {
    return (await isTracked(host, root, file))
      ? { kind: 'ok' }
      : { kind: 'warn', message: `${file} is not committed.${commitHint(file)}` }
  }

  // Written before lefthook install, which otherwise creates an empty lefthook.yml of its own.
  if (config === undefined) await host.write(configPath, lefthookConfig(scan))

  if (!isHookInstalled) {
    const install = await runManager(host, 'lefthook', ['install'], root, 60_000)
    if (!succeeded(install)) {
      return { kind: 'warn', message: `lefthook install failed: ${failure(install)}` }
    }
  }
  const done = config !== undefined
    ? 'Ran lefthook install. The gitleaks command is active.'
    : isHookInstalled
      ? `The Lefthook hook was installed but ${file} was missing, so commits ran without a secret scan. Created it with gitleaks.`
      : `Created ${file} (gitleaks) and ran lefthook install.`
  const hint = (await isTracked(host, root, file)) ? '' : commitHint(file)
  return { kind: 'added', message: `${done}${hint}` }
}

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

async function ensureHusky(host: Host, root: string, scan: string, options: GuardOptions): Promise<Outcome> {
  const hookPath = `${root}/${HUSKY_HOOK}`
  const hook = await readText(host, hookPath)
  const hooksPath = await hooksPathSetting(host, root)
  const isHuskyActive = hooksPath !== undefined && /\.husky/.test(hooksPath)

  if (hook !== undefined && /gitleaks/.test(hook)) {
    if (isHuskyActive) {
      return (await isTracked(host, root, HUSKY_HOOK))
        ? { kind: 'ok' }
        : { kind: 'warn', message: `${HUSKY_HOOK} is not committed.${commitHint(HUSKY_HOOK)}` }
    }
    return {
      kind: 'warn',
      message: '.husky/pre-commit already runs gitleaks, but Husky is not active. Run the project install, which runs the prepare script.',
    }
  }

  let pkg: PackageJson
  try {
    pkg = parseJson(await host.read(`${root}/package.json`)) as PackageJson
  } catch {
    return { kind: 'warn', message: 'package.json could not be parsed. Nothing was changed.' }
  }

  const pm = await packageManager(host, root)
  const hasHusky = hasHuskyDependency(pkg)
  if (!hasHusky) {
    if (!options.autoInstallHusky) {
      return {
        kind: 'warn',
        message: `This JS/TS project has no Husky. Run \`${pm.add.join(' ')}\`, or turn on secret-guard's Auto-install Husky option.`,
      }
    }
    const added = await runPackageManager(host, pm.add, root, 600_000)
    if (!succeeded(added)) {
      return { kind: 'warn', message: `Installing Husky with ${pm.name} failed: ${failure(added)}` }
    }
  }

  // The installed version, else the one package.json asks for (node_modules may not be installed yet).
  const husky = await huskyPackage(host, root)
  const major = husky.major ?? declaredMajor(pkg.devDependencies?.husky ?? pkg.dependencies?.husky)
  const isLegacy = major !== undefined && major < 9

  const prepare = pkg.scripts?.prepare
  if (prepare === undefined) {
    // `|| true`: installs without dev dependencies (npm ci --omit=dev, Docker) have no husky, and prepare must not fail them.
    // Read again: installing Husky above has just changed package.json.
    const updated = withPrepareScript(await host.read(`${root}/package.json`), isLegacy ? LEGACY_PREPARE_SCRIPT : PREPARE_SCRIPT)
    if (updated === undefined) return { kind: 'warn', message: 'package.json could not be parsed. Nothing was changed.' }
    await host.write(`${root}/package.json`, updated)
  }

  // Husky 9 runs each hook with sh. Husky 8 has git run it, and git skips a hook without a shebang
  // (Git for Windows) or without the executable bit (macOS, Linux), so a new one gets both.
  const isNewLegacyHook = isLegacy && (hook === undefined || hook.trim() === '')
  await host.write(hookPath, isNewLegacyHook ? `${LEGACY_HUSKY_HEADER}${huskyBlock(scan)}` : prependBlock(hook, huskyBlock(scan)))
  const isChmodFailed = isNewLegacyHook && !isWindows(host) && !succeeded(await host.run(['chmod', '+x', hookPath], root))

  if (!isHuskyActive) {
    const activated = husky.entry === undefined ? undefined : await host.run(['node', husky.entry, ...(isLegacy ? ['install'] : [])], root)
    if (activated === undefined) {
      return {
        kind: 'warn',
        message: 'Wrote .husky/pre-commit, but could not turn Husky on (are node_modules installed?). Run the project install.',
      }
    }
    if (!isHuskyOn(activated, isLegacy)) {
      return { kind: 'warn', message: `Wrote .husky/pre-commit, but Husky did not turn on: ${failure(activated)}` }
    }
  }

  const notes = [
    hasHusky ? undefined : `Installed Husky with ${pm.name}`,
    prepare === undefined
      ? 'added a prepare script'
      : /husky/.test(prepare) ? undefined : `the prepare script does not run husky (${prepare}), so teammates must turn it on after cloning`,
    'added gitleaks to .husky/pre-commit',
    isChmodFailed ? `it is not executable, so git skips it: run chmod +x ${HUSKY_HOOK}` : undefined,
  ].filter((n): n is string => n !== undefined)
  const sentence = notes.join('; ')
  // Git for Windows records a new file as not executable, so macOS and Linux clones would skip the hook.
  const chmodInIndex = isNewLegacyHook && isWindows(host) ? `git update-index --chmod=+x ${HUSKY_HOOK}` : undefined
  const hint = (await isTracked(host, root, HUSKY_HOOK)) ? '' : commitHint(HUSKY_HOOK, chmodInIndex)
  return { kind: 'added', message: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.${hint}` }
}

const BOM = '\uFEFF'

/** JSON.parse that accepts a leading byte order mark, which Windows PowerShell 5.1 writes. */
const parseJson = (text: string): unknown => JSON.parse(text.startsWith(BOM) ? text.slice(1) : text)

/**
 * Whether running Husky turned it on. Husky 9 prints why it did not (`HUSKY=0 skip install`,
 * `.git can't be found`) and still exits 0, and prints nothing when it did. Husky 8 says
 * `Git hooks installed`, and also exits 0 when it skipped.
 */
const isHuskyOn = (r: ProcessRunResult, isLegacy: boolean): boolean =>
  r.exitCode === 0 && (isLegacy ? /Git hooks installed/.test(r.stdout) : r.stdout.trim() === '')

/** The major version a dependency range starts at (`^8.0.3` is 8), or undefined for any other form. */
function declaredMajor(range: string | undefined): number | undefined {
  const m = /^[\^~=v]*(\d+)/.exec(range?.trim() ?? '')
  return m === null ? undefined : Number(m[1])
}

/**
 * package.json with `scripts.prepare` set to `script`, keeping its byte order mark, indentation,
 * key order, line endings and final newline; undefined when it is not a JSON object. Written by
 * the mod itself rather than through `npm pkg set`, which on Windows is a `.cmd` launcher.
 */
export function withPrepareScript(text: string, script: string = PREPARE_SCRIPT): string | undefined {
  let data: unknown
  try {
    data = parseJson(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const manifest = data as Record<string, unknown>
  const scripts = typeof manifest.scripts === 'object' && manifest.scripts !== null ? manifest.scripts : {}
  manifest.scripts = { ...scripts, prepare: script }
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const bom = text.startsWith(BOM) ? BOM : ''
  const body = `${bom}${JSON.stringify(manifest, null, indent).replace(/\n/g, eol)}`
  return /\r?\n$/.test(text) ? `${body}${eol}` : body
}

/**
 * Runs a Node package manager. On Windows npm, pnpm and yarn are `.cmd` launchers that a process
 * cannot start without a shell, so a run that could not start is tried again through cmd.
 */
async function runPackageManager(
  host: Host,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessRunResult | undefined> {
  return (await host.run(argv, cwd, timeoutMs)) ?? host.run(['cmd', '/d', '/s', '/c', ...argv], cwd, timeoutMs)
}

const hasHuskyDependency = (pkg: PackageJson): boolean =>
  pkg.devDependencies?.husky !== undefined || pkg.dependencies?.husky !== undefined

async function readPackageJson(host: Host, root: string): Promise<PackageJson | undefined> {
  try {
    return parseJson(await host.read(`${root}/package.json`)) as PackageJson
  } catch {
    return undefined
  }
}

async function findLefthookConfig(host: Host, root: string): Promise<string | undefined> {
  for (const name of LEFTHOOK_CONFIGS) {
    if (await fileExists(host, `${root}/${name}`)) return name
  }
  return undefined
}

/**
 * The installed Husky: the script its package names as its `husky` command, run with `node`, and
 * its major version. Going through the package rather than `node_modules/.bin/husky` works on
 * Windows too, where that is a `.cmd` launcher a process cannot start without a shell.
 */
async function huskyPackage(host: Host, root: string): Promise<{ entry?: string; major?: number }> {
  const manifest = await readText(host, `${root}/node_modules/husky/package.json`)
  if (manifest === undefined) return {}
  try {
    const data = parseJson(manifest) as { bin?: string | Record<string, string>; version?: string }
    const entry = typeof data.bin === 'string' ? data.bin : data.bin?.husky
    const major = typeof data.version === 'string' ? declaredMajor(data.version) : undefined
    return {
      entry: entry === undefined ? undefined : `${root}/node_modules/husky/${entry.replace(/^\.\//, '')}`,
      major,
    }
  } catch {
    return {}
  }
}

/** A config secret-guard wrote itself, which it may replace when the user picks the other manager. */
const isOwn = (config: string | undefined): boolean => config !== undefined && config.startsWith(MARK)

/** Removes the other manager's hook before switching, while that manager is still installed. */
async function uninstallHook(host: Host, root: string, manager: Manager): Promise<void> {
  const hook = await installedHook(host, root)
  const isTheirs = manager === 'lefthook' ? isLefthookHook(hook) : isPreCommitHook(hook)
  if (isTheirs && (await isInstalled(host, manager))) await runManager(host, manager, ['uninstall'], root, 60_000)
}

const configName = (manager: Manager, lefthookFile: string | undefined): string =>
  manager === 'lefthook' ? (lefthookFile ?? LEFTHOOK_CONFIG) : PRE_COMMIT_CONFIG

/** Adds a note to an outcome, ahead of any commit hint so the `git add` command stays last. */
function withNote(outcome: Outcome, note: string | undefined): Outcome {
  if (note === undefined || outcome.kind === 'skip') return outcome
  if (outcome.kind === 'ok') return { kind: 'warn', message: note }
  const hintAt = outcome.message.indexOf(' Commit ')
  const message = hintAt < 0
    ? `${outcome.message} ${note}`
    : `${outcome.message.slice(0, hintAt)} ${note}${outcome.message.slice(hintAt)}`
  return { ...outcome, message }
}

export async function ensureGuard(host: Host, cwd: string, options: GuardOptions): Promise<Outcome> {
  const gitleaks = await host.run(['gitleaks', 'version'], host.toolDir)
  if (!succeeded(gitleaks)) return { kind: 'skip', reason: 'gitleaks is not installed' }

  const location = await locateProject(host, cwd)
  if (location.kind === 'unreachable') return { kind: 'warn', message: UNREACHABLE }
  if (location.kind === 'none') return { kind: 'skip', reason: 'not a Git repository' }
  const root = location.root

  const scan = scanCommand(gitleaks.stdout)
  const lefthookFile = await findLefthookConfig(host, root)
  const lefthookText = lefthookFile === undefined ? undefined : await readText(host, `${root}/${lefthookFile}`)
  const preCommitText = await readText(host, `${root}/${PRE_COMMIT_CONFIG}`)
  const available: Record<Manager, boolean> = {
    'pre-commit': await isInstalled(host, 'pre-commit'),
    lefthook: await isInstalled(host, 'lefthook'),
  }
  // A pick only counts while that manager is installed; otherwise projects keep what they have.
  const preferred = options.preferredManager !== undefined && available[options.preferredManager]
    ? options.preferredManager
    : undefined

  // A project that already has a hook config keeps its manager, unless secret-guard wrote that
  // config itself and the user picked the other manager.
  let manager: Manager | 'husky' | undefined
  let note: string | undefined
  if (lefthookFile !== undefined && preCommitText !== undefined) {
    manager = preferred ?? (available.lefthook || !available['pre-commit'] ? 'lefthook' : 'pre-commit')
    const other = manager === 'lefthook' ? PRE_COMMIT_CONFIG : lefthookFile
    note = `This project has both ${lefthookFile} and ${PRE_COMMIT_CONFIG}; secret-guard used ${manager}. Keep one and delete ${other}.`
  } else if (lefthookFile !== undefined) {
    manager = preferred === 'pre-commit' && isOwn(lefthookText) ? 'pre-commit' : 'lefthook'
  } else if (preCommitText !== undefined) {
    manager = preferred === 'lefthook' && isOwn(preCommitText) ? 'lefthook' : 'pre-commit'
  } else {
    const pkg = await readPackageJson(host, root)
    const isJs = await fileExists(host, `${root}/package.json`)
    const usesHusky = pkg !== undefined && hasHuskyDependency(pkg)
    if (isJs && (usesHusky || options.autoInstallHusky || !available.lefthook || preferred === 'pre-commit')) {
      manager = 'husky'
    } else if (isJs) {
      manager = 'lefthook' // a global binary: no dependency to add to the project
    } else {
      manager = preferred ?? (available['pre-commit'] ? 'pre-commit' : available.lefthook ? 'lefthook' : undefined)
    }
  }

  if (manager === undefined) return { kind: 'skip', reason: 'neither pre-commit nor lefthook is installed' }
  if (manager === 'husky') return ensureHusky(host, root, scan, options)

  // Switching away from a config secret-guard wrote: remove the old manager's hook first.
  const switchedFrom: Manager | undefined =
    manager === 'lefthook' && isOwn(preCommitText) && lefthookFile === undefined ? 'pre-commit'
      : manager === 'pre-commit' && isOwn(lefthookText) && preCommitText === undefined ? 'lefthook'
        : undefined
  if (switchedFrom !== undefined) {
    await uninstallHook(host, root, switchedFrom)
    note = `Switched this project from ${switchedFrom} to ${manager}; delete ${configName(switchedFrom, lefthookFile)}, which secret-guard wrote.`
  }

  const outcome = manager === 'lefthook'
    ? await ensureLefthook(host, root, scan, switchedFrom === 'lefthook' ? undefined : lefthookFile)
    : await ensurePreCommit(host, root, scan)
  return withNote(outcome, note)
}

/** Shown once per session when both managers are installed and the user has not picked one. */
export const BOTH_INSTALLED =
  'Both pre-commit and Lefthook are installed. Pick one hook manager with /secret-guard-use pre-commit or /secret-guard-use lefthook; secret-guard can then help remove the other.'

/** How each manager is removed by hand, listed for the platform first: Homebrew does not exist on Windows. */
const REMOVE_BY_HAND: Record<'unix' | 'windows', Record<Manager, string>> = {
  unix: {
    'pre-commit': 'brew uninstall pre-commit, uv tool uninstall pre-commit, pipx uninstall pre-commit or pip uninstall pre-commit',
    lefthook: 'brew uninstall lefthook or npm uninstall -g lefthook',
  },
  windows: {
    'pre-commit': 'uv tool uninstall pre-commit, pipx uninstall pre-commit or pip uninstall pre-commit',
    lefthook: 'scoop uninstall lefthook, winget uninstall evilmartians.lefthook or npm uninstall -g lefthook',
  },
}

/** Whether the mod runs on Windows, told from its own folder's path (a drive letter, or backslashes). */
export const isWindows = (host: Host): boolean => /^[A-Za-z]:[\\/]/.test(host.toolDir) || host.toolDir.includes('\\')

export const other = (manager: Manager): Manager => (manager === 'lefthook' ? 'pre-commit' : 'lefthook')

export function parseUseArgs(args: string): { manager: Manager; removeOther: boolean } | undefined {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const manager = words.find(w => w === 'pre-commit' || w === 'lefthook') as Manager | undefined
  const rest = words.filter(w => w !== manager)
  if (manager === undefined || rest.some(w => w !== '--remove-other')) return undefined
  return { manager, removeOther: rest.includes('--remove-other') }
}

/** How each manager is installed, listed for the platform first. */
const INSTALL: Record<'unix' | 'windows', Record<Manager, string>> = {
  unix: {
    'pre-commit': 'brew install pre-commit, uv tool install pre-commit or pipx install pre-commit',
    lefthook: 'brew install lefthook or npm install -g lefthook',
  },
  windows: {
    'pre-commit': 'uv tool install pre-commit, pipx install pre-commit or pip install pre-commit',
    lefthook: 'scoop install lefthook, winget install evilmartians.lefthook or npm install -g lefthook',
  },
}

/**
 * Why a pick of a manager that is not installed is refused. Kept, it would not count (a pick
 * only counts while installed), and with --remove-other it would uninstall the only manager left.
 */
export function notInstalledPick(host: Host, manager: Manager): string {
  const ways = INSTALL[isWindows(host) ? 'windows' : 'unix'][manager]
  return `${manager} is not installed, so the pick was not kept and nothing was changed. Install it with one of: ${ways}; then run /secret-guard-use ${manager} again.`
}

export const USE_USAGE =
  'Usage: /secret-guard-use pre-commit|lefthook [--remove-other]. Picks the hook manager secret-guard sets up; --remove-other then uninstalls the other one.'

/**
 * Removes the manager the user did not pick from this machine: with Homebrew when it was installed
 * that way, otherwise says how to remove it by hand.
 */
export async function removeManager(host: Host, manager: Manager): Promise<string> {
  if (!(await isInstalled(host, manager))) return `${manager} is not installed, so there is nothing to remove.`
  const cwd = host.toolDir
  if (isWindows(host)) {
    return `${manager} was left in place: on Windows secret-guard does not uninstall tools itself. Remove it with one of: ${REMOVE_BY_HAND.windows[manager]}.`
  }
  const brew = await host.run(['brew', 'list', '--versions', manager], cwd)
  if (!succeeded(brew) || brew.stdout.trim() === '') {
    return `${manager} was not installed with Homebrew, so it was left in place. Remove it with one of: ${REMOVE_BY_HAND.unix[manager]}.`
  }
  const removed = await host.run(['brew', 'uninstall', manager], cwd, 300_000)
  return succeeded(removed)
    ? `Removed ${manager} with Homebrew.`
    : `brew uninstall ${manager} failed: ${failure(removed)}`
}

/** What happens to other repositories once a manager is removed, said before the user confirms. */
export function removalWarning(manager: Manager, picked: Manager): string {
  return `${manager} is still installed. Hooks it installed in other repositories may fail or stop scanning once it is removed. Open a Claude session in each of them first: secret-guard switches the ones it set up to ${picked}, and tells you about the rest. When ready, run /secret-guard-use ${picked} --remove-other.`
}
