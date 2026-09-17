# AGENTS.md

Context for agents that work in this repository.

## What this is

jira-ticket-pane, a Claude Code plugin whose behavior lives in one hooks
module (a "Claude Mod"). `/jira <KEY-123>` fetches one Jira issue through an
MCP server the session already has, and draws it in a pane beside the
transcript. The fetch runs inside the module (`$.mcp.call`), not in a model
turn. A press on the pane arms the issue text to ride the next prompt as
context.

The plugin lives in `plugin/`. There is no build step and no runtime package
dependency.

## Visibility

The repository is private today. The layer is public-possible: commit
messages, comments, README and docs are in English. Follow ASD-STE100
Simplified Technical English. Never commit a real issue key, a real Jira
site name, or a real issue body. Fixtures use invented keys (`DEMO-1`).

## Rules

- Function hooks are early access. The module loads only where
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. The API can change between
  releases. The types come from `/plugin-types`, which writes
  `.claude/types/claude-code.d.ts` at the repository root; that directory is
  gitignored, so run `/plugin-types` once in a new checkout.
- The validator reads the module statically. Hand `$` only to function
  declarations at the top of the module, and spell every call
  `$.noun.event(...)`. Build one `host` bundle of closures over `$` at
  `session.start`; the rest of the module holds the host, never `$`.
- Never fetch from the render hook. Fetch on `command.run` and on the refresh
  press, keep the result in state, and draw from state.
- Every `Pane` element prop must be one the surface declares. One unknown
  prop drops the whole tree without a message. Type the element constructors
  with `Elements['terminal']` so the compiler catches it.
- Tests are `plugin/tests/*.test.ts`, run with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin`. They stub
  `mcp.call`, `tool.list`, `fs.read`, `ui.status` and `store.get`/`store.set`.
  No test reaches a real MCP server.
- Quality gates: `claude plugin validate plugin`, `npx -p typescript tsc -p
  plugin/hooks`, and the plugin tests. Run all three before a commit.
- Development loop: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir
  "$PWD/plugin"` in a real terminal. `-p` has no pane surface. Hook failures
  are fail-open and appear only in `~/.claude/debug/<session>.txt`.
- Design decisions go to `docs/decisions/` as short numbered notes
  (Context / Decision / Consequences).
- Commits are semantic units. Comments say why, not what. Each module starts
  with its responsibility and what it must not know about.
- Adding a dependency: exact pin, released 7 or more days ago with no
  security fix after it, and ask the owner first with the reason.
