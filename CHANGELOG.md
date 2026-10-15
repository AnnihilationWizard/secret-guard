# Changelog

## [1.0.2] - 2026-10-16

- Fixed: projects without a `package.json` were never set up, and showed `core.hooksPath is set to /dev/null`. Claude Code runs a mod's git with `-c core.hooksPath=/dev/null`; secret-guard now reads `core.hooksPath` only from the project's local, global and system config files.
- Fixed: a JS/TS project whose hook already ran gitleaks was reported as having Husky off for the same reason.
- Fixed: notices no longer repeat the mod's name (`secret-guard: secret-guard: …`), since Claude Code already heads each toast with it.

## [1.0.1] - 2026-10-15

- Notices are now in English, such as `Created .pre-commit-config.yaml (gitleaks) and ran pre-commit install.`
- The comment line in a generated `.pre-commit-config.yaml` and the `.husky/pre-commit` step, including its warning when gitleaks is missing, are now in English.
- A test checks that every notice and generated file is in English.

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

[1.0.2]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.2
[1.0.1]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.1
[1.0.0]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.0
