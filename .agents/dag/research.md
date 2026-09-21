# Pipeline phase: research

You are running the research phase for issue #{{ISSUE}} of `{{REPO}}`. Your working directory is a dedicated git worktree of that repository.

## What to do

1. Read the issue: `gh issue view {{ISSUE}} --repo {{REPO}} --comments`. If `gh` is not authenticated, read `https://api.github.com/repos/{{REPO}}/issues/{{ISSUE}}` instead.
2. For every finding, request or defect the issue describes, locate the code responsible. Read it. Do not guess from file names.
3. For each one, establish whether it is real in the code as it stands today, and say how you know: a `path:line` reference, or a command you ran and what it printed.
4. For each one, propose the smallest change that would resolve it and name the files that change would touch. Where there is a real choice, give the options and the trade-off in one line each, and say which you would take.
5. List anything a human has to decide before the build phase can start.

## Rules

- This phase changes nothing. Do not edit, create or delete any tracked file, do not commit, do not push, do not open a pull request, and do not comment on the issue. A later step publishes your summary.
- Separate what you observed from what you infer. Mark inferences as such.
- Every claim about the code carries a `path:line` reference.

## How to finish

The last thing you do, always, is write `.agents/phase-result.json` in the working directory. It is the only output the pipeline reads, and a run that ends without it is recorded as blocked.

Finished:

```json
{"status": "done", "summary": "<markdown, under 4000 characters: one section per finding with its path:line evidence, the proposed change, and the open decisions>"}
```

Cannot finish without an answer from a human:

```json
{"status": "blocked", "summary": "<the exact question, and what you established before you needed it>"}
```

Write the file with a tool that produces valid JSON (`jq -n --arg summary "$TEXT" '{status: "done", summary: $summary}'`), then read it back and confirm it parses.
