export type TicketSource = 'branch' | 'prompt' | 'tool' | 'history' | 'manual'

export type Seen = { key: string; source: TicketSource; at: number }

export type Issue = {
  key: string
  url: string
  summary: string
  type: string | null
  isSubtask: boolean
  status: string
  statusCategory: string | null
  priority: string | null
  assignee: string | null
  sprint: string | null
  parentKey: string | null
  description: string | null
}

export type Child = {
  key: string
  url: string
  summary: string
  type: string | null
  status: string
  statusCategory: string | null
  assignee: string | null
}

export type JiraState = {
  seen: Seen[]
  issues: Record<string, Issue>
  children: Record<string, Child[]>
  errors: Record<string, string>
  /** The Jira site's address, once the connector named it. */
  siteUrl: string | null
  isLoading: boolean
  fetchedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'jira-ticket': { jira: JiraState; isBandHidden: boolean }
  }
}
