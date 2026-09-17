# 0003. Fixture mode reads MCP tool result shapes from disk

- Status: accepted
- Date: 2026-09-17

## Context

This development machine has no Jira MCP server connected, so testing the
pane by hand needs a stand-in for a real fetch. The stand-in needs to
exercise the same drawing and arming code that a real fetch would use.

`$.env.get` requires its variable name to be a string literal, because the
validator that checks the module statically reads that name and lists it
among the variables the plugin reads.

## Decision

Setting `JIRA_TICKET_PANE_FIXTURE=<dir>` makes the plugin read
`<dir>/<KEY>.json`. The plugin skips the call to an MCP server. Each
fixture file
takes the shape of an MCP tool result: a `content` field, an `isError`
field, and an optional `structuredContent` field. Because a fixture takes
that exact shape, the code that draws the pane and the code that arms an
issue's text run the same path whether the result came from a fixture file
or a real call.

Every fixture value is invented. When a fixture is built from a real
response for reference, only the field names come from that response; the
values are replaced.

## Consequences

A fixture is a guess at the response shape: no real response has
confirmed it on this development machine. A field a real server sends
but no fixture covers stays untested until a fixture adds it.
