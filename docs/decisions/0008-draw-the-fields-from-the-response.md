# 0008. Draw summary, status, and the other fields from the response

- Status: accepted
- Date: 2026-09-19

## Context

`0004-draw-the-blocks-as-they-arrive.md` drew each text content block
as its own line and left `structuredContent` as raw JSON under a fold,
since no real Jira MCP server's response shape was on hand at the time.

A session against Atlassian's own MCP server showed that shape. The
tool's result carries one text content block, holding a JSON string:
`{ "issues": { "nodes": [{ "key", "fields": { "summary", "issuetype",
"status", "priority", "assignee", "reporter", "labels", "description",
"created", "updated" }, "webUrl" }] } }`. The tool sets no
`structuredContent`. Sending `responseContentFormat: "markdown"` did not
change `description`: it still came back as Atlassian Document Format
(ADF), a tree of typed nodes such as `paragraph` and `bulletList`.

## Decision

`issueViewOf` parses each text content block as JSON in turn and reads
the first one shaped like `{ issues: { nodes: [...] } }` into a plain
`IssueView`: one string per field, always, with `''` standing in for an
absent or a `null` field. `adfTextOf` turns an ADF node into text: a
`paragraph` or `heading` joins its children then ends with a newline, a
`bulletList` or `orderedList` gives one `- `-led line per item, and every
other node recurses into its children.

The pane draws a bold `<key> <summary>` heading, a dim
`<type> · <status> · <priority> · <assignee>` line, labels when the
issue has any, the description, and the url. The armed text that rides a
prompt draws the same heading and description.

No content block matching `issues.nodes` falls back to `0004`'s block
drawing. The fold still shows raw JSON either way: `structuredContent`
when the tool sends one, else the parsed block `issueViewOf` read.

## Consequences

A server answering a different JSON shape, or plain text, still draws
through the block-drawing fallback; only the confirmed shape gets the
field-by-field heading. An ADF node type outside `adfTextOf`'s known set
still reads as text through the generic recursion, keeping the words and
losing only that node's own structure.
