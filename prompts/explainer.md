## Mission
Explain the published change of story `${local_id}` to its reviewer: for every acceptance criterion in the story file
`${story_file}`, which changes cover it and which tests prove it. A script turns your text into a local HTML guide and
computes every code link from the real diff, so you name paths and symbols, never line numbers.

You only read. The change is committed on `${branch}` in `${repo_path}`; compare it with `origin/${base_branch}`:
`git diff --stat origin/${base_branch}...HEAD`, `git diff origin/${base_branch}...HEAD -- <path>`, and read files.
The run's verdicts and review notes: `${state_cli} get ${task_id}`. You never edit files and never run git commands other
than `git diff`, `git log`, `git show` and `git status`.

## Steps
1. Run `${state_cli} get ${task_id} published`. If it prints nothing, output `GUIDE=SKIPPED` and stop.
2. Read the story file. Take the acceptance criteria from the tracker issue part when there is one (it wins), else from the
   task file. Keep their order and wording (shorten only if a criterion is longer than two lines).
3. For each criterion decide `met`, `partly` or `not-met` from the code and the tests, not from the PR text. `partly` and
   `not-met` need one sentence saying what is missing.
4. Name the changes and tests per criterion. A path is repository-relative with forward slashes, exactly as
   `git diff --name-only` prints it. `symbol` (changes) and `name` (tests) are a text that occurs literally in the file:
   a class, method or test name. Only name files that are in the diff; one to four entries per list.

## Output: record it, then print GUIDE=STORED
Run exactly once, with a quoted heredoc holding one JSON object:
```
${state_cli} guide ${task_id} - <<'GUIDE_JSON'
{"summary": "...",
 "criteria": [{"text": "...", "status": "met", "how": "...",
               "changes": [{"path": "...", "symbol": "...", "why": "..."}],
               "tests": [{"path": "...", "name": "...", "proves": "..."}]}],
 "risks": ["..."],
 "manual_checks": ["..."]}
GUIDE_JSON
```
- `summary`: 2-3 sentences, what a caller or user can do now and the shape of the change.
- `how`: one or two sentences, the reasoning a reviewer needs for this criterion.
- `risks`: at most 4, where a reviewer should look closely and why (from the review notes and your own reading).
- `manual_checks`: the checks the story asks for that no test covers.
- Fictional data only; no secrets, tokens or real ids.
Then print exactly `GUIDE=STORED`.
