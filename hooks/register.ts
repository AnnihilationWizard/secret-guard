import type { EngineInterface, Register } from 'claude-code'
import {
  BOTH_INSTALLED,
  ensureGuard,
  hostFrom,
  isInstalled,
  other,
  locateProject,
  parseUseArgs,
  removalWarning,
  removeManager,
  UNREACHABLE,
  USE_USAGE,
  type Manager,
} from './guard.ts'

const MANAGER_KEY = 'manager'

// Repositories already checked in this session, so moving around one repository does not repeat a notice.
const checked = new Set<string>()
let isBothNoticeShown = false

// Checks and /secret-guard-use run one at a time, so a switch never interleaves with a check's file
// writes. Each pick bumps the generation, and a check that started before it drops its notice,
// which describes the project as it was before the switch.
let queue: Promise<unknown> = Promise.resolve()
let generation = 0

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

async function preferredManager($: EngineInterface): Promise<Manager | undefined> {
  const value = await $.store.get(MANAGER_KEY)
  return value === 'pre-commit' || value === 'lefthook' ? value : undefined
}

async function check($: EngineInterface, cwd: string, autoInstallHusky: boolean): Promise<void> {
  const startedIn = generation
  const host = hostFrom($)
  const location = await locateProject(host, cwd)
  if (location.kind === 'none') return
  // A folder where commands cannot start has no root to key on; its own path stands in.
  const key = location.kind === 'repo' ? location.root : cwd
  if (checked.has(key)) return
  checked.add(key)
  if (location.kind === 'unreachable') {
    $.ui.toast(UNREACHABLE)
    return
  }
  const preferred = await preferredManager($)
  if (preferred === undefined && !isBothNoticeShown) {
    if ((await isInstalled(host, 'pre-commit')) && (await isInstalled(host, 'lefthook'))) {
      isBothNoticeShown = true
      $.ui.toast(BOTH_INSTALLED)
    }
  }
  const outcome = await ensureGuard(host, cwd, { autoInstallHusky, preferredManager: preferred })
  if (startedIn !== generation) return
  // Claude Code already heads each toast with the mod's name, so the text carries no prefix of its own.
  if (outcome.kind === 'added' || outcome.kind === 'warn') $.ui.toast(outcome.message)
}

/** Runs the check after the current event, so it never holds up the session. */
function inBackground($: EngineInterface, cwd: string, autoInstallHusky: boolean): void {
  $.clock.after(0, () => {
    void inTurn(() => check($, cwd, autoInstallHusky)).catch(error => $.ui.toast(`The check failed: ${String(error)}`))
  })
}

/** /secret-guard-use: saves the pick, sets up this project with it, and removes the other manager on request. */
async function use($: EngineInterface, args: string, autoInstallHusky: boolean): Promise<string> {
  const parsed = parseUseArgs(args)
  if (parsed === undefined) return USE_USAGE
  generation += 1
  return inTurn(() => switchTo($, parsed.manager, parsed.removeOther, autoInstallHusky))
}

async function switchTo($: EngineInterface, manager: Manager, removeOther: boolean, autoInstallHusky: boolean): Promise<string> {
  const parsed = { manager, removeOther }
  await $.store.set(MANAGER_KEY, parsed.manager)
  const host = hostFrom($)
  const cwd = await $.session.cwd()

  // Switch this project now, while the other manager is still installed to remove its hook.
  const location = await locateProject(host, cwd)
  let project = ''
  if (location.kind !== 'none') {
    checked.add(location.kind === 'repo' ? location.root : cwd)
    const outcome = await ensureGuard(host, cwd, { autoInstallHusky, preferredManager: parsed.manager })
    project = outcome.kind === 'added' || outcome.kind === 'warn' ? ` This project: ${outcome.message}` : ''
  }

  const unpicked = other(parsed.manager)
  const machine = parsed.removeOther
    ? await removeManager(host, unpicked)
    : (await isInstalled(host, unpicked))
      ? removalWarning(unpicked, parsed.manager)
      : ''
  // Claude Code heads the command's output with the mod's name, so the text does not repeat it.
  return [`Picked ${parsed.manager}: new projects get it from now on.${project}`, machine].filter(s => s !== '').join('\n')
}

/** The worktree an EnterWorktree result names, if any. */
export function worktreePath(result: unknown): string | undefined {
  const path = (result as { result?: { worktreePath?: unknown } } | undefined)?.result?.worktreePath
  return typeof path === 'string' && path !== '' ? path : undefined
}

export const register: Register = (on, options) => {
  const autoInstallHusky = options.autoInstallHusky === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'secret-guard-use',
      description: 'Pick pre-commit or Lefthook for secret-guard, and optionally remove the other',
      argumentHint: 'pre-commit|lefthook [--remove-other]',
    })
    inBackground($, e.cwd, autoInstallHusky)
    return started
  })

  on('command.run', { command: 'secret-guard-use' }, async ($, e) => ({ text: await use($, e.args, autoInstallHusky) }))
    .catch(() => ({ text: 'secret-guard-use failed; nothing else was changed after the error.' }))

  // A worktree shares the repository's installed hook but not an uncommitted config, so its commits
  // would be blocked or skip the scan. Check it before the result goes back, so the config is there when work starts.
  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const result = await next(e)
    const path = worktreePath(result)
    if (path !== undefined) {
      try {
        await inTurn(() => check($, path, autoInstallHusky))
      } catch (error) {
        $.ui.toast(`The check failed: ${String(error)}`)
      }
    }
    return result
  }).catch(($, e, next) => next(e)) // never stand in the way of EnterWorktree: replay its own result
}
