# 0006. No poll; refetch is always a deliberate action

- Status: accepted
- Date: 2026-09-17

## Context

An open pane could refetch its issue on a timer, the way a pull request's
checks change while a person watches. A Jira issue's fields rarely change
within the span of one session. A timer would mostly repeat calls to the
MCP server for no new information.

## Decision

The plugin refetches an issue only two ways: typing `/jira <KEY>` again,
and pressing the `↻` button. Each is an action a person takes on purpose.
The plugin sets no timer.

## Consequences

The plugin has no timer, so it has nothing to cancel when the pane
closes. Its `ui.close` handler only tracks whether the pane is open or
closed; it does not stop a timer, because there is no timer to stop. A
change made to an issue elsewhere, after it was fetched, will not appear
in the pane until a person presses `↻` or retypes `/jira <KEY>`.
