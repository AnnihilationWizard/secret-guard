import type { EngineInterface, ProcessRunResult } from 'claude-code'

/** 這個 mod 用到的主機能力；register 由 `$` 建出，測試用記憶體假物件。 */
export type Host = {
  /** undefined：指令無法啟動（未安裝）或逾時。 */
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
  (r === undefined ? '無法執行' : r.stderr || r.stdout || `exit ${r.exitCode}`).trim().slice(0, 300)

async function readText(host: Host, path: string): Promise<string | undefined> {
  return (await host.exists(path)) ? host.read(path) : undefined
}

/** gitleaks 8.19 起改用 `gitleaks git`；更舊的版本只有 `protect`。 */
export function scanCommand(versionOutput: string): string {
  const m = /(\d+)\.(\d+)/.exec(versionOutput)
  const isLegacy = m !== null && (Number(m[1]) < 8 || (Number(m[1]) === 8 && Number(m[2]) < 19))
  return isLegacy
    ? 'gitleaks protect --staged --redact --verbose'
    : 'gitleaks git --pre-commit --redact --staged --verbose'
}

export function preCommitConfig(scan: string): string {
  return `${MARK}: 每次 commit 前用全域安裝的 gitleaks 掃描 staged 變更
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
  return `${MARK}: 每次 commit 前掃描 staged 變更中的密鑰
if command -v gitleaks >/dev/null 2>&1; then
  ${scan} || exit 1
else
  echo "gitleaks 未安裝，略過密鑰掃描（brew install gitleaks）" >&2
fi
`
}

/** 把區塊插在既有 hook 的 shebang 之後，確保在其他指令（含 exit）之前執行。 */
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
    // pnpm 在 workspace 根目錄拒絕 add，除非明確加 -w。
    const workspaceRoot = (await host.exists(`${root}/pnpm-workspace.yaml`)) ? ['-w'] : []
    return { name: 'pnpm', add: ['pnpm', 'add', ...workspaceRoot, '-D', 'husky'] }
  }
  if (await host.exists(`${root}/yarn.lock`)) return { name: 'yarn', add: ['yarn', 'add', '-D', 'husky'] }
  if ((await host.exists(`${root}/bun.lockb`)) || (await host.exists(`${root}/bun.lock`))) {
    return { name: 'bun', add: ['bun', 'add', '-d', 'husky'] }
  }
  return { name: 'npm', add: ['npm', 'install', '--save-dev', 'husky'] }
}

async function hooksPathSetting(host: Host, root: string): Promise<string | undefined> {
  const r = await host.run(['git', 'config', '--get', 'core.hooksPath'], root)
  const value = r?.stdout.trim()
  return succeeded(r) && value ? value : undefined
}

async function ensurePreCommit(host: Host, root: string, scan: string): Promise<Outcome> {
  if (!succeeded(await host.run(['pre-commit', '--version'], root))) {
    return { kind: 'skip', reason: 'pre-commit 未安裝' }
  }

  const configPath = `${root}/.pre-commit-config.yaml`
  const config = await readText(host, configPath)
  if (config !== undefined && !/gitleaks/.test(config)) {
    return {
      kind: 'warn',
      message: '已有 .pre-commit-config.yaml 但沒有 gitleaks hook；不自動修改既有設定，請手動加入。',
    }
  }

  const hooksPath = await hooksPathSetting(host, root)
  if (hooksPath !== undefined) {
    return {
      kind: 'warn',
      message: `core.hooksPath 已設為 ${hooksPath}，pre-commit install 會拒絕執行；未做變更。`,
    }
  }

  const hookFile = await host.run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'], root)
  const installed = succeeded(hookFile) ? await readText(host, hookFile.stdout.trim()) : undefined
  const isInstalled = installed !== undefined && /pre-commit/.test(installed)
  if (config !== undefined && isInstalled) return { kind: 'ok' }

  if (config === undefined) await host.write(configPath, preCommitConfig(scan))

  const install = await host.run(['pre-commit', 'install'], root, 60_000)
  if (!succeeded(install)) {
    return { kind: 'warn', message: `pre-commit install 失敗：${failure(install)}` }
  }
  return {
    kind: 'added',
    message: config === undefined
      ? '已建立 .pre-commit-config.yaml（gitleaks）並執行 pre-commit install。'
      : '已執行 pre-commit install，gitleaks hook 生效。',
  }
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
    return isHuskyActive
      ? { kind: 'ok' }
      : { kind: 'warn', message: '.husky/pre-commit 已有 gitleaks，但 husky 尚未啟用；請先執行專案的 install（會跑 prepare script）。' }
  }

  let pkg: PackageJson
  try {
    pkg = JSON.parse(await host.read(`${root}/package.json`)) as PackageJson
  } catch {
    return { kind: 'warn', message: 'package.json 無法解析；未做變更。' }
  }

  const pm = await packageManager(host, root)
  const hasHusky = pkg.devDependencies?.husky !== undefined || pkg.dependencies?.husky !== undefined
  if (!hasHusky) {
    if (!options.autoInstallHusky) {
      return {
        kind: 'warn',
        message: `JS/TS 專案尚未安裝 husky。請執行 \`${pm.add.join(' ')}\`，或在設定中開啟 secret-guard 的「自動安裝 Husky」。`,
      }
    }
    const added = await host.run(pm.add, root, 600_000)
    if (!succeeded(added)) {
      return { kind: 'warn', message: `安裝 husky 失敗（${pm.name}）：${failure(added)}` }
    }
  }

  const prepare = pkg.scripts?.prepare
  if (prepare === undefined) {
    // `|| true`：只裝正式依賴（npm ci --omit=dev、Docker）時沒有 husky，prepare 不能讓安裝失敗。
    await host.run(['npm', 'pkg', 'set', `scripts.prepare=${PREPARE_SCRIPT}`], root)
  }

  await host.write(hookPath, prependBlock(hook, huskyBlock(scan)))

  if (!isHuskyActive) {
    const activated = await host.run([`${root}/node_modules/.bin/husky`], root)
    if (!succeeded(activated)) {
      return {
        kind: 'warn',
        message: '已寫入 .husky/pre-commit，但無法啟用 husky（node_modules 尚未安裝？）；請執行專案的 install。',
      }
    }
  }

  const notes = [
    hasHusky ? undefined : `已用 ${pm.name} 安裝 husky`,
    prepare === undefined
      ? '已加入 prepare script'
      : /husky/.test(prepare) ? undefined : `prepare script 沒有呼叫 husky（${prepare}），隊友 clone 後需手動啟用`,
    '已將 gitleaks 加入 .husky/pre-commit',
  ].filter((n): n is string => n !== undefined)
  return { kind: 'added', message: `${notes.join('；')}。` }
}

export async function ensureGuard(host: Host, cwd: string, options: GuardOptions): Promise<Outcome> {
  const gitleaks = await host.run(['gitleaks', 'version'], cwd)
  if (!succeeded(gitleaks)) return { kind: 'skip', reason: 'gitleaks 未安裝' }

  const top = await host.run(['git', 'rev-parse', '--show-toplevel'], cwd)
  if (!succeeded(top)) return { kind: 'skip', reason: '不是 Git 專案' }
  const root = top.stdout.trim()

  const scan = scanCommand(gitleaks.stdout)
  return (await host.exists(`${root}/package.json`))
    ? ensureHusky(host, root, scan, options)
    : ensurePreCommit(host, root, scan)
}
