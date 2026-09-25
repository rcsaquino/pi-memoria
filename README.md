# pi-memoria

Long-term memory for [pi](https://pi.dev). Saves preferences, project context and
past decisions as Markdown files, then retrieves relevant notes in later sessions.

Memory lives in your agent directory and follows you across projects. Search runs
locally, with no database, embedding service or additional runtime dependencies.
The agent can also search pi's saved conversations when a detail was never saved
as a note.

## Install

Requires pi and Node.js **22.19.0 or later**.

```sh
pi install npm:pi-memoria
```

Restart pi or run `/reload` to load the extension and its bundled skills.
No configuration is required.

Alternatively, install a tagged release from GitHub:

```sh
pi install git:github.com/rcsaquino/pi-memoria@v0.1.3
```

Use one installation method, not both.

## Use it

Ask pi to remember something:

```text
Remember that I use pnpm for personal projects and prefer tabs over spaces.
```

In a later session, relevant notes are added to the agent's context automatically.
You can also ask directly:

```text
What package manager do I use for personal projects?
What did we decide about the deployment last week?
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `/memoria` | Show store status and the briefing's size |
| `/memoria search <query>` | Search saved notes |
| `/memoria sessions <query>` | Search earlier conversations |
| `/memoria topics` | Review notes and possible duplicates |
| `/memoria doctor` | Check for consistency problems |
| `/memoria paths` | Show storage locations |

Saving a fact and retrieving it are separate steps. Automatic recall searches
existing notes; it does not turn every conversation into a memory. The agent
saves a note when something is worth keeping.

## What gets remembered

Memoria keeps three sources of context:

- **A short briefing** (`MEMORY.md`): standing preferences and context included
  in the system prompt. Limited to 5,000 characters by default.
- **Topic notes** (`library/`): people, projects, decisions and other details
  retrieved when relevant. Facts about the same subject accumulate in one file.
- **Saved conversations**: read-only searches of pi's transcripts, with file and
  line references so the agent can check the surrounding dialogue.

For example, several preferences belong in `preferences/dietary-preferences.md`,
not separate `likes-apples.md` and `likes-pears.md` files. Notes support aliases,
links and superseded decisions. Renaming a note preserves its identity; merging
notes requires an explicit request.

The default store is separate from the installed extension:

```text
~/.pi/agent/memoria/
├── MEMORY.md
├── config.json           # optional settings
├── library/
│   ├── people/
│   ├── projects/
│   └── preferences/
├── .index/               # rebuildable search data
└── .trash/               # recoverable deleted notes
```

If you set `PI_CODING_AGENT_DIR`, the store follows that directory. You can read
and edit notes with a text editor; the index picks up changes automatically.

## Configuration

Create `~/.pi/agent/memoria/config.json` to override defaults. For example, to
add a project store and teach search an abbreviation:

```json
{
  "projectRoot": ".pi/memoria-project",
  "synonyms": { "k8s": ["kubernetes"] }
}
```

The primary store is user-wide. `projectRoot` adds an optional writable project
store; `extraRoots` adds read-only stores. Reranking is off by default because
it makes an additional model call per search.

<details>
<summary>All configuration options</summary>

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

</details>

## Privacy and limits

**Local storage does not mean model-private memory.** The briefing, recalled
notes and returned transcript excerpts become part of the configured model's
context. With a hosted model, that content is sent to its provider. Reranking
also sends content to the configured model when enabled.

- Notes are not encrypted, and memoria does not detect or redact credentials.
  Do not store secrets.
- Search is lexical (BM25 with aliases, synonyms, prefix and fuzzy matching),
  not embedding-based. It can miss a paraphrase with no matching terms.
- Recall is bounded. Relevant notes can be omitted by score or context limits;
  transcript searches report `partial` when they run out of scan budget.
- Reranking can reorder retrieved notes, not find notes that search missed.
- Deletes move notes to `.trash/`. This is recovery, not secure erasure.
- Writes use atomic file replacement, but separate pi processes are not
  coordinated as concurrent writers. Keep backups.

## Backup and troubleshooting

Back up the store by copying `~/.pi/agent/memoria/` (or
`$PI_CODING_AGENT_DIR/memoria/`). Notes are plain markdown, so a folder copy is
the complete backup; `.index/` is derived and can be omitted.

If recall misses an existing note, check `/memoria paths`, try a distinctive
name or phrase, then run `/memoria reindex`. For duplicated subjects, use
`/memoria topics` and ask the agent to consolidate the appropriate notes.

## Reference and development

The [reference guide](https://github.com/rcsaquino/pi-memoria/blob/main/docs/reference.md)
covers all tools and commands, note format, scopes, session search, backup
semantics, briefing validation and benchmark commands. It follows the current
checkout, which may be ahead of the npm release.

To work on the extension from a clone:

```sh
npm install
npm run typecheck
npm test
npm run eval
npm run bench
pi -e ./index.ts
```

No build step is needed. See
[AGENTS.md](https://github.com/rcsaquino/pi-memoria/blob/main/AGENTS.md)
for architecture, invariants and contribution checks.

Report bugs through [GitHub Issues](https://github.com/rcsaquino/pi-memoria/issues).
Include your pi and Node versions, steps to reproduce, and relevant errors.
Remove personal memory content and credentials before sharing logs.

## Support My Work

If pi-memoria is useful to you, please consider supporting my work by
[buying me a coffee](https://ko-fi.com/rcsaquino). 😊

<a href="https://ko-fi.com/rcsaquino" target="_blank" rel="noopener noreferrer"><img height="72" src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" alt="Buy Me a Coffee at ko-fi.com" /></a>

## License

[MIT](https://github.com/rcsaquino/pi-memoria/blob/main/LICENSE) © 2026 rcsaquino.
