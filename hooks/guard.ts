import type { EngineInterface, ProcessRunResult } from 'claude-code'

/** What the mod needs from the host: built from `$` in register, an in-memory fake in tests. */
export type Host = {
  /** Resolves undefined when the command cannot start (not installed) or times out. */
  run: (argv: readonly string[], cwd: string, timeoutMs?: number) => Promise<ProcessRunResult | undefined>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
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

/** An uncommitted hook file exists only in this folder: other worktrees and fresh clones lack it. */
const commitHint = (path: string): string =>
  ` Commit ${path} so other worktrees and clones get it: git add ${path} && git commit`

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
  }
}

const succeeded = (r: ProcessRunResult | undefined): r is ProcessRunResult =>
  r !== undefined && r.exitCode === 0

const failure = (r: ProcessRunResult | undefined): string =>
  (r === undefined ? 'could not run' : r.stderr || r.stdout || `exit ${r.exitCode}`).trim().slice(0, 300)

async function readText(host: Host, path: string): Promise<string | undefined> {
  return (await host.exists(path)) ? host.read(path) : undefined
}

/** Whether a hook manager's command is installed and runs. */
export async function isInstalled(host: Host, manager: Manager, cwd: string): Promise<boolean> {
  return succeeded(await host.run(manager === 'lefthook' ? ['lefthook', 'version'] : ['pre-commit', '--version'], cwd))
}

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
  echo "gitleaks is not installed; skipping the secret scan (brew install gitleaks)" >&2
fi
`
}

/** Puts the block right after the hook's shebang, so it runs before any other command (an exit included). */
export function prependBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim() === '') return block
  const lines = existing.split('\n')
  if (lines[0]?.startsWith('#!')) {
    return [lines[0], block.trimEnd(), ...lines.slice(1)].join('\n')
  }
  return `${block}${existing}`
}

type PackageManager = { name: string; add: string[] }

async function packageManager(host: Host, root: string): Promise<PackageManager> {
  if (await host.exists(`${root}/pnpm-lock.yaml`)) {
    // pnpm refuses to add to a workspace root unless -w is given.
    const workspaceRoot = (await host.exists(`${root}/pnpm-workspace.yaml`)) ? ['-w'] : []
    return { name: 'pnpm', add: ['pnpm', 'add', ...workspaceRoot, '-D', 'husky'] }
  }
  if (await host.exists(`${root}/yarn.lock`)) return { name: 'yarn', add: ['yarn', 'add', '-D', 'husky'] }
  if ((await host.exists(`${root}/bun.lockb`)) || (await host.exists(`${root}/bun.lock`))) {
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

/** The pre-commit hook in the repository's shared hooks folder, which worktrees and the main checkout share. */
async function installedHook(host: Host, root: string): Promise<string | undefined> {
  const hookFile = await host.run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'], root)
  return succeeded(hookFile) ? readText(host, hookFile.stdout.trim()) : undefined
}

const isPreCommitHook = (hook: string | undefined): boolean => hook !== undefined && /generated by pre-commit/i.test(hook)
const isLefthookHook = (hook: string | undefined): boolean => hook !== undefined && /lefthook/.test(hook)

async function ensurePreCommit(host: Host, root: string, scan: string): Promise<Outcome> {
  if (!(await isInstalled(host, 'pre-commit', root))) {
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
  if (!(await isInstalled(host, 'lefthook', root))) {
    return existing === undefined
      ? { kind: 'skip', reason: 'lefthook is not installed' }
      : {
          kind: 'warn',
          message: `This project uses Lefthook (${existing}), but lefthook is not installed. Install it, then run lefthook install.`,
        }
  }

  const file = existing ?? LEFTHOOK_CONFIG
  const configPath = `${root}/${file}`
  const config = existing === undefined ? undefined : await host.read(configPath)
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
    const install = await host.run(['lefthook', 'install'], root, 60_000)
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
    pkg = JSON.parse(await host.read(`${root}/package.json`)) as PackageJson
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
    const added = await host.run(pm.add, root, 600_000)
    if (!succeeded(added)) {
      return { kind: 'warn', message: `Installing Husky with ${pm.name} failed: ${failure(added)}` }
    }
  }

  const prepare = pkg.scripts?.prepare
  if (prepare === undefined) {
    // `|| true`: installs without dev dependencies (npm ci --omit=dev, Docker) have no husky, and prepare must not fail them.
    await host.run(['npm', 'pkg', 'set', `scripts.prepare=${PREPARE_SCRIPT}`], root)
  }

  await host.write(hookPath, prependBlock(hook, huskyBlock(scan)))

  if (!isHuskyActive) {
    const activated = await host.run([`${root}/node_modules/.bin/husky`], root)
    if (!succeeded(activated)) {
      return {
        kind: 'warn',
        message: 'Wrote .husky/pre-commit, but could not turn Husky on (are node_modules installed?). Run the project install.',
      }
    }
  }

  const notes = [
    hasHusky ? undefined : `Installed Husky with ${pm.name}`,
    prepare === undefined
      ? 'added a prepare script'
      : /husky/.test(prepare) ? undefined : `the prepare script does not run husky (${prepare}), so teammates must turn it on after cloning`,
    'added gitleaks to .husky/pre-commit',
  ].filter((n): n is string => n !== undefined)
  const sentence = notes.join('; ')
  const hint = (await isTracked(host, root, HUSKY_HOOK)) ? '' : commitHint(HUSKY_HOOK)
  return { kind: 'added', message: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.${hint}` }
}

const hasHuskyDependency = (pkg: PackageJson): boolean =>
  pkg.devDependencies?.husky !== undefined || pkg.dependencies?.husky !== undefined

async function readPackageJson(host: Host, root: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await host.read(`${root}/package.json`)) as PackageJson
  } catch {
    return undefined
  }
}

async function findLefthookConfig(host: Host, root: string): Promise<string | undefined> {
  for (const name of LEFTHOOK_CONFIGS) {
    if (await host.exists(`${root}/${name}`)) return name
  }
  return undefined
}

/** The repository root for `cwd`, or undefined outside a Git repository. */
export async function projectRoot(host: Host, cwd: string): Promise<string | undefined> {
  const top = await host.run(['git', 'rev-parse', '--show-toplevel'], cwd)
  return succeeded(top) ? top.stdout.trim() : undefined
}

/** A config secret-guard wrote itself, which it may replace when the user picks the other manager. */
const isOwn = (config: string | undefined): boolean => config !== undefined && config.startsWith(MARK)

/** Removes the other manager's hook before switching, while that manager is still installed. */
async function uninstallHook(host: Host, root: string, manager: Manager): Promise<void> {
  const hook = await installedHook(host, root)
  const isTheirs = manager === 'lefthook' ? isLefthookHook(hook) : isPreCommitHook(hook)
  if (isTheirs && (await isInstalled(host, manager, root))) await host.run([manager, 'uninstall'], root, 60_000)
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
  const gitleaks = await host.run(['gitleaks', 'version'], cwd)
  if (!succeeded(gitleaks)) return { kind: 'skip', reason: 'gitleaks is not installed' }

  const root = await projectRoot(host, cwd)
  if (root === undefined) return { kind: 'skip', reason: 'not a Git repository' }

  const scan = scanCommand(gitleaks.stdout)
  const lefthookFile = await findLefthookConfig(host, root)
  const lefthookText = lefthookFile === undefined ? undefined : await host.read(`${root}/${lefthookFile}`)
  const preCommitText = await readText(host, `${root}/${PRE_COMMIT_CONFIG}`)
  const available: Record<Manager, boolean> = {
    'pre-commit': await isInstalled(host, 'pre-commit', root),
    lefthook: await isInstalled(host, 'lefthook', root),
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
    const isJs = await host.exists(`${root}/package.json`)
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

const REMOVE_BY_HAND: Record<Manager, string> = {
  'pre-commit': 'brew uninstall pre-commit, pipx uninstall pre-commit or pip uninstall pre-commit',
  lefthook: 'brew uninstall lefthook, npm uninstall -g lefthook, scoop uninstall lefthook or winget uninstall evilmartians.lefthook',
}

export const other = (manager: Manager): Manager => (manager === 'lefthook' ? 'pre-commit' : 'lefthook')

export function parseUseArgs(args: string): { manager: Manager; removeOther: boolean } | undefined {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const manager = words.find(w => w === 'pre-commit' || w === 'lefthook') as Manager | undefined
  const rest = words.filter(w => w !== manager)
  if (manager === undefined || rest.some(w => w !== '--remove-other')) return undefined
  return { manager, removeOther: rest.includes('--remove-other') }
}

export const USE_USAGE =
  'Usage: /secret-guard-use pre-commit|lefthook [--remove-other]. Picks the hook manager secret-guard sets up; --remove-other then uninstalls the other one.'

/**
 * Removes the manager the user did not pick from this machine: with Homebrew when it was installed
 * that way, otherwise says how to remove it by hand.
 */
export async function removeManager(host: Host, manager: Manager, cwd: string): Promise<string> {
  if (!(await isInstalled(host, manager, cwd))) return `${manager} is not installed, so there is nothing to remove.`
  const brew = await host.run(['brew', 'list', '--versions', manager], cwd)
  if (!succeeded(brew) || brew.stdout.trim() === '') {
    return `${manager} was not installed with Homebrew, so it was left in place. Remove it with one of: ${REMOVE_BY_HAND[manager]}.`
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
