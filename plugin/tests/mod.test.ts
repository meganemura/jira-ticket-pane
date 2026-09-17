// Tests for the plugin's function-hooks module, run by `claude plugin test plugin` with
// `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The kit loads the module as the engine does and hands
// each test the engine's own `$`; the hooks a test registers with `on` sit beneath the module,
// where an MCP server, the file system and the terminal would be. Nothing here reaches a real
// MCP server: `mcp.call` answers from a script keyed on the server, tool and arguments given.

import type { CommandRunInput, McpToolResult, On, RenderInput, ToolInfo } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { contextTextOf, discoverTool, fittedContextTextOf, issueTextOf } from '../hooks/mod'

tier('user')

const PLUGIN = 'jira-ticket-pane'
const PANE_ID = 'jira-ticket-pane'
const COMMAND = 'jira'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PANE_ID,
  viewport: { columns: 120, rows: 40 },
  props: { title: PANE_ID, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

const RUN: CommandRunInput = { command: COMMAND, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

const TOOLS: ToolInfo[] = [{ name: 'mcp__atlassian__getJiraIssue', description: 'Get a Jira issue', mcp: true }]

const SUCCESS_RESULT: McpToolResult = {
  content: [{ type: 'text', text: 'DEMO-1: Sample summary' }, { type: 'text', text: 'A short description.' }],
  isError: false,
}

const STRUCTURED_RESULT: McpToolResult = {
  ...SUCCESS_RESULT,
  structuredContent: { key: 'DEMO-1', fields: { summary: 'Sample summary' } },
}

type McpCall = { server: string; tool: string; args: Record<string, unknown> }

type WorldOptions = {
  tools?: ToolInfo[]
  mcp?: (call: McpCall) => McpToolResult
  files?: Record<string, string>
  store?: Record<string, unknown>
  env?: Record<string, string>
}

// The world beneath the module: `tool.list`'s own tools, an `mcp.call` that answers from a
// script keyed on server, tool and arguments, `fs.read` over a fixed set of paths, and a
// terminal that keeps what was opened, closed and told as a status line.
function world(on: On, options: WorldOptions = {}) {
  const mcpCalls: McpCall[] = []
  let toolListCalls = 0
  let fsReadCalls = 0
  const opened: string[] = []
  const closed: string[] = []
  const statuses: (string | undefined)[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  on('mcp.call', ($, e) => {
    mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    const answer = options.mcp?.({ server: e.server, tool: e.tool, args: e.args })
    return { value: answer ?? { content: [], isError: true } }
  })

  on('tool.list', () => {
    toolListCalls += 1
    return { value: options.tools ?? [] }
  })

  on('fs.read', ($, e) => {
    fsReadCalls += 1
    const text = options.files?.[e.path]
    if (text === undefined) throw new Error(`no fixture file: ${e.path}`)
    return { value: text }
  })

  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: undefined }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  // Chain event: the bottom of `prompt.submit` echoes back the prompt as it arrived, `context`
  // included — without echoing it, an attach made on the way down would not show in the result.
  on('prompt.submit', ($, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))

  mock.store(on, options.store ?? {})
  mock.env(on, options.env ?? {})

  return {
    get mcpCalls() {
      return mcpCalls
    },
    get toolListCalls() {
      return toolListCalls
    },
    get fsReadCalls() {
      return fsReadCalls
    },
    opened,
    closed,
    statuses,
  }
}

// The strings a drawn tree carries: a Text's joined children, a Button's label.
function textOf(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('\n')
  if (typeof tree !== 'object' || tree === null) return ''
  const type: unknown = Reflect.get(tree, 'type')
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  if (type === 'Text') {
    return (Array.isArray(children) ? children : []).filter((child): child is string => typeof child === 'string').join('')
  }
  if (type === 'Button') {
    const label = typeof props === 'object' && props ? Reflect.get(props, 'label') : undefined
    return typeof label === 'string' ? label : ''
  }
  return textOf(children)
}

// A Button's `onPress` is not awaited by `$.ui.press`; it finishes after a few turns of the
// task queue. `setTimeout` is reached through the global object, as the module names no host
// globals of its own.
async function settle(): Promise<void> {
  const later = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => later(resolve, 0))
}

describe('mod', () => {
  test('/jira DEMO-1 fetches through the discovered MCP tool and draws the issue', async ($, on) => {
    const kept = world(on, { tools: TOOLS, mcp: () => SUCCESS_RESULT })
    await $.session.start(SESSION)

    const { text } = await $.command.run({ ...RUN, args: 'DEMO-1' })

    expect(text).toBe('jira-ticket-pane shows DEMO-1')
    expect(kept.opened).toEqual([PANE_ID])
    expect(kept.mcpCalls).toEqual([{ server: 'atlassian', tool: 'getJiraIssue', args: { issueKey: 'DEMO-1' } }])
    expect(textOf(await $.ui.render(PANE))).toContain('DEMO-1: Sample summary')
  })

  test('an isError result retries the next argument name until one answers', async ($, on) => {
    const kept = world(on, {
      tools: TOOLS,
      mcp: ({ args }) => {
        if ('issueKey' in args) return { content: [{ type: 'text', text: 'issueKey rejected' }], isError: true }
        return { content: [{ type: 'text', text: 'DEMO-1 via issueIdOrKey' }], isError: false }
      },
    })
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })

    expect(kept.mcpCalls.map((call) => Object.keys(call.args)[0])).toEqual(['issueKey', 'issueIdOrKey'])
    expect(textOf(await $.ui.render(PANE))).toContain('DEMO-1 via issueIdOrKey')
  })

  test('every argument name failing shows the last error text, unchanged', async ($, on) => {
    world(on, {
      tools: TOOLS,
      mcp: ({ args }) => {
        if ('issueKey' in args) return { content: [{ type: 'text', text: 'error: issueKey' }], isError: true }
        if ('issueIdOrKey' in args) return { content: [{ type: 'text', text: 'error: issueIdOrKey' }], isError: true }
        return { content: [{ type: 'text', text: 'error: key' }], isError: true }
      },
    })
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })

    const text = textOf(await $.ui.render(PANE))
    expect(text).toContain('error: key')
    expect(text).not.toContain('error: issueKey')
  })

  test('no candidate MCP tool lists only the connected MCP tools, not a built-in one', async ($, on) => {
    const tools: ToolInfo[] = [
      { name: 'Read', description: 'Read a file', mcp: false },
      { name: 'mcp__other__doSomething', description: 'Unrelated', mcp: true },
    ]
    world(on, { tools })
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })

    const text = textOf(await $.ui.render(PANE))
    expect(text).toContain('no Jira MCP tool found')
    expect(text).toContain('mcp__other__doSomething')
    expect(text).not.toContain('Read')
  })

  test('a pinned config skips tool.list and survives a fresh session.start', async ($, on) => {
    const kept = world(on, { mcp: () => SUCCESS_RESULT })
    await $.session.start(SESSION)

    const configured = await $.command.run({ ...RUN, args: 'config server=x tool=y' })
    expect(configured.text).toBe('jira-ticket-pane calls y on x')

    // A fresh session.start re-reads `state.config` from the store; if `config` had not been
    // written through, this would reset it to null and the next fetch would fall back to
    // `tool.list` discovery instead of the pinned tool.
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })

    expect(kept.toolListCalls).toBe(0)
    expect(kept.mcpCalls).toEqual([{ server: 'x', tool: 'y', args: { issueKey: 'DEMO-1' } }])
  })

  test('a config already in the store applies from session.start, with no /jira config command', async ($, on) => {
    const kept = world(on, { mcp: () => SUCCESS_RESULT, store: { config: { server: 'x', tool: 'y' } } })
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })

    expect(kept.toolListCalls).toBe(0)
    expect(kept.mcpCalls).toEqual([{ server: 'x', tool: 'y', args: { issueKey: 'DEMO-1' } }])
  })

  describe('fixture mode', () => {
    const FIXTURE_JSON = JSON.stringify(SUCCESS_RESULT)

    test('a fixture file answers the issue with no MCP call and no tool.list', async ($, on) => {
      const kept = world(on, { env: { JIRA_TICKET_PANE_FIXTURE: '/fx' }, files: { '/fx/DEMO-1.json': FIXTURE_JSON } })
      await $.session.start(SESSION)
      await $.command.run({ ...RUN, args: 'DEMO-1' })

      expect(textOf(await $.ui.render(PANE))).toContain('DEMO-1: Sample summary')
      expect(kept.mcpCalls).toEqual([])
      expect(kept.toolListCalls).toBe(0)
    })

    test('a missing fixture file shows an error line naming the path', async ($, on) => {
      world(on, { env: { JIRA_TICKET_PANE_FIXTURE: '/fx' }, files: {} })
      await $.session.start(SESSION)
      await $.command.run({ ...RUN, args: 'DEMO-1' })

      const text = textOf(await $.ui.render(PANE))
      expect(text).toContain('could not read')
      expect(text).toContain('/fx/DEMO-1.json')
    })

    test('a broken fixture file shows a parse error line', async ($, on) => {
      world(on, { env: { JIRA_TICKET_PANE_FIXTURE: '/fx' }, files: { '/fx/DEMO-1.json': '{ this is not json' } })
      await $.session.start(SESSION)
      await $.command.run({ ...RUN, args: 'DEMO-1' })

      const text = textOf(await $.ui.render(PANE))
      expect(text).toContain('could not parse')
    })
  })

  test('pressing attach arms the issue text to ride exactly the next prompt', async ($, on) => {
    const kept = world(on, { tools: TOOLS, mcp: () => SUCCESS_RESULT })
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'arm:button' })
    await settle()
    expect(kept.statuses.at(-1)).toContain('rides your next prompt')

    const first = await $.prompt.submit({ text: 'what does this ask for?', wait: false, origin: { kind: 'composer' } })
    expect(first.context ?? []).toHaveLength(1)
    expect(first.context?.[0]).toContain('DEMO-1')
    expect(first.context?.[0]).toContain('DEMO-1: Sample summary')

    const second = await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })
    expect(second.context ?? []).toHaveLength(0)
  })

  test('an argument that is not an issue key leaves status only, no calls, no pane', async ($, on) => {
    const kept = world(on, { tools: TOOLS })
    await $.session.start(SESSION)

    const lower = await $.command.run({ ...RUN, args: 'demo-1' })
    const short = await $.command.run({ ...RUN, args: 'DEMO' })

    expect(lower.text).toContain('is not an issue key')
    expect(short.text).toContain('is not an issue key')
    expect(kept.mcpCalls).toEqual([])
    expect(kept.toolListCalls).toBe(0)
    expect(kept.fsReadCalls).toBe(0)
    expect(kept.opened).toEqual([])
  })

  test('/jira with no argument toggles the pane open, then shut', async ($, on) => {
    const kept = world(on)
    await $.session.start(SESSION)

    const shown = await $.command.run(RUN)
    expect(shown.text).toBe('jira-ticket-pane shown')
    expect(kept.opened).toEqual([PANE_ID])

    const hidden = await $.command.run(RUN)
    expect(hidden.text).toBe('jira-ticket-pane hidden')
    expect(kept.closed).toEqual([PANE_ID])
  })

  test('pressing the structured content toggle reveals the JSON', async ($, on) => {
    world(on, { tools: TOOLS, mcp: () => STRUCTURED_RESULT })
    await $.session.start(SESSION)
    await $.command.run({ ...RUN, args: 'DEMO-1' })

    const collapsed = textOf(await $.ui.render(PANE))
    expect(collapsed).not.toContain('"key"')

    await $.ui.press({ plugin: PLUGIN, key: 'structured:button' })

    const expanded = textOf(await $.ui.render(PANE))
    expect(expanded).toContain('"key": "DEMO-1"')
  })

  describe('pure functions', () => {
    test('discoverTool cuts a tool name at the first __, not every one', () => {
      const tools: ToolInfo[] = [{ name: 'mcp__atlassian__jira_issue__get', description: '', mcp: true }]
      expect(discoverTool(tools)).toEqual({ server: 'atlassian', tool: 'jira_issue__get' })
    })

    test('discoverTool prefers the shortest matching name; ties keep tool.list order', () => {
      const tools: ToolInfo[] = [
        { name: 'mcp__atlassian__getJiraIssueWithExtras', description: '', mcp: true },
        { name: 'mcp__atlassian__getJiraIssue', description: '', mcp: true },
      ]
      expect(discoverTool(tools)).toEqual({ server: 'atlassian', tool: 'getJiraIssue' })
    })

    test('discoverTool drops a name it cannot cut into a server and a tool', () => {
      const tools: ToolInfo[] = [{ name: 'mcp__jiraissuegetter', description: '', mcp: true }]
      expect(discoverTool(tools)).toBeNull()
    })

    test('issueTextOf joins the text content blocks, skipping any other kind', () => {
      const result: McpToolResult = { content: [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }], isError: false }
      expect(issueTextOf(result)).toBe('first\n\nsecond')
    })

    test('contextTextOf names the issue and quotes the body line by line', () => {
      expect(contextTextOf('DEMO-1', 'line one\n\nline two')).toBe(
        'The user attached Jira issue DEMO-1 from jira-ticket-pane to this prompt. Read it as context for what they ask:\n> line one\n>\n> line two',
      )
    })

    test('fittedContextTextOf keeps whole lines up to room, cuts with a note, or drops entirely', () => {
      expect(fittedContextTextOf('short', 100)).toBe('short')
      // Not even the note fits alongside a first line: dropped entirely, not a note with no body.
      expect(fittedContextTextOf('a'.repeat(50), 10)).toBeUndefined()

      const cutNote = '(The rest of this issue was cut: it did not fit in the prompt.)'
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`.padEnd(10, ' '))
      const text = lines.join('\n')
      const room = cutNote.length + 11 + 11
      expect(fittedContextTextOf(text, room)).toBe(`${lines[0]}\n${lines[1]}\n${cutNote}`)
    })
  })
})
