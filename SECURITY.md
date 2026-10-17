# Security Notes

secret-guard adds a gitleaks pre-commit hook to Git projects you open in Claude Code. These notes describe what it can reach; they do not establish a support SLA.

## What the mod does

- It hooks `session.start` and the EnterWorktree tool, and works in the session's Git project or the new worktree only.
- It runs `gitleaks version`, `git`, `pre-commit --version`, `pre-commit install`, `lefthook version` and `lefthook install`. When it switches a project it set up to the other manager, it runs that manager's `uninstall`. In JS/TS projects it may run Husky's own script from `node_modules/husky` with `node`, and, only when `autoInstallHusky` is on, the project's package manager to add Husky; on Windows, a package manager that cannot start directly is run through `cmd /d /s /c` with the same fixed arguments.
- It writes `.pre-commit-config.yaml`, `lefthook.yml` or `.husky/pre-commit` in the project and may add a `prepare` script to `package.json` itself, keeping the file's formatting. It never rewrites a hook config that already exists, and never deletes files.
- `/secret-guard-use <manager> --remove-other` runs `brew list` and `brew uninstall` for the other manager, only when you type that flag and never on Windows. It keeps your pick with Claude Code's plugin storage.
- It makes no network requests of its own. Installing Husky downloads it through the project's package manager, which runs that package's install scripts.
- It does not read or send secrets. gitleaks runs locally at commit time, with findings redacted.

A pre-commit hook is a safety net, not a guarantee. It can be skipped with `git commit --no-verify`, does not scan history that is already committed, and only finds what gitleaks rules match. Rotate any secret that was committed, even if it was later removed.

## Report a security concern

If this repository offers GitHub private vulnerability reporting, use the **Report a vulnerability** option on its [Security page](https://github.com/AnnihilationWizard/secret-guard/security). This document does not assume that the option is enabled.

If no private reporting option is available, open a minimal issue asking the maintainer to arrange a private channel. Do not publish exploit details, credentials or private code in that issue.

Include the affected version, Claude Code version, environment, steps to reproduce and impact. No response-time or supported-version guarantee is currently stated.
