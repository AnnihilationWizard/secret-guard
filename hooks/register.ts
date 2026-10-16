import type { EngineInterface, Register } from 'claude-code'
import { ensureGuard, hostFrom, projectRoot } from './guard.ts'

// Repositories already checked in this session, so moving around one repository does not repeat a notice.
const checked = new Set<string>()

async function check($: EngineInterface, cwd: string, autoInstallHusky: boolean): Promise<void> {
  const host = hostFrom($)
  const root = await projectRoot(host, cwd)
  if (root === undefined || checked.has(root)) return
  checked.add(root)
  const outcome = await ensureGuard(host, cwd, { autoInstallHusky })
  // Claude Code already heads each toast with the mod's name, so the text carries no prefix of its own.
  if (outcome.kind === 'added' || outcome.kind === 'warn') $.ui.toast(outcome.message)
}

/** Runs the check after the current event, so it never holds up the session. */
function inBackground($: EngineInterface, cwd: string, autoInstallHusky: boolean): void {
  $.clock.after(0, () => {
    void check($, cwd, autoInstallHusky).catch(error => $.ui.toast(`The check failed: ${String(error)}`))
  })
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
    inBackground($, e.cwd, autoInstallHusky)
    return started
  })

  // A worktree shares the repository's installed hook but not an uncommitted config, so its commits
  // would be blocked. Check it before the result goes back, so the config is there when work starts.
  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const result = await next(e)
    const path = worktreePath(result)
    if (path !== undefined) {
      try {
        await check($, path, autoInstallHusky)
      } catch (error) {
        $.ui.toast(`The check failed: ${String(error)}`)
      }
    }
    return result
  }).catch(($, e, next) => next(e)) // never stand in the way of EnterWorktree: replay its own result
}
