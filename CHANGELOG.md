# Changelog

## [1.0.0] - 2026-10-15

Initial release of secret-guard by AnnihilationWizard.

- At session start, a background check looks for a gitleaks pre-commit hook in the current Git project and adds one when it is missing.
- Projects without a `package.json` get a `.pre-commit-config.yaml` that runs the installed `gitleaks`, followed by `pre-commit install`.
- JS/TS projects get the gitleaks step at the top of `.husky/pre-commit`, and Husky is turned on.
- An existing `.pre-commit-config.yaml` without gitleaks, or a `core.hooksPath` set by another tool, gets a notice instead of a change.
- `autoInstallHusky` option, off by default, adds Husky with the package manager the lockfile points to; pnpm workspace roots install with `-w`.
- A `prepare` script added by the mod is `husky || true`, so installs without dev dependencies do not fail.
- gitleaks older than 8.19 gets `gitleaks protect` instead of `gitleaks git`.
- Marketplace file so the repository installs with `/plugin install secret-guard --marketplace AnnihilationWizard/secret-guard`.
- Tests for each project case, run with `claude plugin test`.
- English README with an illustration, install and usage instructions, contribution guidance and security notes.

Built on Claude Code's early-access function-hooks mod API.

[1.0.0]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.0
