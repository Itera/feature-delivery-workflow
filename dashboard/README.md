# Workflow dashboard

Read-only live view of one digital-factory workflow: stages, task graph (with `when:` conditions),
live per-task status and run output. For the intent loop (the `sdlc` workflow installed in a project's
`.intent-loop/` folder, see the sdlc-workflow repo) it also shows the intent queue with
verdicts and diagnostics (feedback, gates log, test log). No dependencies. Standalone app; it is not part
of the repo it watches.

![The dashboard during an sdlc loop run: stages, task graph with the running review task, and the intent queue](docs/screenshot.png)

## Run a workflow and watch it: `wfui.sh run`

```sh
cd my-project && /path/to/workflow-dashboard/wfui.sh run my-workflow --set target_path=src/
```

`wfui.sh run <workflow> [engine args]` (also `wfui.sh --hub run …`) takes the workflow like `wfui.sh` below (a path,
or its file name or `name:` here) and passes the rest to `digital-factory workflow run` (`--set k=v`, `-w <dir>`,
`--vars <json>`, `-t 1h`, …). It:

1. makes sure the hub runs on port 4777: it reuses the hub on that port, or starts one in the background that
   keeps running after the workflow (its output goes to `~/.wfui/hub-<port>.log`);
2. runs the engine with its output in `runs/<workflow file>@<stamp>.log` (`./runs`, or `runs/` next to the
   workflow or one folder up, else created next to the workflow);
3. prints the workflow, the log, the hub's link, this workflow's link (`/w/<id>/` on the hub) and how to reach the
   port, then each task as it starts and finishes, and the summary with the links again. On a terminal the info
   block is framed and coloured (links in cyan, tasks yellow when they start, green or red when they end); piped
   or with `NO_COLOR=1` it is plain text:

```
━━ wfui run ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ▶ my-workflow
   workflow  /work/out/my-project/workflows/my-workflow.yaml
   log       /work/out/my-project/workflows/runs/my-workflow@20261028-141500.log
   hub       http://localhost:4777/  (started now, pid 30780; its output: /home/ubuntu/.wfui/hub-4777.log)
   this run  http://localhost:4777/w/L3dvcmsvb3V0L215LXByb2plY3Qvd29ya2Zsb3dzL215LXdvcmtmbG93LnlhbWw/
   ports     the hub listens on port 4777 in this container (every workflow goes through it). …
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 tasks
  ● Create High-Level Architecture (architect)
  ✓ Create High-Level Architecture [1m04s]
  …
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ■ 6/6 succeeded Duration: 3m30s
   this run  http://localhost:4777/w/L3dvcmsv…/
   hub       http://localhost:4777/  (keeps running)
```

Ctrl+C stops the workflow, not the hub. Env: `WFUI_PORT` (hub port, default 4777), `WFUI_HOST` (default `0.0.0.0` in
a container, else `127.0.0.1`), `WFUI_URL` (the hub's address as users open it, when the port is published as
another one, e.g. `WFUI_URL=http://localhost:3001`), `DF_BIN` (engine binary; see "Engine binary" below). In a
container only the hub's port has to be published
(`podman run -p 4777:4777 …`); a running container's ports cannot be changed.

## Quick start: `wfui.sh`

From a project folder, name the workflow (file name with or without `.yaml`, or its `name:`); with only one
workflow there, the name can be left out. From anywhere, give the path to the workflow YAML instead:

```sh
cd my-project && /path/to/workflow-dashboard/wfui.sh my-workflow
cd my-app && /path/to/workflow-dashboard/wfui.sh          # the only workflow: the intent loop's .intent-loop/sdlc.yaml
/path/to/workflow-dashboard/wfui.sh ~/dev/my-project/workflows/my-workflow.yaml
```

It looks for workflow YAMLs (files with `name:` and `tasks:`) in the folder, its `workflows/` and `.intent-loop/`
and its direct subfolders, and lists them when the name is missing or ambiguous. It watches the intent loop when
the workflow is in a project's `.intent-loop/` (or its folder has `.task-state/` or `intents/`), otherwise `./runs`
(or, if missing, the `runs/` folder next to the workflow YAML or one folder up), plus the runs in the engine
database (below). Other options
(`--port`, `--outputs`, `--runs`, `--repo`, `--db`) still apply. To call it as `wfui` from anywhere:
`ln -s /path/to/workflow-dashboard/wfui.sh ~/bin/wfui` (any folder on your PATH).

## Starting a run the dashboard can see

The dashboard only reads: it gets a run from a log file or from the engine database, never from the engine
process. A plain `digital-factory workflow run … <yaml>` prints only to the terminal, so the dashboard shows the
workflow's graph and nothing happens on it. Where the dashboard and the hub get a run's progress from:

| Started with | Progress comes from |
|---|---|
| `wfui.sh run`, `server.js run`, `run.sh`, `… \| tee <log>` | the log file the engine's output is saved to |
| the intent loop (`.intent-loop/tick-loop.sh`, `orchestrate-tick.sh`) | its log in `.task-state/logs` and `.task-state/state.json` |
| `/workflow-execute`, `/workflow-live-cli` (from Claude/Copilot) | the engine database (they write no log) |
| a plain `digital-factory workflow run` | nothing: the graph only |

Start the run in one of these ways:

- **`wfui.sh run <workflow> [engine args]`** (above): it starts the engine itself and saves its output to
  `runs/<workflow file>@<stamp>.log`, which the dashboard and the hub read (the database plays no part), and makes
  sure the hub runs and prints the links, in one command.
- **Let the dashboard start it** (one process, nothing else to set up). The log goes to `runs/` in this app's
  folder, and the dashboard serves the live view:
  ```sh
  node /path/to/workflow-dashboard/server.js run path/to/workflow.yaml --repo "$PWD" --set key=value
  ```
- **Start the engine yourself and save its output** in the runs folder the dashboard watches (`wfui.sh <yaml>`
  prints it at startup: `runs in <dir>`). Name the log after the workflow file, without `.yaml`, plus a
  `YYYYmmdd-HHMMSS` stamp (the YAML's `name:` works too):
  ```sh
  digital-factory workflow run … workflows/my-workflow.yaml 2>&1 | tee runs/my-workflow@$(date +%Y%m%d-%H%M%S).log
  ```
  A project's own `run.sh` usually does this (e.g. next to a `dashboard.sh` that opens the dashboard, below).
- **Start it from Claude/Copilot** with `/workflow-execute` or `/workflow-live-cli`, using the same workflow YAML
  path. These runs are read from the engine database (below); the dashboard then prints `also following
  /workflow-execute and live-cli runs in <db>`. Without that line it found no database: pass `--db <file>` (or
  `DF_BIN`, when the engine is not on PATH, e.g. `~/.digital-factory/digital-factory`).

## Hub: all workflows on this machine

```sh
cd ~/dev && /path/to/workflow-dashboard/wfui.sh --hub     # or plain wfui.sh in a folder without workflows
```

http://127.0.0.1:4777 lists:
- **Running** workflows from any folder:
  - `digital-factory workflow run … <yaml>` processes, from the process list. Their live output is the log file
    their stdout is written to (`| tee x.log`, as a project's `run.sh`, the intent loop's tick and `server.js run` do), found in `/proc`
    on Linux and with `lsof` elsewhere. A run that prints only to a terminal shows as running, without per-task
    progress.
  - `/workflow-execute` and `/workflow-live-cli` runs, from the engine databases (below).
- **Recent** runs, from the engine's `.digital-factory/events/*_completed.json` and databases under `--root`
  (default: the folder the hub starts in, 5 levels deep), plus folders where the hub saw a run.

The databases are every `.digital-factory/digital-factory-rel.db` the hub finds that way, `~/.digital-factory/`
and the one next to the engine binary (on PATH or `DF_BIN`).

Clicking a row opens that workflow's dashboard at `/w/<id>/` on the hub's own port: the hub starts a `server.js`
for it on a free local port (reused on later clicks, stopped with the hub) and passes the requests through, so
only the hub's port has to be reachable. The dashboard watches the intent loop when the workflow is in a project's
`.intent-loop/` (or its folder has `.task-state/` or `intents/`), otherwise the `runs/` folder with its logs (or the
live log) and the database. The hub
writes only `~/.wfui/known.json` (workflows it saw running, with their folder and log), so they stay listed
afterwards.

## All ways to use it

```sh
# 1. Run any workflow and watch it (no intents needed). Output goes to runs/<workflow file>@<time>.log in this app's folder
node server.js run path/to/workflow.yaml --repo /path/to/repo [--set key=value]... [-- extra engine args]

# 2. Watch a log that something else writes (e.g. `digital-factory workflow run ... | tee run.log`)
node server.js --workflow path/to/workflow.yaml --log run.log

# 3. Watch the intent orchestrator loop (default): .task-state/logs + state.json in the repo
node server.js --repo /path/to/repo     # workflow: the only workflow YAML in the repo (or pass --workflow)

# 4. Watch a runs folder: logs named <workflow file>@YYYYmmdd-HHMMSS.log, or <name: in the YAML>@… (other workflows' logs are ignored)
node server.js --runs path/to/logs --workflow path/to/workflow.yaml
```

One dashboard shows one workflow. For a second workflow start another dashboard on another `--port`.

### Runs started from Claude/Copilot (`/workflow-execute`, `/workflow-live-cli`)

These write no log file, but the engine records them in its database, `.digital-factory/digital-factory-rel.db`.
In runs mode (4., and `wfui.sh <workflow>` outside the intent loop) the dashboard reads it read only, and the
**Run log** selector lists these runs next to the log runs (`… · workflow-execute`, `… · live-cli`); the newest
is shown by default, live:

- `/workflow-execute` (MCP): task started / done / failed / skipped events with durations and errors
  (`execution_events`). Run output shows these events.
- `/workflow-live-cli` (warm-worker pool + `dispatch`): the jobs of each dispatch, which worker took them and
  their results (`channel_control`, `channel_status`). Jobs name the agent, not the task, so each job is given to
  the first task of that agent whose dependencies had finished; a waiting job shows *waiting for a worker*.

The database is the nearest `.digital-factory/digital-factory-rel.db` above the workflow or the cwd, else the one
next to the engine binary (found on PATH or with `DF_BIN`); `--db <file>` (or `WFUI_DB`) picks another, `--db off` turns it off. Reading it needs
Node 22.12+ (built-in `node:sqlite`) or the `sqlite3` command; without either the dashboard shows log runs only.
In a container, run the dashboard where the engine runs (the same `.digital-factory/` folder).

The dashboard only reads files, so it can watch any folder. A project calls it from its own folder; for
example, a `dashboard.sh` next to the workflows:

```sh
exec node /path/to/workflow-dashboard/server.js --runs "$HERE/runs" --workflow "$HERE/workflows/$1.yaml" "${@:2}"
```

Common options: `--port <n>` (default 4777), `--host <addr>` (default 127.0.0.1, or `WFUI_HOST`), `--workflow <yaml>`, `--outputs <dir>`. The page is at http://127.0.0.1:4777 and
updates every second over Server-Sent Events; the **Run log** selector shows earlier runs. In run mode the
dashboard keeps serving after the workflow ends (Ctrl+C to quit).

**Engine binary** (for run mode, `wfui.sh run` and finding the engine database): `DF_BIN` if set, else
`digital-factory` on the PATH, else `~/.digital-factory/digital-factory`, else a `.digital-factory/digital-factory`
in any folder above the project or above this app (an engine kept next to the projects). The intent loop's
`orchestrate-tick.sh` looks in the same order.

### In a container

Only Node 18+ is needed (e.g. `node:20-slim`; Node 22.12+ or `sqlite3` to also follow `/workflow-execute` runs). Listen on all interfaces with `--host 0.0.0.0` (by default the
dashboard is reachable only from the same machine/container), publish the port and mount the workflow folder:

```sh
docker run --rm -it -p 4777:4777 -v "$PWD":/work -w /work node:20-slim \
  /work/workflow-dashboard/wfui.sh my-workflow --host 0.0.0.0     # then open http://localhost:4777
```

The hub needs only its own port too (`wfui.sh --hub --host 0.0.0.0 --port <published port>`): the dashboards it
opens are served through it. It sees only workflows running in the same container and needs `ps` there (missing in
some slim images); log files are found in `/proc`. Run mode needs the engine in the container (`DF_BIN`).

## Data sources (never written; the hub's `~/.wfui/known.json` aside)

| Source | Used for |
|---|---|
| workflow YAML | task graph: ids, `depends_on`, `when:`, agent + model |
| run log (`runs/`, `--log`, or `.task-state/logs/<id>-<attempt>.log` written by `orchestrate-tick.sh`) | live per-task status (engine output: `●` started, `✓` done, `✗` failed, `⚠ … (skipped: …)`) |
| engine database `.digital-factory/digital-factory-rel.db` (runs mode, read only) | `/workflow-execute` and live-cli runs: per-task status from `execution_events` / `channel_*` |
| `.task-state/state.json` (loop mode) | intents, status, phase, attempts, verdicts, feedback |
| `.task-state/gates-<id>.log`, `test-<id>.log` | diagnostics tab |
| files under `--outputs` dirs | Outputs tab (files modified between the run's start and its last log write) |

While a task runs, its graph node and task panel show what the agent is doing (latest tool call, e.g.
`▸ bash mkdir -p …/generated-docs`) and for how long. This comes from the engine's progress frames, which are
redraws and are therefore left out of the Run output tab. Orchestrator tasks show each parallel sub-agent as its own box under
the task, with its own arrow, status, run time and latest call (a dashed placeholder until the run spawns
them). The engine does not log which item a sub-agent works on, so they are numbered (`<agent name> #1`). A task can be preselected with `#task=<id>` in the URL. Running tasks and sub-agents show a small spinning cogwheel (static when the OS asks for reduced motion).

The **🐹 Lemmings** button in the header switches to a playful pixel-art look (remembered by the browser; **⚙︎ Classic**
switches back). The boxes become dirt blocks with a grass top in the status colour. A builder lays bricks on running tasks,
a blocker stands on pending ones (arms out, looking around), failed tasks blow up ("Oh no!"), and on skipped ones (in greyscale)
a lemming skips rope. Lemmings keep leaving the first task one after another, walking along the bottom inside the
boxes. To reach the box below in the same stage they float down with an umbrella from the middle of the box and land on
its green top (floating on down through it if they have to go further down). Towards the next stage they walk to the right edge
and take brick stairs into the bottom of the next box (never to an orchestrator's parallel sub-agent boxes). Stairs
appear once the task before them is done, and arrows out of finished tasks are dropped. Each lemming's journey ends at
the first task that is not done yet, or through the exit door at the right end of the last task (the bottom box of the right-most stage), which appears once that task is done. The characters are original sprites drawn in `lemmings.js`.

The **Timeline** appears once the selected run is over (a finished workflow run, or a finished intent attempt), as
a collapsed line (`▸ Timeline  N tasks · duration`); click it to expand. It shows when each task (and each
orchestrator sub-agent) ran, on the run clock: the log has no timestamps, so times are rebuilt from the engine's
phase timers and task durations. Click a bar to select the task.

With `--outputs <dir>` (repeatable) the **Outputs** tab lists the files under those folders that changed while
the selected run was going on (hidden folders and `node_modules` are skipped). Click one to read it in the
panel; PDFs, images and HTML open in a new tab. Only files under `--outputs` folders are served, read-only,
with scripts disabled.

A watched run is shown as **STALLED** when its log has no final summary and has not grown for 60 s (the engine
prints a progress spinner while a task runs, so a live run keeps the log growing).

Stage groups are declared in the workflow YAML, as a `stages` list under its `metadata:` (the engine ignores
metadata; `workflow validate` and `run` accept it). Tasks are listed by id or by `name`:

```yaml
metadata:
    stages:
        - name: Setup
          tasks: [branch, snapshot-before-tests]
        - name: Acceptance tests
          tasks: [write-tests, lock-tests]
```

Without stages (or for tasks not listed) each dependency layer becomes its own stage, named after its tasks
(`1. Load flows`, `3. Design UX & Design architecture`, `4. Review +2`; a leading `Step N:` in task names is
dropped). Graph columns line up with the stage boxes above them; when a window is too narrow for that, the
graph keeps fixed-width columns and scrolls horizontally. The workflow YAML is re-read on every refresh, so edits show up live. Only direct dependencies are drawn (transitive edges are hidden; all
dependencies are listed in the task panel).
