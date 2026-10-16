# secret-guard

<p align="center">
  <strong>Secrets stop at the commit.</strong><br>
  A Claude Code mod that adds a gitleaks pre-commit hook to each Git project you open.
</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/Version-1.0.3-green.svg" alt="Version 1.0.3"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://code.claude.com/docs"><img src="https://img.shields.io/badge/Platform-Claude%20Code-D97757.svg" alt="Platform: Claude Code"></a>
  <a href="hooks/register.ts"><img src="https://img.shields.io/badge/Type-Function%20hooks%20mod-6E7681.svg" alt="Function hooks mod"></a>
  <a href="tests/guard.test.ts"><img src="https://img.shields.io/badge/Tests-22%20passing-3FB950.svg" alt="22 tests passing"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

![Side-by-side terminal: on the left a fresh clone has no hook and a commit with a GitHub token lands in history; on the right secret-guard sets up a gitleaks hook when Claude Code starts and the same commit is stopped](docs/images/preview.svg)

*Illustration of a commit before and after.*

Installing `gitleaks` and `pre-commit` on your machine does not protect a repository until that repository has a hook config and someone runs `pre-commit install`. On a fresh clone, that step is easy to forget. secret-guard does it for you: when a Claude Code session starts in a Git project, it checks for a gitleaks pre-commit hook and adds one if it is missing. From then on, a commit that contains an API key, token or private key stops before it reaches history.

| | |
| --- | --- |
| **Runs** | When a session starts, and when Claude enters a worktree |
| **Needs** | `gitleaks`, plus `pre-commit` for projects without a `package.json` |
| **Writes** | `.pre-commit-config.yaml`, or `.husky/pre-commit` in JS/TS projects |
| **Never** | Rewrites an existing config, or adds dependencies unless you opt in |

> [!NOTE]
> secret-guard is built on Claude Code's function-hooks mod API, which is in early access and may change between releases.

## Features

- **Set up once per project:** A project that already has a gitleaks hook is left alone, and the check never delays your first prompt.
- **pre-commit for most projects:** Writes a `.pre-commit-config.yaml` that runs your installed `gitleaks`, then runs `pre-commit install`.
- **Husky for JS/TS:** Puts the gitleaks step at the top of `.husky/pre-commit`, ahead of existing commands, and turns Husky on.
- **Worktrees work too:** A worktree shares the repository's installed hook but not an uncommitted config, so its commits would be blocked. secret-guard adds the config there, and reminds you to commit it so every worktree and clone has it.
- **Respects your setup:** An existing `.pre-commit-config.yaml` without gitleaks, or a `core.hooksPath` set by another tool, gets a notice instead of a change.
- **No surprise dependencies:** Husky is added to `package.json` only when you turn on `autoInstallHusky`.
- **Safe defaults for builds:** A `prepare` script added by secret-guard is `husky || true`, so installs without dev dependencies do not fail.

| Project | What secret-guard does |
| --- | --- |
| Not a Git repository, or `gitleaks` not installed | Nothing |
| No `package.json` and no `.pre-commit-config.yaml` | Creates the config and runs `pre-commit install` |
| `.pre-commit-config.yaml` with gitleaks, hook not installed | Runs `pre-commit install` |
| Hook installed but no `.pre-commit-config.yaml`, as in a new worktree | Creates the config, so commits are no longer blocked |
| Set up, but the config or `.husky/pre-commit` is not committed | Shows a notice with the `git add` command |
| `.pre-commit-config.yaml` without gitleaks | Shows a notice and leaves the file as it is |
| `package.json` with Husky as a dependency | Adds gitleaks to `.husky/pre-commit` and turns Husky on |
| `package.json` without Husky | Shows the install command, or installs Husky when `autoInstallHusky` is on |

## Install

Install the tools secret-guard calls:

```bash
brew install gitleaks pre-commit
```

Then, in a Claude Code **terminal** session, run:

```
/plugin install secret-guard --marketplace AnnihilationWizard/secret-guard
```

1. Answer `y` to add the `github:AnnihilationWizard/secret-guard` marketplace.
2. Choose a scope. The **user** scope loads the mod in every session.
3. Claude Code confirms `Installed secret-guard. Plugin is now active.` The check runs in each session started after that.

To update later, run `claude plugin update`, then `/reload-plugins`.

<details>
<summary>Run from a local clone instead</summary>

```bash
git clone https://github.com/AnnihilationWizard/secret-guard.git
claude --plugin-dir ./secret-guard
```

To load a clone in every session, add it to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/secret-guard" }
}
```

</details>

## Usage

Start Claude Code in a Git project. If the project has no gitleaks hook, a notice says what secret-guard added. Then commit as usual. When gitleaks finds a secret in the staged changes, the commit stops and gitleaks prints the file, line and rule, with the secret redacted.

The pre-commit config secret-guard writes:

```yaml
repos:
  - repo: local
    hooks:
      - id: gitleaks
        name: gitleaks
        entry: gitleaks git --pre-commit --redact --staged --verbose
        language: system
        pass_filenames: false
```

With gitleaks older than 8.19, the entry is `gitleaks protect --staged --redact --verbose`.

To allow a false positive, add its fingerprint to a `.gitleaksignore` file in the project, or set an allowlist in `.gitleaks.toml`.

## Configuration

| Option | Default | Effect |
| --- | --- | --- |
| `autoInstallHusky` | `false` | In a JS/TS project without Husky, adds it as a dev dependency with the package manager the lockfile points to: pnpm, yarn, bun or npm. Changes `package.json` and the lockfile. |

Change it from the `/config` menu, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "secret-guard@secret-guard": {
      "options": { "autoInstallHusky": true }
    }
  }
}
```

In a pnpm workspace root, secret-guard installs with `pnpm add -w`.

### Limitations

- secret-guard sets up every Git project you open, including repositories you cloned only to read. Each project is set up once, and a notice names the change.
- A worktree is checked when a session starts in it or Claude enters it with EnterWorktree. Moving into one with a shell `cd` is not detected; commit the config once and every worktree has it.
- Teammates need `gitleaks` too. With the pre-commit config, a commit fails when `gitleaks` is missing. The Husky step prints a warning and lets the commit through.
- Husky sets `core.hooksPath`, so hooks in `.git/hooks` stop running in that project.
- Yarn Plug'n'Play projects have no `node_modules/.bin/husky`. secret-guard writes the hook and asks you to turn Husky on.
- The `/plugin install` command is available in terminal sessions only. A user-scope install also loads in the desktop app's Code tab.

## Development

```bash
claude plugin validate .   # manifest, marketplace file and hooks module
claude plugin test .       # tests/*.test.ts against the engine
```

After Claude Code first loads the mod, it writes the API types to `.claude-plugin/types/` (git-ignored). Type-check against them with TypeScript 5.4 or newer:

```bash
npx -p typescript@5 tsc -p .
```

Run `claude --plugin-dir .` to try changes. In an interactive session the folder is watched, and saving a file reloads the mod.

## Project Structure

```text
.claude-plugin/   plugin.json manifest and marketplace.json
hooks/            hooks.json, the session-start hook and the setup logic
tests/            tests for the setup logic
docs/images/      README illustration
```

## Contributing

Bug reports and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an [issue](https://github.com/AnnihilationWizard/secret-guard/issues) or pull request, and follow [SECURITY.md](SECURITY.md) for security reports.

## License

[MIT License](LICENSE). Copyright © 2026 [AnnihilationWizard](https://github.com/AnnihilationWizard).
