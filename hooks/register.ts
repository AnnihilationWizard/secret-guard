import type { Register } from 'claude-code'
import { ensureGuard, hostFrom } from './guard.ts'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 不擋住第一個 prompt：檢查（可能含 husky 安裝）在 session 就緒後於背景執行。
    $.clock.after(0, () => {
      void ensureGuard(hostFrom($), e.cwd, { autoInstallHusky: options.autoInstallHusky === true })
        .then(outcome => {
          if (outcome.kind === 'added' || outcome.kind === 'warn') $.ui.toast(`secret-guard: ${outcome.message}`)
        })
        .catch(error => $.ui.toast(`secret-guard: 檢查失敗：${String(error)}`))
    })
    return started
  })
}
