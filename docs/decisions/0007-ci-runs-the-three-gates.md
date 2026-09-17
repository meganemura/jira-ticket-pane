# 0007. CI runs the same three gates, pinned, with one stated exception

- Status: accepted
- Date: 2026-09-17

## Context

`claude plugin validate plugin`, `tsc -p plugin/hooks`, and the plugin
tests ran locally only, before a commit. Running them on every push and
pull request gives a change from anyone the same check.

A workflow that needs a secret is a bigger commitment than one that does
not. The pull-request-pane project checked this directly, with every
environment variable cleared except `HOME`, `PATH`, and `USER`, and its own
decision note records that all three gates, plus `/plugin-types` (needed
to write `.claude/types/`, which `tsc` reads), ran with nothing else set.
None of them calls the model. This repository has not run that check
itself; it carries the credential-free design forward from that record.

## Decision

`.github/workflows/test.yml` runs on every push to `main` and every pull
request: `actions/checkout`, `actions/setup-node` (Node 22.23.2), `npm
install -g @anthropic-ai/claude-code@2.1.273`, `/plugin-types` (under
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, the flag the plugin itself needs),
then the three gates, with `tsc` run through `npx --package
typescript@7.0.2 tsc -p plugin/hooks`, so CI pins the exact version it
runs.

Every pin is exact: `actions/checkout` and `actions/setup-node` by commit
SHA, `typescript` and Node by exact version. `@anthropic-ai/claude-code@2.1.273`
is a stated exception to the usual "released at least a week ago" rule:
`claude plugin test`, the subcommand these gates need, is absent from
earlier versions. pull-request-pane's own decision note records which
earlier version it checked; this repository has not repeated that check.
Function hooks are early
access, and this plugin already tracks that channel by design (see
AGENTS.md); the CI pin tracks the same channel. No secret is configured.

A separate note on checking versions by hand: npm's `min-release-age`
setting, set in a local `.npmrc`, hides any version newer than the
configured age from both `npm view` and `npm install`, with no error
naming the reason. A machine with that setting can show a short list and
hide a newer version that does exist.

## Consequences

- Bumping any pinned version is a deliberate edit to this file.
- The `claude` pin may need to move again on its own schedule, once a
  version that still runs `claude plugin test` is a week old.
- A person running the same gates locally can use an unpinned `typescript`;
  only CI is pinned.

Note, 2026-09-17: this repository ran the credential check after this note
was written. A new clone, an empty `HOME`, and only `PATH` and `USER` set:
`/plugin-types`, validate, `tsc` and the plugin tests all passed with the
2.1.273 native binary. The npm package of that version was not tested
here, because a local package-age guard hid it from `npm install`.
