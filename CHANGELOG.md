# Changelog

## [1.1.0] - 2026-10-17

- Lefthook support: secret-guard writes a `lefthook.yml` with a gitleaks command and runs `lefthook install`, writing the config first so Lefthook does not create an empty one. A project's existing Lefthook config is used in any file name and format Lefthook reads.
- A JS/TS project without Husky gets Lefthook when it is installed, instead of a notice to add Husky as a dependency.
- When both pre-commit and Lefthook are installed and none is picked, a notice once per session asks you to pick one.
- `/secret-guard-use pre-commit|lefthook` keeps your pick, switches projects secret-guard set up with the other manager (removing that manager's hook first), and with `--remove-other` uninstalls the other manager through Homebrew, or says how when it was installed another way.
- A Lefthook worktree whose config is missing gets one: such commits otherwise run without a secret scan.
- A project with both a Lefthook and a pre-commit config gets a notice naming the file to delete.
- pre-commit and Lefthook hooks are told apart by their own markers, so one is never taken for the other.

## [1.0.3] - 2026-10-16

- Fixed: in a worktree, commits were blocked with `No .pre-commit-config.yaml file was found`. A worktree shares the repository's installed hook but not an uncommitted config; secret-guard now creates the config when the hook is installed and the config is missing.
- When Claude enters a worktree with the EnterWorktree tool, secret-guard checks that worktree before the tool result goes back, so the config is in place before work starts.
- A notice reminds you to commit `.pre-commit-config.yaml` or `.husky/pre-commit` when it is set up but not committed, with the `git add` command.
- Each repository is checked once per session.

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

[1.1.0]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.1.0
[1.0.3]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.3
[1.0.2]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.2
[1.0.1]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.1
[1.0.0]: https://github.com/AnnihilationWizard/secret-guard/releases/tag/v1.0.0
