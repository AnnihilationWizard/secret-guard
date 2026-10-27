import { test, expect } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import { worktreePath } from '../hooks/register.ts'
import {
  configuredHooksPath,
  ensureGuard,
  huskyBlock,
  isWindows,
  lefthookConfig,
  locateProject,
  notInstalledPick,
  parseUseArgs,
  preCommitConfig,
  prependBlock,
  removalWarning,
  removeManager,
  scanCommand,
  UNREACHABLE,
  withPrepareScript,
  type Host,
  type Outcome,
} from '../hooks/guard.ts'

const ROOT = '/repo'
const ENGINE_HOOKS_PATH = 'command\t/dev/null\ncommand\t/dev/null\n'

type Fake = {
  files: Record<string, string>
  /** argv joined by spaces → result; a missing key means the command cannot start. */
  commands: Record<string, Partial<ProcessRunResult>>
  /** Paths, relative to ROOT, that `git ls-files --error-unmatch` reports as committed. */
  tracked: string[]
  ran: string[]
  /** A folder no command can start in, as a Windows path past 260 characters behaves. */
  unreachable?: string
  /** What a successful command does to the files, by argv joined with spaces. */
  onRun: Record<string, (fake: Fake) => void>
}

const TOOL_DIR = '/mod'

/** Husky 9 as installed in node_modules: its package names bin.js as the husky command. */
function installHusky(fake: Fake): void {
  fake.files[`${ROOT}/node_modules/husky/package.json`] = '{"name":"husky","bin":{"husky":"bin.js"}}'
  fake.commands[`node ${ROOT}/node_modules/husky/bin.js`] = {}
}

const COMMIT_CONFIG_HINT =
  ' Commit .pre-commit-config.yaml so other worktrees and clones get it: git add .pre-commit-config.yaml, then git commit'
const COMMIT_HUSKY_HINT = ' Commit .husky/pre-commit so other worktrees and clones get it: git add .husky/pre-commit, then git commit'

function fakeHost(fake: Fake): Host {
  return {
    run: async (argv, cwd) => {
      const key = argv.join(' ')
      fake.ran.push(key)
      if (fake.unreachable !== undefined && cwd === fake.unreachable) return undefined
      if (key.startsWith('git ls-files --error-unmatch -- ')) {
        const isTracked = fake.tracked.includes(argv[argv.length - 1] ?? '')
        return { exitCode: isTracked ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      }
      const r = fake.commands[key]
      if (r === undefined) return undefined
      const result = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r }
      if (result.exitCode === 0) fake.onRun[key]?.(fake)
      return result
    },
    exists: async path => {
      // Claude Code refuses a device or network path by throwing, as it does for \\.\NUL\pre-commit on Windows.
      if (path.startsWith('\\\\') || path.startsWith('/dev/null/')) throw new Error(`${path} refused`)
      return path in fake.files
    },
    read: async path => {
      const text = fake.files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    write: async (path, text) => {
      fake.files[path] = text
    },
    toolDir: TOOL_DIR,
  }
}

const base = (): Fake => ({
  files: {},
  tracked: [],
  onRun: {},
  ran: [],
  commands: {
    'gitleaks version': { stdout: '8.21.2\n' },
    'git rev-parse --show-toplevel': { stdout: `${ROOT}\n` },
    'pre-commit --version': { stdout: 'pre-commit 4.0.1\n' },
    // What Claude Code reports for a mod's git: its own -c core.hooksPath=/dev/null, scope "command".
    'git config --show-scope --get-all core.hooksPath': { stdout: ENGINE_HOOKS_PATH },
    // --git-path follows Claude Code's core.hooksPath override, so it names the null device ...
    'git rev-parse --path-format=absolute --git-path hooks/pre-commit': { stdout: '\\\\.\\NUL\\pre-commit\n' },
    // ... while --git-common-dir names the real, shared .git folder.
    'git rev-parse --path-format=absolute --git-common-dir': { stdout: `${ROOT}/.git\n` },
    'pre-commit install': { stdout: 'pre-commit installed at .git/hooks/pre-commit\n' },
  },
})

test('does nothing when gitleaks is not installed', async () => {
  const fake = base()
  delete fake.commands['gitleaks version']
  const host = fakeHost(fake)
  expect(await ensureGuard(host, ROOT, { autoInstallHusky: false })).toEqual({ kind: 'skip', reason: 'gitleaks is not installed' })
  expect(Object.keys(fake.files)).toEqual([])
})

test('skips a folder that is not a Git repository', async () => {
  const fake = base()
  fake.commands['git rev-parse --show-toplevel'] = { exitCode: 128 }
  const host = fakeHost(fake)
  expect((await ensureGuard(host, ROOT, { autoInstallHusky: false })).kind).toBe('skip')
})

test('creates .pre-commit-config.yaml and runs pre-commit install in a project without one', async () => {
  const fake = base()
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({
    kind: 'added',
    message: `Created .pre-commit-config.yaml (gitleaks) and ran pre-commit install.${COMMIT_CONFIG_HINT}`,
  })
  expect(fake.files[`${ROOT}/.pre-commit-config.yaml`]).toContain('entry: gitleaks git --pre-commit --redact --staged --verbose')
  expect(fake.ran).toContain('pre-commit install')
})

test('leaves a configured, installed and committed project alone', async () => {
  const fake = base()
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = 'repos:\n  - repo: https://github.com/gitleaks/gitleaks\n'
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = '#!/usr/bin/env bash\n# File generated by pre-commit\n'
  fake.tracked.push('.pre-commit-config.yaml')
  const host = fakeHost(fake)
  expect(await ensureGuard(host, ROOT, { autoInstallHusky: false })).toEqual({ kind: 'ok' })
  expect(fake.ran).not.toContain('pre-commit install')
})

test('reminds to commit a config that is set up but not committed', async () => {
  const fake = base()
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = 'repos:\n  - repo: https://github.com/gitleaks/gitleaks\n'
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = '#!/usr/bin/env bash\n# File generated by pre-commit\n'
  const host = fakeHost(fake)
  expect(await ensureGuard(host, ROOT, { autoInstallHusky: false })).toEqual({
    kind: 'warn',
    message: `.pre-commit-config.yaml is not committed.${COMMIT_CONFIG_HINT}`,
  })
})

test('the commit hint names each command, since Windows PowerShell 5.1 rejects &&', async () => {
  const fake = base()
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome.kind === 'added' && outcome.message).toContain('git add .pre-commit-config.yaml, then git commit')
  expect(outcome.kind === 'added' && outcome.message).not.toContain('&&')
})

test('worktree with the shared hook but no config: creates the config so commits are not blocked', async () => {
  const fake = base()
  // A worktree shares the main checkout's hooks folder, so the hook is there while the untracked config is not.
  fake.commands['git rev-parse --path-format=absolute --git-common-dir'] = { stdout: '/main/.git\n' }
  fake.files['/main/.git/hooks/pre-commit'] = '#!/usr/bin/env bash\n# File generated by pre-commit\n'
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({
    kind: 'added',
    message:
      'The pre-commit hook was installed but .pre-commit-config.yaml was missing, so commits were blocked. Created it with gitleaks.' +
      COMMIT_CONFIG_HINT,
  })
  expect(fake.files[`${ROOT}/.pre-commit-config.yaml`]).toContain('gitleaks git --pre-commit')
  expect(fake.ran).not.toContain('pre-commit install')
})

test('only warns about an existing config without gitleaks and leaves it unchanged', async () => {
  const fake = base()
  const original = 'repos:\n  - repo: https://github.com/psf/black\n'
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = original
  const host = fakeHost(fake)
  expect((await ensureGuard(host, ROOT, { autoInstallHusky: false })).kind).toBe('warn')
  expect(fake.files[`${ROOT}/.pre-commit-config.yaml`]).toBe(original)
})

test('skips a project without package.json when pre-commit is not installed', async () => {
  const fake = base()
  delete fake.commands['pre-commit --version']
  const host = fakeHost(fake)
  expect((await ensureGuard(host, ROOT, { autoInstallHusky: false })).kind).toBe('skip')
  expect(Object.keys(fake.files)).toEqual([])
})

test('JS project without Husky and auto-install off: shows the command and changes no file', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"name":"app"}'
  fake.files[`${ROOT}/pnpm-lock.yaml`] = ''
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome.kind).toBe('warn')
  expect(outcome.kind === 'warn' && outcome.message).toContain('pnpm add -D husky')
  expect(Object.keys(fake.files).sort()).toEqual([`${ROOT}/package.json`, `${ROOT}/pnpm-lock.yaml`])
})

test('JS project with Husky: puts gitleaks ahead of the existing hook and turns Husky on', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"},"scripts":{"prepare":"husky"}}'
  fake.files[`${ROOT}/.husky/pre-commit`] = 'npm test\n'
  fake.tracked.push('.husky/pre-commit')
  installHusky(fake)
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({ kind: 'added', message: 'Added gitleaks to .husky/pre-commit.' })
  const hook = fake.files[`${ROOT}/.husky/pre-commit`] ?? ''
  expect(hook.indexOf('gitleaks git')).toBeLessThan(hook.indexOf('npm test'))
  expect(fake.ran).toContain(`node ${ROOT}/node_modules/husky/bin.js`)
  expect(fake.ran).not.toContain('pre-commit install')
})

test('JS project with auto-install on: installs Husky with the package manager its lockfile points to', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"name":"app"}'
  fake.files[`${ROOT}/yarn.lock`] = ''
  fake.commands['yarn add -D husky'] = {}
  // yarn writes the new devDependency, which the prepare script must not overwrite.
  fake.onRun['yarn add -D husky'] = f => {
    f.files[`${ROOT}/package.json`] = '{"name":"app","devDependencies":{"husky":"^9.1.7"}}'
  }
  installHusky(fake)
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: true })
  expect(outcome).toEqual({
    kind: 'added',
    message: `Installed Husky with yarn; added a prepare script; added gitleaks to .husky/pre-commit.${COMMIT_HUSKY_HINT}`,
  })
  expect(fake.ran).toContain('yarn add -D husky')
  // Installs without dev dependencies have no husky, so prepare must tolerate it or npm ci --omit=dev fails.
  expect(JSON.parse(fake.files[`${ROOT}/package.json`] ?? '{}')).toEqual({
    name: 'app',
    devDependencies: { husky: '^9.1.7' },
    scripts: { prepare: 'husky || true' },
  })
  expect(fake.ran.some(c => c.startsWith('npm pkg'))).toBe(false)
  expect(fake.files[`${ROOT}/.husky/pre-commit`]).toContain('gitleaks git --pre-commit')
})

test('a package manager that cannot start directly is retried through cmd, as npm.cmd on Windows needs', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"name":"app"}'
  fake.commands['cmd /d /s /c npm install --save-dev husky'] = {}
  installHusky(fake)
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: true })
  expect(outcome.kind === 'added' && outcome.message).toContain('Installed Husky with npm')
  expect(fake.ran).toContain('npm install --save-dev husky')
  expect(fake.ran).toContain('cmd /d /s /c npm install --save-dev husky')
})

test('a package manager that cannot start at all reports the failure instead of claiming success', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"name":"app"}'
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: true })
  expect(outcome).toEqual({ kind: 'warn', message: 'Installing Husky with npm failed: could not run' })
  expect(fake.files[`${ROOT}/package.json`]).toBe('{"name":"app"}')
})

test('withPrepareScript keeps indentation, key order, line endings and the final newline', () => {
  expect(withPrepareScript('{\n\t"name": "app",\n\t"scripts": {\n\t\t"test": "vitest"\n\t}\n}\n')).toBe(
    '{\n\t"name": "app",\n\t"scripts": {\n\t\t"test": "vitest",\n\t\t"prepare": "husky || true"\n\t}\n}\n',
  )
  expect(withPrepareScript('{\r\n    "name": "app"\r\n}\r\n')).toBe(
    '{\r\n    "name": "app",\r\n    "scripts": {\r\n        "prepare": "husky || true"\r\n    }\r\n}\r\n',
  )
  expect(withPrepareScript('{"name":"app"}')).toBe('{\n  "name": "app",\n  "scripts": {\n    "prepare": "husky || true"\n  }\n}')
  expect(withPrepareScript('[1, 2]')).toBeUndefined()
  expect(withPrepareScript('{not json')).toBeUndefined()
})

test('withPrepareScript reads a package.json with a byte order mark and keeps the mark', () => {
  expect(withPrepareScript('﻿{\r\n  "name": "app"\r\n}\r\n')).toBe(
    '﻿{\r\n  "name": "app",\r\n  "scripts": {\r\n    "prepare": "husky || true"\r\n  }\r\n}\r\n',
  )
})

test('a package.json saved with a byte order mark, as Windows PowerShell 5.1 does, is set up like any other', async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/package.json`] = '﻿{\r\n  "name": "app",\r\n  "devDependencies": {\r\n    "husky": "^9.1.0"\r\n  }\r\n}\r\n'
  installHusky(fake)
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  // Read as a Husky project, not as one without Husky that gets Lefthook.
  expect(outcome.kind === 'added' && outcome.message).toContain('Added a prepare script; added gitleaks to .husky/pre-commit')
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBeUndefined()
  expect(fake.files[`${ROOT}/package.json`]?.startsWith('﻿{\r\n')).toBe(true)
  expect(fake.files[`${ROOT}/package.json`]).toContain('"prepare": "husky || true"')
})

test('installs Husky with -w at a pnpm workspace root', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"name":"mono","scripts":{"prepare":"husky || true"}}'
  fake.files[`${ROOT}/pnpm-lock.yaml`] = ''
  fake.files[`${ROOT}/pnpm-workspace.yaml`] = 'packages:\n  - packages/*\n'
  fake.commands['pnpm add -w -D husky'] = {}
  installHusky(fake)
  const host = fakeHost(fake)
  expect((await ensureGuard(host, ROOT, { autoInstallHusky: true })).kind).toBe('added')
  expect(fake.ran).toContain('pnpm add -w -D husky')
})

test('suggests pnpm add without -w outside a workspace', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"name":"app"}'
  fake.files[`${ROOT}/pnpm-lock.yaml`] = ''
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome.kind === 'warn' && outcome.message).toContain('`pnpm add -D husky`')
})

test('leaves a JS project alone when its committed hook runs gitleaks and Husky is active', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"}}'
  fake.files[`${ROOT}/.husky/pre-commit`] = 'gitleaks git --pre-commit --staged\n'
  fake.tracked.push('.husky/pre-commit')
  fake.commands['git config --show-scope --get-all core.hooksPath'] = { stdout: `${ENGINE_HOOKS_PATH}local\t.husky/_\n` }
  const host = fakeHost(fake)
  expect(await ensureGuard(host, ROOT, { autoInstallHusky: false })).toEqual({ kind: 'ok' })
})

test('reminds to commit a Husky hook that runs gitleaks but is not committed', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"}}'
  fake.files[`${ROOT}/.husky/pre-commit`] = 'gitleaks git --pre-commit --staged\n'
  fake.commands['git config --show-scope --get-all core.hooksPath'] = { stdout: `${ENGINE_HOOKS_PATH}local\t.husky/_\n` }
  const host = fakeHost(fake)
  expect(await ensureGuard(host, ROOT, { autoInstallHusky: false })).toEqual({
    kind: 'warn',
    message: `.husky/pre-commit is not committed.${COMMIT_HUSKY_HINT}`,
  })
})

test("ignores Claude Code's own core.hooksPath=/dev/null and still sets up the project", async () => {
  const fake = base()
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome.kind).toBe('added')
  expect(outcome.kind === 'added' && outcome.message).not.toContain('core.hooksPath')
  expect(fake.ran).toContain('pre-commit install')
})

test('still warns when a config file sets core.hooksPath', async () => {
  const fake = base()
  fake.commands['git config --show-scope --get-all core.hooksPath'] = { stdout: `${ENGINE_HOOKS_PATH}global\t~/.githooks\n` }
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({
    kind: 'warn',
    message: 'core.hooksPath is set to ~/.githooks, so pre-commit install would refuse to run. Nothing was changed.',
  })
  expect(fake.ran).not.toContain('pre-commit install')
})

test('configuredHooksPath reads only config-file scopes', () => {
  expect(configuredHooksPath('command\t/dev/null\ncommand\t/dev/null\n')).toBeUndefined()
  expect(configuredHooksPath('global\t~/.githooks\ncommand\t/dev/null\n')).toBe('~/.githooks')
  expect(configuredHooksPath('global\t~/.githooks\nlocal\t.husky/_\n')).toBe('.husky/_')
  expect(configuredHooksPath('')).toBeUndefined()
})

test('every notice and generated file is in English', async () => {
  const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/
  const scenarios: Array<{ setup: (fake: Fake) => void; autoInstallHusky: boolean }> = [
    { setup: () => {}, autoInstallHusky: false },
    { setup: f => { delete f.commands['gitleaks version'] }, autoInstallHusky: false },
    { setup: f => { f.commands['git rev-parse --show-toplevel'] = { exitCode: 128 } }, autoInstallHusky: false },
    { setup: f => { delete f.commands['pre-commit --version'] }, autoInstallHusky: false },
    { setup: f => { f.files[`${ROOT}/.pre-commit-config.yaml`] = 'repos: []\n' }, autoInstallHusky: false },
    {
      setup: f => { f.commands['git config --show-scope --get-all core.hooksPath'] = { stdout: 'local\t.githooks\n' } },
      autoInstallHusky: false,
    },
    { setup: f => { f.commands['pre-commit install'] = { exitCode: 1, stderr: 'boom' } }, autoInstallHusky: false },
    { setup: f => { f.files[`${ROOT}/package.json`] = '{not json' }, autoInstallHusky: false },
    { setup: f => { f.files[`${ROOT}/package.json`] = '{}' }, autoInstallHusky: false },
    { setup: f => { f.files[`${ROOT}/package.json`] = '{}' }, autoInstallHusky: true },
    {
      setup: f => {
        f.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"9"},"scripts":{"prepare":"node setup.js"}}'
        installHusky(f)
      },
      autoInstallHusky: false,
    },
    { setup: f => { f.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"9"}}' }, autoInstallHusky: false },
    {
      setup: f => {
        f.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"9"}}'
        f.files[`${ROOT}/.husky/pre-commit`] = 'gitleaks git\n'
      },
      autoInstallHusky: false,
    },
  ]
  for (const { setup, autoInstallHusky } of scenarios) {
    const fake = base()
    setup(fake)
    const outcome: Outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky })
    const text = outcome.kind === 'skip' ? outcome.reason : outcome.kind === 'ok' ? '' : outcome.message
    expect(cjk.test(text)).toBe(false)
    for (const content of Object.values(fake.files)) expect(cjk.test(content)).toBe(false)
  }
  expect(cjk.test(preCommitConfig(scanCommand('8.21.2')))).toBe(false)
  expect(cjk.test(huskyBlock(scanCommand('8.21.2')))).toBe(false)
})

test('worktreePath reads the path from an EnterWorktree result', () => {
  expect(worktreePath({ result: { worktreePath: '/repo/.claude/worktrees/x', worktreeBranch: 'worktree-x' } })).toBe(
    '/repo/.claude/worktrees/x',
  )
  expect(worktreePath({ isError: true, text: 'failed' })).toBeUndefined()
  expect(worktreePath(undefined)).toBeUndefined()
})

// --- Lefthook ---------------------------------------------------------------------------------

const LEFTHOOK_HOOK = '#!/bin/sh\n# lefthook hook\ncall_lefthook run "pre-commit" "$@"\n'
const PRE_COMMIT_HOOK = '#!/usr/bin/env bash\n# File generated by pre-commit: https://pre-commit.com\n'
const SCAN = 'gitleaks git --pre-commit --redact --staged --verbose'

/** A project with only Lefthook installed (no pre-commit). */
const lefthookOnly = (): Fake => {
  const fake = base()
  delete fake.commands['pre-commit --version']
  fake.commands['lefthook version'] = { stdout: '2.2.2\n' }
  fake.commands['lefthook install'] = {}
  fake.commands['lefthook uninstall'] = {}
  return fake
}

test('only Lefthook installed: creates lefthook.yml before lefthook install', async () => {
  const fake = lefthookOnly()
  const host = fakeHost(fake)
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({
    kind: 'added',
    message:
      'Created lefthook.yml (gitleaks) and ran lefthook install. Commit lefthook.yml so other worktrees and clones get it: git add lefthook.yml, then git commit',
  })
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBe(lefthookConfig(SCAN))
  expect(fake.ran).toContain('lefthook install')
})

test('uses an existing Lefthook config in any supported name and format', async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/.config/lefthook.toml`] = '[pre-commit.commands.gitleaks]\nrun = "gitleaks git --pre-commit"\n'
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = LEFTHOOK_HOOK
  fake.tracked.push('.config/lefthook.toml')
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })).toEqual({ kind: 'ok' })
})

test('only warns about a Lefthook config without gitleaks and leaves it unchanged', async () => {
  const fake = lefthookOnly()
  const original = 'pre-commit:\n  commands:\n    lint:\n      run: eslint\n'
  fake.files[`${ROOT}/lefthook.yml`] = original
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({
    kind: 'warn',
    message: 'lefthook.yml has no gitleaks command. It was left as it is; add one under pre-commit yourself.',
  })
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBe(original)
})

test('Lefthook project without lefthook installed: says to install it', async () => {
  const fake = base()
  fake.files[`${ROOT}/lefthook.yml`] = lefthookConfig(SCAN)
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome.kind).toBe('warn')
  expect(outcome.kind === 'warn' && outcome.message).toContain('lefthook is not installed')
})

test('Lefthook worktree with the shared hook but no config: creates it, since commits would skip the scan', async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = LEFTHOOK_HOOK
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome.kind === 'added' && outcome.message).toContain(
    'The Lefthook hook was installed but lefthook.yml was missing, so commits ran without a secret scan.',
  )
  expect(fake.ran).not.toContain('lefthook install')
})

test('a Lefthook hook is not mistaken for a pre-commit hook', async () => {
  const fake = base()
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = preCommitConfig(SCAN)
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = LEFTHOOK_HOOK
  fake.tracked.push('.pre-commit-config.yaml')
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome.kind).toBe('added')
  expect(fake.ran).toContain('pre-commit install')
})

test('JS project without Husky and Lefthook installed: uses Lefthook instead of adding a dependency', async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/package.json`] = '{"name":"app"}'
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome.kind).toBe('added')
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBe(lefthookConfig(SCAN))
  expect(fake.files[`${ROOT}/package.json`]).toBe('{"name":"app"}')
})

test('JS project that already uses Husky keeps Husky even with Lefthook installed', async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"},"scripts":{"prepare":"husky"}}'
  installHusky(fake)
  await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(fake.files[`${ROOT}/.husky/pre-commit`]).toContain('gitleaks git --pre-commit')
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBeUndefined()
})

const WINDOWS_TOOL_DIR = 'C:\\Users\\dev\\.claude\\plugins\\secret-guard'

test('on Windows, Lefthook installed with npm (a .cmd launcher) is found and installed through cmd', async () => {
  const fake = base()
  delete fake.commands['pre-commit --version']
  // lefthook.cmd cannot start without a shell, so only the cmd runs answer.
  fake.commands['cmd /d /s /c lefthook version'] = { stdout: '1.11.0\n' }
  fake.commands['cmd /d /s /c lefthook install'] = {}
  const host = { ...fakeHost(fake), toolDir: WINDOWS_TOOL_DIR }
  const outcome = await ensureGuard(host, ROOT, { autoInstallHusky: false })
  expect(outcome.kind === 'added' && outcome.message).toContain('Created lefthook.yml (gitleaks) and ran lefthook install.')
  expect(fake.ran).toContain('lefthook version')
  expect(fake.ran).toContain('cmd /d /s /c lefthook install')
})

test('on Windows, switching away from Lefthook uninstalls its hook through cmd', async () => {
  const fake = base()
  fake.commands['pre-commit uninstall'] = {}
  fake.commands['cmd /d /s /c lefthook version'] = { stdout: '1.11.0\n' }
  fake.commands['cmd /d /s /c lefthook uninstall'] = {}
  fake.files[`${ROOT}/lefthook.yml`] = lefthookConfig(SCAN)
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = LEFTHOOK_HOOK
  const host = { ...fakeHost(fake), toolDir: WINDOWS_TOOL_DIR }
  await ensureGuard(host, ROOT, { autoInstallHusky: false, preferredManager: 'pre-commit' })
  expect(fake.ran).toContain('cmd /d /s /c lefthook uninstall')
  expect(fake.ran.indexOf('cmd /d /s /c lefthook uninstall')).toBeLessThan(fake.ran.indexOf('pre-commit install'))
})

test('outside Windows, a lefthook that cannot start is not retried through cmd', async () => {
  const fake = base()
  fake.files[`${ROOT}/lefthook.yml`] = lefthookConfig(SCAN)
  await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(fake.ran.some(c => c.startsWith('cmd '))).toBe(false)
})

test('a Lefthook config that exists but cannot be read is never written over', async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/lefthook.yml`] = 'pre-commit: {}\n'
  const host = fakeHost(fake)
  const read = host.read
  let reads = 0
  // The first read (to choose the manager) works; the second, in the Lefthook step, is refused.
  const flaky: Host = {
    ...host,
    read: async path => (path.endsWith('lefthook.yml') && ++reads > 1 ? Promise.reject(new Error('refused')) : read(path)),
  }
  expect(await ensureGuard(flaky, ROOT, { autoInstallHusky: false })).toEqual({
    kind: 'warn',
    message: 'lefthook.yml could not be read. Nothing was changed.',
  })
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBe('pre-commit: {}\n')
  expect(fake.ran).not.toContain('lefthook install')
})

// --- Both managers ------------------------------------------------------------------------------

const bothInstalled = (): Fake => {
  const fake = lefthookOnly()
  fake.commands['pre-commit --version'] = { stdout: 'pre-commit 4.7.0\n' }
  fake.commands['pre-commit uninstall'] = {}
  return fake
}

test('both installed and no pick: a new project gets pre-commit', async () => {
  const fake = bothInstalled()
  await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(fake.files[`${ROOT}/.pre-commit-config.yaml`]).toBe(preCommitConfig(SCAN))
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBeUndefined()
})

test('both installed and Lefthook picked: a new project gets Lefthook', async () => {
  const fake = bothInstalled()
  await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false, preferredManager: 'lefthook' })
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBe(lefthookConfig(SCAN))
  expect(fake.files[`${ROOT}/.pre-commit-config.yaml`]).toBeUndefined()
})

test('picking Lefthook switches a project secret-guard set up with pre-commit, removing the old hook first', async () => {
  const fake = bothInstalled()
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = preCommitConfig(SCAN)
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = PRE_COMMIT_HOOK
  fake.tracked.push('.pre-commit-config.yaml')
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false, preferredManager: 'lefthook' })
  expect(fake.ran.indexOf('pre-commit uninstall')).toBeGreaterThan(-1)
  expect(fake.ran.indexOf('pre-commit uninstall')).toBeLessThan(fake.ran.indexOf('lefthook install'))
  expect(fake.files[`${ROOT}/lefthook.yml`]).toBe(lefthookConfig(SCAN))
  expect(outcome).toEqual({
    kind: 'added',
    message:
      'Created lefthook.yml (gitleaks) and ran lefthook install. ' +
      'Switched this project from pre-commit to lefthook; delete .pre-commit-config.yaml, which secret-guard wrote. ' +
      'Commit lefthook.yml so other worktrees and clones get it: git add lefthook.yml, then git commit',
  })
})

test('a pick of a manager that is no longer installed keeps pre-commit projects protected', async () => {
  const fake = base() // pre-commit installed, Lefthook not
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = preCommitConfig(SCAN)
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = PRE_COMMIT_HOOK
  fake.tracked.push('.pre-commit-config.yaml')
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false, preferredManager: 'lefthook' })).toEqual({ kind: 'ok' })
})

test("picking Lefthook leaves a project's own pre-commit config alone", async () => {
  const fake = bothInstalled()
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = 'repos:\n  - repo: https://github.com/gitleaks/gitleaks\n'
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = PRE_COMMIT_HOOK
  fake.tracked.push('.pre-commit-config.yaml')
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false, preferredManager: 'lefthook' })).toEqual({ kind: 'ok' })
  expect(fake.ran).not.toContain('pre-commit uninstall')
})

test('a project with both configs uses the pick and says which file to delete', async () => {
  const fake = bothInstalled()
  fake.files[`${ROOT}/lefthook.yml`] = lefthookConfig(SCAN)
  fake.files[`${ROOT}/.pre-commit-config.yaml`] = preCommitConfig(SCAN)
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = LEFTHOOK_HOOK
  fake.tracked.push('lefthook.yml', '.pre-commit-config.yaml')
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false, preferredManager: 'lefthook' })).toEqual({
    kind: 'warn',
    message: 'This project has both lefthook.yml and .pre-commit-config.yaml; secret-guard used lefthook. Keep one and delete .pre-commit-config.yaml.',
  })
})

test('neither manager installed: a project without package.json is skipped', async () => {
  const fake = base()
  delete fake.commands['pre-commit --version']
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })).toEqual({
    kind: 'skip',
    reason: 'neither pre-commit nor lefthook is installed',
  })
})

// --- /secret-guard-use ----------------------------------------------------------------------------

test('parseUseArgs accepts a manager and --remove-other, and nothing else', () => {
  expect(parseUseArgs('lefthook')).toEqual({ manager: 'lefthook', removeOther: false })
  expect(parseUseArgs(' pre-commit  --remove-other ')).toEqual({ manager: 'pre-commit', removeOther: true })
  expect(parseUseArgs('')).toBeUndefined()
  expect(parseUseArgs('husky')).toBeUndefined()
  expect(parseUseArgs('lefthook --force')).toBeUndefined()
})

test('removeManager uninstalls with Homebrew when it was installed that way', async () => {
  const fake = bothInstalled()
  fake.commands['brew list --versions pre-commit'] = { stdout: 'pre-commit 4.7.0\n' }
  fake.commands['brew uninstall pre-commit'] = {}
  expect(await removeManager(fakeHost(fake), 'pre-commit')).toBe('Removed pre-commit with Homebrew.')
  expect(fake.ran).toContain('brew uninstall pre-commit')
})

test('removeManager leaves a non-Homebrew install in place and says how to remove it', async () => {
  const fake = bothInstalled()
  fake.commands['brew list --versions lefthook'] = { exitCode: 1 }
  const text = await removeManager(fakeHost(fake), 'lefthook')
  expect(text).toContain('was not installed with Homebrew, so it was left in place')
  expect(text).toContain('npm uninstall -g lefthook')
  expect(fake.ran.some(c => c.startsWith('brew uninstall'))).toBe(false)
})

test('removeManager does nothing when the manager is not installed', async () => {
  const fake = lefthookOnly()
  expect(await removeManager(fakeHost(fake), 'pre-commit')).toBe('pre-commit is not installed, so there is nothing to remove.')
})

test('removeManager lists uv among the ways to remove a non-Homebrew pre-commit', async () => {
  const fake = bothInstalled()
  fake.commands['brew list --versions pre-commit'] = { exitCode: 1 }
  const text = await removeManager(fakeHost(fake), 'pre-commit')
  expect(text).toContain('uv tool uninstall pre-commit')
  expect(text.indexOf('brew uninstall pre-commit')).toBeLessThan(text.indexOf('uv tool uninstall'))
})

test('on Windows removeManager never calls brew and lists Windows ways first', async () => {
  const fake = bothInstalled()
  const host = { ...fakeHost(fake), toolDir: 'C:\\Users\\dev\\.claude\\plugins\\secret-guard' }
  expect(isWindows(host)).toBe(true)
  const preCommit = await removeManager(host, 'pre-commit')
  expect(preCommit).toContain('Remove it with one of: uv tool uninstall pre-commit')
  expect(preCommit).not.toContain('brew')
  const lefthook = await removeManager(host, 'lefthook')
  expect(lefthook).toContain('Remove it with one of: scoop uninstall lefthook')
  expect(fake.ran.some(c => c.startsWith('brew'))).toBe(false)
})

test('isWindows is false for a POSIX mod folder', () => {
  expect(isWindows(fakeHost(base()))).toBe(false)
})

test('a pick of a manager that is not installed is refused with how to install it', () => {
  const text = notInstalledPick(fakeHost(base()), 'pre-commit')
  expect(text).toContain('pre-commit is not installed, so the pick was not kept and nothing was changed.')
  expect(text).toContain('brew install pre-commit')
  expect(text).toContain('then run /secret-guard-use pre-commit again')
})

test('on Windows the install hint for a refused pick never names Homebrew', () => {
  const host = { ...fakeHost(base()), toolDir: 'C:\\Users\\dev\\.claude\\plugins\\secret-guard' }
  const text = notInstalledPick(host, 'lefthook')
  expect(text).toContain('Install it with one of: scoop install lefthook')
  expect(text).not.toContain('brew')
})

test('removalWarning asks for confirmation before anything is removed', () => {
  expect(removalWarning('pre-commit', 'lefthook')).toContain('/secret-guard-use lefthook --remove-other')
})

// --- Folders where commands cannot start (Windows long paths) -------------------------------------

test('a folder where commands cannot start gets a warning instead of a silent skip', async () => {
  const fake = base()
  fake.commands['git --version'] = { stdout: 'git version 2.51.0\n' }
  fake.unreachable = ROOT
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })).toEqual({ kind: 'warn', message: UNREACHABLE })
  expect(Object.keys(fake.files)).toEqual([])
})

test('tools are checked from the mod folder, so a project folder failure is not read as gitleaks missing', async () => {
  const fake = base()
  fake.commands['git --version'] = { stdout: 'git version 2.51.0\n' }
  fake.unreachable = ROOT
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome.kind).not.toBe('skip')
})

test('with git missing everywhere, a folder is skipped as before', async () => {
  const fake = base()
  delete fake.commands['git rev-parse --show-toplevel']
  expect(await locateProject(fakeHost(fake), ROOT)).toEqual({ kind: 'none' })
})

// --- Husky on any platform -------------------------------------------------------------------------

test("Husky is turned on through node and the package's own bin entry", async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"},"scripts":{"prepare":"husky"}}'
  fake.files[`${ROOT}/node_modules/husky/package.json`] = '{"name":"husky","bin":"./bin.js"}'
  fake.commands[`node ${ROOT}/node_modules/husky/bin.js`] = {}
  expect((await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })).kind).toBe('added')
  expect(fake.ran.some(c => c.includes('node_modules/.bin/husky'))).toBe(false)
})

test('without node_modules, Husky is not turned on and the notice says to run the install', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"},"scripts":{"prepare":"husky"}}'
  const outcome = await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  expect(outcome).toEqual({
    kind: 'warn',
    message: 'Wrote .husky/pre-commit, but could not turn Husky on (are node_modules installed?). Run the project install.',
  })
})

test("the installed hook is found through --git-common-dir, never the null-device path Claude Code's override gives", async () => {
  const fake = lefthookOnly()
  fake.files[`${ROOT}/lefthook.yml`] = lefthookConfig(SCAN)
  fake.files[`${ROOT}/.git/hooks/pre-commit`] = LEFTHOOK_HOOK
  fake.tracked.push('lefthook.yml')
  // Before 1.1.3 the hook was looked up at \\.\NUL\pre-commit, which Claude Code refuses on Windows.
  expect(await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })).toEqual({ kind: 'ok' })
  expect(fake.ran).not.toContain('git rev-parse --path-format=absolute --git-path hooks/pre-commit')
  expect(fake.ran).not.toContain('lefthook install')
})

test('scanCommand picks the command for the gitleaks version', () => {
  expect(scanCommand('v8.18.4')).toBe('gitleaks protect --staged --redact --verbose')
  expect(scanCommand('8.19.0')).toBe('gitleaks git --pre-commit --redact --staged --verbose')
})

test('prependBlock keeps the shebang first', () => {
  expect(prependBlock('#!/bin/sh\nnpm test\n', 'X\n')).toBe('#!/bin/sh\nX\nnpm test\n')
})

test('prependBlock gives the block the line endings of a CRLF hook', () => {
  expect(prependBlock('#!/bin/sh\r\nnpm test\r\n', 'X\nY\n')).toBe('#!/bin/sh\r\nX\r\nY\r\nnpm test\r\n')
  expect(prependBlock('npm test\r\n', 'X\n')).toBe('X\r\nnpm test\r\n')
  expect(prependBlock('#!/bin/sh', 'X\n')).toBe('#!/bin/sh\nX\n')
})

test('a CRLF Husky hook gets the gitleaks step with CRLF line endings only', async () => {
  const fake = base()
  fake.files[`${ROOT}/package.json`] = '{"devDependencies":{"husky":"^9.1.0"},"scripts":{"prepare":"husky"}}'
  fake.files[`${ROOT}/.husky/pre-commit`] = '#!/usr/bin/env sh\r\nnpm test\r\n'
  installHusky(fake)
  await ensureGuard(fakeHost(fake), ROOT, { autoInstallHusky: false })
  const hook = fake.files[`${ROOT}/.husky/pre-commit`] ?? ''
  expect(hook).toContain('gitleaks git --pre-commit')
  expect(hook.replace(/\r\n/g, '')).not.toContain('\n')
})

test('the Husky step names no platform-specific install command, since teammates may use any system', () => {
  const block = huskyBlock(SCAN)
  expect(block).not.toContain('brew')
  expect(block).toContain('https://github.com/gitleaks/gitleaks#installing')
})
