## Pitfall: Changelog or release notes

Short summaries, version bumps, or bullet-point changelogs are mechanical text assembly.
Correct: **low**. Common misclass: medium (due to "multiple topics" heuristic triggering).

## Pitfall: Large codebase research without implementation

Exploring many files, tracing call chains, or answering "how does this system work" requires deep context but produces no edits.
Correct: **high**. Common misclass: medium (no tool-heavy edit loop detected).

## Pitfall: Typo fix or variable rename

Single-token changes with obvious scope — no reasoning required beyond locate-and-replace.
Correct: **low**. Common misclass: medium (touches "code modification" signal).

## Pitfall: Explain-this-code / what-does-X-do

Read-only comprehension with no action output. Even complex code only needs reading, not planning.
Correct: **low**. Common misclass: medium (complex subject matter ≠ complex task).

## Pitfall: Multi-file refactor with clear plan provided

When the user supplies exact steps, file list, and target API — execution is mechanical even across many files.
Correct: **medium**. Common misclass: high (multi-file scope triggers complexity heuristic).

## Pitfall: Writing tests for existing code

Requires understanding behavior and edge cases but follows repeatable patterns; no architectural decisions.
Correct: **medium**. Common misclass: low (looks like "just write code") or high (many assertions).

## Pitfall: Debugging across unfamiliar code with no repro

Requires hypothesis generation, broad search, and iterative narrowing — high cognitive load even for small fixes.
Correct: **high**. Common misclass: medium (eventual fix may be a one-liner).

## Pitfall: Generating config or boilerplate from template

Filling in known fields from a schema or copying a pattern with substitutions — no judgment involved.
Correct: **low**. Common misclass: medium (output length mistaken for complexity).

## Pitfall: Architecture decision or tradeoff analysis

Even a short prompt like "should we use X or Y" demands weighing constraints, future implications, and trade-offs.
Correct: **high**. Common misclass: medium (short prompt ≠ simple task).

## Pitfall: Tool-loop implementation phase

Sustained edit/bash/test cycles executing a known plan — cognitive load is steady, not escalating.
Correct: **medium** (stay). Common misclass: upgrades to high (many tool calls mistaken for complexity growth).
