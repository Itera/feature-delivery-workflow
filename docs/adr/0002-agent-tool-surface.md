# ADR-0002 · Every agent declares its whole tool surface

- **Status:** Accepted (2026-11-05)
- **Fixed rules touched:** “Verifiers are separate, fresh, read-only”; “No tracker writes” for pilots without a tracker block

## Context
Spike S6: an agent started by DF inherits every MCP server and plugin of the person running it (Jira and Confluence write, mail, chat,
GitHub, design tools) and agent tools such as `Agent`, `Skill`, `Workflow` and `PowerShell`. `allowed_tools` restricts built-in tools
only; MCP tools stay. A builder could therefore move a Jira issue, post a message or open a PR outside the factory's control, and a
`PowerShell` call sidesteps Bash deny patterns.

## Decision
- Each role file declares `allowed_tools` explicitly (builders: `Read, Glob, Grep, Write, Edit, Bash(<listed commands>)`; verifiers: read-only and `git diff/log/show`), plus `denied_tools: ["mcp__*", "Agent", "Task", "Skill", "Workflow", "PowerShell", "WebFetch", "WebSearch"]`.
- External side effects (push, PR, tracker) happen only in deterministic command tasks.
- A `tool-surface` gate reads each agent's init event from its transcript and fails the run if the tools offered differ from the role's declaration. This catches new user MCP servers or engine changes.
- Code Compass for agents is deferred (it would need an MCP allow that the wildcard deny overrides). Until increment 3 decides, code intelligence runs as a deterministic step whose output is passed to the agents.

## Consequences
- Runs are reproducible across people: the result doesn't depend on who has which plugins.
- Adding a tool to a role is a template change, reviewed like any other.
