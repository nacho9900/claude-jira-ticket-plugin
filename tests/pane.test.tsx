import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { groupsOf, keysInBranch, keysInText, keysInToolCall } from '../hooks/register'

const node = (key: string, fields: Record<string, unknown>) => ({
  key,
  webUrl: `https://example.atlassian.net/browse/${key}`,
  fields,
})

const ISSUES: Record<string, unknown> = {
  'PROJ-6601': node('PROJ-6601', {
    summary: 'Backend | Fix the export',
    issuetype: { name: 'Dev Task', subtask: true },
    status: { name: 'Done', statusCategory: { key: 'done' } },
    priority: { name: 'Medium' },
    assignee: { displayName: 'Ada Lovelace' },
    customfield_10020: [{ name: 'Sprint 12', state: 'active' }],
    parent: { key: 'PROJ-6600' },
    description: 'Stream the file.',
  }),
  'PROJ-6600': node('PROJ-6600', {
    summary: 'Reports | Export fails for large files',
    issuetype: { name: 'Bug', subtask: false },
    status: { name: 'Developed', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'Lowest' },
    description: '## Context\n\nThe export times out.',
  }),
}
const CHILDREN = [
  node('PROJ-6601', { summary: 'Backend | Fix the export', status: { name: 'Done', statusCategory: { key: 'done' } } }),
  node('PROJ-6602', { summary: 'Mobile | Fix the export', status: { name: 'To Do', statusCategory: { key: 'new' } } }),
]

function world(on: On, branch: string, calls: string[]) {
  mock.store(on)
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('--abbrev-ref') ? `${branch}\n` : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('tool.list', () =>
    ({
      value: [
        { name: 'mcp__atl__getAccessibleAtlassianResources' },
        { name: 'mcp__atl__getJiraIssue' },
        { name: 'mcp__atl__searchJiraIssuesUsingJql' },
      ],
    }) as any,
  )
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, any>
    if (input.tool === 'mcp__atl__getAccessibleAtlassianResources') {
      const sites = [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: ['read:jira-work'] }]
      return { result: '', text: JSON.stringify(sites) } as any
    }
    if (input.cloudId !== 'cloud-1') throw new Error(`called Jira with cloudId ${input.cloudId}`)
    if (input.tool === 'mcp__atl__getJiraIssue') {
      calls.push(`issue ${input.issueIdOrKey}`)
      const found = ISSUES[input.issueIdOrKey]
      return (found
        ? { result: '', text: JSON.stringify({ issues: { nodes: [found] } }) }
        : { result: '', isError: true, text: 'Issue does not exist or you do not have permission to see it.' }) as any
    }
    if (input.tool === 'mcp__atl__searchJiraIssuesUsingJql') {
      calls.push(`jql ${input.jql}`)
      return { result: '', text: JSON.stringify({ issues: { nodes: CHILDREN } }) } as any
    }
    return { result: 'ok', text: 'ok' } as any
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: { tool: 'mcp__jira-ticket__track_ticket' } }) as any)
  return clock
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: {} } as any
const PANE_PROPS = { title: 'Jira', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: {} } as any

describe('finding keys', () => {
  test('text: keys and browse links, not UTF-8 or SHA-256', () => {
    expect(keysInText('look at PROJ-6601 and https://example.atlassian.net/browse/OPS-30, in UTF-8 with SHA-256')).toEqual([
      'OPS-30',
      'PROJ-6601',
    ])
  })
  test('branch: lowercase keys', () => {
    expect(keysInBranch('me/proj-6601-stream-export')).toEqual(['PROJ-6601'])
    expect(keysInBranch('main')).toEqual([])
  })
  test('tool calls: Jira tools and git commands, not the plugin own calls', () => {
    expect(keysInToolCall('mcp__x__getJiraIssue', { issueIdOrKey: 'PROJ-1' })).toEqual(['PROJ-1'])
    expect(keysInToolCall('mcp__x__getJiraIssue', { issueIdOrKey: 'PROJ-1', actionSource: 'jira_mcp_card' })).toEqual([])
    expect(keysInToolCall('Bash', { command: 'git checkout -b proj-77-fix' })).toEqual(['PROJ-77'])
    expect(keysInToolCall('Bash', { command: 'ls PROJ-77' })).toEqual([])
    expect(keysInToolCall('Read', { file_path: '/x/PROJ-77.md' })).toEqual([])
  })
  test('subtasks group under their parent, newest first', () => {
    const groups = groupsOf({
      seen: [
        { key: 'OPS-30', source: 'prompt', at: 1 },
        { key: 'PROJ-6601', source: 'branch', at: 2 },
      ],
      issues: { 'PROJ-6601': { isSubtask: true, parentKey: 'PROJ-6600' } as any },
      children: {},
      errors: {},
      isLoading: false,
      fetchedAt: null,
    })
    expect(groups.map(g => g.rootKey)).toEqual(['PROJ-6600', 'OPS-30'])
    expect(groups[0]!.seen.map(one => one.key)).toEqual(['PROJ-6601'])
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the branch's subtask shows in the band under its parent, with links`, async ($, on) => {
    const calls: string[] = []
    const clock = world(on, 'proj-6601-stream-export', calls)
    on('session.start', () => ({ cwd: '/repo' }) as any)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as any)
    await clock.advance(1000)
    await clock.settle()

    expect(calls).toContain('issue PROJ-6601')
    expect(calls).toContain('jql parent = PROJ-6600 ORDER BY key ASC')

    const band = await $.ui.mount({ plugin: 'jira-ticket', surface, component: 'AbovePrompt', props: BAND_PROPS })
    const parent = await band.find({ type: 'Link', text: 'PROJ-6600' })
    expect(parent?.props.href).toBe('https://example.atlassian.net/browse/PROJ-6600')
    expect(await band.find({ type: 'Link', text: 'PROJ-6601' })).toBeDefined()
    expect(await band.find({ type: 'Link', text: 'PROJ-6602' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '(Developed)' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '(Done)' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '->' })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'detail' })).toBeDefined()

    const pane = await $.ui.mount({ plugin: 'jira-ticket', surface, component: 'Pane', requestId: 'jira-ticket', props: PANE_PROPS })
    expect(await pane.find({ type: 'Link', text: 'PROJ-6602' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '(To Do)' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
  })
}

test('a key in a prompt is picked up, a key Jira does not know is dropped', async ($, on) => {
  const calls: string[] = []
  const clock = world(on, 'main', calls)
  on('prompt.submit', ($, e) => ({ text: e.text }) as any)
  await $.prompt.submit({ text: 'start with PROJ-6600 and also FOO-1' } as any)
  await clock.advance(1000)
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'jira-ticket', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Link', text: 'PROJ-6600' })).toBeDefined()
  expect(await band.find({ type: 'Link', text: 'FOO-1' })).toBeUndefined()
})

test('nothing found: no band', async ($, on) => {
  world(on, 'main', [])
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as any)
  const band = await $.ui.mount({ plugin: 'jira-ticket', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Button', key: 'detail' })).toBeUndefined()
})

test('git commands: only the branch and the PR title count', () => {
  expect(keysInToolCall('Bash', { command: "cat > x.ts <<'EOF'\nsession-1 [A-Z0-9]\nEOF\ngit status" })).toEqual([])
  expect(keysInToolCall('Bash', { command: 'git switch -c proj-88-x && npm test' })).toEqual(['PROJ-88'])
  expect(keysInToolCall('Bash', { command: 'gh pr create --title "PROJ-90 | Fix" --body "see UTF-8 FOO-2"' })).toEqual(['PROJ-90'])
})
