import type { Register } from 'claude-code'
import { ensureGuard, hostFrom } from './guard.ts'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Never hold up the first prompt: the check, which may install Husky, runs in the background once the session is ready.
    $.clock.after(0, () => {
      void ensureGuard(hostFrom($), e.cwd, { autoInstallHusky: options.autoInstallHusky === true })
        .then(outcome => {
          if (outcome.kind === 'added' || outcome.kind === 'warn') $.ui.toast(`secret-guard: ${outcome.message}`)
        })
        .catch(error => $.ui.toast(`secret-guard: the check failed: ${String(error)}`))
    })
    return started
  })
}
