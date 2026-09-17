// The plugin's one function-hooks module. `/jira <KEY>` fetches one Jira issue through an MCP
// server the session already has (`$.mcp.call`, never a model turn) and draws it in a pane
// beside the transcript. A press on the pane's attach button arms the issue text to ride the
// person's next prompt as context, the same way the model reads any other attached text.
//
// Must NOT know about: which MCP server serves Jira (discovered from `$.tool.list()`, or set
// once with `/jira config`, never hard-coded); writing back to Jira; a poll timer; drag-select
// over the issue text (a later milestone); field-by-field rendering of `structuredContent` (it
// is shown as raw JSON, folded, not laid out).
//
// It loads only where Claude Code has function hooks enabled. The engine's validator reads this
// file statically, so every call on `$` is spelled `$.noun.event(...)` and `$` is handed only to
// the function declarations at the top of the file; the rest of the module holds a `Host`, a
// bundle of closures built once at `session.start`.

import type { Elements, McpToolResult, On, RenderElement, ToolInfo } from 'claude-code'

const PANE_ID = 'jira-ticket-pane'
const PANE_TITLE = 'jira-ticket-pane'
const COMMAND = 'jira'

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/

// Jira MCP tools spell the issue key argument differently server to server; tried in order
// until one answers `isError: false`.
const ARG_NAMES = ['issueKey', 'issueIdOrKey', 'key']

// `prompt.submit`'s `context` is capped at this many characters total, across every entry it
// carries (the d.ts states the cap; matched here rather than discovered by a rejected prompt).
const PROMPT_CONTEXT_MAX_CHARS = 32_000
const CONTEXT_CUT_NOTE = '(The rest of this issue was cut: it did not fit in the prompt.)'

const STORE_KEY = 'config'

type McpConfig = { server: string; tool: string }

type Armed = { key: string; text: string }

type Host = {
  envFixture: () => Promise<string | undefined>
  mcpCall: (server: string, tool: string, args: Record<string, unknown>) => Promise<McpToolResult>
  toolList: () => Promise<ToolInfo[]>
  fsRead: (path: string) => Promise<string>
  status: (text: string | undefined) => void
  open: () => Promise<void>
  close: () => Promise<void>
  invalidate: () => void
  log: (text: string) => void
  register: () => Promise<unknown>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
}

type State = {
  host: Host | null
  isOpen: boolean
  issueKey: string | null
  result: McpToolResult | null
  error: string | null
  toolNames: string[]
  config: McpConfig | null
  isLoading: boolean
  fetchedAt: string | null
  isStructuredOpen: boolean
  armed: Armed | null
}

// The host is a bundle of closures over `$`, built once at `session.start`, so the rest of this
// file never holds `$` itself. That is the validator's rule and also the seam a test fakes:
// every world a test builds stubs these same calls with `on(...)`.
function hostOf($: any): Host {
  return {
    envFixture: () => $.env.get('JIRA_TICKET_PANE_FIXTURE'),
    mcpCall: (server, tool, args) => $.mcp.call(server, tool, args),
    toolList: () => $.tool.list(),
    fsRead: (path) => $.fs.read(path),
    status: (text) => $.ui.status(text),
    open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
    close: () => $.ui.close({ id: PANE_ID }),
    invalidate: () => $.ui.invalidate('ui.render'),
    log: (text) => $.ui.log(text),
    register: () => $.command.register({ name: COMMAND, description: 'Show or hide the jira-ticket-pane pane, or fetch one Jira issue by key' }),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// What came out of the store is code's own past write, not the engine's word: validated before
// anything trusts its shape, since a version of this file that has since changed the shape could
// still be sitting there.
function configFromStore(value: unknown): McpConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const server = Reflect.get(value, 'server')
  const tool = Reflect.get(value, 'tool')
  if (typeof server !== 'string' || typeof tool !== 'string') return null
  return { server, tool }
}

// A fixture file is this file's own past write too (by whoever set up the fixture), not the
// engine's word: the two fields fetchIssue reads off it (`content`, `isError`) are checked
// before anything trusts the rest.
function mcpResultOf(value: unknown): McpToolResult | null {
  if (typeof value !== 'object' || value === null) return null
  const content = Reflect.get(value, 'content')
  const isError = Reflect.get(value, 'isError')
  if (!Array.isArray(content) || typeof isError !== 'boolean') return null
  const structuredContent = Reflect.get(value, 'structuredContent')
  return { content, isError, ...(structuredContent === undefined ? {} : { structuredContent }) }
}

// An MCP tool name is `mcp__<server>__<tool>`; the tool name itself may contain `__`, so this
// cuts at the first `__` past the prefix rather than splitting on every one.
function parsedToolNameOf(name: string): McpConfig | null {
  const prefix = 'mcp__'
  if (!name.startsWith(prefix)) return null
  const rest = name.slice(prefix.length)
  const cut = rest.indexOf('__')
  if (cut === -1) return null
  const server = rest.slice(0, cut)
  const tool = rest.slice(cut + 2)
  if (server === '' || tool === '') return null
  return { server, tool }
}

// A Jira "get one issue" tool, guessed from its name alone: connected, about Jira, about an
// issue, and reads rather than writes. Of several candidates the shortest name wins (a plainer
// name reads as the more likely single-purpose tool); ties keep the order `$.tool.list()` gave,
// since `Array.prototype.sort` is stable.
export function discoverTool(tools: ToolInfo[]): McpConfig | null {
  const candidates = tools
    .filter((tool) => tool.mcp && /jira/i.test(tool.name) && /issue/i.test(tool.name) && /get|fetch|read|show/i.test(tool.name))
    .map((tool) => ({ name: tool.name, parsed: parsedToolNameOf(tool.name) }))
    .filter((candidate): candidate is { name: string; parsed: McpConfig } => candidate.parsed !== null)

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.name.length - b.name.length)
  return candidates[0]!.parsed
}

// The text a fetched issue reads as once it rides a prompt or is shown to the person: every
// `text` content block, in order, each block its own paragraph.
export function issueTextOf(result: McpToolResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n\n')
}

// What an armed issue reads as once it rides a prompt as context: a sentence telling the model
// what the person attached, then the issue text quoted line by line (an empty line becomes a
// bare `>`).
export function contextTextOf(key: string, text: string): string {
  const header = `The user attached Jira issue ${key} from jira-ticket-pane to this prompt. Read it as context for what they ask:`
  const quoted = text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`))
  return [header, ...quoted].join('\n')
}

// Whole when it fits the context room left, else as many whole lines as fit plus a cut note —
// never a line sliced mid-word. `undefined` when not even the header fits, so the caller can
// drop the attach instead of sending a note with no body.
export function fittedContextTextOf(text: string, room: number): string | undefined {
  if (text.length <= room) return text
  const kept: string[] = []
  let used = CONTEXT_CUT_NOTE.length
  for (const line of text.split('\n')) {
    const cost = line.length + 1
    if (used + cost > room) break
    kept.push(line)
    used += cost
  }
  const hasBody = kept.length > 1
  return hasBody ? `${kept.join('\n')}\n${CONTEXT_CUT_NOTE}` : undefined
}

// Fetches `key` into `state`, from a fixture file when `JIRA_TICKET_PANE_FIXTURE` names a
// directory, else from the connected MCP server. `isLoading` and `fetchedAt` bracket every
// path, success or failure, so the refresh button's label always reflects what just happened.
async function fetchIssue(state: State, key: string): Promise<void> {
  const host = state.host
  if (host === null) return
  state.isLoading = true
  host.invalidate()
  try {
    const dir = await host.envFixture()
    if (dir !== undefined && dir !== '') {
      await fetchFromFixture(state, host, dir, key)
    } else {
      await fetchFromMcp(state, host, key)
    }
  } finally {
    state.isLoading = false
    state.fetchedAt = new Date().toLocaleTimeString()
    host.invalidate()
  }
}

// Fixture mode never calls `mcp.call` or `tool.list`: a fixture stands in for both the
// discovery and the call, for local development with no MCP server connected.
async function fetchFromFixture(state: State, host: Host, dir: string, key: string): Promise<void> {
  state.result = null
  state.error = null
  state.toolNames = []
  const path = `${dir}/${key}.json`
  let text: string
  try {
    text = await host.fsRead(path)
  } catch (error) {
    state.error = `jira-ticket-pane: could not read ${path}: ${messageOf(error)}`
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    state.error = `jira-ticket-pane: could not parse ${path}: ${messageOf(error)}`
    return
  }
  const result = mcpResultOf(parsed)
  if (result === null) {
    state.error = `jira-ticket-pane: ${path} is not a Jira MCP tool result`
    return
  }
  state.result = result
}

async function fetchFromMcp(state: State, host: Host, key: string): Promise<void> {
  state.result = null
  state.error = null
  state.toolNames = []

  let config = state.config
  if (config === null) {
    const tools = await host.toolList()
    const discovered = discoverTool(tools)
    if (discovered === null) {
      state.error = 'no Jira MCP tool found'
      state.toolNames = tools.filter((tool) => tool.mcp).map((tool) => tool.name)
      return
    }
    config = discovered
  }

  let lastResult: McpToolResult | null = null
  for (const argName of ARG_NAMES) {
    let result: McpToolResult
    try {
      result = await host.mcpCall(config.server, config.tool, { [argName]: key })
    } catch (error) {
      state.error = messageOf(error)
      return
    }
    if (!result.isError) {
      state.result = result
      return
    }
    lastResult = result
  }

  // Every argument name failed: the real Jira MCP tool this session has may need an argument
  // this file does not know to send, so its own error text (not reworded) is the only clue.
  if (lastResult !== null) state.error = lastResult.content.map((block) => block.text ?? '').join('\n\n')
}

// The real element types, so the typecheck refuses a prop the engine would refuse. `Text` takes
// no `key` (giving it one drops the whole tree); `Box` and `Button` do.
type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text'>

function refreshRowOf(ui: Ui, state: State): RenderElement | null {
  const key = state.issueKey
  if (key === null) return null
  const { Box, Button } = ui
  const label = state.isLoading ? '↻ reading…' : `↻ ${key} ${state.fetchedAt ?? ''}`.trimEnd()
  return Box({ key: 'refresh', children: [Button({ key: 'refresh:button', label, onPress: () => void fetchIssue(state, key).catch(() => undefined) })] })
}

function errorRowsOf(ui: Ui, state: State): RenderElement[] {
  if (state.error === null) return []
  const { Text } = ui
  const rows: RenderElement[] = [Text({ color: 'red', children: state.error })]
  if (state.toolNames.length > 0) {
    rows.push(Text({ dimColor: true, children: 'connected MCP tools:' }))
    for (const name of state.toolNames) rows.push(Text({ dimColor: true, children: name }))
    rows.push(Text({ dimColor: true, children: 'fix the tool with: /jira config server=<name> tool=<name>' }))
  }
  return rows
}

function resultRowsOf(ui: Ui, state: State): RenderElement[] {
  const result = state.result
  if (result === null) return []
  const { Box, Text } = ui
  const blocks = result.content.map((block) => (block.type === 'text' ? Text({ children: block.text ?? '' }) : Text({ dimColor: true, children: `[${block.type} block]` })))
  return [Box({ key: 'result', flexDirection: 'column', rowGap: 1, children: blocks })]
}

function armRowOf(ui: Ui, state: State, host: Host): RenderElement | null {
  const result = state.result
  const key = state.issueKey
  if (result === null || key === null) return null
  const { Box, Button } = ui
  const isArmed = state.armed !== null && state.armed.key === key
  const label = isArmed ? 'attached: rides your next prompt (press to drop)' : 'attach to next prompt'
  return Box({
    key: 'arm',
    children: [
      Button({
        key: 'arm:button',
        label,
        onPress: () => {
          if (state.armed !== null && state.armed.key === key) {
            state.armed = null
            host.status(undefined)
          } else {
            state.armed = { key, text: issueTextOf(result) }
            host.status(`${key} rides your next prompt (press the button again to drop it)`)
          }
          host.invalidate()
        },
      }),
    ],
  })
}

function structuredRowsOf(ui: Ui, state: State, host: Host): RenderElement[] {
  const result = state.result
  if (result === null || result.structuredContent === undefined) return []
  const { Box, Button, Text } = ui
  const isOpen = state.isStructuredOpen
  const rows: RenderElement[] = [
    Box({
      key: 'structured',
      children: [
        Button({
          key: 'structured:button',
          label: isOpen ? '▼ structured content' : '▶ structured content',
          onPress: () => {
            state.isStructuredOpen = !state.isStructuredOpen
            host.invalidate()
          },
        }),
      ],
    }),
  ]
  if (isOpen) rows.push(Text({ dimColor: true, children: JSON.stringify(result.structuredContent, null, 2) }))
  return rows
}

function paneOf(ui: Ui, state: State, host: Host): RenderElement {
  const { Box, Text } = ui
  const children: RenderElement[] = []

  const refreshRow = refreshRowOf(ui, state)
  if (refreshRow !== null) children.push(refreshRow)
  if (state.issueKey === null && state.error === null) children.push(Text({ children: 'type /jira <KEY> to show an issue' }))

  children.push(...errorRowsOf(ui, state))
  children.push(...resultRowsOf(ui, state))

  const armRow = armRowOf(ui, state, host)
  if (armRow !== null) children.push(armRow)

  children.push(...structuredRowsOf(ui, state, host))

  return Box({ key: 'jira-ticket-pane', flexDirection: 'column', paddingTop: 1, paddingRight: 1, children })
}

// `config server=<s> tool=<t>` pins the MCP tool so `fetchIssue` never calls `tool.list`;
// `config clear` drops that pin, back to discovery. Values carry no whitespace, so a plain
// `\S+` token match is enough.
function handleConfig(state: State, host: Host, rest: string): { text: string } {
  if (rest === 'clear') {
    state.config = null
    void host.storeSet(STORE_KEY, null).catch(() => undefined)
    return { text: 'jira-ticket-pane config cleared' }
  }

  let server: string | undefined
  let tool: string | undefined
  for (const token of rest.split(/\s+/).filter((piece) => piece !== '')) {
    const serverMatch = /^server=(\S+)$/.exec(token)
    if (serverMatch) server = serverMatch[1]
    const toolMatch = /^tool=(\S+)$/.exec(token)
    if (toolMatch) tool = toolMatch[1]
  }

  if (server === undefined || tool === undefined) {
    const usage = 'jira-ticket-pane: usage: /jira config server=<name> tool=<name> (or /jira config clear)'
    host.status(usage)
    return { text: usage }
  }

  state.config = { server, tool }
  void host.storeSet(STORE_KEY, { server, tool }).catch(() => undefined)
  return { text: `jira-ticket-pane calls ${tool} on ${server}` }
}

export function register(on: On) {
  const state: State = {
    host: null,
    isOpen: false,
    issueKey: null,
    result: null,
    error: null,
    toolNames: [],
    config: null,
    isLoading: false,
    fetchedAt: null,
    isStructuredOpen: false,
    armed: null,
  }

  // A second `prompt.submit` arriving while the first one's `next` is still in flight must not
  // attach the same armed issue twice.
  let carrying: Armed | null = null

  on('session.start', async ($, e, next) => {
    const host = hostOf($)
    state.host = host
    await host.register().catch((error: unknown) => host.log(`jira-ticket-pane: /${COMMAND} is not available: ${messageOf(error)}`))
    state.config = configFromStore(await host.storeGet(STORE_KEY).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const host = state.host
    if (host === null) return next(e)
    const args = e.args.trim()

    if (args === '') {
      if (state.isOpen) {
        await host.close()
        state.isOpen = false
        return { text: 'jira-ticket-pane hidden' }
      }
      await host.open()
      state.isOpen = true
      host.invalidate()
      return { text: 'jira-ticket-pane shown' }
    }

    const configMatch = /^config(?:\s+(.*))?$/.exec(args)
    if (configMatch !== null) return handleConfig(state, host, (configMatch[1] ?? '').trim())

    if (KEY_RE.test(args)) {
      if (!state.isOpen) {
        await host.open()
        state.isOpen = true
      }
      // A new key drops what is armed, so a stale issue's text cannot ride a prompt about a
      // different one; a refetch of the same key (this branch running twice, or the refresh
      // button) leaves it be.
      if (state.issueKey !== args) state.armed = null
      state.issueKey = args
      await fetchIssue(state, args)
      return { text: `jira-ticket-pane shows ${args}` }
    }

    const usage = `jira-ticket-pane: "${args}" is not an issue key (expected a form such as DEMO-1)`
    host.status(usage)
    return { text: usage }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || state.host === null) return next(e)
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Text } = await $.ui.resolve(e)
    return paneOf({ Box, Button, Text }, state, state.host)
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) state.isOpen = false
    return result
  })

  // The armed issue rides the next prompt as context, never the prompt box itself. Fit the text
  // to the room the context has left, attach it on the way down, and disarm only once the
  // prompt actually entered (a drop leaves it armed, so a refused prompt does not silently
  // spend the one attach the person meant to make).
  on('prompt.submit', async ($, e, next) => {
    const host = state.host
    const asked = state.armed
    if (host === null || asked === null || carrying === asked) return next(e)

    const context = e.context ?? []
    const room = PROMPT_CONTEXT_MAX_CHARS - context.reduce((sum, block) => sum + block.length, 0)
    const text = fittedContextTextOf(contextTextOf(asked.key, asked.text), room)

    if (text === undefined) {
      state.armed = null
      host.status(`${asked.key} did not fit in the prompt and was dropped`)
      host.invalidate()
      return next(e)
    }

    carrying = asked
    try {
      const result = await next({ ...e, context: [...context, text] })
      if (result.drop === undefined && state.armed === asked) {
        state.armed = null
        host.status(undefined)
        host.invalidate()
      }
      return result
    } finally {
      carrying = null
    }
  })
}
