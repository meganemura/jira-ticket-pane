# 0005. Attach the issue as prompt context

- Status: accepted
- Date: 2026-09-17

## Context

The function-hooks API offers two ways to hand text to the next prompt.
`prompt.fill` replaces the whole prompt box, and the module cannot read
back what a person already typed there before that replacement happens.
Using it would risk erasing a partly written prompt. `prompt.submit`
instead carries a `context` field that rides alongside whatever the person
typed, leaving the prompt box untouched.

## Decision

The `attach to next prompt` button arms the current issue's text by
storing it for the plugin's `prompt.submit` handler to add to `context`.
Arming clears once the prompt enters the session. A prompt the engine
drops leaves the arm in place. Fetching a new key also clears an existing
arm, since the armed text would otherwise no longer match what the pane
shows.

`prompt.submit`'s `context` field holds up to 32,000 characters in total,
across every block already on the prompt. The plugin fits the armed
issue text to the room left in that budget. When the full text does not
fit, the plugin keeps whole lines up to that room. It adds a cut note at
the end of the attached text. The model reads the note; the pane does
not show it. When even the header does not fit, the plugin drops the
attach and shows one status line.

The pane has one arm button. It arms the whole issue's text. Milestone 1
has no drag-select of part of the issue text: the button arms all of it,
or none of it. pull-request-pane measured hotkeys on two real terminal
setups and found that a `Button`'s hotkey inside a pane did not fire.
This button carries no hotkey for that reason.

## Consequences

Selecting part of an issue to attach, the way a person can drag over part
of a field in pull-request-pane, is deferred to a later milestone. Until
then, arming always sends the full issue text, which can be more than a
person wants to send for a short question about one field.
