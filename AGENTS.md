# AGENTS.md — how to work on memoria

This file is for any agent (or human) modifying this project. It is the durable
statement of intent *and* the working manual: read it fully before editing code.
Any agent working here is allowed and expected to edit it when the design
changes.

## North star

**Recall 100% of what is stored, without the user having to remind the agent.**

If a fact is in the memory library, then a question about that fact must be
answered correctly — regardless of phrasing, typos, language, or how the fact was
originally written. Recall must be automatic: the agent should not need to
remember to check memory, and the user should not need to point at it.

Everything else in this document is subordinate to that goal.

## What this project is

A pi extension that gives the agent long-term memory:

- `memoria/MEMORY.md` — curated hot memory, injected into every session (≤ 5000 chars).
- `memoria/library/<category>/<topic>.md` — **topic notes**: one file per broad
  grouping (`food-preferences.md`), many facts inside under `## Facts`. Never one
  file per fact (`likes-apples.md` is explicitly forbidden).
- `memoria/synonyms.json` — optional query-side synonym table (e.g. `k8s` → `kubernetes`).
- An in-memory inverted index (`memoria/.index/index.json` or `index.bin`) for
  sub-millisecond recall, plus `.index/usage.json` for hits/writes/last-used.
- Nine tools (`memoria_recall`, `memoria_write`, `memoria_read`, `memoria_move`,
  `memoria_hot`, `memoria_list`, `memoria_forget`, `memoria_export`,
  `memoria_import`), a `/memoria` command with subcommands, and a skill
  (`skills/memoria/SKILL.md`) that teaches an agent how to maintain the store.

The extension itself lives in this repository. The *store* it manages is
user-level, not per-project: `<agent dir>/memoria`, i.e. `~/.pi/agent/memoria`
by default, or `$PI_CODING_AGENT_DIR/memoria` when pi's agent directory is
customized. `index.ts` passes pi's `getAgentDir()` into `MemoriaRuntime` so the
store always follows pi's own configuration; core modules stay pi-free and just
default to `<home>/.pi/agent`. `projectRoot` optionally adds a writable
per-project store; `extraRoots` are always read-only additions.

## Product goals

0. **One memory, every project.** The store is user-level, so what the agent
   learns in one repository is available in the next. A memory system that resets
   per project cannot deliver "knows the user". `projectRoot` exists for
   project-scoped facts and `extraRoots` for opt-in read-only additions, never as
   the primary model.
1. **Zero-effort recall.** Memories surface automatically on every user prompt,
   not only when the model chooses to call a tool. The agent is additionally
   instructed (in the system prompt) to search before answering anything about
   people, preferences, projects, decisions, or history.
2. **Curated hot memory.** `MEMORY.md` is always in the system prompt, capped at
   5000 characters, and answers one question: *what should the agent know before
   it reads a single message?* In practice: who the user is, how they like to
   work, hard constraints, and the one-line state of active work. It reads as a
   short natural briefing — sentences and paragraphs, no headings, no bullet
   lists, no annotations, no labels — because every character in it is paid for
   on every request. Anything occasional belongs in the library, where recall
   finds it on demand.
3. **Unbounded cold memory.** Everything else lives in a categorized markdown
   library that can grow without polluting context.
4. **Agents-first ergonomics.** The library is plain markdown with YAML
   frontmatter in named folders. Agents can navigate it with `memoria_list`,
   read it with `memoria_read`, or just open the files. Generated `INDEX.md`
   files give a table of contents per category.
5. **Broad topic files, never fact files.** One note per broad grouping
   (`food-preferences.md`), many facts inside it. A file named after a single
   fact (`likes-apples.md`) is a defect, not a style choice: it fragments
   knowledge, multiplies near-duplicate files, and makes the library unnavigable
   as it grows. The store enforces this — fact-shaped *and relational* topics
   (`John's father`, `dad`) are rejected and filed under the category instead,
   because a relationship is a fact that expires the moment the person has a
   name.
6. **Names are handles, not identity.** A subject answers to many names —
   nicknames, full names, relations, the name it was first stored under. Aliases
   in frontmatter are indexed like tags so any of them recalls the note, and
   `memoria_move` can re-file a note under a better name later while keeping its
   id and every previous name. Renaming is therefore housekeeping: correctness
   never depends on the file name being the current best one.
7. **Speed as a feature.** Retrieval is in-memory and must stay sub-millisecond
   for typical libraries (target: <1 ms warm, <5 ms at 10k notes). Retrieval
   speed is what allows us to search on *every* prompt.
8. **Durability and recoverability.** Memories are human-readable files on disk.
   Deletes are soft (moved to `.trash/`). The search index is derived and can
   always be rebuilt from markdown. Moves are journaled so a crash cannot leave
   two copies with one id.

## Recall strategy (defence in depth)

| Layer | Mechanism | When it runs | Budget |
|---|---|---|---|
| 1 | `MEMORY.md` inside the `<memoria>` system-prompt section | every model call | 5,000 chars |
| 2 | Auto-recall: top matches rendered as a `memoria_recall` message | every user prompt | ~2,400 chars |
| 3 | `memoria_recall` tool with filters, prefix and fuzzy search | when the agent asks | tool output limits |
| 4 | `memoria_read` / `memoria_list` / plain file reads | when the agent digs deeper | built-in truncation |
| 5 | Generated `library/INDEX.md` + category indexes | browsing / grep | unbounded |

Retrieval quality depends on the shape of the notes, which is why the topic
policy is load-bearing: a snippet from a focused topic note is far more useful
than a snippet from an ever-growing `preferences.md`, and BM25 length
normalization rewards the smaller document. Topic breadth is therefore capped by
`topicMaxChars` (spill into `topic-2.md`) rather than left unbounded.

Layers 1 and 2 are the guarantee. Layers 3–5 are the escape hatches.

## Efficiency contract

- Search runs against an in-memory inverted index (BM25 with field boosts).
- No filesystem access on the scoring path. Snippets come from an in-memory body
  cache or a `preview` stored in the index.
- The index is persisted to `memoria/.index/index.json` (or `index.bin` above
  20k notes) and reconciled incrementally by mtime+size, so multi-thousand-note
  libraries reload in ~100 ms and changes cost one file read.
- `fs.watch` invalidates the index immediately and refreshes once the filesystem
  settles; a TTL scan is the fallback.
- Hard caps (`MAX_POSTINGS_SCANNED`, `MAX_CANDIDATES`, `MAX_QUERY_TERMS`) bound
  worst-case latency.
- Usage tracking (hits/writes/last-used) happens in memory and is flushed on a
  debounce; it must never write during a search.

## Quality bar for recall

- **Exact**: ids, file paths, versions, error codes, config keys, `snake_case`,
  `kebab-case`, `camelCase` all match literally.
- **Variants**: plurals, `-ing`/`-ed`, `-ize`/`-ization` families match via a
  conservative stemmer.
- **Prefix**: `kuber` finds `kubernetes`.
- **Fuzzy**: one or two typos still match a distinctive term.
- **Phrase**: a verbatim phrase lifts the correct note above term-frequency noise.
- **CJK**: unigram + bigram matching for Chinese, Japanese, Korean.
- **Synonyms**: query-side expansion makes `k8s` find `kubernetes` without
  re-indexing.
- **Time**: "last week" and "yesterday" become a recency window instead of
  literal words.
- **Links**: `related` notes are pulled in; notes that a newer note `supersedes`
  are demoted and flagged rather than silently contradicting.
- **Scope**: cross-store results are rank-normalized so a small store is not
  drowned, and a note present in two stores is returned once.
- **Filters**: category, tags, priority, recency, unfiled, scope.
- **Topic grouping**: related facts live in one note, so a hit brings its
  context with it and `memoria_read` on the topic shows the full picture.
- **Coverage**: notes matching more distinct query terms rank above notes
  matching one term many times.

## Success measures

- A fact written by the agent in session A is surfaced in session B when a
  related question is asked, without the user mentioning the fact.
- `npm test` includes a latency assertion: warm search < 3 ms/query at 200 notes.
- `npm run eval` reports recall@5 = 100% and recall@1 ≥ 75% over the fixture
  corpus (currently 100% / 92.5% / MRR 0.958 / 0.16 ms average).
- `npm run bench` reports sub-millisecond search at 1k notes and <2 ms at 5k
  notes (worst-case artificial corpus with a tiny vocabulary).
- `memoria doctor` reports no problems on a healthy store.

## Non-goals

- Embeddings / vector search as a requirement. This project deliberately uses
  lexical retrieval so it stays dependency-free, instant, and inspectable. An
  optional model reranker is allowed, but baseline recall must never depend on it.
- Cloud sync, multi-user access control, encryption at rest.
- Storing secrets. The tool descriptions explicitly tell the model not to.
- Replacing pi's built-in context files (`AGENTS.md`) or compaction.

## Installation shape (keep it copy-pasteable)

Users install by copying `index.ts`, `src/`, `skills/` and `package.json` into
`~/.pi/agent/extensions/memoria/`. Constraints that follow:

- **No runtime dependencies beyond what pi supplies** (`typebox`,
  `@earendil-works/pi-*`). Never add an npm dependency to the extension path; if
  something were truly needed it must be declared in `package.json` and only used
  by package installs.
- **No build step.** Node/jiti strips the TypeScript directly, so a plain copy of
  the sources must run. Avoid TS features that require transformation (see below).
- The store must never live inside the extension directory — it is resolved from
  pi's agent dir so updating the extension cannot touch user memories.

## Commands

```bash
npm install            # peer deps: pi packages + typebox (dev only)
npm test               # node --test tests/*.test.ts (Node 24 type-stripping; no build step)
npm run typecheck      # tsc --noEmit
npm run eval           # recall@1/@5/MRR over the fixture corpus
npm run bench          # latency benchmark: node tests/bench.ts [docs] [--real|--binary]
node tests/bench.ts 1000 5000
```

Manual smoke test with pi itself:

```bash
pi --extension /path/to/memoria/index.ts
# or, from a project: pi -e ./index.ts
```

Node 24 runs the TypeScript directly. This imposes two hard constraints:

1. **No TypeScript features that require transformation**, in particular no
   `enum`, no `namespace`, no constructor parameter properties
   (`constructor(private x: number)`), and no `import x = require()`.
2. Type-only imports must say `import type`, and relative imports must include
   the `.ts` extension (e.g. `./src/store.ts`). `verbatimModuleSyntax` is on.

RegExp literals inside template literals need a doubled backslash
(`` new RegExp(`\\bfoo\\b`) ``) — a single backslash is consumed by the template
literal and silently produces a broken pattern.

## Architecture map

```
index.ts                  Extension entry point: lifecycle hooks, system-prompt
                          section, auto-recall, auto-learn, message renderer.
src/types.ts              All shared types. No runtime imports.
src/util.ts               Atomic writes, mutex, debounce, ids, hashing, paths.
src/frontmatter.ts        YAML-subset frontmatter parser/serializer (zero deps).
src/tokenize.ts           Tokenizer: identifiers, camel/snake/kebab, CJK, stemmer,
                          trigrams, edit distance.
src/config.ts             Defaults, config.json loading, root resolution.
src/store.ts              Filesystem: parse/write/update/delete/move notes, link
                          fields, MEMORY.md helpers, scanning, INDEX.md, journal.
src/index-engine.ts       MemoryIndex: inverted index, JSON/binary persistence,
                          incremental refresh, compaction, fuzzy/prefix lookups,
                          link resolution, scratch buffers.
src/search.ts             BM25 scoring, boosts, filters, snippets, explain,
                          related expansion, superseded demotion, time windows.
src/similarity.ts         Duplicate-subject and contradiction detection.
src/usage.ts              hits/writes/last-used tracking (.index/usage.json).
src/timeexpr.ts           "last week" → time windows.
src/synonyms.ts           Query-side synonym tables (config + synonyms.json).
src/transfer.ts           JSONL export/import with path sanitizing.
src/recall.ts             Rendering of the system section and recall block.
src/learn.ts              Session harvesting: chunking, prompt building, parsing.
src/rerank.ts             Optional best-effort model reranker.
src/runtime.ts            Roots, locks, search cache, scopes, health, transfer.
src/tools.ts              pi tool definitions (schemas, execute, TUI renderers).
src/commands.ts           /memoria subcommands + entry renderer.
tests/                    node:test suites, eval harness, bench. Everything is
                          hermetic except tests/extension.test.ts (fake pi API).
skills/memoria/SKILL.md   Maintenance instructions for other agents.
```

Dependency direction is one-way: `types/util → tokenize/frontmatter → store →
index-engine → search → recall/learn → runtime → tools/commands → index.ts`.
Never import upward from a lower layer; `store.ts` and `search.ts` must stay free
of pi runtime imports so they remain testable in isolation.

## Invariants (do not break these)

1. **File names always stay broad.** The file name is `slugify(topic)`, where the
   topic defaults to the category and fact-shaped topics are rejected by
   `looksAtomicTopic()` + `resolveTopic()` in `src/store.ts`. That detector covers
   three shapes, and all three must stay covered: a personal subject (`my dad`), a
   personal verb (`likes apples`), and a **relational or possessive** phrase
   (`John's father`, `dad`, `Alice's manager` — see `RELATION_NOUNS` and
   `POSSESSIVE`). A relation is a fact that goes stale the moment the person has a
   name, so it belongs in the note body, never in the file name. Gerunds are
   *nouns*: "Machine learning notebook" and "Budget planning" are valid topics
   (`isPredicate` excludes `-ing`), while "Alice prefers oat milk" is not. Facts
   are appended with `appendFact()` under `## Facts`;
   `createMemory({mode:"auto"})` merges by design. Never reintroduce a per-fact
   file path (no `title`-derived slugs), and keep the fact-like/relation-shaped
   tests in `tests/store.test.ts` green.
2. **`MemoryIndex.terms` is an id-indexed dictionary and must never be reordered.**
   Prefix search uses the separate `sortedTermIds()` cache. Sorting `terms` in
   place corrupts every posting list. (This was a real bug; keep the regression
   test in `tests/search.test.ts` passing.)
3. **`docIdx` values are stable until `compact()`.** Scratch buffers are keyed by
   doc index and are invalidated by `scratchGeneration` on compaction/clear.
   Runtime updates always `removeDoc(old)` then `addDoc(new)` — never `addDoc`
   alone for a note that already exists, or the same subject is indexed twice.
4. **Identity is the id and the aliases, not the file name.** `moveMemory()` may
   rename or merge a note, but it must keep the existing `id` (an id read earlier
   in a session must stay valid) and record the previous topic, title and file
   name as aliases. Merging must append through `appendFact()` so duplicates are
   skipped, and must never overwrite the target's facts. Refuse to merge unless
   the caller asked for it. Moves are journaled before the file becomes visible
   and the journal is cleared after the source is trashed, so
   `recoverJournal()` can complete an interrupted move on the next start.
5. **Search must not do filesystem I/O on the scoring path.** Bodies come from
   `bodyOrPreview()`; only final-hit snippets may touch the body cache/disk.
   Usage recording is in-memory and debounced, never synchronous disk I/O.
6. **`MEMORY.md` is an always-loaded briefing, not a log.** It holds a short
   introduction to the user plus standing context (identity, working style, hard
   constraints, active work). Sentences and paragraphs only: no HTML comments,
   no annotations, no headings or bullets, and no `Topic — fact` labels.
   `addHotEntry()` places a sentence in the paragraph with the strongest token
   overlap (no marker is ever written). It is capped at `config.hotLimit`
   (default 5000 chars); the injected copy is trimmed at a sentence boundary by
   `trimHot()` and the removed text is *returned to the caller*. Keep
   `hotTemplate()` minimal.
7. **Writes are atomic** (`atomicWriteFile`) and soft-deleted files go to `.trash/`.
8. **Index freshness**: after writing through `runtime.write`/`updateMemoryById`/
   `forget`/`move`/`import`, update the in-memory index directly; never rely on a
   rescan. External edits are caught by `index.refresh()` (watcher settle timer +
   TTL). Any mutation or external change must call `bumpCacheGeneration()`; a
   stale cached search result after a write is a correctness bug.
9. **Never throw from `before_agent_start`, `agent_end` or `session_shutdown`.**
   Recall and auto-learn failures must be swallowed with a notification; the turn
   must continue.
10. **Writes are serialized.** Every read-modify-write path in `MemoriaRuntime`
    goes through the per-root `KeyedMutex`, and `memoria_write` / `memoria_hot` /
    `memoria_forget` / `memoria_move` / `memoria_import` declare
    `executionMode: "sequential"`. Two parallel writes to the same topic must both
    survive; see the concurrency tests in `tests/runtime.test.ts`. The mutex is
    **not reentrant**: never call a runtime method that takes the root lock from
    inside `locks.run(root, …)` (import handles MEMORY.md by calling `writeHot`
    directly).
11. **Scope semantics.** `primary` is the user-level store and the default write
    target; `project` (when `projectRoot` is set) is writable; `extraRoots` are
    always read-only; `all` reads everything and writes to the primary store;
    `global` is a legacy alias for `primary`. Cross-store merges require rank
    normalization and id dedupe (`tests/runtime.test.ts`).
12. **Tool output is bounded.** Use `truncateChars`/`oneLine`; never dump an
    unbounded body into tool output.
13. **Tests must never touch the real `~/.pi/agent`.** Pass `{ home, agentDir }`
    to `MemoriaRuntime`, or set `PI_CODING_AGENT_DIR` in the extension harness.
    `withRuntime()` in `tests/runtime.test.ts` is the pattern.
14. **New config keys need** a default in `DEFAULT_CONFIG`, coercion in
    `coerceConfig`, actual use (grep for it), and a row in the README table.
15. **Keep zero runtime dependencies** in core modules. `typebox`,
    `@earendil-works/pi-*` are supplied by pi and are only imported by the
    extension-facing modules (`index.ts`, `tools.ts`, `commands.ts`, `learn.ts`,
    `rerank.ts`).
16. **Optional features degrade, they never break.** Synonyms, reranking, usage
    tracking, auto-learn, time hints and related expansion must all be safe to
    disable or fail: fall back to lexical order/plain behaviour and continue.
17. **Persistence changes bump `INDEX_VERSION`.** `hydrate()` must defensively
    fill fields added after the first release, because a stale or corrupt index
    must rebuild from markdown rather than fail. The binary format stores posting
    weights as `float32`; that is exact for this system's dyadic tf weights
    (1, 1.5, 2, 3, 4 and their sums) and far below the 3-decimal score rounding.

## Testing philosophy

- Pure logic gets unit tests (`frontmatter`, `tokenize`, `store`, `search`,
  `learn`, `recall`, `knowledge` — the housekeeping modules).
- `tests/runtime.test.ts` exercises the real `MemoriaRuntime` against a temp
  directory, including concurrency, the search cache, usage flush, journal
  recovery, export/import, reranking and project scopes.
- `tests/engine.test.ts` covers index persistence (JSON and binary round-trips,
  corrupt-file recovery), watch filtering and link resolution.
- `tests/extension.test.ts` drives the real extension factory with a fake
  `ExtensionAPI`, asserting on registered tools, captured events and rendered
  output. Extend this whenever you add a tool or lifecycle hook.
- `tests/eval.test.ts` pins retrieval quality with the fixture corpus; update
  fixtures when the corpus grows, not thresholds to make a failure disappear.
  `tests/eval.ts` prints the same numbers plus per-question diagnostics.
- `tests/search.test.ts` includes a latency assertion (warm search over 200 docs
  must stay under 3 ms/query) and a persistence round-trip. Keep both.
- The naming/consolidation behavior is covered by one end-to-end scenario in
  `tests/runtime.test.ts` ("the John Doe scenario"): a relation is filed as a fact
  under a broad topic, the note is later re-filed under the real name, and every
  handle (old id, old name, new path) still resolves. Extend that scenario rather
  than adding narrow unit tests when you change naming behavior.
- Prefer deterministic fixtures over timers/sleeps. There is one deliberate
  `setTimeout(10)` to make mtime differ; keep it small.

## Common tasks

**Add a tool.** Register it in `src/tools.ts` with `promptSnippet` and
`promptGuidelines`, add a fake-API test, and document it in `README.md`. Keep the
name prefixed with `memoria_`.

**Change ranking.** `src/search.ts`: `analyzeQuery` (weights, idf, synonyms),
`addTerm` (BM25 + boosts), `baseScore` (priority + recency), exact-phrase boosts,
related/superseded handling, `explainHit`. Add a ranking assertion to
`tests/search.test.ts` before and after, and run `npm run eval`.

**Change the note format.** `src/store.ts`: `parseMemoryDoc` and
`createMemory`/`updateMemory`, plus `src/frontmatter.ts` if needed. Unknown
frontmatter keys must round-trip unchanged; new indexed fields need
`FIELD_WEIGHTS`, `computeTokens`, `IndexedDocMeta`, the serializer and an
`INDEX_VERSION` bump.

**Change the topic/broadness rules.** `src/store.ts`: `looksAtomicTopic` (the
fact detector: pronoun subjects, personal verbs, `RELATION_NOUNS`, `POSSESSIVE`),
`resolveTopic` (fallback + reporting), `appendFact` (how facts are laid out) and
`extendSummary`. Update the `GOOD topics` / `BAD topics` examples in
`src/learn.ts`'s prompt and in `src/tools.ts`'s `topic` description together, then
extend `tests/store.test.ts`. `slugify()` strips apostrophes so possessives join
(`John's father` → `johns-father`) instead of splitting into `john-s-father`.

**Change how a note is renamed or consolidated.** `moveMemory()` in
`src/store.ts` (target resolution, aliases, merge vs rename, journaling) plus
`MemoriaRuntime.move()` in `src/runtime.ts`, which owns the index bookkeeping and
the per-root lock. `memoria_move` in `src/tools.ts` and `/memoria move` in
`src/commands.ts` are thin wrappers over it. Keep the "refuse unless
`merge: true`" guard: silently mixing two subjects into one file is worse than a
failed move.

**Change what is injected into prompts.** `src/recall.ts`
`renderSystemSection` (stable section, cache-friendly) and `renderRecallBlock`
(per-prompt message). Respect the character budgets and keep the "you must
search" rules. Recall parts are built by `buildRecallParts` (current prompt at
weight 1, recent turns at `autoRecallPriorWeight`).

**Add a category.** Categories are plain folders under `library/`. Nothing needs
to change: `categoryFromRelPath` derives them automatically.

**Add a maintenance report.** Put the pure detection in `src/similarity.ts` (or
a sibling pure module), aggregate it in `MemoriaRuntime.health()`, and render it
from `/memoria` and `memoria doctor`. Keep the search path out of it.

## Pitfalls and gotchas

- Pi wraps each `systemPromptOptions.sections.<name>` in a tag of the same name,
  so `sections.memoria` must contain plain markdown, not another `<memoria>` tag.
- `before_agent_start` messages are appended **after** the user message. That is
  intentional (it keeps the system prefix cacheable). Do not move recall into
  the system prompt — it changes every turn and would invalidate the cache.
- `fs.watch(..., { recursive: true })` works on Node 24 Linux/macOS. The watcher
  must ignore `.index/`, `.trash/` and generated `INDEX.md` files or it will feed
  itself (`isIgnoredWatchPath`).
- The index file is derived data. Never make correctness depend on it: if it is
  corrupt, `MemoryIndex.load()` must rebuild from markdown.
- `runtime.init(force)` creates the store. Tool handlers get the runtime through
  `getRuntime(ctx)`; never construct a `MemoriaRuntime` per call.
- `ctx.ui.notify` is not available in `json`/`print` modes as a visible message;
  guard UI usage and keep non-UI behavior working.
- Auto-recall should skip prompts that are slash commands or fewer than two
  meaningful tokens; otherwise every `ls`-style prompt pays a search.
- `stripLeadingTitle()` in `src/store.ts` needs the `/m` flag on its heading
  regex. Without it the pattern can only match a single-line body, so it silently
  becomes a no-op — which both breaks H1 replacement on rename and double-counts
  the title in `computeTokens()`.
- Aliases are compared case-insensitively and capped at `MAX_ALIASES`. Add them
  through `normalizeAliases()` only: hand-rolled concatenation reintroduces
  duplicates, and a duplicate alias makes `memoria_read` resolve arbitrarily
  between two notes (`memoria doctor` reports that as a clash).
- The broadness heuristic is deliberately aggressive: rejecting a noun-phrase
  topic only costs specificity (it falls back to the category), whereas accepting
  a fact-shaped topic produces exactly the bad file names this project forbids.
  Do not "fix" a false positive by making the detector more permissive without
  adding a regression test for `likes apples` first.
- The `KeyedMutex` serializes per root, not globally, and is not reentrant.
  Nested acquisition deadlocks.
- Import files are untrusted data: always go through `sanitizeRelPath()`, never
  `join(root, untrusted)`.
- Duplicate detection is deliberately conservative: `compareDocs()` requires a
  *name link* (`namesLinked`) before reporting content overlap, because two
  different people who share a paragraph (John Doe and his father) otherwise look
  identical. Do not relax that without a regression test for the two-people case
  in `tests/knowledge.test.ts`.

## Release checklist

1. `npm run typecheck && npm test && npm run eval && npm run bench` are clean.
2. Bump `version` in `package.json`.
3. Commit, then tag: `git tag v0.x.y && git push origin main --tags`.
4. Verify the published shape before announcing, without touching your real
   agent dir:

   ```bash
   PI_CODING_AGENT_DIR=/tmp/pi-check pi install git:github.com/<you>/pi-memoria@v0.x.y
   PI_CODING_AGENT_DIR=/tmp/pi-check pi -p "remember that I prefer tabs"
   du -sh /tmp/pi-check/git/*/*/*     # must be well under a few MB, no node_modules
   PI_CODING_AGENT_DIR=/tmp/pi-check pi remove git:github.com/<you>/pi-memoria@v0.x.y
   ```

5. `npm pack --dry-run` must list only `index.ts`, `src/**`, `skills/**`,
   `README.md`, `LICENSE` and `package.json`.

Package-shape invariants live in
[Installation shape](#installation-shape-keep-it-copy-pasteable).

## Definition of done for a change

1. `npm run typecheck` is clean.
2. `npm test` is green (includes the eval guard).
3. `npm run eval` shows no recall regression; `npm run bench` shows no latency
   regression beyond noise.
4. Docs updated: `README.md` for user-visible behavior, this file for invariants
   and design intent.
5. New config keys appear in `DEFAULT_CONFIG`, `coerceConfig` and the README
   table, and are actually read somewhere.
