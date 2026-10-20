import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Child, Issue, JiraState, Seen, TicketSource } from '../types'

const PANE = 'jira-ticket'
const SPRINT_FIELD = 'customfield_10020'
// Marks the plugin's own Jira calls, so the observer below does not count them.
const MARK = 'jira_mcp_card'
const REFRESH_MS = 2 * 60 * 1000
const STALE_MS = 60 * 1000
const MAX_SEEN = 10
const DESCRIPTION_CHARS = 700

const EMPTY: JiraState = { seen: [], issues: {}, children: {}, errors: {}, siteUrl: null, isLoading: false, fetchedAt: null }
const jira = atom({ plugin: 'jira-ticket', key: 'jira' } as const, EMPTY)
const isBandHidden = atom({ plugin: 'jira-ticket', key: 'isBandHidden' } as const, false)

// ---------- finding keys ----------

// Prefixes that look like Jira keys and never are (UTF-8, SHA-256, ...).
const NOT_JIRA = new Set([
  'UTF', 'ISO', 'SHA', 'AES', 'RFC', 'HTTP', 'TLS', 'SSL', 'CVE', 'RSA', 'ECMA', 'ES', 'IPV', 'MD', 'GPT',
  'WIN', 'OS', 'TS', 'JS', 'PR', 'ARM', 'X', 'H', 'E', 'COVID', 'PEP', 'JSR', 'GO', 'NODE', 'JAVA', 'V',
])
const STRICT_KEY = /\b([A-Z]{2}[A-Z0-9]{0,8}-\d{1,6})\b/g
const LOOSE_KEY = /(?:^|[^A-Za-z0-9-])([A-Za-z]{2}[A-Za-z0-9]{0,8}-\d{1,6})(?![0-9A-Za-z])/g
const URL_KEY = /atlassian\.net\/browse\/([A-Z]{2}[A-Z0-9]{0,8}-\d{1,6})/g

const isJiraLike = (key: string) => !NOT_JIRA.has(key.split('-')[0] ?? '')

function collect(text: string, pattern: RegExp): string[] {
  const keys: string[] = []
  for (const match of text.matchAll(pattern)) {
    const key = match[1]?.toUpperCase()
    if (key && isJiraLike(key) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** Keys written the way people write them: PROJ-123, or a browse URL. */
export const keysInText = (text: string): string[] => [
  ...new Set([...collect(text, URL_KEY), ...collect(text, STRICT_KEY)]),
]

/** Keys in a branch or a git command, where they are often lowercase. */
export const keysInBranch = (text: string): string[] => collect(text, LOOSE_KEY)

// Only the branch a git command names, and a PR's title or head: never the
// rest of a command, which can hold anything (a heredoc, a test fixture).
const GIT_BRANCH = /\bgit\s+(?:checkout|switch|branch|push|worktree\s+add)\b[^\n;&|]*/g
const GH_PR = /\bgh\s+pr\s+(?:create|edit)\b[^\n;&|]*/g
const PR_TITLE = /--(?:title|head|base)[=\s]+(?:"([^"]*)"|'([^']*)'|(\S+))|-t\s+(?:"([^"]*)"|'([^']*)')/g

export function keysInGitCommand(command: string): string[] {
  const keys: string[] = []
  for (const [part] of command.matchAll(GIT_BRANCH)) keys.push(...keysInBranch(part))
  for (const [part] of command.matchAll(GH_PR)) {
    for (const m of part.matchAll(PR_TITLE)) keys.push(...keysInBranch(m.slice(1).find(Boolean) ?? ''))
  }
  return [...new Set(keys)]
}

const JIRA_ISSUE_TOOL =
  /__(getJiraIssue|editJiraIssue|transitionJiraIssue|addCommentToJiraIssue|addWorklogToJiraIssue|getTransitionsForJiraIssue|getJiraIssueRemoteIssueLinks)$/

/** The keys a tool call is about, from its input (and a created issue's result). */
export function keysInToolCall(tool: string, input: Record<string, unknown>, resultText?: string): string[] {
  if (input.actionSource === MARK) return []
  if (JIRA_ISSUE_TOOL.test(tool) && typeof input.issueIdOrKey === 'string') {
    return keysInBranch(input.issueIdOrKey)
  }
  if (/__createJiraIssue$/.test(tool) && resultText) {
    const created = resultText.match(/"key"\s*:\s*"([A-Z][A-Z0-9]{1,9}-\d{1,6})"/)?.[1]
    return created ? [created] : []
  }
  if (tool === 'Bash' && typeof input.command === 'string') return keysInGitCommand(input.command)
  return []
}

// ---------- the session's tickets ----------

const seenKey = async ($: EngineInterface) => `seen.v2:${await $.session.id()}`

let bandHiddenFor: string | null = null

async function remember($: EngineInterface, keys: string[], source: TicketSource): Promise<boolean> {
  if (keys.length === 0) return false
  const at = Date.now()
  let isNew = false
  const next = await update($, jira, s => {
    const seen = [...s.seen]
    for (const key of keys) {
      const i = seen.findIndex(one => one.key === key)
      if (i === -1) isNew = true
      const kept = i === -1 ? null : seen.splice(i, 1)[0]!
      seen.push({ key, source: kept?.source === 'manual' ? 'manual' : source, at })
    }
    return { ...s, seen: seen.slice(-MAX_SEEN) }
  })
  await $.store.set(await seenKey($), next.seen)
  if (isNew) {
    await update($, isBandHidden, () => false)
    scheduleRefresh($)
  }
  return isNew
}

async function forget($: EngineInterface, keys: string[] | 'all') {
  const next = await update($, jira, s =>
    keys === 'all' ? EMPTY : { ...s, seen: s.seen.filter(one => !keys.includes(one.key)) },
  )
  await $.store.set(await seenKey($), next.seen)
}

async function currentBranch($: EngineInterface): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    const branch = stdout.trim()
    return exitCode === 0 && branch !== '' && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}

let lastBranch: string | null = null

async function checkBranch($: EngineInterface) {
  const branch = await currentBranch($)
  if (branch === null || branch === lastBranch) return
  lastBranch = branch
  await remember($, keysInBranch(branch).slice(0, 1), 'branch')
}

async function scanHistory($: EngineInterface) {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return
  const keys: string[] = []
  for (const message of messages) {
    if (message.role === 'user') keys.push(...keysInText(message.text))
    for (const use of message.toolUses) keys.push(...keysInToolCall(use.tool, use.input, use.text))
  }
  await remember($, [...new Set(keys)].slice(-MAX_SEEN), 'history')
}

// ---------- Jira ----------

/** A ticket's page on the site, or '' while the site is not known (the link then draws as text). */
const ticketUrl = (siteUrl: string | null, key: string) => (siteUrl ? `${siteUrl}/browse/${key}` : '')

type Site = { cloudId: string; url: string }
let site: Site | null = null

/** The Jira site the Atlassian connector reaches: asked once, then kept in the store. */
async function jiraSite($: EngineInterface): Promise<Site> {
  if (site) return site
  const stored = (await $.store.get('site')) as Site | undefined
  if (stored?.cloudId && stored.url) return (site = stored)
  const body = await callTool($, 'getAccessibleAtlassianResources', {})
  const list: any[] = Array.isArray(body) ? body : (body?.resources ?? [])
  const found = list.find(r => r?.scopes?.some((one: string) => one.includes('jira'))) ?? list[0]
  if (!found?.id || !found?.url) throw new Error('The Atlassian connector returned no Jira site.')
  site = { cloudId: String(found.id), url: String(found.url).replace(/\/$/, '') }
  await $.store.set('site', site)
  return site
}
const toolNames = new Map<string, string>()

async function jiraTool($: EngineInterface, name: string): Promise<string> {
  const known = toolNames.get(name)
  if (known) return known
  const found = (await $.tool.list()).find(t => t.name.startsWith('mcp__') && t.name.endsWith(`__${name}`))
  if (!found) throw new Error('No Atlassian connector in this session.')
  toolNames.set(name, found.name)
  return found.name
}

class NotFound extends Error {}

async function callJira($: EngineInterface, name: string, args: Record<string, unknown>): Promise<any> {
  const { cloudId } = await jiraSite($)
  return callTool($, name, { cloudId, actionSource: MARK, ...args })
}

async function callTool($: EngineInterface, name: string, args: Record<string, unknown>): Promise<any> {
  const tool = await jiraTool($, name)
  const ran: any = await $.tool.call({ tool, ...args } as any)
  if (ran.deny) throw new Error(ran.deny)
  const text: string = ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))
  if (ran.isError) {
    if (/does not exist|not found|404|No issue/i.test(text)) throw new NotFound(text)
    throw new Error(text.slice(0, 300))
  }
  return JSON.parse(text)
}

const ISSUE_FIELDS = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'parent', SPRINT_FIELD]

function shorten(markdown: string): string {
  if (markdown.length <= DESCRIPTION_CHARS) return markdown
  const cut = markdown.slice(0, DESCRIPTION_CHARS)
  const atParagraph = cut.lastIndexOf('\n\n')
  return `${(atParagraph > DESCRIPTION_CHARS / 2 ? cut.slice(0, atParagraph) : cut).trimEnd()} …`
}

export function toIssue(node: any): Issue {
  const f = node.fields ?? {}
  const sprints: any[] = Array.isArray(f[SPRINT_FIELD]) ? f[SPRINT_FIELD] : []
  const sprint = sprints.find(s => s?.state === 'active') ?? sprints.at(-1)
  const description = typeof f.description === 'string' ? f.description.trim() : ''
  return {
    key: node.key,
    url: node.webUrl ?? '',
    summary: f.summary ?? '(no title)',
    type: f.issuetype?.name ?? null,
    isSubtask: f.issuetype?.subtask === true,
    status: f.status?.name ?? '—',
    statusCategory: f.status?.statusCategory?.key ?? null,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    sprint: sprint?.name ?? null,
    parentKey: f.parent?.key ?? null,
    description: description === '' ? null : shorten(description),
  }
}

export function toChild(node: any): Child {
  const f = node.fields ?? {}
  return {
    key: node.key,
    url: node.webUrl ?? '',
    summary: f.summary ?? '',
    type: f.issuetype?.name ?? null,
    status: f.status?.name ?? '—',
    statusCategory: f.status?.statusCategory?.key ?? null,
    assignee: f.assignee?.displayName ?? null,
  }
}

async function fetchIssue($: EngineInterface, key: string): Promise<Issue> {
  const body = await callJira($, 'getJiraIssue', {
    issueIdOrKey: key,
    fields: ISSUE_FIELDS,
    responseContentFormat: 'markdown',
  })
  const node = body?.issues?.nodes?.[0] ?? (body?.key ? body : null)
  if (!node) throw new NotFound(`${key} does not exist`)
  return toIssue(node)
}

async function fetchChildren($: EngineInterface, key: string): Promise<Child[]> {
  const body = await callJira($, 'searchJiraIssuesUsingJql', {
    jql: `parent = ${key} ORDER BY key ASC`,
    fields: ['summary', 'status', 'issuetype', 'assignee'],
    maxResults: 50,
  })
  return (body?.issues?.nodes ?? []).map(toChild)
}

export type Group = { rootKey: string; root: Issue | null; children: Child[]; seen: Seen[] }

/** The session's tickets grouped under their parent, the newest work first. */
export function groupsOf(s: JiraState): Group[] {
  const groups: Group[] = []
  for (const one of [...s.seen].reverse()) {
    const issue = s.issues[one.key]
    const rootKey = issue?.isSubtask && issue.parentKey ? issue.parentKey : one.key
    let group = groups.find(g => g.rootKey === rootKey)
    if (!group) {
      group = { rootKey, root: s.issues[rootKey] ?? null, children: s.children[rootKey] ?? [], seen: [] }
      groups.push(group)
    }
    if (one.key !== rootKey) group.seen.push(one)
  }
  return groups
}

const fetchedAt = new Map<string, number>()
const isStale = (key: string, force: boolean) => force || Date.now() - (fetchedAt.get(key) ?? 0) > STALE_MS

let isRefreshing = false
let isAgain = false

async function refresh($: EngineInterface, force = false) {
  if (isRefreshing) {
    isAgain = true
    return
  }
  isRefreshing = true
  try {
    do {
      isAgain = false
      await refreshOnce($, force)
    } while (isAgain)
  } finally {
    isRefreshing = false
  }
}

async function refreshOnce($: EngineInterface, force: boolean) {
  const start = await read($, jira)
  if (start.seen.length === 0) return
  await update($, jira, s => ({ ...s, isLoading: true }))

  const issues: Record<string, Issue> = {}
  const children: Record<string, Child[]> = {}
  const errors: Record<string, string> = {}
  const missing: string[] = []

  const load = async (key: string) => {
    if (!isStale(key, force) && start.issues[key]) return
    try {
      issues[key] = await fetchIssue($, key)
      fetchedAt.set(key, Date.now())
    } catch (e) {
      if (e instanceof NotFound) missing.push(key)
      else errors[key] = e instanceof Error ? e.message : String(e)
    }
  }

  for (const one of start.seen) await load(one.key)
  const known = { ...start.issues, ...issues }
  const roots = new Set(
    start.seen
      .filter(one => !missing.includes(one.key))
      .map(one => (known[one.key]?.isSubtask && known[one.key]?.parentKey) || one.key),
  )
  for (const root of roots) {
    if (!known[root]) await load(root)
    if (!isStale(`children:${root}`, force) && start.children[root]) continue
    try {
      children[root] = await fetchChildren($, root)
      fetchedAt.set(`children:${root}`, Date.now())
    } catch (e) {
      errors[root] = e instanceof Error ? e.message : String(e)
    }
  }

  const next = await update($, jira, s => {
    const seen = s.seen.filter(one => one.source === 'manual' || !missing.includes(one.key))
    const kept = Object.fromEntries(Object.entries(s.errors).filter(([key]) => !(key in issues)))
    return {
      ...s,
      seen,
      issues: { ...s.issues, ...issues },
      children: { ...s.children, ...children },
      errors: { ...kept, ...errors },
      siteUrl: site?.url ?? s.siteUrl,
      isLoading: false,
      fetchedAt: Date.now(),
    }
  })
  if (missing.length > 0) await $.store.set(await seenKey($), next.seen)
}

function scheduleRefresh($: EngineInterface, force = false) {
  $.clock.after(300, () => {
    void refresh($, force)
  })
}

const TRACK_TOOL = 'mcp__jira-ticket__track_ticket'

async function trackTicket($: EngineInterface, raw: unknown): Promise<any> {
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')]
  if (list[0] === 'clear') {
    await forget($, 'all')
    return { result: 'cleared' }
  }
  const keys = [...new Set(list.flatMap(one => [...keysInText(one.toUpperCase()), ...keysInBranch(one)]))]
  if (keys.length === 0) return { result: 'No Jira keys in the input.', isError: true }
  await remember($, keys, 'manual')
  await refresh($, true)
  return { result: describe(await read($, jira)) }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Jira' })

function describe(s: JiraState): string {
  if (s.seen.length === 0) return 'No Jira tickets in this session.'
  return s.seen
    .map(one => {
      const issue = s.issues[one.key]
      const error = s.errors[one.key]
      return issue ? `${issue.key} ${issue.summary} (${issue.status})` : error ? `${one.key} (error: ${error})` : one.key
    })
    .join('; ')
}

// ---------- drawing helpers ----------

function statusColor(category: string | null) {
  return category === 'done' ? 'success' : category === 'indeterminate' ? 'warning' : 'subtle'
}

type Item = { key: string; url: string; status: string; category: string | null; isWorked: boolean }

/** PROJ-1 (In Progress) -> PROJ-2 (Done) / PROJ-3 (To Do) */
function chain(ui: any, g: Group, children: Child[], current: string | undefined, siteUrl: string | null, tail?: unknown) {
  const { Box, Text, Link } = ui
  const seenKeys = g.seen.map(one => one.key)
  const root: Item = {
    key: g.rootKey,
    url: g.root?.url || ticketUrl(siteUrl, g.rootKey),
    status: g.root?.status ?? '…',
    category: g.root?.statusCategory ?? null,
    isWorked: g.rootKey === current,
  }
  const items: Item[] = children.map(c => ({
    key: c.key,
    url: c.url,
    status: c.status,
    category: c.statusCategory,
    isWorked: seenKeys.includes(c.key),
  }))
  // A worked subtask Jira has not listed yet still shows.
  for (const one of g.seen) {
    if (!items.some(i => i.key === one.key)) {
      items.push({ key: one.key, url: ticketUrl(siteUrl, one.key), status: '…', category: null, isWorked: true })
    }
  }
  const item = (i: Item) => [
    <Link key={`l-${i.key}`} href={i.url} label={i.key} />,
    <Text key={`s-${i.key}`} color={statusColor(i.category)} bold={i.isWorked}>{`(${i.status})`}</Text>,
  ]
  return (
    <Box key={`g-${g.rootKey}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
      {item(root)}
      {items.length > 0 ? <Text dimColor>-&gt;</Text> : null}
      {items.flatMap((i, n) => [...(n > 0 ? [<Text key={`sep-${i.key}`} dimColor>/</Text>] : []), ...item(i)])}
      {tail ?? null}
    </Box>
  )
}

function withIssues(s: JiraState, g: Group): Child[] {
  return g.seen.map(one => {
    const listed = g.children.find(c => c.key === one.key)
    const issue = s.issues[one.key]
    return (
      listed ?? {
        key: one.key,
        url: issue?.url || ticketUrl(s.siteUrl, one.key),
        summary: issue?.summary ?? '',
        type: issue?.type ?? null,
        status: issue?.status ?? '…',
        statusCategory: issue?.statusCategory ?? null,
        assignee: issue?.assignee ?? null,
      }
    )
  })
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jira',
      description: 'Opens the Jira pane. /jira PROJ-123 adds a ticket, /jira clear empties the list.',
    })
    await $.tool.register({
      name: 'track_ticket',
      description:
        'Adds Jira tickets to the Jira pane and band of this session. Tickets mentioned in prompts, git branches and Jira tool calls are picked up automatically; call this only for a ticket the user names some other way.',
      inputSchema: {
        type: 'object',
        properties: { keys: { type: 'array', items: { type: 'string' }, description: 'Jira keys or ticket URLs' } },
        required: ['keys'],
      },
    })
    $.clock.every(REFRESH_MS, () => {
      void refresh($)
    })

    const ran = await next(e)
    const stored = await $.store.get(await seenKey($))
    if (Array.isArray(stored) && stored.length > 0) {
      await update($, jira, s => ({ ...s, seen: stored as Seen[] }))
    }
    await scanHistory($)
    await checkBranch($)
    scheduleRefresh($)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) await remember($, keysInText(e.text), 'prompt')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TRACK_TOOL) return trackTicket($, (e as unknown as { keys?: unknown }).keys)
    const ran = await next(e)
    const input = e as unknown as Record<string, unknown>
    const text = (ran as { text?: string }).text
    const keys = keysInToolCall(String(e.tool), input, text)
    if (keys.length > 0) await remember($, keys, 'tool')
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await checkBranch($)
    return ran
  })

  on('command.run', { command: 'jira' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await forget($, 'all')
      return { text: 'Removed every ticket from this session.' }
    }
    if (arg !== '') {
      const keys = [...keysInText(arg.toUpperCase()), ...keysInBranch(arg)]
      if (keys.length === 0) return { text: `"${arg}" does not look like a Jira key (e.g. PROJ-123).` }
      await remember($, [...new Set(keys)], 'manual')
    }
    await openPane($)
    await refresh($, true)
    return { text: describe(await read($, jira)) }
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, jira)
    if (e.props.hasSurvey || s.seen.length === 0 || (await read($, isBandHidden))) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const current = s.seen.at(-1)?.key
    const groups = groupsOf(s).slice(0, Math.max(1, e.props.maxRows - 1))
    const buttons = [
      <Button key="detail" plain onPress={() => void openPane($)}>Details</Button>,
      <Button key="hide" plain onPress={() => update($, isBandHidden, () => true)}>Hide</Button>,
    ]
    return (
      <Box flexDirection="column">
        {groups.map((g, n) => chain($.ui.resolve(e), g, withIssues(s, g), current, s.siteUrl, n === 0 ? buttons : undefined))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, jira)
    const current = s.seen.at(-1)?.key

    if (s.seen.length === 0) {
      return (
        <Text dimColor>
          No Jira tickets in this session yet. They show up on their own from the git branch, when you name one in
          the chat, or when one is worked on.
        </Text>
      )
    }

    const errors = Object.entries(s.errors).filter(([key]) => s.seen.some(one => one.key === key) || groupsOf(s).some(g => g.rootKey === key))
    return (
      <Box flexDirection="column" gap={1}>
        {groupsOf(s).map(g => chain($.ui.resolve(e), g, g.children.length > 0 ? g.children : withIssues(s, g), current, s.siteUrl))}
        {errors.map(([key, error]) => (
          <Text key={`e-${key}`} color="error">{`${key}: ${error}`}</Text>
        ))}
        <Box flexDirection="row">
          <Button key="reload" plain onPress={() => void refresh($, true)}>{s.isLoading ? 'Refreshing…' : 'Refresh'}</Button>
        </Box>
      </Box>
    )
  })
}
