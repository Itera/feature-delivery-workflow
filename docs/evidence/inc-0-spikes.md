# Increment 0 · spike results (2026-11-05)

Engine: `digital-factory.exe` (Windows amd64 build 2026-09-01). Claude CLI as the agent runtime. Target: a disposable scratch
repo, no LCA repo touched. Workflows: [spikes/s1-s5.yaml](../../spikes/s1-s5.yaml), [spikes/s6-toolset.yaml](../../spikes/s6-toolset.yaml).
Total spike cost: about $0.24 (S5 on Sonnet was $0.21 of it, cold cache).

| Spike | Result | Evidence | Consequence |
|---|---|---|---|
| S1 isolation | **Pass, with a surprise.** An agent with `cwd: ${repo_path}` wrote only its own file into the target repo; `git status --porcelain --ignored` showed only `notes/`. But DF writes `.digital-factory/` and `.digital-factory-outputs/` **next to the workflow file**, not into `-w`. | Scratch repo status; files under `spikes/.digital-factory-outputs/` | The driver copies the rendered workflow + prompts into `runs/<run>/` and runs it there, so outputs land per run. The copy doubles as the trust snapshot of the template. [ADR-0001](../adr/0001-run-from-outside-the-project.md). The C1 fallback is not needed. |
| S2 deny rules | **Pass.** Under `bypassPermissions`, `Edit(locked/**)` and `Write(locked/**)` were refused (“File is in a directory that is denied”), and `Bash(echo:*)` was refused. | Agent tool results in the s2 transcript | “The builder can't touch tests” is enforced, not only detected. Bash patterns only cover the named commands (`sed -i`, `cp`, `printf >` would pass), so the snapshot and hash guards stay as the second layer (spec §2.10). |
| S3 shell | **Fail as assumed.** DF runs `command` tasks through **cmd.exe** on Windows. `bash` on the PATH resolves first to Git Bash, then to WSL `System32\bash.exe`. | s3 output = the command echoed back by cmd; `where bash` | Every command task is a single cmd-safe line that calls Git Bash by absolute path (adapter `shell.bash`) with a script from the run's copy. Peter's multi-line inline gate scripts move into `scripts/gates/*.sh`. |
| S4 gh accounts | **Pass.** `gh auth switch` to `michal-matovcik-lca` and back works. Michal is assignable (204) in `lca-tools-be`, `lca-tools-fe` and `lca-tools-docs`. | `gh api` output | `publish` switches the account, then restores it in a `trap`. |
| S5 advisor | **No advisor tool** on the DF Claude runtime. | s5 tool list | Spec fallback applies: an Opus skeleton or plan does the advisor's job up front (relevant from increment 5). |
| S6 tool surface (new) | Agents inherit **all of the user's MCP servers** (17: Jira and Confluence write, Gmail, Slack, GitHub, Figma, …) and agent tools (`Agent`, `Skill`, `Workflow`, `PowerShell`). `allowed_tools` restricts built-in tools but **not** MCP tools (114 remained). `denied_tools: ["mcp__*"]` removes all MCP tools. | s6a and s6b init events | Every agent gets an explicit `allowed_tools` list **plus** `denied_tools: ["mcp__*"]`. Without the allowlist, `PowerShell` would bypass Bash deny patterns. A deterministic `tool-surface` check compares each agent's init tool list with what the role declares. [ADR-0002](../adr/0002-agent-tool-surface.md). |

## Other findings that change the plan

- **Agent transcripts carry cost** (`model_usage…costUSD`, `total_cost_usd`), so increment 3's cost snapshot can read it from the run outputs, with no extra calls.
- **Pilot CI rules** (commit-subject checks on PRs into the integration branches) are recorded locally, not here.
- **Test stacks:** backend xUnit + Moq on `net10.0-windows`; frontend Karma + Jasmine (`ng test`) on the story base.
