# Codex playbook

Rules learned from working with Codex. Cap: 40 lines. This is not a history: when something is learned,
rewrite or merge an existing rule before adding another. (How to launch Codex and how to judge its work is
already in the mod's instructions; only what experience taught goes here.)

## When to delegate
- Nothing measured yet. Start with bounded, read-heavy work: a wide review or exploration of a repository,
  mechanical edits on named files, tests for existing code, a second opinion on a diff, web research.
- Do not delegate what is trivial, ambiguous, delicate or architectural.

## Models
- List here the models this Codex account offers and what each one proved good at, strongest first.
- To restrict which models may be used, list their names in `models.json` beside this file.

## How to ask
- Say up front how many cases and which edge cases to cover: Codex does what is asked and no more.
- Ask it to run the verification (tests, type check) and report the output.

## How to review and correct
- Verify each finding against the code it cites before accepting it.
- Correct with `--resume <thread>`: the thread keeps its context.
