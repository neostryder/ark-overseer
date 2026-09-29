# Contributing to ARK Overseer

Bug reports and feature requests are welcome as issues. Search the open issues first, and say which version you run (the This computer page shows it), what you did, and what happened instead of what you expected. A log excerpt helps; the service writes its logs to `C:\ProgramData\ARK Overseer\logs`. Remove any passwords first.

## Pull requests

ARK Overseer is offered under the AGPL-3.0 and, separately, under commercial licenses. To keep both possible, every contributor agrees to the [contributor license agreement](CLA.md) before a pull request is merged. Say so in a comment on your pull request: "I have read the ARK Overseer CLA and I agree to it." One agreement covers all your later contributions.

Before you open a pull request:

- Run `npm test`, `npm run format:check` and `npm run check`. All three must pass.
- Add a test for every behavior you add or change, and make sure the test fails without your change.
- Add a line under `## [Unreleased]` in `CHANGELOG.md`. Each line starts with `[Visible]` or `[Internal]`, then category tags, then a short bold title and what changed from the user's side.
- Keep user-facing text short, plain and direct, with plain ASCII punctuation. Every string a user reads lives in `public/js/strings.js` or in a `MESSAGES` object beside the code that raises it.
- Every child process started from Node passes `windowsHide: true`, and PowerShell is only ever `pwsh`.

Small, focused pull requests are easier to review than large ones. If you plan a big change, open an issue first so we can agree on the shape of it.
