# 0002. Find the Jira tool at run time

- Status: accepted
- Date: 2026-09-17

## Context

The plugin does not hard-code which MCP server or which tool serves a Jira
issue. This development machine has no Jira MCP server connected, and a
server's name differs from one installation to the next, so a fixed name
would not travel.

`ToolInfo`, the type the function-hooks API exposes for a connected tool,
has the shape `{ name, description, mcp }`. It carries no separate field
for the server the tool came from. The plugin recovers the server name by
splitting the tool's full name at its first `__`, since the convention is
`mcp__<server>__<tool>` and the tool's own name can itself contain `__`.

## Decision

By default, the plugin searches connected MCP tools for one whose name
contains both "jira" and "issue", and one of "get", "fetch", "read", or
"show". When more than one tool matches, it picks the one with the
shortest name.

When the search finds no match, the pane lists the names of the MCP tools
connected to the session, so a person can see what is available and set a
tool by hand.

`/jira config server=<name> tool=<name>` pins a specific server and tool,
replacing the search. `/jira config clear` removes the pin and returns to
the default search. A pin lives in the plugin's own store and outlasts the
session.

To call the chosen tool, the plugin tries three argument names in order:
`issueKey`, `issueIdOrKey`, `key`. It moves to the next name only when the
prior call's result carries `isError`. The last call's error text goes to
the pane unchanged.

## Consequences

The search rule is a guess. No real Jira MCP server's tool list was
available when it was written. Once a session against a real
server shows the correct tool name and argument name, this note gets two
lines added recording them, and the default search or the argument order
can change to match. A server whose tool needs an argument beyond the
three tried here fails all three calls; the pane's error text is the only
diagnostic a person has in that case.

Note, 2026-09-19: a session against Atlassian's own MCP server confirmed
`getJiraIssue`, matching the rule above, with two required arguments,
`cloudId` and `issueIdOrKey`. The order is now `issueIdOrKey`, `issueKey`,
`key`. The plugin resolves `cloudId` from the same server's
`getAccessibleAtlassianResources` tool, or from `/jira config cloud=<id>`.
