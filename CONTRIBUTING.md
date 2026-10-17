# Contributing

Thank you for helping improve secret-guard. It is a small Claude Code mod written as a plugin of function hooks. Start with the [README](README.md).

## Report a bug

Use the [issue tracker](https://github.com/AnnihilationWizard/secret-guard/issues). Include:

- The secret-guard version, Claude Code version (`claude --version`) and operating system.
- The versions of `gitleaks`, `pre-commit` and `lefthook` you have installed, and the package manager for JS/TS projects.
- The kind of project: plain Git repository, pre-commit or Lefthook config, JS/TS with or without Husky, pnpm workspace, Yarn Plug'n'Play.
- The notice secret-guard showed and what you expected it to do.
- Any transcript line that names `secret-guard`.

Never paste secrets, gitleaks findings, source code or paths you are not allowed to share. For security concerns, follow [SECURITY.md](SECURITY.md).

## Propose a change

Open an issue that describes the problem and the intended behavior before a broad change. Keep changes focused: secret-guard should only add a missing gitleaks hook, never rewrite a config the user already has.

## Develop and verify

Run from the repository root:

```bash
claude plugin validate .
claude plugin test .
npx -p typescript@5 tsc -p .
```

The type-check needs the types Claude Code writes to `.claude-plugin/types/` the first time it loads the mod, for example with `claude --plugin-dir .`.

For behavior changes, add or update a test in `tests/guard.test.ts`. The tests drive the setup logic through an in-memory host, so they need no real repository or network.

## Submit a pull request

- Explain the problem and the resulting behavior.
- List the checks you ran and their results.
- Update the README and CHANGELOG when behavior changes.
- Use a Conventional Commit message, such as `fix: skip projects with a broken package.json`.
