# 0010. The pane draws on Claude Code Desktop

- Status: accepted
- Date: 2026-10-15

## Context

Since Claude Code 2.1.287, mods load by default, and the Code tab of Claude Code Desktop draws
a mod's `Pane` on the `desktop` surface. The render hook drew only when `e.surface` was
`terminal` and passed every other surface to `next(e)`. On the desktop, `/jira DEMO-1` opened
a pane with no issue in it.

The desktop's element table has `Box`, `Button`, `Link` and `Text` with the same props as the
terminal's.

The divider is a row of `─`, as many as `bodyColumns` less the two side paddings. On the
terminal, one cell too many wrapped a `─` onto a second row (0009). How the desktop paints a
cell was not measured.

## Decision

- The render hook draws the same tree on `terminal` and `desktop`. `Ui` is typed with
  `Elements['terminal' | 'desktop']`. Other surfaces still go to `next(e)`.
- The divider's `Text` takes `wrap: 'truncate'`. A divider that is too long for the row is cut,
  not wrapped. On the terminal the divider fits the row, so nothing changes there.
- CI moves from Claude Code 2.1.273 to 2.1.280. The test kit of 2.1.273 presses a Button only
  on the terminal drawing; the kit of 2.1.280 presses one on the desktop drawing too. 2.1.280
  is the version grilling-pane pins, and it is 23 days old today. The `ui.open` stub of the
  tests answers `{ isPlaced: true }`, as the 2.1.280 declarations require.

## Consequences

- Tests render the pane on both surfaces and compare the trees on both tabs, and arm the issue
  from the desktop.
- The mobile app has the same four elements, but the pane does not draw there yet: no test
  covers it.
- A check in the real desktop app is still to do: the test kit checks the tree, not how the
  desktop paints it.
