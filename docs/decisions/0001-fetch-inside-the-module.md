# 0001. Fetch the issue inside the module

- Status: accepted
- Date: 2026-09-17

## Context

`/jira <KEY>` is a pane display action. A person types it to see one
issue. Routing that fetch through a model turn would spend tokens and
time on every single lookup, for a task that has no need for a model's
judgment.

The function-hooks API gives the module a direct path instead:
`$.mcp.call`. Its type declarations describe it as using the engine's own
connection and credential for the target MCP server, and state that it does
not raise a permission prompt.

## Decision

The `command.run` hook for `/jira` calls `$.mcp.call` directly to fetch the
issue. The refresh press (the `↻` button) calls the same function. Neither
path goes through a model turn. The fetched result goes into plugin state;
the render hook reads that state and draws the pane. The render hook itself
never calls `$.mcp.call`.

## Consequences

Whether `$.mcp.call` can reach an MCP server that a different plugin
brought into the session is not confirmed on this development machine,
which has no Jira MCP server connected. If a later session shows that it
cannot reach such a server, the fallback design is a skill that lets the
model call the tool, with the module reading the result through the
`tool.call` hook and drawing it from there. A move to that design gets its
own decision note, since it changes where the fetch happens and what it
costs per lookup.
