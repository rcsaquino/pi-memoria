# pi-memoria reference

[Back to the README](../README.md)

Technical details for the current checkout. Published versions may differ.

## How it works

1. **`MEMORY.md`** lives in the store root and is injected into the system
   prompt on every model call, capped at `hotLimit` (5000 characters). It is a
   short **prose** briefing: who the user is, how they work, hard constraints,
   the state of active work. It is not a log. No headings, no bullets, no
   annotations. Being stable, it does not invalidate the prompt cache.
2. **Auto-recall** searches the library on every user prompt and injects the
   best matches as a `memoria_recall` message, with ids, paths and excerpts. The
   previous turn is folded in at a lower weight (`autoRecallPriorWeight`) so a
   long earlier message cannot out-vote the current question.
3. **`memoria_recall`** lets the agent search deeper, with filters for category,
   tags, priority, recency, scope and score, plus an optional scoring breakdown.
4. **Plain markdown**: `library/INDEX.md` and per-category indexes provide a
   generated table of contents, and `read`/`grep`/`cat` work on the files.
5. **Past conversations**: if the library has nothing, the transcripts pi saved
   for earlier sessions are searched as a last resort, with file-and-line
   citations so anything found can be verified in context.

Ranking combines BM25 over weighted fields (title, tags, aliases, links,
summary, category, body) with boosts for exact phrases, priority, recency, query
coverage, time windows ("last week"), related notes, and a demotion for notes
that a newer note declares superseded. Matching is resilient: identifiers and
paths match literally, plurals and verb forms match through a conservative
stemmer, `kuber` finds `kubernetes`, one or two typos still hit, and CJK text is
matched with unigrams and bigrams.

## The memory library

```
<agent dir>/memoria/
├── MEMORY.md                          always-injected prose briefing
├── config.json                        optional store configuration
├── synonyms.json                      optional query-side synonym table
├── library/
│   ├── INDEX.md                       generated table of contents
│   ├── people/<topic>.md              one note per broad topic
│   ├── projects/<topic>.md
│   ├── preferences/<topic>.md
│   ├── decisions/<topic>.md
│   ├── workflows/<topic>.md
│   ├── knowledge/<topic>.md
│   └── inbox/<topic>.md               quick captures, triaged later
├── .index/                            derived: index.json|index.bin, usage.json
└── .trash/                            soft-deleted notes
```

`<agent dir>` is `~/.pi/agent` by default, or `$PI_CODING_AGENT_DIR` when pi's
agent directory is customized. Because the store is user-level, memories follow
you across projects: remember something in one repository and recall it in
another.

Pi's own conversation transcripts live next to the store at
`<agent dir>/sessions/` (plus `sessions-archive/` if you keep one). They are read
by [session recall](#session-recall-past-conversations) and never modified.

### Broad topics, never facts

| User says | Stored as | Not as |
|---|---|---|
| "I like apples" | `library/preferences/food-preferences.md` → `- **Fruit** — Likes apples.` | `likes-apples.md` |
| "I like pears" | appended to the same `food-preferences.md` | `likes-pears.md` |
| "Alice prefers oat milk" | `library/people/alice.md` | `alice-prefers-oat-milk.md` |
| "my dad is Bob" | `library/people/bob.md` → `- **Bob** — John's father, retired.` | `dad.md`, `johns-father.md` |

Rules enforced by the store, not merely requested from the model:

- The file name is always `slugify(topic)`. Topics that read like a single fact
  (`likes apples`, `I like apples`) or like a **relationship** (`John's father`,
  `dad`, `Alice's manager`) are rejected and the fact is filed under the category
  name instead (`people.md`), with an explanatory note returned to the agent.
  A relationship goes in the fact text; the note is named after the subject.
- Writing to an existing topic **appends** under a `## Facts` section, skipping
  duplicates. There is no one-file-per-fact path.
- A note may grow to `topicMaxChars` (default 8000) before new facts spill into
  `topic-2.md`.
- `memoria_write` accepts `mode: "new"` to force a sibling file and
  `mode: "replace"` to overwrite a note deliberately.
- `memoria doctor` flags any file named after a fact or a relationship.

### Names change: aliases first, renames second

A person is not their name, and the first name you learn is rarely the one you
keep. Notes therefore carry **aliases** in frontmatter, indexed at tag weight:

```markdown
---
topic: Bob
aliases: ["Robert", "Bobby", "John's father"]
---
```

Any of `Bob`, `Robert`, `Bobby`, `John's father` (and the file name) recalls
the note, so retrieval never depends on which name won the file name.

When the better name *is* known, `memoria_move` re-files the note:

- Target free → the file is **renamed**; the note keeps its `id`, so ids read
  earlier in the session stay valid.
- Target exists → the move reports a conflict. Set `merge: true` to combine the
  facts and links (duplicates skipped, nothing overwritten) and move the old
  file to `.trash/`. A merge refuses to discard aliases or links when their
  limits are full.
- The previous topic, title and file name are added to the target's aliases, so
  old references keep working.

Renaming is deliberately an explicit agent action rather than a side effect of
writing: renaming during an unrelated write is how you end up with `bob-2.md`
and a path the agent read earlier in the session that no longer exists.

### Related notes and superseded notes

```markdown
---
related: ["mem_1758_ab12"]          # pulled into recall with the source note
supersedes: ["Deploy process"]      # this note replaces that one
---
```

- `related` notes are appended to recall results (`related` marker) and shown by
  `memoria_read`, so following a reference works from either end.
- A note that another note declares `supersedes` stays searchable but is
  **demoted and flagged** (`SUPERSEDED BY: …`). That is the recommended way to
  change a decision: write the new note with `supersedes` instead of deleting
  history.
- `memoria doctor` reports dangling links and fact pairs that look contradictory
  (same wording, opposite polarity).

### Note format

Notes are markdown with optional YAML frontmatter. Frontmatter is written
automatically on the first `memoria_write`; hand-written notes without it are
still indexed (the title comes from the first `#` heading, the category from the
folder).

```markdown
---
id: mem_1758712445123_a1b2c3
title: Dietary preferences          # broad topic = note title
topic: Dietary preferences           # drives the file name: dietary-preferences.md
category: preferences
tags: [alice, dietary, food]
aliases: ["Dairy", "Food preferences"]
related: []
supersedes: []
created: 2025-09-24T09:14:05.123Z
updated: 2025-09-24T09:14:05.123Z
last_used: 1758712445123            # refreshed lazily on recall
source: agent
confidence: high
priority: normal
summary: Oat milk in coffee; lactose intolerant.
---

# Dietary preferences

## Facts

- **Drinks** — Drinks oat milk in flat whites; avoids dairy.
- **Fruit** — Likes apples and pears; dislikes durian.
```

Fields: `topic` (broad grouping, drives the file name), `priority`
(`low|normal|high|critical`, boosts ranking), `confidence`, `tags`, `aliases`
(all indexed), `related`, `supersedes`, `summary` (used in listings and recall),
`last_used` (maintained by the store), and `category` (kept in sync with the
folder). Unknown keys are preserved verbatim through updates.

## Tools

| Tool | Purpose |
|---|---|
| `memoria_recall` | Search long-term memory. Filters by category, tags, priority, recency, scope; options for `include_body`, `min_score`, `explain`, `rerank`, `drop_superseded`, prefix/fuzzy control. |
| `memoria_write` | Add a fact to a broad **topic note** (`topic`, `content`, optional `label`, category, tags, aliases, related, supersedes, summary, priority). Creates the note on first use and appends afterwards. |
| `memoria_read` | Read a full note by id, path or alias, with its aliases, related notes and superseding notes. |
| `memoria_move` | Re-file a note under a better broad topic (`from`, `topic`, optional `category`, `merge`, `keep_alias`). Renames when the target is free; set `merge: true` to combine with an occupied target. |
| `memoria_sessions` | Search the transcripts of earlier conversations (`action: "search"`, plus `since_days`, `project`, `include_tools`, `user_only`) and read the surrounding dialogue (`action: "read"`, `path`, `line`, `window`) before quoting it. |
| `memoria_hot` | Read/add/remove/replace/compact `MEMORY.md`, the always-in-context briefing. |
| `memoria_list` | Browse categories, titles, ids, tags, aliases and summaries. |
| `memoria_forget` | Move a note to `.trash/` (recoverable). |

The agent's system prompt teaches it when to use them, so you normally do not
have to ask.

## Commands

```
/memoria                     Store status, index stats, MEMORY.md budget
/memoria search <query>      Ranked results with snippets (--primary/--project/--all)
/memoria store <text>        Quick capture into library/inbox
/memoria read <id|path>      Print a full note
/memoria move <ref> <topic> [--merge]  Re-file a note; opt into merging an occupied target
/memoria hot                 Show MEMORY.md
/memoria topics              Review notes: facts, size, usage, merge candidates
/memoria diff [days]         Memories created or updated recently (default 7 days)
/memoria sessions <query>    Search earlier conversations (--days=N --project=X --tools --user)
/memoria sessions --read <path> <line> [--window=N]   Show the surrounding dialogue
/memoria doctor              Consistency problems and housekeeping hints
/memoria reindex             Rebuild the search index from disk
/memoria index               Regenerate library/INDEX.md files
/memoria paths               Print store paths
/memoria forget <id>         Move a note to .trash
```

## Configuration

Create `config.json` in the store root (`~/.pi/agent/memoria/config.json`) to
override any default. Everything is optional; unknown or malformed values fall
back to the default rather than failing.

```json
{
  "autoRecall": true,
  "autoRecallLimit": 3,
  "topicMaxWords": 6,
  "exclude": ["library/scratch"],
  "projectRoot": ".pi/memoria-project",
  "synonyms": { "k8s": ["kubernetes"] }
}
```

| Key | Default | Meaning |
|---|---:|---|
| `rootDir` | `"$AGENT_DIR/memoria"` | Primary store. Supports `$AGENT_DIR`, `~/`, absolute and cwd-relative paths. |
| `projectRoot` | `""` | Optional writable per-project store; empty disables it. |
| `extraRoots` | `[]` | Additional **read-only** stores to search. |
| `hotLimit` | `5000` | Hard cap for `MEMORY.md`, in characters. |
| `snippetChars` | `280` | Body excerpt length per hit. |
| `autoRecall` | `true` | Search the library on every user prompt. |
| `autoRecallLimit` | `3` | Maximum notes injected per prompt. |
| `autoRecallMinRatio` | `0.3` | Automatic hits must score at least this fraction of the strongest eligible hit; set to `0` to disable the relative cutoff. |
| `autoRecallMinScore` | `1.4` | Score floor for auto-recall. |
| `autoRecallMaxChars` | `2400` | Strict total character budget, including wrappers and transcript fallback. |
| `autoRecallLastTurns` | `1` | Previous turns folded into the recall query. |
| `autoRecallPriorWeight` | `0.4` | Weight of those previous turns versus the current prompt. |
| `bodyCacheBytes` | `8388608` | In-memory body cache budget. |
| `scanIntervalMs` | `2000` | Minimum interval between filesystem freshness scans. |
| `watcherSettleMs` | `300` | Idle delay after a file event before refreshing (coalesces bursts). |
| `exclude` | `[]` | Path fragments never indexed. |
| `defaultCategory` | `"inbox"` | Folder for notes without a category. |
| `topicMaxWords` | `6` | Longest topic name before falling back to the category. |
| `topicMaxChars` | `8000` | Largest note before facts spill into a sibling file. |
| `usageTracking` | `true` | Track hits/writes/last-used in `.index/usage.json`. |
| `lastUsedWriteIntervalMs` | `21600000` | Refresh a note's `last_used` at most this often (6 h). |
| `staleAfterDays` | `365` | `doctor` reports notes unused for longer. |
| `promoteAfterWrites` | `3` | Suggest `memoria_hot` after this many writes with priority ≥ high. |
| `dedupeThreshold` | `0.62` | Overlap above which two notes are reported as merge candidates. |
| `relatedHits` | `3` | Related notes pulled into one result. |
| `relatedBoost` | `0.35` | Score factor for those related notes. |
| `synonyms` | `{}` | Inline synonym table (merged over `synonyms.json`). |
| `synonymWeight` | `0.6` | Weight of synonym-expanded query terms. |
| `timeHints` | `true` | Parse "last week"/"yesterday" in queries into a recency window. |
| `searchCacheSize` | `32` | LRU entries for repeated identical searches (0 disables). |
| `rerank` | `false` | Let the session model reorder recall candidates. |
| `rerankModel` | `""` | Model id (`provider/model`); empty uses the session model. |
| `rerankTopK` | `12` | Candidates shown to the reranker. |
| `rerankTimeoutMs` | `2500` | Reranker budget before falling back to lexical order. |
| `indexFormat` | `"auto"` | `auto` (binary above 20k notes), `json` or `binary`. |
| `sessionSearch` | `true` | Search saved session transcripts at all. |
| `sessionRoots` | `[]` | Extra transcript roots (searched before `<agent dir>/sessions`). |
| `sessionFallback` | `true` | Search transcripts automatically when the library returns nothing. |
| `sessionScanMs` | `1500` | Wall-clock budget for an explicit transcript search (the automatic fallback uses at most 400 ms). |
| `sessionExcerptChars` | `400` | Context characters per transcript hit. |
| `sessionCacheBytes` | `33554432` | In-memory budget for parsed transcripts. |
| `sessionIncludeTools` | `false` | Include tool calls/results and compaction summaries by default. |
| `sessionRipgrep` | `true` | Use a ripgrep prefilter to skip match-free transcripts when `rg` is available; without it the slower built-in scanner runs. |

## Scopes: personal, project, read-only

- **`primary`** (default): the user-level store at `<agent dir>/memoria`.
  Memories follow you across projects.
- **`project`**: set `projectRoot` to keep project-specific memories in the
  repository (`"projectRoot": ".pi/memoria-project"`). It is writable: pass
  `scope: "project"` to write there, while reads default to `all`.
- **`all`**: primary + project + extra roots, read paths merged.
- **`extraRoots`**: additional stores that are always **read-only**, for a
  shared team library or an archive from another machine.
- **`global`**: legacy alias for `primary`.

Cross-store results are rank-normalized: a small store's best hit is lifted to
the global best (up to 4×) instead of being drowned by a large one, and a note
that exists in two stores is returned once.

## Synonyms

Domain shorthand rarely appears in the notes you wrote earlier. Drop a
`synonyms.json` in the store root (or inline the table in `config.json`) and
expansion happens at query time, both directions, with no re-indexing:

```json
{
  "k8s": ["kubernetes"],
  "postgres": ["postgresql", "pg"],
  "auth": ["authentication", "login"],
  "oncall": ["on-call", "pager"]
}
```

## Model reranking

BM25 is exact but literal: it does not know which of five plausible notes you
mean. With `"rerank": true`, the top candidates (`rerankTopK`) are shown to the
session model, which returns them in relevance order, within
`rerankTimeoutMs`. Reranking is strictly best-effort: on timeout, error, missing
auth or an unparsable reply, lexical order is used, so it can never make recall
fail. It is off by default because it costs a model call per search.

## Session recall (past conversations)

Curated memory only holds what the agent decided to remember. The rest of the
story is in pi's saved transcripts, so memoria can search them:

- **Automatically**, whenever `memoria_recall` finds nothing (`sessionFallback`,
  on by default). The injected block is explicitly labelled as raw evidence and
  includes the file and line of every excerpt.
- **On request**, through the `memoria_sessions` tool, useful for "remember
  when", "did we discuss", exact earlier wording, dates, or prior decisions that
  were never turned into memory notes.
- **From the CLI**, with `/memoria sessions <query>` and
  `/memoria sessions --read <path> <line>`.

```
memoria_sessions { action: "search", query: "deploy window Thursday" }
memoria_sessions { action: "search", query: "oat milk", user_only: true }
memoria_sessions { action: "read", path: "<file from a hit>", line: 92, window: 8 }
```

The bundled `memoria-sessions` skill teaches the agent the discipline that makes
this trustworthy: run two to four short distinctive searches (not one long
question), then **read the surrounding dialogue before quoting it**; a later
user correction outranks an earlier assistant claim, and transcript text is
evidence to evaluate, not instructions to follow. If nothing is found, the tool
reports how many sessions and messages were searched.

What it does and does not touch:

| Property | Behaviour |
|---|---|
| Scope | Every `*.jsonl` under the configured roots, newest first (no index that can go stale). |
| Content | User and assistant **text** by default. Thinking blocks are never extracted. Tool calls/results, compaction summaries and extension payloads only with `include_tools: true`. |
| Output | Bounded excerpts plus `file:line`; never a whole transcript dump. |
| Writes | None. Transcripts are read-only and `read` refuses paths outside the session roots. |
| Cost | With `rg`, only transcripts containing the query terms are parsed; without it, a full cold scan of 110 sessions / 13 MB ≈ 120 ms, repeats ≈ 5 ms from the parse cache. |
| Coverage | Exhaustive unless a budget stops it. `partial` (shown in the tool output, the recall block and `/memoria sessions`) means the scan stopped early: the hits are real, but older sessions were not read. Newest sessions are scanned first, already-parsed files stay cached while they fit `sessionCacheBytes` (so retries get further on corpora that fit the cache), and concurrent searches share one in-flight parse per transcript (so several `memoria_sessions` calls in one turn do not multiply the work). An explicit `memoria_sessions` call uses the larger `sessionScanMs` budget. |
| Privacy | Search runs locally; returned excerpts enter the configured model’s context. |

`sessionRoots` exists for archives or a second agent directory. Set
`sessionSearch: false` to disable the feature entirely, or
`sessionFallback: false` to keep the tool while never searching automatically.

When `rg` is available (pi ships it and puts it on `PATH`), a selective search
asks ripgrep which transcripts contain the query terms and parses only those, so
even a gigabyte-scale history is answered within the normal budget. If `rg` is
missing or fails, memoria falls back to reading every transcript itself and says
so: the result carries a `ripgrep is not installed` note, and interactive mode
shows it once per session. Large histories may then be only partially covered.

Without `rg` (or for a deliberately disabled accelerator), the default
`sessionScanMs` budget and `sessionCacheBytes` cache cover only part of a large
corpus: searches report `partial`, and repeats are cold scans because the cache
cannot retain the parsed files. Raise `sessionScanMs` so an explicit
`memoria_sessions` call can cover the whole corpus in one pass, and
`sessionCacheBytes` only if you have the RAM for the parsed messages (at this
scale that means gigabytes). The automatic fallback remains capped at 400 ms,
so on such a corpus it is always a partial scan.

## Backup

The store is plain markdown, so a backup is a copy of the store directory
(`~/.pi/agent/memoria/`, or `$PI_CODING_AGENT_DIR/memoria/`). `.index/` is
derived and can be omitted; `.trash/` and `.history/` hold recoverable deleted
notes and previous briefing versions respectively. The files stay readable as
plain markdown if you stop using memoria, and you can commit the store to a
private repository after reviewing it for sensitive content.

## Performance

These are previously recorded results, not measurements from every release or
a guarantee for other machines. Run the commands below to measure your setup.

`node tests/bench.ts 1000 5000` measures a worst-case corpus (50-word
vocabulary, 60-word documents, so every posting list is long);
`node tests/bench.ts 1000 5000 --real` uses a realistic high-vocabulary corpus
(~44k distinct terms at 5k notes).

| Corpus | Notes | Index size | Cold load | Reload | Search | Prefix | Fuzzy |
|---|---:|---:|---:|---:|---:|---:|---:|
| worst case | 1,000 | 1.3 MB | 219 ms | 23 ms | 0.35 ms | 0.22 ms | 0.32 ms |
| worst case | 5,000 | 6.8 MB | 1.10 s | 109 ms | 0.89 ms | 0.66 ms | 0.94 ms |
| realistic | 5,000 | 8.5 MB | 1.34 s | 134 ms | 1.20 ms | 0.64 ms | 1.02 ms |
| realistic | 20,000 | 34.5 MB | 5.4 s | 543 ms | 5.88 ms | 2.63 ms | 4.30 ms |

Auto-recall runs on every prompt, which is why the search path is
allocation-light: a dense scratch-buffer BM25 loop, posting lists in memory, and
snippets read only for the final hits. Recency scans are throttled
(`scanIntervalMs`) and coalesced from filesystem events (`watcherSettleMs`), so
a burst of edits costs one refresh.

## Privacy and durability

- **Local only.** Search and storage run locally. The briefing, recalled notes and transcript
  excerpts enter the configured model’s context. Optional reranking makes
  additional model calls.
- **Files, not a database.** Memoria never owns your data: notes are markdown
  with frontmatter, deletes are soft (moved to `.trash/`), and the index is
  derived and can be rebuilt with `/memoria reindex`.
- **Crash-safe moves.** Category moves, renames and merges are journaled. On
  restart, a merge only removes its source after the target has all its facts
  and the source's former id.
- **Atomic writes.** Every write goes through a temp file and rename; there is no
  window where a note is half-written.
- **Scoped reads.** `memoria_read` only follows paths inside the memory library;
  transcript window reads refuse paths or symlinks outside configured roots.
- **Secrets:** memoria does not scan for credentials, and the tool descriptions
  tell the agent not to store them. If you keep secrets in the store anyway, remember
  that recall may surface them in model context; treat the store like your shell
  history.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Notes exist but recall finds nothing | `/memoria reindex`; check `/memoria paths` for the store location; remember scopes (`--all` searches every root). |
| A note is filed under `people.md` instead of the person's name | The topic was rejected as fact-shaped or relational. Write with the person's name as `topic` and put the relationship in the content. |
| The same subject ended up in two notes | `/memoria topics` lists merge candidates with the exact `memoria_move` command; `memoria doctor` reports them too. |
| `MEMORY.md` is over budget | Read it, then use `memoria_hot { action: "replace", text: "..." }` to rewrite it tightly while preserving standing facts. Compact refuses destructive truncation. |
| A decision changed | Write the new note with `supersedes: ["<old id, path or title>"]`; the old note stays searchable but is demoted and flagged. |
| Search misses domain shorthand | Add `synonyms.json` (see [Synonyms](#synonyms)). |
| Model reranking is slow | Lower `rerankTopK`, or leave `rerank` off; lexical search avoids the extra model call. |
| Want to see what changed lately | `/memoria diff 3` for the last three days, `/memoria topics` for usage, and a session-start notification summarises changes since your previous session. |
| An agent edited files and the index is stale | Filesystem events and a throttled scan pick changes up automatically; `/memoria doctor` shows the state. |
| The user references something from before | The agent should search transcripts (`memoria_sessions`, or `/memoria sessions <query>`) rather than claim it does not remember; `/memoria paths` lists the session roots. |
| Session search finds nothing | Try different wording, a name or a date, or `include_tools: true`; check `sessionRoots` covers the transcript location, and note that a budget-limited scan reports `partial`. |

## Development

```bash
npm install            # dev-only: pi host packages + typescript
npm test               # node:test, no build step
npm run typecheck      # tsc --noEmit
npm run eval           # recall@1/@5/MRR over the fixture corpus
npm run bench          # latency at 1k and 5k notes
npm run bench:real     # realistic high-vocabulary corpus
pi -e ./index.ts       # run the extension from the checkout
```

The extension runs on Node's native type-stripping (`node >= 22.19`), which
means no build step but also no `enum`, `namespace`, constructor parameter
properties or `import x = require()` in the sources. Type-only imports must use
`import type`, and relative imports include the `.ts` extension.

Architecture, invariants and the release checklist live in
[`AGENTS.md`](../AGENTS.md). The short version:

```
index.ts            lifecycle hooks, system-prompt section, auto-recall
src/types.ts        shared types (no runtime imports)
src/util.ts         atomic writes, mutex, debounce, ids, paths
src/frontmatter.ts  dependency-free YAML-subset parser/serializer
src/tokenize.ts     identifiers, camel/snake/kebab, CJK, stemmer, trigrams
src/config.ts       defaults, coercion, path resolution
src/store.ts        filesystem: parse, write, merge, move, MEMORY.md, indexes
src/index-engine.ts inverted index, persistence (JSON/binary), link resolution
src/search.ts       BM25, boosts, snippets, explain, related/superseded handling
src/similarity.ts   duplicate-topic and contradiction detection
src/usage.ts        hits/writes/last-used tracking
src/timeexpr.ts     "last week" → recency windows
src/synonyms.ts     query-side synonym tables
src/recall.ts       prompt/message rendering
src/rerank.ts       optional model reranking
src/runtime.ts      roots, locks, caching, health, scopes
src/tools.ts        tool definitions and renderers
src/commands.ts     /memoria subcommands
```

### Publishing your own copy

1. Push the repository to GitHub (public or private).
2. Keep `index.ts` at the package root and the `pi` manifest in `package.json`.
3. Leave the host modules as `peerDependencies` **and** mark them
   `"optional": true` in `peerDependenciesMeta`, keeping them in
   `devDependencies` for local tests only. Without that, npm installs a ~450 MB
   duplicate of pi into the package.
4. Tag releases (`git tag v<version> && git push --tags`) and install by tag:
   `pi install git:github.com/<you>/pi-memoria@v<version>`.
5. `npm pack --dry-run` should list only `index.ts`, `src/**`, `skills/**`,
   `README.md`, `LICENSE` and `package.json`.

## Design notes and limits

- **Topic notes are the unit of storage.** This is deliberately opinionated: a
  file per fact fragments knowledge and makes retrieval worse. The cost is that
  the agent must pick a broad topic; when it picks badly, the store falls back to
  the category rather than creating a bad file name, and `memoria_move` fixes it
  later.
- **Lexical, not semantic.** BM25 with a conservative stemmer, prefix and fuzzy
  matching is fast, deterministic and dependency-free, but it will not connect
  "my manager" to "Alice" without an alias or a synonym table. Embeddings would
  improve that; they are not worth the dependency for a store this fast.
- **Cross-topic duplication is reported, not merged automatically.** The store
  flags two notes as duplicates only when their *names* also point at the same
  subject (equal slugs, or one name being a prefix/suffix of the other, e.g.
  `Alice` and `Alice Smith`, or a legacy `Johns father` note whose name appears
  as an alias). Content overlap alone is not enough: one person's note naturally
  describes the people around them, and merging John Doe with his father would be
  worse than missing a duplicate. Folding notes stays an explicit
  `memoria_move`, suggested on write and listed by `/memoria topics`.
- **Usage is derived data.** `.index/usage.json` drives staleness and promotion
  hints; deleting `.index/` only loses those hints.
- **Journal recovery covers moves, not arbitrary edits.** A crash between an
  atomic write and a trash move is repaired; a crash mid-edit of a single file
  leaves the previous content intact (writes are atomic).
- **Model reranking instead of embeddings.** An embedding index would improve
  semantic matching, but pi exposes chat completions rather than an embedding
  API, and a vector store is a dependency this project does not want. The
  optional reranker reorders retrieved candidates, but cannot recover missing candidates, and
  degrades to lexical order on any failure. Time-scoped questions are handled by
  parsing the window out of the query rather than by time-decayed IDF: the note's
  own timestamp is the signal that matters.

## Token-efficient automatic recall

Automatic recall strips Telegram transport headers and `[time]` metadata before
searching (dates in user prose are preserved). It selects up to three candidates
by default, excludes superseded notes and hits matching only previous turns, and
applies both the absolute score floor and `autoRecallMinRatio`. Current-query
synonyms remain eligible. Explicit `memoria_recall` retains broad retrieval.

Injected entries contain just a title, reference and excerpt; diagnostic scores,
tags, paths and missing-term lists remain available through explicit tools.
The entire automatic block, including complete transcript citations and its
verification instruction, fits `autoRecallMaxChars`; entries that cannot fit are
omitted. An empty block is not injected.

Unchanged note/excerpt fingerprints already present on the active context branch
are not injected again. Changed notes or different excerpts can reappear, and
compaction conservatively resets suppression. This metadata is not sent to the
model. Recently written titles no longer churn the system-prompt section; the
user-facing session delta notification remains. Relevant recalled evidence can be
used directly instead of making a redundant recall tool call.

Budgets are character limits, not tokenizer measurements. The eight existing tools
remain registered for API compatibility; optional reranking remains off by default.


## Briefing write contract

All supported MEMORY.md mutations validate the complete proposed prose before
saving. Lists, headings (except the legacy `# Memory` template, which is removed),
annotations, code fences, tables, repeated sentences and over-budget text are
rejected. A failed validation leaves the previous file untouched. Adds never
truncate input. Compact is non-destructive: an oversized briefing requires an
explicit, agent-authored replacement, not dropping trailing facts.

Before any edit, the agent must read the briefing, consolidate related statements,
preserve unrelated standing facts, apply explicit corrections in place, and ask
about ambiguous conflicts. Only verified, high-leverage standing context belongs
here; dated maintenance history and skill instructions belong elsewhere. These
semantic requirements are agent rules, not guarantees from the validator.

Changed writes preserve the previous file in `.history/*-MEMORY.md`. History is
local, not injected or searched as notes, and currently has no automatic retention
limit.

Direct filesystem edits bypass this contract. In-process locking does not provide
cross-process writer coordination. No additional model calls or scheduled audit
are introduced by validation.
