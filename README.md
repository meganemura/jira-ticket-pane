# jira-ticket-pane

A Claude Code plugin (a Claude Mod). `/jira DEMO-1` fetches one Jira issue
from an MCP server already connected to the session, and draws it in a pane
beside the transcript. The fetch runs inside the plugin. It never runs as
part of a model turn.
A button on the pane arms the issue text to ride the next prompt as context.

## Requirements

- Claude Code with function hooks enabled: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
  This is early access. The API can change between releases.
- CI pins Claude Code version 2.1.273.
- An MCP server connected to the session, with a tool that reads Jira issues.
- A terminal surface. `-p` has no pane.

## Install

```sh
git clone <repository URL>
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "<clone>/plugin"
```

The repository has no public URL yet.

## `/jira`

- `/jira <KEY>` fetches the issue and draws it in the pane. It opens the
  pane if the pane is closed.
- `/jira` with no key toggles the pane's display.
- The `↻` button refetches the current issue. The plugin polls nothing on a
  timer.
- The `attach to next prompt` button arms the issue text. Press it again to
  drop the text. The text drops on its own once a prompt goes out. The
  plugin does not write into the prompt box.
- `prompt.submit`'s `context` field holds up to 32,000 characters in
  total, across every block already on the prompt. The plugin fits the
  armed issue text to the room left in that budget.
- When the full text does not fit, the plugin keeps whole lines up to
  that room. It adds a cut note at the end of the attached text. The
  model reads the note. The pane does not show it.
- When even the header does not fit, the plugin drops the attach and
  shows one status line.
- The issue's structured content sits under a fold.
- A key matches `[A-Z][A-Z0-9]+-\d+`.

## `/jira config`

By default the plugin finds the tool to call at run time. The search rule:
an MCP tool whose name contains both "jira" and "issue", and one of "get",
"fetch", "read", or "show". When more than one tool matches, the plugin
picks the one with the shortest name.

When the search finds no match, the pane lists the names of the MCP tools
connected to the session.

- `/jira config server=<name> tool=<name>` pins a specific server and tool.
- `/jira config clear` returns to the default search.

A pinned value lives in the plugin's own store and outlasts the session.

To call the tool, the plugin tries three argument names in order:
`issueKey`, `issueIdOrKey`, `key`.

## Fixture mode

Set `JIRA_TICKET_PANE_FIXTURE=<dir>` to read `<dir>/<KEY>.json` in place of
a call to a real MCP server. Each JSON file takes the shape of an MCP tool
result: a `content` field, an `isError` field, and an optional
`structuredContent` field.

Try it:

```sh
JIRA_TICKET_PANE_FIXTURE="$PWD/plugin/tests/fixtures" CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$PWD/plugin"
```

Then, inside the session, run `/jira DEMO-1`.

## Development

Run `/plugin-types` once in a new checkout. It writes
`.claude/types/claude-code.d.ts`, which the type checker reads.

Three gates, run before a commit:

```sh
claude plugin validate plugin
npx -p typescript tsc -p plugin/hooks
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin
```

A hook failure fails open: the session keeps running, and the failure
appears only in `~/.claude/debug/<session>.txt`.

## Limits

- The plugin reads issues. It does not write to Jira.
- It fetches one issue at a time.
- It does not manage authentication. When the MCP server returns an error,
  the pane shows the server's error text as is.
- The plugin has not run against a real Atlassian MCP server. Rendering
  fields such as summary, status, and assignee as their own headings
  waits for a look at that server's response shape.
