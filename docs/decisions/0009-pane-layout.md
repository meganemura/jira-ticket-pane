# 0009. A top bar, a divider, and a header shared by both tabs

- Status: accepted
- Date: 2026-09-19

## Context

`0008` split the pane into an `issue` tab and a `meta` tab. The key, the
summary, and the status stayed inside the `issue` tab's own rows. A
person switching to `meta` lost sight of the status and the assignee,
the two fields most likely to answer "where does this stand".

## Decision

The pane now draws a fixed layout, top to bottom: a top bar, a divider,
a header, then the selected tab's body.

The top bar puts the tab buttons on the left and the refresh and attach
buttons on the right, in one row with space between the two groups.
Every button draws `plain`, so the row reads as a line of labels beside
the issue. The header — the key, the summary, the status, the type, the
priority, and the assignee — draws above both tabs, so the state of the
issue shows without a tab switch. The `issue` tab holds only the
description below the header; the `meta` tab holds the field list and
the raw JSON fold.

The status dot, `●`, takes its color from the issue's status category:
blue for new work, yellow for work in progress, green for done work.
Every other line stays dim or plain. One field carries color, so a
glance finds it.

## Consequences

`●` is a wide dingbat on some terminal fonts, two cells instead of one.
`•`, the bullet list marker `adfTextOf` now uses, carries the same risk.
Should either widen and throw off a line's spacing on a real terminal, a
plain `*` replaces it.

A `Link`'s `hover` style needs a keyed `Box` around it to take effect.
The `meta` tab's url row alone carries a key, `meta:url`, for this.

The divider's width follows the pane's own `bodyColumns`, less the one
column the pane's `paddingRight` already spends, so it stops at the
pane's right edge.
