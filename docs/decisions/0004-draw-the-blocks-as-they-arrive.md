# 0004. Draw the response's blocks as they arrive

- Status: accepted
- Date: 2026-09-17

## Context

An MCP tool result carries its main content as a list of blocks, typically
text, plus an optional `structuredContent` field. This development machine
has no Jira MCP server connected, so the shape of a real Jira tool's
response is not confirmed here: which fields `structuredContent` carries,
whether a summary or a status arrives as its own block, and how a
multi-field issue is laid out are all open questions.

## Decision

Milestone 1 draws each text block from the response's content list, in the
order the response lists them. It draws `structuredContent`, when present,
as its raw JSON, under a fold that starts closed. This asks nothing of the
shape of the JSON inside, so it draws correctly whether that shape turns
out to be simple or deeply nested.

## Consequences

The pane does not yet give summary, status, or assignee their own drawn
heading, because doing that well needs a known field layout to draw
against. That layout will come from capturing one real response as a
fixture (see `0003-fixture-mode.md`) and reading its `structuredContent`
shape.
