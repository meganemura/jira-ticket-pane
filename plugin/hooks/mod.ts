// The plugin's one function-hooks module. `/jira <KEY>` fetches one Jira issue through an MCP
// server the session already has, calling `$.mcp.call` directly inside this hook, and draws it
// in a pane beside the transcript. A press on the pane's attach button arms the issue text to
// ride the person's next prompt as context, the same way the model reads any other attached text.
//
// Must NOT know about: which MCP server serves Jira (learned from `$.tool.list()`, or pinned
// once with `/jira config`); which Atlassian cloud site holds the issue (resolved through
// `getAccessibleAtlassianResources`, or pinned with `/jira config cloud=<id>`); writing back to
// Jira; a poll timer (an issue does not change minute to minute, so one refresh press stays
// enough); drag-select over the issue text (a later milestone).
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
// until one answers `isError: false`. Atlassian's own MCP server confirmed `issueIdOrKey`; the
// other two stay as a fallback for a server that spells the argument another way.
const ARG_NAMES = ['issueIdOrKey', 'issueKey', 'key']

// Matches the tool that lists the Atlassian cloud sites a session can reach, by name alone
// (Atlassian's own server calls it `getAccessibleAtlassianResources`). Its result names the
// `cloudId` a Jira issue call needs.
const ACCESSIBLE_RESOURCES_RE = /accessible.*resources/i

// `PROMPT_CONTEXT_MAX_CHARS` copies the cap the d.ts states for `prompt.submit`'s `context`, so
// `fittedContextTextOf` can size an attachment up front, without spending a prompt just to learn
// the number by its rejection.
const PROMPT_CONTEXT_MAX_CHARS = 32_000
const CONTEXT_CUT_NOTE = '(The rest of this issue was cut: it did not fit in the prompt.)'

const STORE_KEY = 'config'

type McpConfig = { server: string; tool: string; cloudId?: string }

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
  lastCall: string | null
  config: McpConfig | null
  isLoading: boolean
  fetchedAt: string | null
  isStructuredOpen: boolean
  armed: Armed | null
  fetchSeq: number
  // Which of the two tabs the pane draws. Stays as the person left it across a refetch or a new
  // key: no reset to `'issue'` on a fresh fetch.
  tab: 'issue' | 'meta'
  // The Atlassian cloud site id, resolved once per session through
  // `getAccessibleAtlassianResources` and kept here for every later fetch; never written to the
  // store, since a pin belongs to `/jira config cloud=<id>` alone.
  cloudId: string | null
  siteLines: string[]
}

// The host is a bundle of closures over `$`, built once at `session.start`: `$` stays inside
// `hostOf` and the function declarations at the top of the file the validator reads, and the
// rest of the module works through this `Host`. That boundary is also the seam a test fakes:
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

// The store holds this file's own past write, and an earlier version of this file may have saved
// a different shape; configFromStore checks each field before state trusts it as an McpConfig.
function configFromStore(value: unknown): McpConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const server = Reflect.get(value, 'server')
  const tool = Reflect.get(value, 'tool')
  if (typeof server !== 'string' || typeof tool !== 'string') return null
  const cloudId = Reflect.get(value, 'cloudId')
  return { server, tool, ...(typeof cloudId === 'string' ? { cloudId } : {}) }
}

// A person writes a fixture file, so its shape is unchecked until here: the two fields
// fetchFromFixture reads off it, `content` and `isError`, are checked before anything trusts the
// rest.
function mcpResultOf(value: unknown): McpToolResult | null {
  if (typeof value !== 'object' || value === null) return null
  const content = Reflect.get(value, 'content')
  const isError = Reflect.get(value, 'isError')
  if (!Array.isArray(content) || typeof isError !== 'boolean') return null
  const structuredContent = Reflect.get(value, 'structuredContent')
  return { content, isError, ...(structuredContent === undefined ? {} : { structuredContent }) }
}

// An MCP tool name is `mcp__<server>__<tool>`, and the tool name itself may contain `__`;
// parsedToolNameOf cuts only at the first `__` past the prefix, so the rest of the name stays
// whole as the tool.
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
// issue, and named with a read verb (get, fetch, read or show). Of several candidates the
// shortest name wins (a plainer name reads as the more likely single-purpose tool); ties keep
// the order `$.tool.list()` gave, since `Array.prototype.sort` is stable.
export function discoverTool(tools: ToolInfo[]): McpConfig | null {
  const candidates = tools
    .filter((tool) => tool.mcp && /jira/i.test(tool.name) && /issue/i.test(tool.name) && /get|fetch|read|show/i.test(tool.name))
    .map((tool) => ({ name: tool.name, parsed: parsedToolNameOf(tool.name) }))
    .filter((candidate): candidate is { name: string; parsed: McpConfig } => candidate.parsed !== null)

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.name.length - b.name.length)
  return candidates[0]!.parsed
}

// The tool that lists a session's accessible Atlassian cloud sites, on the same server as the
// Jira issue tool: connected, name matching `ACCESSIBLE_RESOURCES_RE`, server cut from its full
// name matching `server`. Absent from `tool.list()`, some servers need no `cloudId` at all.
function accessibleResourcesToolOf(tools: ToolInfo[], server: string): McpConfig | null {
  const match = tools.find((tool) => tool.mcp && ACCESSIBLE_RESOURCES_RE.test(tool.name) && parsedToolNameOf(tool.name)?.server === server)
  return match === undefined ? null : parsedToolNameOf(match.name)
}

// One Jira issue, read off the shape Atlassian's own MCP server answers with: every field a
// plain string, always, with `''` standing in for an absent or a `null` field, so a caller
// never needs its own null check on top of this one.
type IssueView = {
  key: string
  summary: string
  type: string
  status: string
  // Read off `fields.status.statusCategory.key`: `''` when the field or the category is absent,
  // the same rule every other field on this type follows. `statusColorOf` reads this alone.
  statusCategory: string
  priority: string
  assignee: string
  reporter: string
  labels: string[]
  description: string
  url: string
  created: string
  updated: string
}

// A category maps to the color a Jira board would use for it (new work, work under way, done
// work); a category this file does not know draws with no color, rather than guessing one.
export function statusColorOf(category: string): string | undefined {
  if (category === 'new') return 'blue'
  if (category === 'indeterminate') return 'yellow'
  if (category === 'done') return 'green'
  return undefined
}

// An ISO timestamp's date and minute, with no seconds and no timezone offset: `2026-09-19
// 16:32`. A value that does not start with the ISO shape passes through unchanged, so a server
// sending something else still shows, rather than a mangled cut of it.
function shortDateOf(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(0, 16).replace('T', ' ') : value
}

function statusCategoryKeyOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const category = Reflect.get(value, 'statusCategory')
  if (typeof category !== 'object' || category === null) return ''
  return stringOf(Reflect.get(category, 'key'))
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// A Jira field carried as `{ name: string }` (issue type, status, priority) or `null`.
function nameOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  return stringOf(Reflect.get(value, 'name'))
}

// A Jira field carried as `{ displayName: string }` (assignee, reporter) or `null`.
function displayNameOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  return stringOf(Reflect.get(value, 'displayName'))
}

// Reads plain text out of an Atlassian Document Format node. A `text` node gives its own text;
// `paragraph` and `heading` join their children then end with a newline; a `bulletList` or
// `orderedList` gives one `- `-led line per `listItem`; `codeBlock` joins its children's text;
// `hardBreak` is a bare newline. Every other node, `doc` included, recurses into its children.
// A plain string passes through unchanged; `null` or `undefined` reads as `''`.
export function adfTextOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || node === undefined) return ''
  if (typeof node !== 'object') return ''
  const type = Reflect.get(node, 'type')
  const contentRaw = Reflect.get(node, 'content')
  const children = Array.isArray(contentRaw) ? contentRaw : []

  if (type === 'text') return stringOf(Reflect.get(node, 'text'))
  if (type === 'hardBreak') return '\n'
  // Every block-level node ends with its own newline, so a doc's children join with no
  // separator of their own and still land one block per line.
  if (type === 'paragraph' || type === 'heading') return `${children.map(adfTextOf).join('')}\n`
  if (type === 'codeBlock') return `${children.map(adfTextOf).join('')}\n`
  if (type === 'bulletList' || type === 'orderedList') {
    const lines = children
      .filter((item): item is object => typeof item === 'object' && item !== null && Reflect.get(item, 'type') === 'listItem')
      .map((item) => {
        const itemContent = Reflect.get(item, 'content')
        const itemChildren = Array.isArray(itemContent) ? itemContent : []
        return `• ${itemChildren.map(adfTextOf).join('').trimEnd()}`
      })
    return `${lines.join('\n')}\n`
  }
  return children.map(adfTextOf).join('')
}

// One issue, read off `parsed`: wrapped in `{ issues: { nodes: [...] } }` (a model's own tool
// call answers this way), or the issue object itself with `key` and `fields` at the top level (a
// call made through `$.mcp.call` from inside this module answers this way, with no wrapper).
// `null` when `parsed` carries neither shape.
function issueNodeOf(parsed: unknown): unknown | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const issues = Reflect.get(parsed, 'issues')
  if (typeof issues === 'object' && issues !== null) {
    const nodes = Reflect.get(issues, 'nodes')
    if (Array.isArray(nodes) && nodes.length > 0) return nodes[0]
  }
  const key = Reflect.get(parsed, 'key')
  const fields = Reflect.get(parsed, 'fields')
  if (typeof key === 'string' && typeof fields === 'object' && fields !== null) return parsed
  return null
}

// The first text content block that parses as JSON carrying an issue, wrapped or not (see
// `issueNodeOf`); `null` when no block parses as either shape (an older or a different server's
// plain-text answer, for instance).
function issueJsonOf(result: McpToolResult): unknown | null {
  for (const block of result.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      continue
    }
    if (issueNodeOf(parsed) !== null) return parsed
  }
  return null
}

// `issueJsonOf`'s issue, read into an `IssueView`; `null` when no content block carries either
// known shape, so the caller falls back to drawing the raw blocks.
export function issueViewOf(result: McpToolResult): IssueView | null {
  const parsed = issueJsonOf(result)
  if (parsed === null) return null
  const node = issueNodeOf(parsed)
  if (typeof node !== 'object' || node === null) return null
  const fieldsRaw = Reflect.get(node, 'fields')
  const fields = typeof fieldsRaw === 'object' && fieldsRaw !== null ? fieldsRaw : {}
  const labelsRaw = Reflect.get(fields, 'labels')
  const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((label): label is string => typeof label === 'string') : []
  return {
    key: stringOf(Reflect.get(node, 'key')),
    summary: stringOf(Reflect.get(fields, 'summary')),
    type: nameOf(Reflect.get(fields, 'issuetype')),
    status: nameOf(Reflect.get(fields, 'status')),
    statusCategory: statusCategoryKeyOf(Reflect.get(fields, 'status')),
    priority: nameOf(Reflect.get(fields, 'priority')),
    assignee: displayNameOf(Reflect.get(fields, 'assignee')),
    reporter: displayNameOf(Reflect.get(fields, 'reporter')),
    labels,
    // Trimmed: every block-level node in adfTextOf ends its own line with a newline, so the
    // last block of a description leaves one trailing behind with nothing after it.
    description: adfTextOf(Reflect.get(fields, 'description')).trimEnd(),
    // `webUrl` alone: a call through `$.mcp.call` carries `self`, an api.atlassian.com API link
    // with no site name in it, so there is no host to build a browse url from when `webUrl` is
    // absent.
    url: stringOf(Reflect.get(node, 'webUrl')),
    created: stringOf(Reflect.get(fields, 'created')),
    updated: stringOf(Reflect.get(fields, 'updated')),
  }
}

// The `type · status · priority · assignee` line: an empty type, status or priority drops out;
// assignee always shows, `unassigned` standing in for an empty one.
function metaLineOf(view: IssueView): string {
  const parts = [view.type, view.status, view.priority].filter((part) => part !== '')
  parts.push(view.assignee !== '' ? view.assignee : 'unassigned')
  return parts.join(' · ')
}

// The text a fetched issue reads as once it rides a prompt or is shown to the person. A parsed
// `IssueView` reads as a heading block (key, summary, the meta line, labels when any, the url),
// a blank line, then the description. Otherwise every `text` content block joins as its own
// paragraph, unchanged from before field-by-field rendering existed.
export function issueTextOf(result: McpToolResult): string {
  const view = issueViewOf(result)
  if (view !== null) {
    const heading = [`${view.key}: ${view.summary}`, metaLineOf(view)]
    if (view.labels.length > 0) heading.push(`labels: ${view.labels.join(', ')}`)
    heading.push(view.url)
    return [heading.join('\n'), view.description].join('\n\n')
  }
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

// Whole when it fits the context room left, else as many whole lines as fit plus a cut note; a
// kept line is always whole, cut only between lines. `undefined` when not even the header fits,
// so the caller drops the attach; a note with no body under it would tell the model nothing.
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

// What a fetch found, kept out of `state` until the caller knows this is still the fetch that
// gets to write it (a `fetchIssue` for an older key can land after a newer one). `cloudId` is
// the value to keep in `state.cloudId` once this fetch lands: unchanged from what came in, when
// this fetch never touched it.
type FetchOutcome = {
  result: McpToolResult | null
  error: string | null
  toolNames: string[]
  lastCall: string | null
  cloudId: string | null
  siteLines: string[]
}

// Fetches `key` into `state`, from a fixture file when `JIRA_TICKET_PANE_FIXTURE` names a
// directory, else from the connected MCP server. Refresh, or a fast run of `/jira <KEY>`, can
// start a second fetch before the first one lands. `fetchSeq` numbers each attempt; `fetchIssue`
// compares its own number to the one currently in `state` before it writes `result`, `error`,
// `toolNames`, `lastCall`, `cloudId`, `siteLines`, `isLoading` or `fetchedAt`, so a late answer
// from an older fetch leaves standing whatever a newer fetch already wrote.
async function fetchIssue(state: State, key: string): Promise<void> {
  const host = state.host
  if (host === null) return
  const seq = ++state.fetchSeq
  state.isLoading = true
  state.result = null
  state.error = null
  state.toolNames = []
  state.lastCall = null
  state.siteLines = []
  host.invalidate()
  try {
    const dir = await host.envFixture()
    const outcome =
      dir !== undefined && dir !== '' ? await fetchFromFixture(host, dir, key, state.cloudId) : await fetchFromMcp(host, state.config, state.cloudId, key)
    if (seq === state.fetchSeq) {
      state.result = outcome.result
      state.error = outcome.error
      state.toolNames = outcome.toolNames
      state.lastCall = outcome.lastCall
      state.cloudId = outcome.cloudId
      state.siteLines = outcome.siteLines
    }
  } finally {
    if (seq === state.fetchSeq) {
      state.isLoading = false
      state.fetchedAt = hhmmOf(new Date())
    }
    host.invalidate()
  }
}

// The clock time the refresh button shows, with the seconds dropped: `13:52`, always two digits
// each side of the colon.
function hhmmOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// Fixture mode never calls `mcp.call` or `tool.list`: a fixture stands in for both the
// discovery and the call, for local development with no MCP server connected. It never touches
// `cloudId` either; `priorCloudId` passes through unchanged.
async function fetchFromFixture(host: Host, dir: string, key: string, priorCloudId: string | null): Promise<FetchOutcome> {
  const path = `${dir}/${key}.json`
  let text: string
  try {
    text = await host.fsRead(path)
  } catch (error) {
    return { result: null, error: `jira-ticket-pane: could not read ${path}: ${messageOf(error)}`, toolNames: [], lastCall: null, cloudId: priorCloudId, siteLines: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { result: null, error: `jira-ticket-pane: could not parse ${path}: ${messageOf(error)}`, toolNames: [], lastCall: null, cloudId: priorCloudId, siteLines: [] }
  }
  const result = mcpResultOf(parsed)
  if (result === null) {
    return { result: null, error: `jira-ticket-pane: ${path} is not a Jira MCP tool result`, toolNames: [], lastCall: null, cloudId: priorCloudId, siteLines: [] }
  }
  return { result, error: null, toolNames: [], lastCall: null, cloudId: priorCloudId, siteLines: [] }
}

// One Atlassian cloud site, out of `getAccessibleAtlassianResources`'s own answer.
type Site = { id: string; url: string }

// Reads the array `getAccessibleAtlassianResources` answers with, `[{ id, url, name, ... }]`,
// into the `id` and `url` of each entry; an entry with no string `id` is dropped.
function sitesOf(value: unknown): Site[] {
  if (!Array.isArray(value)) return []
  const sites: Site[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = Reflect.get(entry, 'id')
    if (typeof id !== 'string') continue
    const url = Reflect.get(entry, 'url')
    sites.push({ id, url: typeof url === 'string' ? url : '' })
  }
  return sites
}

// What resolving the cloud site found: `cloudId` set on exactly one accessible site, `error` (and
// `siteLines` naming each candidate) on zero or on more than one.
type SiteResolution = { cloudId: string | null; error: string | null; siteLines: string[]; lastCall: string | null }

async function siteResolutionOf(host: Host, server: string, tool: string): Promise<SiteResolution> {
  const lastCall = `${tool} on ${server}`
  let result: McpToolResult
  try {
    result = await host.mcpCall(server, tool, {})
  } catch (error) {
    return { cloudId: null, error: messageOf(error), siteLines: [], lastCall }
  }
  if (result.isError) {
    const texts = result.content.map((block) => block.text).filter((text): text is string => typeof text === 'string' && text !== '')
    const error = texts.length > 0 ? texts.join('\n\n') : `${tool} answered isError with no text (server ${server})`
    return { cloudId: null, error, siteLines: [], lastCall }
  }
  const text = result.content.find((block) => block.type === 'text' && typeof block.text === 'string')?.text
  let parsed: unknown
  try {
    parsed = text === undefined ? [] : JSON.parse(text)
  } catch (error) {
    return { cloudId: null, error: `jira-ticket-pane: could not parse ${tool}'s answer: ${messageOf(error)}`, siteLines: [], lastCall }
  }
  const sites = sitesOf(parsed)
  if (sites.length === 0) return { cloudId: null, error: 'no Atlassian site is accessible to this session', siteLines: [], lastCall }
  if (sites.length > 1) {
    return {
      cloudId: null,
      error: 'more than one Atlassian site; pin one with /jira config server=<s> tool=<t> cloud=<id>',
      siteLines: sites.map((site) => `${site.id}  ${site.url}`.trimEnd()),
      lastCall,
    }
  }
  return { cloudId: sites[0]!.id, error: null, siteLines: [], lastCall: null }
}

async function fetchFromMcp(host: Host, config: McpConfig | null, priorCloudId: string | null, key: string): Promise<FetchOutcome> {
  let resolved = config
  // `tools` stays `null` when `config` pins the server and tool by hand: that path never calls
  // `tool.list`, so it has nothing to check `ACCESSIBLE_RESOURCES_RE` against and sends no
  // `cloudId` unless `config.cloudId` or an already-resolved `priorCloudId` gives it one.
  let tools: ToolInfo[] | null = null
  if (resolved === null) {
    tools = await host.toolList()
    const discovered = discoverTool(tools)
    if (discovered === null) {
      return {
        result: null,
        error: 'no Jira MCP tool found',
        toolNames: tools.filter((tool) => tool.mcp).map((tool) => tool.name),
        lastCall: null,
        cloudId: priorCloudId,
        siteLines: [],
      }
    }
    resolved = discovered
  }

  let cloudId = config?.cloudId ?? priorCloudId ?? null
  if (cloudId === null && tools !== null) {
    const accessibleTool = accessibleResourcesToolOf(tools, resolved.server)
    if (accessibleTool !== null) {
      const site = await siteResolutionOf(host, accessibleTool.server, accessibleTool.tool)
      if (site.error !== null) {
        return { result: null, error: site.error, toolNames: [], lastCall: site.lastCall, cloudId: null, siteLines: site.siteLines }
      }
      cloudId = site.cloudId
    }
  }

  let lastResult: McpToolResult | null = null
  let lastCall = ''
  for (const argName of ARG_NAMES) {
    // Set right before each call, so a reject inside the try carries the name of the call that
    // threw, the same name an exhausted loop carries for its last attempt.
    lastCall = `${resolved.tool} on ${resolved.server} with ${argName} (${cloudId !== null ? 'cloudId set' : 'no cloudId'})`
    let result: McpToolResult
    try {
      result = await host.mcpCall(resolved.server, resolved.tool, {
        [argName]: key,
        ...(cloudId !== null ? { cloudId } : {}),
        responseContentFormat: 'markdown',
      })
    } catch (error) {
      return { result: null, error: messageOf(error), toolNames: [], lastCall, cloudId, siteLines: [] }
    }
    if (!result.isError) return { result, error: null, toolNames: [], lastCall: null, cloudId, siteLines: [] }
    lastResult = result
  }

  // Every argument name failed: the real Jira MCP tool this session has may need an argument
  // this file does not know to send, so its answer's own text is the clue kept. A block can
  // carry no text; a wholly blank answer falls back to a line naming the server and tool, so the
  // error line always carries words for a person to read.
  const texts = (lastResult?.content ?? []).map((block) => block.text).filter((text): text is string => typeof text === 'string' && text !== '')
  const error = texts.length > 0 ? texts.join('\n\n') : `the tool answered isError with no text (server ${resolved.server}, tool ${resolved.tool})`
  return { result: null, error, toolNames: [], lastCall, cloudId, siteLines: [] }
}

// The real element types, so the typecheck refuses a prop the engine would refuse. `Text` takes
// no `key` (giving it one drops the whole tree); `Box` and `Button` do. None of this pane's
// Buttons take a `hotkey`: pull-request-pane tested that prop in a real terminal, and the
// hotkey did not fire inside a pane.
type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Link' | 'Text'>

// Sized to `bodyColumns`, the render input's own cells-across-the-body figure, less the one cell
// the pane's own `paddingRight` already spends: the same reasoning pull-request-pane's
// `kindDividerOf` used for its own divider.
function dividerOf(ui: Ui, bodyColumns: number): RenderElement {
  return ui.Text({ dimColor: true, children: '─'.repeat(Math.max(bodyColumns - 1, 0)) })
}

// Every state the pane can be in shows this row: the tabs on the left once an issue has parsed
// into fields, the refresh and attach buttons on the right once an issue is loaded. Plain
// buttons keep the row from reading as boxed chrome sitting over the issue itself.
function topBarOf(ui: Ui, state: State, host: Host, view: IssueView | null): RenderElement {
  const { Box, Button } = ui

  const tabButtons: RenderElement[] =
    view === null
      ? []
      : [
          Button({
            key: 'tabs:issue',
            label: 'issue',
            plain: true,
            ...(state.tab === 'issue' ? {} : { dimColor: true }),
            onPress: () => {
              state.tab = 'issue'
              host.invalidate()
            },
          }),
          Button({
            key: 'tabs:meta',
            label: 'meta',
            plain: true,
            ...(state.tab === 'meta' ? {} : { dimColor: true }),
            onPress: () => {
              state.tab = 'meta'
              host.invalidate()
            },
          }),
        ]

  const rightButtons: RenderElement[] = []
  const key = state.issueKey
  if (key !== null) {
    const refreshLabel = state.isLoading ? '↻ …' : `↻ ${state.fetchedAt ?? ''}`.trimEnd()
    rightButtons.push(
      Button({ key: 'refresh:button', label: refreshLabel, plain: true, dimColor: true, onPress: () => void fetchIssue(state, key).catch(() => undefined) }),
    )

    const result = state.result
    if (result !== null) {
      const isArmed = state.armed !== null && state.armed.key === key
      rightButtons.push(
        Button({
          key: 'arm:button',
          label: isArmed ? 'attached ✓' : 'attach',
          plain: true,
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
      )
    }
  }

  return Box({
    key: 'topbar',
    flexDirection: 'row',
    justifyContent: 'space-between',
    children: [
      Box({ key: 'tabs', flexDirection: 'row', columnGap: 1, children: tabButtons }),
      Box({ key: 'topbar-right', flexDirection: 'row', columnGap: 1, children: rightButtons }),
    ],
  })
}

function errorRowsOf(ui: Ui, state: State): RenderElement[] {
  if (state.error === null) return []
  const { Text } = ui
  const rows: RenderElement[] = [Text({ color: 'red', children: `✗ ${state.error}` })]
  if (state.lastCall !== null) rows.push(Text({ dimColor: true, children: `called ${state.lastCall}` }))
  if (state.toolNames.length > 0) {
    rows.push(Text({ dimColor: true, children: 'connected MCP tools:' }))
    for (const name of state.toolNames) rows.push(Text({ dimColor: true, children: name }))
    rows.push(Text({ dimColor: true, children: 'fix the tool with: /jira config server=<name> tool=<name>' }))
  }
  for (const line of state.siteLines) rows.push(Text({ dimColor: true, children: line }))
  return rows
}

// Common to both tabs: a `<key> <summary>` heading, then the status dot (colored by category),
// the type, the priority when the issue has one, and the assignee. Reading the state this way
// needs no tab switch, so a press to see `raw json` is the only reason to leave the issue tab.
function headerRowsOf(ui: Ui, view: IssueView): RenderElement {
  const { Box, Text } = ui
  const statusColor = statusColorOf(view.statusCategory)

  const identityRow = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [Text({ color: 'cyan', bold: true, children: view.key }), Text({ bold: true, children: view.summary })],
  })

  const stateRowChildren: RenderElement[] = [
    Text({ ...(statusColor === undefined ? {} : { color: statusColor }), children: `● ${view.status}` }),
    Text({ dimColor: true, children: view.type }),
  ]
  if (view.priority !== '') stateRowChildren.push(Text({ dimColor: true, children: view.priority }))
  stateRowChildren.push(Text({ dimColor: true, children: view.assignee !== '' ? view.assignee : 'unassigned' }))
  const stateRow = Box({ flexDirection: 'row', columnGap: 3, children: stateRowChildren })

  return Box({ flexDirection: 'column', children: [identityRow, stateRow] })
}

// One `<label>  <value>` row per field, a label padded to line the values up, an empty value
// dropped (assignee excepted: `unassigned` always shows). The url row alone carries a `key`, the
// keyed Box a `Link`'s `hover` needs to take effect.
function metaLinesOf(ui: Ui, view: IssueView): RenderElement {
  const { Box, Link, Text } = ui
  const rows: { label: string; value: string; isUrl?: true }[] = [
    { label: 'type', value: view.type },
    { label: 'status', value: view.status },
    { label: 'priority', value: view.priority },
    { label: 'assignee', value: view.assignee !== '' ? view.assignee : 'unassigned' },
    { label: 'reporter', value: view.reporter },
    { label: 'labels', value: view.labels.join(', ') },
    { label: 'created', value: shortDateOf(view.created) },
    { label: 'updated', value: shortDateOf(view.updated) },
    { label: 'url', value: view.url, isUrl: true },
  ]

  const children = rows
    .filter((row) => row.value !== '')
    .map((row) => {
      const valueElement = row.isUrl === true ? Link({ href: row.value, children: [Text({ hover: { color: 'cyan' }, children: row.value })] }) : Text({ children: row.value })
      return Box({
        ...(row.isUrl === true ? { key: 'meta:url' } : {}),
        flexDirection: 'row',
        children: [Text({ dimColor: true, children: row.label.padEnd(11) }), valueElement],
      })
    })

  return Box({ key: 'meta-lines', flexDirection: 'column', children })
}

// The fold's raw JSON: `structuredContent` when the tool sent one, else the text block
// `issueViewOf` itself read its fields from. This keeps the fold showing something once fields
// can draw straight from a text block instead of needing `structuredContent`.
function structuredJsonOf(result: McpToolResult): unknown {
  return result.structuredContent !== undefined ? result.structuredContent : issueJsonOf(result)
}

function structuredRowsOf(ui: Ui, state: State, host: Host): RenderElement[] {
  const result = state.result
  if (result === null) return []
  const structured = structuredJsonOf(result)
  if (structured === null || structured === undefined) return []
  const { Box, Button, Text } = ui
  const isOpen = state.isStructuredOpen
  const rows: RenderElement[] = [
    Box({
      key: 'structured',
      children: [
        Button({
          key: 'structured:button',
          label: isOpen ? '▼ raw json' : '▶ raw json',
          plain: true,
          dimColor: true,
          onPress: () => {
            state.isStructuredOpen = !state.isStructuredOpen
            host.invalidate()
          },
        }),
      ],
    }),
  ]
  if (isOpen) rows.push(Text({ dimColor: true, children: JSON.stringify(structured, null, 2) }))
  return rows
}

// A parsed `IssueView` draws the shared header, then its selected tab's body: the description on
// `issue`, the field list and the raw-json fold on `meta`. Otherwise (no parsed view: an older or
// a different server's answer) every `text` content block draws as its own row, unchanged from
// before field-by-field rendering existed, with the fold under it.
function resultRowsOf(ui: Ui, state: State, host: Host, view: IssueView | null): RenderElement[] {
  const result = state.result
  if (result === null) return []
  const { Box, Text } = ui

  if (view !== null) {
    const header = headerRowsOf(ui, view)
    const body: RenderElement =
      state.tab === 'issue'
        ? view.description !== ''
          ? Text({ children: view.description })
          : Text({ dimColor: true, children: '(no description)' })
        : Box({ key: 'meta', flexDirection: 'column', rowGap: 1, children: [metaLinesOf(ui, view), ...structuredRowsOf(ui, state, host)] })
    return [Box({ key: 'result', flexDirection: 'column', rowGap: 1, children: [header, body] })]
  }

  const blocks = result.content.map((block) => (block.type === 'text' ? Text({ children: block.text ?? '' }) : Text({ dimColor: true, children: `[${block.type} block]` })))
  return [Box({ key: 'result', flexDirection: 'column', rowGap: 1, children: blocks }), ...structuredRowsOf(ui, state, host)]
}

function paneOf(ui: Ui, state: State, host: Host, bodyColumns: number): RenderElement {
  const { Box, Text } = ui
  const view = state.result !== null ? issueViewOf(state.result) : null
  const children: RenderElement[] = [topBarOf(ui, state, host, view), dividerOf(ui, bodyColumns)]

  if (state.issueKey === null && state.error === null) children.push(Text({ dimColor: true, children: 'type /jira <KEY> to show an issue' }))

  children.push(...errorRowsOf(ui, state))
  children.push(...resultRowsOf(ui, state, host, view))

  return Box({ key: 'jira-ticket-pane', flexDirection: 'column', paddingTop: 1, paddingRight: 1, paddingLeft: 1, children })
}

// `config server=<s> tool=<t>` pins the MCP tool, so `fetchIssue` skips `tool.list` and calls it
// directly; `config clear` drops that pin, back to discovery. `cloud=<id>` is optional and pins
// the Atlassian cloud site, so `fetchFromMcp` skips `getAccessibleAtlassianResources` too. Values
// carry no whitespace, so a plain `\S+` token match is enough. Both branches call `storeSet`
// unawaited: `state.config` already holds the value the rest of this session reads, so a slow or
// failing write to the store must not hold up the command's reply.
function handleConfig(state: State, host: Host, rest: string): { text: string } {
  if (rest === 'clear') {
    state.config = null
    void host.storeSet(STORE_KEY, null).catch(() => undefined)
    return { text: 'jira-ticket-pane config cleared' }
  }

  let server: string | undefined
  let tool: string | undefined
  let cloud: string | undefined
  for (const token of rest.split(/\s+/).filter((piece) => piece !== '')) {
    const serverMatch = /^server=(\S+)$/.exec(token)
    if (serverMatch) server = serverMatch[1]
    const toolMatch = /^tool=(\S+)$/.exec(token)
    if (toolMatch) tool = toolMatch[1]
    const cloudMatch = /^cloud=(\S+)$/.exec(token)
    if (cloudMatch) cloud = cloudMatch[1]
  }

  if (server === undefined || tool === undefined) {
    const usage = 'jira-ticket-pane: usage: /jira config server=<name> tool=<name> [cloud=<id>] (or /jira config clear)'
    host.status(usage)
    return { text: usage }
  }

  const config: McpConfig = { server, tool, ...(cloud !== undefined ? { cloudId: cloud } : {}) }
  state.config = config
  void host.storeSet(STORE_KEY, config).catch(() => undefined)
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
    lastCall: null,
    config: null,
    isLoading: false,
    fetchedAt: null,
    isStructuredOpen: false,
    armed: null,
    fetchSeq: 0,
    cloudId: null,
    siteLines: [],
    tab: 'issue',
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

    // A typo should spend nothing on the real MCP server: this branch calls `host.status` alone,
    // zero calls to `mcp.call`, `tool.list` or `fs.read`.
    const usage = `jira-ticket-pane: "${args}" is not an issue key (expected a form such as DEMO-1)`
    host.status(usage)
    return { text: usage }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || state.host === null) return next(e)
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Link, Text } = await $.ui.resolve(e)
    return paneOf({ Box, Button, Link, Text }, state, state.host, e.props.bodyColumns)
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) state.isOpen = false
    return result
  })

  // The armed issue rides the next prompt as one of its context entries; the person's own prompt
  // text passes through unchanged. Fit the text to the room the context has left, attach it on
  // the way down, and disarm only once the prompt actually entered (a drop leaves it armed, so a
  // refused prompt keeps the one attach the person meant to make, to spend on a later try).
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
