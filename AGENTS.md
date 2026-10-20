# AGENTS.md

Guidance for coding agents working on this repository.

## What this is

A Claude Code plugin made of function hooks (a "mod"): one hooks module, `hooks/register.tsx`, that
`hooks/hooks.json` names. It runs inside Claude Code's own sandbox, with no DOM and no Node: everything
outside the module is reached through `$` (the engine interface), and JSX compiles against the global `h`.

## Layout

| Path | What it holds |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest. `types` points at the state contract. |
| `.claude-plugin/marketplace.json` | Makes this repository a one-plugin marketplace (`source: "./"`). |
| `hooks/register.tsx` | All the behaviour: finding keys, calling Jira, grouping, drawing. |
| `types/index.d.ts` | The contract for every value the module keeps in `$.state`. |
| `tests/pane.test.tsx` | Tests run by `claude plugin test`, against the engine itself. |

`.claude-plugin/types/` is written by Claude Code each time it loads the plugin (the API's declarations
and a `tsconfig.json` the top-level one extends). It is ignored by git; never edit it.

## How it works

1. **Finding tickets.** Keys come from the git branch (`git rev-parse --abbrev-ref HEAD`, checked at
   session start and after every turn), the user's prompts, the input of Jira tool calls
   (`issueIdOrKey`), a created issue's result, the branch or PR title in `git` / `gh pr` commands, and
   the transcript when a session resumes. A key Jira says does not exist is dropped.
2. **Calling Jira.** The module never talks to Jira directly. It finds the Atlassian connector's tools
   with `$.tool.list()` (any `mcp__*__getJiraIssue`) and calls them with `$.tool.call`. The site comes
   from `getAccessibleAtlassianResources` once and is kept in `$.store`. Its own calls carry
   `actionSource: "jira_mcp_card"`, which the tool-call observer skips.
3. **Grouping.** A subtask is shown under its parent; the parent's subtasks come from
   `searchJiraIssuesUsingJql` with `parent = KEY`.
4. **Drawing.** A `ui.render` hook on `AbovePrompt` draws the band (the parent and the subtasks worked
   on), and one on `Pane` draws every subtask of each parent.

## Rules for changes

- Keep everything in English: code, comments, UI text, docs.
- Keep it generic: no company names, sites, ticket keys or people in code, tests or docs. Tests use
  invented data (`PROJ-1`, `example.atlassian.net`).
- `$` may only be passed to functions declared at the top of the file; drawing helpers take the element
  table from `$.ui.resolve(e)` instead.
- State a drawing reads lives in `$.state` (declared in `types/index.d.ts`), never in module variables:
  a reload starts the module over.
- A render hook never writes state; write from a press handler or another event.
- Background Jira calls go through the permission check. Read-only tools only.

## Checking a change

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .   # after Claude Code has loaded the plugin once, so .claude-plugin/types exists
```

The API is early access. Its declarations, laid in `.claude-plugin/types/claude-code/index.d.ts`, are the
reference: grep them for an event or a noun on `$` before guessing.
