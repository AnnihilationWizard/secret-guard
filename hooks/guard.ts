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

export type GuardOptions = { autoInstallHusky: boolean }

const MARK = '# secret-guard'

export const PREPARE_SCRIPT = 'husky || true'

const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml'
const HUSKY_HOOK = '.husky/pre-commit'

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

async function ensurePreCommit(host: Host, root: string, scan: string): Promise<Outcome> {
  if (!succeeded(await host.run(['pre-commit', '--version'], root))) {
    return { kind: 'skip', reason: 'pre-commit is not installed' }
  }

  const configPath = `${root}/.pre-commit-config.yaml`
  const config = await readText(host, configPath)
  if (config !== undefined && !/gitleaks/.test(config)) {
    return {
      kind: 'warn',
      message: '.pre-commit-config.yaml has no gitleaks hook. It was left as it is; add the hook yourself.',
    }
  }

  const hooksPath = await hooksPathSetting(host, root)
  if (hooksPath !== undefined) {
    return {
      kind: 'warn',
      message: `core.hooksPath is set to ${hooksPath}, so pre-commit install would refuse to run. Nothing was changed.`,
    }
  }

  // The hook lives in the repository's shared hooks folder, so a worktree or clone can have it without the config.
  const hookFile = await host.run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'], root)
  const installed = succeeded(hookFile) ? await readText(host, hookFile.stdout.trim()) : undefined
  const isInstalled = installed !== undefined && /pre-commit/.test(installed)
  if (config !== undefined && isInstalled) {
    return (await isTracked(host, root, PRE_COMMIT_CONFIG))
      ? { kind: 'ok' }
      : { kind: 'warn', message: `${PRE_COMMIT_CONFIG} is not committed.${commitHint(PRE_COMMIT_CONFIG)}` }
  }

  if (config === undefined) await host.write(configPath, preCommitConfig(scan))

  if (!isInstalled) {
    const install = await host.run(['pre-commit', 'install'], root, 60_000)
    if (!succeeded(install)) {
      return { kind: 'warn', message: `pre-commit install failed: ${failure(install)}` }
    }
  }
  const done = config !== undefined
    ? 'Ran pre-commit install. The gitleaks hook is active.'
    : isInstalled
      ? `The pre-commit hook was installed but ${PRE_COMMIT_CONFIG} was missing, so commits were blocked. Created it with gitleaks.`
      : `Created ${PRE_COMMIT_CONFIG} (gitleaks) and ran pre-commit install.`
  const hint = (await isTracked(host, root, PRE_COMMIT_CONFIG)) ? '' : commitHint(PRE_COMMIT_CONFIG)
  return { kind: 'added', message: `${done}${hint}` }
}

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

async function ensureHusky(host: Host, root: string, scan: string, options: GuardOptions): Promise<Outcome> {
  const hookPath = `${root}/.husky/pre-commit`
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
  const hasHusky = pkg.devDependencies?.husky !== undefined || pkg.dependencies?.husky !== undefined
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

/** The repository root for `cwd`, or undefined outside a Git repository. */
export async function projectRoot(host: Host, cwd: string): Promise<string | undefined> {
  const top = await host.run(['git', 'rev-parse', '--show-toplevel'], cwd)
  return succeeded(top) ? top.stdout.trim() : undefined
}

export async function ensureGuard(host: Host, cwd: string, options: GuardOptions): Promise<Outcome> {
  const gitleaks = await host.run(['gitleaks', 'version'], cwd)
  if (!succeeded(gitleaks)) return { kind: 'skip', reason: 'gitleaks is not installed' }

  const root = await projectRoot(host, cwd)
  if (root === undefined) return { kind: 'skip', reason: 'not a Git repository' }

  const scan = scanCommand(gitleaks.stdout)
  return (await host.exists(`${root}/package.json`))
    ? ensureHusky(host, root, scan, options)
    : ensurePreCommit(host, root, scan)
}
