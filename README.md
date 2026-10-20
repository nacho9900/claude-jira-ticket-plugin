# claude-jira-ticket-plugin

A [Claude Code](https://code.claude.com) plugin that shows the Jira tickets a session is working on,
without you asking for them.

Each parent ticket gets one compact line, with the subtasks you touched in the session after it:

```
PROJ-100 (In Progress) -> PROJ-101 (Done) / PROJ-104 (In Review)
OPS-30 (To Do)
```

Every key is a link to the ticket, and each status is colored by its category (done, in progress, to do).

- **Band above the prompt:** the parent and the subtasks worked on in this session, with **Details** and
  **Hide**.
- **Side pane (Details):** the same lines with every subtask of each parent, and **Refresh**.

It refreshes on its own every two minutes.

## How tickets are found

Nothing to type. A ticket joins the session when:

- the git branch has its key (`proj-101-fix-export`, `me/PROJ-101`), checked at start and after every turn;
- you write its key or its `…atlassian.net/browse/…` link in a prompt;
- Claude reads, edits, transitions or comments on it through the Atlassian connector, or creates it;
- a `git checkout -b`, `git switch -c`, `git push` or `gh pr create --title …` command names it;
- the session resumes and its history mentions it.

A key Jira does not know is dropped, and strings like `UTF-8` or `SHA-256` are never taken for keys.
Subtasks are grouped under their parent; a ticket without a parent is its own line.

## Requirements

- A Claude Code build with plugin function hooks (early access).
- The **Atlassian** connector (the Atlassian Rovo MCP server) connected in the session, signed in to your
  Jira Cloud site. The plugin finds the site on its own.
- Permission for three **read-only** connector tools, so the plugin can call them in the background
  without a prompt (in auto mode they are refused otherwise, since no message of yours asked for them):
  `getAccessibleAtlassianResources`, `getJiraIssue` and `searchJiraIssuesUsingJql`.

The tool names carry your connector's server name, which `/mcp` shows. In `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__<server>__getAccessibleAtlassianResources",
      "mcp__<server>__getJiraIssue",
      "mcp__<server>__searchJiraIssuesUsingJql"
    ]
  }
}
```

## Install

At the prompt of a terminal session:

```
/plugin install jira-ticket --marketplace nacho9900/claude-jira-ticket-plugin
```

Answer `y` to add the marketplace, then pick a scope (user installs it for every session).

From a shell:

```bash
claude plugin install jira-ticket --marketplace nacho9900/claude-jira-ticket-plugin
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `nacho9900/claude-jira-ticket-plugin`, then **Add plugin**.

Or run it from a clone: name the folder in `CLAUDE_CODE_PLUGIN_DIRS`, in the `env` block of
`~/.claude/settings.json`.

## Commands

The plugin works on its own; these are there when you want them.

| Command | What it does |
| --- | --- |
| `/jira` | Opens the side pane. |
| `/jira PROJ-123` | Adds a ticket by hand. |
| `/jira clear` | Empties the session's list. |

Claude also gets a `track_ticket` tool, for a ticket you name some other way.

## Notes

- The sprint is read from `customfield_10020`, Jira Cloud's default sprint field.
- The list is kept per session, so a resumed session shows its tickets again.

## Development

```bash
claude plugin validate .
claude plugin test .
```

See [AGENTS.md](AGENTS.md) for how the code is laid out and the rules for changing it.

## License

[MIT](LICENSE)
