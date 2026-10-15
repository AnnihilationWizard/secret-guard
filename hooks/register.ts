import type { Register } from 'claude-code'
import { ensureGuard, hostFrom } from './guard.ts'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Never hold up the first prompt: the check, which may install Husky, runs in the background once the session is ready.
    $.clock.after(0, () => {
      void ensureGuard(hostFrom($), e.cwd, { autoInstallHusky: options.autoInstallHusky === true })
        // Claude Code already heads each toast with the mod's name, so the text carries no prefix of its own.
        .then(outcome => {
          if (outcome.kind === 'added' || outcome.kind === 'warn') $.ui.toast(outcome.message)
        })
        .catch(error => $.ui.toast(`The check failed: ${String(error)}`))
    })
    return started
  })
}
