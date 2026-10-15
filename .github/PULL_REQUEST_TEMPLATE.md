## Problem and behavior

Describe the problem and the resulting behavior.

## Related issue

Link the relevant issue, when applicable.

## Verification

List the commands actually run and their results (`claude plugin validate .`, `claude plugin test .`, type-check), the Claude Code, gitleaks and pre-commit versions, and checks not run.

## Risks and limitations

State which kinds of projects the change affects, compatibility with other tool versions, and anything the change leaves undone.

## Checklist

- [ ] The change is focused and never rewrites a config the user already has.
- [ ] Tests, README and CHANGELOG are updated when behavior changes.
- [ ] The diff contains no credentials, gitleaks findings, private code or generated `.claude-plugin/types/` files.
