---
name: memoria-library
description: Navigate and maintain the memoria long-term memory store (MEMORY.md, the markdown library, and its tools). Use when asked about remembered facts, when a memory looks wrong, duplicated, stale or misfiled, or when consolidating notes with memoria_move.
---

# Working with the memoria library

memoria stores long-term memory as plain markdown. The extension already injects
`MEMORY.md` into every prompt and auto-recalls notes per turn, so this skill is
for *maintenance* rather than retrieval: deciding where a fact belongs, fixing a
bad file name, or consolidating notes that describe the same thing.

## Layout

```
<agent dir>/memoria/
├── MEMORY.md        prose briefing injected every session (who the user is)
├── synonyms.json    optional: {"k8s": ["kubernetes"]} query-side expansion
├── config.json      optional store overrides
├── library/<category>/<topic>.md     one note per broad topic
├── library/INDEX.md                  generated table of contents (never edit)
├── .index/          derived: index.json|index.bin, usage.json (safe to delete)
└── .trash/          soft-deleted notes
```

## Rules that matter when editing

1. **Never name a file after a fact or a relationship.** `likes-apples.md`,
   `johns-father.md` and `dad.md` are defects. A relation is a fact that expires
   the moment the person has a name.
2. **One note per subject.** Several facts belong together in one note under
   `## Facts`; use `memoria_write` with the same `topic` to append.
3. **Aliases beat renames.** `aliases: ["Robert", "John's father"]` in
   frontmatter means every name finds the note. Add aliases instead of creating
   a second note about the same person or thing.
4. **Consolidate with `memoria_move`, don't copy.** `memoria_move` renames when
   the target is free and merges (never overwrites) when it is not, keeping the
   note id and adding the old names as aliases.
5. **Resolve contradictions with `supersedes`.** Write the new note with
   `supersedes: ["<old id, path or title>"]`; the old note is demoted and flagged
   instead of silently contradicting the new one.
6. **`MEMORY.md` is prose, not a log.** Short paragraphs, no headings, no bullet
   lists, no annotations. Only facts that pay off in almost every session.

## Triage recipes

- **"What do you remember about X?"** — `memoria_recall` with several focused
  queries (names, aliases, synonyms); then `memoria_read` the best hit.
- **Rename or re-file a note** — `memoria_move { from, topic, merge: true }`.
- **Two notes about one subject** — `/memoria topics` lists merge candidates with
  the exact `memoria_move` command to run. `memoria doctor` reports the same.
- **A note is wrong** — write the correction with `memoria_write` using the same
  topic, or `supersedes` the old note when it replaces a decision.
- **Never something again** — `memoria_forget` (soft delete into `.trash/`).
- **Backup or migrate** — `memoria_export` to JSONL, `memoria_import` to restore
  (`dry_run: true` first, `mode: "merge"` unless you mean to replace).
- **Search feels weak** — add `synonyms.json`, or check `/memoria status`.

## Do not

- Do not edit `.index/` or generated `INDEX.md` files; they are derived.
- Do not hard-delete memory files; `memoria_forget` keeps them recoverable.
- Do not store secrets, credentials or tokens in the library.
- Do not create a note per fact, and do not inline a fact into MEMORY.md when a
  library note would do.
