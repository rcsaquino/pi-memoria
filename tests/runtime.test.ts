import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoriaRuntime } from "../src/runtime.ts";
import { renderRecallBlock, renderSystemSection, buildRecallQuery } from "../src/recall.ts";
import { MemoryIndex } from "../src/index-engine.ts";

/**
 * Hermetic runtime: the store lives under a temporary home directory, never in
 * the real `~/.pi/agent`, so tests cannot pollute (or read) the user's memory.
 */
async function withRuntime(
	fn: (runtime: MemoriaRuntime, cwd: string, home: string) => Promise<void>,
	options: { rootDir?: string; extraRoots?: string[] } = {},
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-runtime-"));
	const home = await mkdtemp(join(tmpdir(), "memoria-home-"));
	const runtime = new MemoriaRuntime(cwd, { home, agentDir: join(home, ".pi", "agent") });
	try {
		await runtime.init(true);
		if (options.rootDir || options.extraRoots) await runtime.reconfigure({ ...runtime.config, ...options });
		await fn(runtime, cwd, home);
	} finally {
		await runtime.dispose();
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
}

test("init creates the store inside the pi agent directory, not the project", async () => {
	await withRuntime(async (runtime, cwd, home) => {
		const expected = join(home, ".pi", "agent", "memoria");
		assert.equal(runtime.roots.primary, expected);
		assert.ok(existsSync(join(expected, "MEMORY.md")));
		assert.ok(existsSync(join(expected, "library")));
		assert.ok(!existsSync(join(cwd, "memoria")), "no store is created in the project");
		const result = await runtime.search("anything");
		assert.equal(result.hits.length, 0);
		assert.ok(result.tookMs < 250);
	});
});

test("write then search finds the new memory without a rescan", async () => {
	await withRuntime(async (runtime) => {
		const { result } = await runtime.write({
			title: "Deploys happen on Thursdays",
			content: "Production deploys are scheduled for Thursday mornings to avoid weekend incidents.",
			category: "workflows",
			tags: ["deploy", "process"],
		});
		assert.equal(result.updated, false);
		const found = await runtime.search("when are deploys");
		assert.ok(found.hits.length > 0);
		assert.equal(found.hits[0].doc.id, result.doc.id);
	});
});

test("updateMemoryById updates in place and reindexes", async () => {
	await withRuntime(async (runtime) => {
		const { result } = await runtime.write({ title: "Coffee order", content: "Alice orders a flat white.", category: "people" });
		const updated = await runtime.updateMemoryById(result.doc.id, { content: "Alice orders an oat flat white." });
		assert.ok(updated);
		assert.equal(updated!.doc.id, result.doc.id);
		const found = await runtime.search("oat flat white");
		assert.equal(found.hits[0].doc.id, result.doc.id);
		const stale = await runtime.search("orders a flat white", { limit: 5 });
		assert.equal(stale.hits[0].doc.id, result.doc.id);
	});
});

test("concurrent writes to the same topic never lose a fact", async () => {
	await withRuntime(async (runtime) => {
		const facts = ["Likes apples.", "Likes pears.", "Dislikes durian.", "Avoids kiwi.", "Enjoys mango."];
		await Promise.all(facts.map((content, index) => runtime.write({ topic: "Food preferences", label: `Fact ${index}`, content, category: "preferences" })));
		const entries = await runtime.listEntries("primary");
		assert.equal(entries.length, 1, "all concurrent writes land in one topic note");
		const doc = await runtime.readMemory(entries[0].meta.id, "primary");
		assert.ok(doc);
		for (const fact of facts) {
			assert.ok(doc!.doc.body.includes(fact), `lost fact: ${fact}\n${doc!.doc.body}`);
		}
	});
});

test("concurrent MEMORY.md appends never lose a bullet", async () => {
	await withRuntime(async (runtime) => {
		await Promise.all(
			["Prefers dark mode.", "Prefers terse answers.", "Uses vim keybindings."].map((sentence) => runtime.hotAdd(sentence, "Preferences")),
		);
		const hot = await runtime.hotState();
		for (const sentence of ["Prefers dark mode.", "Prefers terse answers.", "Uses vim keybindings."]) {
			assert.ok(hot.content.includes(sentence), `lost sentence: ${sentence}\n${hot.content}`);
		}
	});
});

test("forget tombstones the memory and moves the file", async () => {
	await withRuntime(async (runtime) => {
		const { result } = await runtime.write({ title: "Temporary fact", content: "This will be forgotten soon." });
		const forgotten = await runtime.forget(result.doc.id);
		assert.ok(forgotten);
		assert.ok(forgotten!.trashPath.includes(".trash"));
		const found = await runtime.search("forgotten soon");
		assert.equal(found.hits.length, 0);
		assert.equal(await runtime.readMemory(result.doc.id), undefined);
	});
});

test("extra roots are searched alongside the primary store but never written to", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-runtime-"));
	const home = await mkdtemp(join(tmpdir(), "memoria-home-"));
	const extra = join(cwd, "project-memoria");
	const runtime = new MemoriaRuntime(cwd, { home, agentDir: join(home, ".pi", "agent") });
	try {
		await runtime.init(true);
		await runtime.reconfigure({ ...runtime.config, extraRoots: [extra] });
		// Seed the extra root out-of-band (it is a read-only addition).
		const { ensureStore, createMemory } = await import("../src/store.ts");
		await ensureStore(extra, 5000);
		await createMemory(extra, { topic: "Timezone", content: "The project runs in Asia/Manila time.", category: "knowledge" });

		await runtime.write({ topic: "Primary fact", content: "The user prefers oat milk.", category: "preferences" });
		assert.ok(!existsSync(join(extra, "library", "preferences")), "writes never target an extra root");

		const all = await runtime.search("time", { scope: "all" });
		assert.ok(all.byRoot.length >= 2, "both roots are searched");
		const onlyPrimary = await runtime.search("time", { scope: "primary" });
		assert.equal(onlyPrimary.byRoot.length, 1);
		assert.ok(onlyPrimary.hits.every((hit) => !hit.doc.root.startsWith(extra)));
	} finally {
		await runtime.dispose();
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});

test("legacy global resolves to the primary store and project is a real scope", async () => {
	await withRuntime(async (runtime) => {
		const written = await runtime.write({ topic: "Legacy scope", content: "Written with scope global.", category: "knowledge", scope: "global" });
		assert.equal(written.root, runtime.roots.primary);
		// Without a configured projectRoot the project scope is simply empty.
		assert.equal(runtime.roots.project, "");
		const project = await runtime.search("Legacy", { scope: "project" });
		assert.equal(project.byRoot.length, 0);
		assert.equal(project.hits.length, 0);
		const primary = await runtime.search("Legacy", { scope: "primary" });
		assert.equal(primary.byRoot.length, 1);
		assert.ok(primary.hits.length >= 1);
	});
});

test("a configured projectRoot is a writable second store", async () => {
	await withRuntime(async (runtime, cwd) => {
		const projectDir = join(cwd, "project-store");
		await runtime.reconfigure({ ...runtime.config, projectRoot: projectDir });
		assert.equal(runtime.roots.project, projectDir);
		const written = await runtime.write({ topic: "App scope", content: "The app uses Postgres 16.", category: "knowledge", scope: "project" });
		assert.equal(written.root, projectDir);
		// Writes default to the user-level store, and "all" sees both.
		const primary = await runtime.write({ topic: "Editor preferences", content: "The user prefers tabs over spaces.", category: "preferences" });
		assert.equal(primary.root, runtime.roots.primary);
		const all = await runtime.search("Postgres tabs", { scope: "all" });
		const titles = all.hits.map((hit) => hit.doc.title);
		assert.ok(titles.includes("App scope"), `project note missing from all-scope search: ${titles.join(", ")}`);
		assert.ok(titles.includes("Editor preferences"), `primary note missing from all-scope search: ${titles.join(", ")}`);
		// Reads are scoped too: the project note is not in the primary store.
		assert.equal((await runtime.search("Postgres", { scope: "primary" })).hits.length, 0);
		assert.equal((await runtime.search("tabs", { scope: "project" })).hits.length, 0);
	});
});

test("regenerateIndexes writes library/INDEX.md and per-category files", async () => {
	await withRuntime(async (runtime) => {
		await runtime.write({ title: "Alice", content: "Alice likes tea.", category: "people" });
		await runtime.write({ title: "Nightingale", content: "Nightingale uses Postgres.", category: "projects" });
		const results = await runtime.regenerateIndexes("primary");
		assert.equal(results.length, 1);
		const rootIndex = await readFile(join(runtime.roots.primary, "library", "INDEX.md"), "utf8");
		assert.ok(rootIndex.includes("Alice"));
		assert.ok(rootIndex.includes("Nightingale"));
		assert.ok(existsSync(join(runtime.roots.primary, "library", "people", "INDEX.md")));
	});
});

test("generated INDEX.md files never enter the search index", async () => {
	await withRuntime(async (runtime) => {
		await runtime.write({ title: "Alice", content: "Alice likes tea.", category: "people" });
		await runtime.regenerateIndexes("primary");
		const index = await runtime.indexFor(runtime.roots.primary);
		await index.refresh(true);
		assert.ok(index.liveDocs().every((entry) => entry.meta.relPath !== "library/INDEX.md"));
		const result = await runtime.search("Index");
		assert.ok(result.hits.every((hit) => !hit.doc.relPath.endsWith("INDEX.md")));
	});
});

test("hot memory helpers enforce and report the budget", async () => {
	await withRuntime(async (runtime) => {
		const added = await runtime.hotAdd("Prefers terse answers.", "Preferences");
		assert.ok(added.after > added.before);
		const hot = await runtime.hotState();
		assert.ok(hot.content.includes("Prefers terse answers"));
		const removed = await runtime.hotRemove("terse answers");
		assert.equal(removed.removed, 1);
		assert.ok(!removed.after || removed.after < removed.before);
	});
});

test("doctor reports problems in hand-written memories", async () => {
	await withRuntime(async (runtime) => {
		await writeFile(join(runtime.roots.primary, "library", "knowledge", "thin.md"), "# Thin\n\nNo frontmatter here.\n", "utf8").catch(async () => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(runtime.roots.primary, "library", "knowledge"), { recursive: true });
			await writeFile(join(runtime.roots.primary, "library", "knowledge", "thin.md"), "# Thin\n\nNo frontmatter here.\n", "utf8");
		});
		const findings = await runtime.doctor();
		assert.ok(findings.some((finding) => finding.includes("thin.md")));
	});
});

test("external edits are caught by refresh even without a watcher", async () => {
	await withRuntime(async (runtime) => {
		const { result } = await runtime.write({ title: "Config location", content: "Config lives in .pi/settings.json", category: "knowledge" });
		const path = result.path;
		const index = await runtime.indexFor(runtime.roots.primary);
		await writeFile(path, (await readFile(path, "utf8")).replace(".pi/settings.json", ".pi/config.json"), "utf8");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const index2 = await runtime.indexFor(runtime.roots.primary);
		await index2.refresh(true);
		const found = await runtime.search("config.json");
		assert.equal(found.hits[0].doc.id, result.doc.id);
		void index;
	});
});

test("renderSystemSection includes rules, hot memory and category map", () => {
	const section = renderSystemSection({
		root: "/tmp/memoria",
		hotContent: "# Memory\n\n- User prefers dark mode",
		hotChars: 40,
		hotLimit: 5000,
		hotOver: false,
		categories: [
			["people", 3],
			["projects", 2],
		],
		totalDocs: 5,
		indexTookMs: 0,
		recent: [{ id: "mem_1", title: "Newest note", relPath: "library/people/a.md" }],
	});
	assert.ok(section.includes("memoria_recall"));
	assert.ok(section.includes("User prefers dark mode"));
	assert.ok(section.includes("people (3), projects (2)"));
	assert.ok(section.includes("Recently learned"));
	assert.ok(section.includes("MEMORY.md budget: 40/5000"));
});

test("renderSystemSection shows an empty hint and trims over-budget prose without markers", () => {
	const empty = renderSystemSection({
		root: "/tmp/memoria",
		hotContent: "# Memory\n",
		hotChars: 9,
		hotLimit: 5000,
		hotOver: false,
		categories: [],
		totalDocs: 0,
		indexTookMs: 0,
	});
	assert.ok(empty.includes("empty"), empty);
	assert.ok(!empty.includes("<!--"));

	const over = renderSystemSection({
		root: "/tmp/memoria",
		hotContent: `# Memory\n\nFirst fact about Alice.\n\nSecond fact.\n\nThird fact.\n`,
		hotChars: 70,
		hotLimit: 45,
		hotOver: true,
		categories: [],
		totalDocs: 0,
		indexTookMs: 0,
	});
	assert.ok(over.includes("WARNING"), over);
	assert.ok(over.includes("First fact"), over);
	assert.ok(!over.includes("truncated"), "no truncation marker is injected");
	assert.ok(!over.includes("<!--"));
});

test("renderRecallBlock stays within the character budget", () => {
	const hits = Array.from({ length: 10 }, (_, i) => ({
		doc: {
			id: `mem_${i}`,
			root: "/tmp",
			path: `/tmp/library/x/${i}.md`,
			relPath: `library/x/${i}.md`,
			title: `Memory number ${i}`,
			category: "x",
			tags: ["t"],
			aliases: [],
			related: [],
			supersedes: [],
			summary: "s",
			priority: "normal" as const,
			confidence: "medium" as const,
			created: 1,
			updated: 1,
			lastUsed: 1,
			mtimeMs: 1,
			size: 1,
			wordCount: 1,
			bodyChars: 10,
			tokenCount: 1,
			unfiled: false,
			preview: "preview",
			hash: "h",
		},
		score: 10 - i,
		matched: ["memory"],
		snippet: "x".repeat(400),
		exact: false,
	}));
	const rendered = renderRecallBlock({ query: "memory", hits, maxChars: 800, tookMs: 1.2 });
	assert.ok(rendered.startsWith("<memoria_recall"));
	assert.ok(rendered.endsWith("</memoria_recall>"));
	assert.ok(rendered.length < 1400, `rendered length was ${rendered.length}`);
	assert.ok(rendered.includes("[mem_0]"));
	assert.ok(rendered.includes("memoria_read"));
});

test("buildRecallQuery folds previous turns", () => {
	const query = buildRecallQuery("what about her coffee order?", ["Alice is lactose intolerant", "Tell me about Alice"], 1);
	assert.ok(query.includes("coffee order"));
	assert.ok(query.includes("Tell me about Alice"));
	assert.ok(!query.includes("lactose"));
});

test("config.exclude removes matching files from the index", async () => {
	await withRuntime(async (runtime) => {
		await runtime.write({ title: "Keep me", content: "searchable pineapple", category: "knowledge" });
		await runtime.write({ title: "Skip me", content: "searchable pineapple confidential", category: "secret" });
		// Rebuild the index with an exclusion for the secret category.
		await runtime.reconfigure({ ...runtime.config, exclude: ["library/secret"] });
		const results = await runtime.rebuild("primary");
		assert.equal(results[0].docs, 1);
		const found = await runtime.search("pineapple", { scope: "primary" });
		assert.equal(found.hits.length, 1);
		assert.equal(found.hits[0].doc.title, "Keep me");
	});
});

test("doctor does not report phantom category directories", async () => {
	await withRuntime(async (runtime) => {
		await runtime.write({ title: "Note", content: "a healthy note with enough words", category: "knowledge", tags: ["x"], summary: "a healthy note" });
		const findings = await runtime.doctor();
		assert.deepEqual(findings, []);
	});
});

test("busy-store stats aggregate across roots", async () => {
	await withRuntime(async (runtime, cwd) => {
		await runtime.write({ topic: "Apples", content: "first memory about apples", category: "knowledge" });
		await runtime.write({ topic: "Bananas", content: "second memory about bananas", category: "knowledge" });
		const stats = await runtime.stats();
		assert.equal(stats.roots.length, 1);
		assert.equal(stats.roots[0].docs, 2);
		assert.equal(stats.roots[0].categories.knowledge, 2);
		assert.equal(stats.config.hotLimit, 5000);
		void cwd;
	});
});

test("index persists to disk and reloads with identical hits", async () => {
	await withRuntime(async (runtime) => {
		await runtime.write({ title: "Persisted note", content: "The quick brown fox jumps over the lazy dog.", category: "knowledge" });
		const index = await runtime.indexFor(runtime.roots.primary);
		await index.save();
		const reloaded = new MemoryIndex(runtime.roots.primary);
		await reloaded.load();
		const result = await reloaded.search("quick brown fox");
		assert.equal(result.hits.length, 1);
		assert.equal(result.hits[0].doc.title, "Persisted note");
	});
});

test("the John Doe scenario end to end: broad file name, alias rename, nothing lost", async () => {
	await withRuntime(async (runtime) => {
		// 1. He introduces himself.
		const john = await runtime.write({ topic: "John Doe", content: "John Doe is a backend engineer in Manila.", category: "people" });
		// 2. He mentions his father: the relation is a fact, so it lands in a broad topic note.
		const father = await runtime.write({
			topic: "John's father",
			content: "John's father is retired and lives in Cebu.",
			category: "people",
			label: "Father",
		});
		assert.equal(father.result.topicAdjusted, true);
		assert.equal(father.result.relPath, "library/people/people.md", "no johns-father.md is created");
		assert.equal(john.result.relPath, "library/people/john-doe.md");

		// 3. Later: the father has a name. The agent re-files the note and Bob
		//    becomes the topic, with the relation kept as an alias.
		const people = await runtime.readMemory(father.result.doc.id);
		assert.ok(people);
		const moved = await runtime.move(father.result.doc.id, { topic: "Bob" });
		assert.ok(moved);
		assert.equal(moved.result.moved, true);
		assert.equal(moved.result.doc.relPath, "library/people/bob.md");
		assert.equal(moved.result.merged, false);
		assert.deepEqual(moved.result.doc.aliases, ["People"], "the old topic (case-insensitive dedupe of topic and file base)");
		assert.ok(moved.result.doc.body.includes("John's father is retired"));

		// Nothing was lost and every handle still works: id, alias, new path.
		const byId = await runtime.readMemory(father.result.doc.id);
		assert.equal(byId?.doc.title, "Bob");
		const byAlias = await runtime.readMemory("People");
		assert.equal(byAlias?.doc.id, father.result.doc.id);
		const byPath = await runtime.readMemory("library/people/bob.md");
		assert.equal(byPath?.doc.id, father.result.doc.id);

		// The index follows the move: no stale entry at the old path.
		const index = await runtime.indexFor(runtime.roots.primary);
		assert.equal(index.idxForRelPath("library/people/people.md") >= 0, false);
		assert.equal(index.idxForRelPath("library/people/bob.md") >= 0, true);
		const recalled = await runtime.search("Bob");
		assert.ok(recalled.hits.some((hit) => hit.doc.relPath === "library/people/bob.md"));

		// A later write about Bob joins the same note instead of creating bob-2.md.
		const appended = await runtime.write({ topic: "Bob", content: "Bob plays chess on Sundays.", category: "people" });
		assert.equal(appended.result.merged, true);
		assert.equal(appended.result.relPath, "library/people/bob.md");
		assert.equal(appended.result.doc.id, father.result.doc.id);
	});
});

test("move keeps exactly one index entry per note and search stays consistent", async () => {
	await withRuntime(async (runtime) => {
		const created = await runtime.write({ topic: "Nightstand notes", content: "the lamp is too bright", category: "inbox" });
		const moved = await runtime.move(created.result.doc.id, { topic: "Bedroom", category: "home" });
		assert.ok(moved);
		assert.equal(moved.result.doc.relPath, "library/home/bedroom.md");
		const search = await runtime.search("lamp");
		assert.equal(search.hits.length, 1);
		assert.equal(search.hits[0].doc.relPath, "library/home/bedroom.md");
		// Reloading the index from disk agrees with the in-memory one.
		const fresh = new MemoryIndex(runtime.roots.primary);
		await fresh.load();
		assert.equal(fresh.liveDocs().length, 1);
	});
});

test("doctor flags relation-shaped file names and clashing aliases", async () => {
	await withRuntime(async (runtime) => {
		await mkdir(join(runtime.roots.primary, "library", "people"), { recursive: true });
		const legacy = join(runtime.roots.primary, "library", "people", "johns-father.md");
		await writeFile(
			legacy,
			["---", "id: mem_legacy_father", 'title: "John\'s father"', 'topic: "John\'s father"', "category: people", "tags: [family]", "summary: retired", "---", "", "# John's father", "", "- retired", ""].join("\n"),
			"utf8",
		);
		await writeFile(
			join(runtime.roots.primary, "library", "people", "dad.md"),
			["---", "id: mem_dad", "title: Dad", "topic: Dad", "category: people", "tags: [family]", "summary: dad", "---", "", "# Dad", "", "- retired", ""].join("\n"),
			"utf8",
		);
		const findings = await runtime.doctor();
		assert.ok(
			findings.some((finding) => finding.includes("johns-father.md") && finding.includes("memoria_move")),
			`expected a relation finding, got: ${findings.join(" | ")}`,
		);
		assert.ok(findings.some((finding) => finding.includes("dad.md")), `expected dad.md to be flagged, got: ${findings.join(" | ")}`);
	});
});

/* ------------------------------------------------------------------ */
/* Usage tracking, caching and reranking                               */
/* ------------------------------------------------------------------ */

test("recall records usage, persists it, and refreshes last_used at most lazily", async () => {
	await withRuntime(async (runtime) => {
		const { result } = await runtime.write({ topic: "Editor preferences", content: "Prefers four-space indentation.", category: "preferences" });
		const file = join(runtime.roots.primary, result.doc.relPath);
		// Simulate an old note that was never retrieved: no last_used stamp and an
		// updated date in the past, so the lazy touch has work to do.
		const raw = await readFile(file, "utf8");
		const aged = raw
			.replace(/^last_used:.*\n/m, "")
			.replace(/^created:.*$/m, "created: 2020-01-01T00:00:00.000Z")
			.replace(/^updated:.*$/m, "updated: 2020-01-01T00:00:00.000Z");
		await writeFile(file, aged, "utf8");
		await runtime.reconfigure({ ...runtime.config, lastUsedWriteIntervalMs: 60_000 });

		await runtime.search("indentation preferences");
		await runtime.flushUsageNow();

		const usageRaw = await readFile(join(runtime.roots.primary, ".index", "usage.json"), "utf8");
		const usage = JSON.parse(usageRaw) as { docs: Record<string, { hits: number }> };
		assert.ok((usage.docs[result.doc.id]?.hits ?? 0) >= 1, "the hit is recorded");
		const reread = await readFile(file, "utf8");
		assert.match(reread, /^last_used: \d+$/m, "last_used is written back for used notes");
		// The note must not look edited just because it was read.
		assert.ok(reread.includes("updated: 2020-01-01T00:00:00.000Z"), "updated is untouched by reads");
	});
});

test("the search cache returns cached results and is dropped on the next write", async () => {
	await withRuntime(async (runtime) => {
		await runtime.write({ topic: "Nightingale", content: "Nightingale uses Postgres with pgvector.", category: "projects" });
		const first = await runtime.search("pgvector");
		const second = await runtime.search("pgvector");
		assert.equal(second.cached, true, "the second identical query hits the cache");
		assert.equal(second.hits[0].doc.id, first.hits[0].doc.id);
		await runtime.write({ topic: "Analytics", content: "Analytics also uses pgvector for embeddings.", category: "projects" });
		const third = await runtime.search("pgvector");
		assert.notEqual(third.cached, true, "a write invalidates the cache");
		assert.equal(third.hits.length, 2);
	});
});

test("an optional reranker can reorder hits and never breaks recall on failure", async () => {
	await withRuntime(async (runtime) => {
		const a = await runtime.write({ topic: "Alpha notes", content: "The alpha subsystem talks to beta.", category: "knowledge" });
		const b = await runtime.write({ topic: "Beta notes", content: "The beta subsystem answers alpha.", category: "knowledge" });
		const baseline = await runtime.recall("subsystem");
		assert.equal(baseline.reranked, undefined);

		runtime.config = { ...runtime.config, rerank: true };
		runtime.setReranker(async (_query, hits) => hits.map((hit) => hit.doc.id).reverse());
		const reordered = await runtime.recall("subsystem");
		assert.equal(reordered.reranked, true);
		assert.equal(reordered.hits[0].doc.id, baseline.hits[1].doc.id);

		// A broken reranker must fall back to the lexical order.
		runtime.setReranker(async () => {
			throw new Error("model exploded");
		});
		const fallback = await runtime.recall("subsystem");
		assert.notEqual(fallback.reranked, true);
		assert.deepEqual(
			fallback.hits.map((hit) => hit.doc.id),
			baseline.hits.map((hit) => hit.doc.id),
		);
		assert.ok([a.result.doc.id, b.result.doc.id].includes(fallback.hits[0].doc.id));
	});
});

test("similarNotes flags a duplicate subject cheaply", async () => {
	await withRuntime(async (runtime) => {
		const bob = await runtime.write({
			topic: "Bob",
			content: "He is a retired teacher who lives in Cebu.",
			category: "people",
		});
		const robert = await runtime.write({
			topic: "Robert",
			content: "A retired teacher living in Cebu who plays chess.",
			category: "people",
			aliases: ["Bob"],
		});
		const similar = await runtime.similarNotes(bob.result.doc.id, 3, "primary");
		assert.ok(
			similar.some((entry) => entry.id === robert.result.doc.id),
			`expected Robert to be flagged as similar: ${JSON.stringify(similar)}`,
		);
		assert.ok((similar[0].shared.length ?? 0) >= 2);
		assert.equal(similar[0].linked, true);
		// A different person who happens to share the paragraph is not flagged.
		const cebuNeighbour = await runtime.write({
			topic: "Maria",
			content: "A retired teacher living in Cebu who also plays chess on Sundays.",
			category: "people",
		});
		const maria = await runtime.similarNotes(cebuNeighbour.result.doc.id, 3, "primary");
		assert.equal(maria.some((entry) => entry.id === bob.result.doc.id), false, "shared paragraphs alone are not a duplicate signal");
	});
});

test("repeated writes and doctor power the promotion and health reports", async () => {
	await withRuntime(async (runtime) => {
		const note = await runtime.write({ topic: "Hard constraints", content: "Never force-push to main.", category: "preferences", priority: "high" });
		await runtime.write({ topic: "Hard constraints", content: "Never commit secrets.", category: "preferences", priority: "high" });
		await runtime.write({ topic: "Hard constraints", content: "Always run the full test suite before tagging.", category: "preferences", priority: "high" });
		const promotions = await runtime.promotionCandidates(5, "primary");
		assert.ok(promotions.some((entry) => entry.id === note.result.doc.id), "three writes make a promotion candidate");
		await runtime.hotAdd("Never force-push to main and never commit secrets.", "constraints");
		const afterHot = await runtime.promotionCandidates(5, "primary");
		assert.equal(afterHot.some((entry) => entry.id === note.result.doc.id), false, "a note already in MEMORY.md is not suggested again");
		const report = await runtime.health();
		assert.ok(Array.isArray(report.findings));
	});
});

test("export and import round-trip notes and MEMORY.md between stores", async () => {
	await withRuntime(async (runtime) => {
		const note = await runtime.write({
			topic: "Migration plan",
			content: "Step one is to freeze writes.",
			category: "projects",
			tags: ["migration"],
			aliases: ["Big move"],
		});
		await runtime.hotAdd("The user is migrating the platform in Q3.", "migration");
		const { jsonl, notes } = await runtime.exportJsonl({ scope: "primary" });
		assert.equal(notes, 1);
		assert.ok(jsonl.includes("memoria"));

		const otherHome = await mkdtemp(join(tmpdir(), "memoria-home2-"));
		const other = new MemoriaRuntime("/tmp", { home: otherHome, agentDir: join(otherHome, ".pi", "agent") });
		try {
			await other.init(true);
			const imported = await other.importJsonl(jsonl, { mode: "merge", scope: "primary" });
			assert.equal(imported.created.length, 1);
			assert.equal(imported.hotImported, true);
			const found = await other.readMemory(note.result.doc.id, "primary");
			assert.ok(found, "the imported note keeps its id");
			assert.ok(found!.doc.body.includes("freeze writes"));
			assert.deepEqual(found!.doc.aliases, ["Big move"]);
			const hot = await other.hotState();
			assert.ok(hot.content.includes("migrating the platform"));
			// Importing the same dump again is a no-op, not a duplicate.
			const again = await other.importJsonl(jsonl, { mode: "merge", scope: "primary" });
			assert.equal(again.created.length, 0);
			assert.equal(again.skipped, 1);
			// A dry run must not write anything.
			const dry = await other.importJsonl(jsonl.replace(/Step one/, "Step two"), { mode: "merge", dryRun: true });
			assert.deepEqual(dry.created, []);
		} finally {
			await other.dispose();
			await rm(otherHome, { recursive: true, force: true });
		}
	});
});

test("an interrupted move is repaired from the journal on the next start", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "memoria-journal-cwd-"));
	const home = await mkdtemp(join(tmpdir(), "memoria-journal-home-"));
	const runtime = new MemoriaRuntime(cwd, { home, agentDir: join(home, ".pi", "agent") });
	try {
		await runtime.init(true);
		const written = await runtime.write({ topic: "Deploy window", content: "Deploys happen on Thursdays.", category: "workflows" });
		const root = runtime.roots.primary;
		const source = join(root, written.result.doc.relPath);
		const targetRel = "library/workflows/release-window.md";
		const target = join(root, targetRel);
		// Simulate a crash after the target was written but before the trash move.
		await writeFile(target, await readFile(source, "utf8"), "utf8");
		await writeFile(
			join(root, ".index", "journal.json"),
			JSON.stringify({ op: "move", from: written.result.doc.relPath, to: targetRel, at: Date.now() }),
			"utf8",
		);
		await runtime.dispose();

		const restarted = new MemoriaRuntime(cwd, { home, agentDir: join(home, ".pi", "agent") });
		try {
			await restarted.init(true);
			assert.equal(existsSync(source), false, "the stale source file was trashed");
			assert.equal(existsSync(target), true, "the target survives");
			const stats = await restarted.stats();
			assert.ok((stats.recovered ?? []).some((line) => line.includes("interrupted move")), `stats should report the repair: ${JSON.stringify(stats.recovered)}`);
			assert.equal(existsSync(join(root, ".index", "journal.json")), false, "the journal is cleared");
		} finally {
			await restarted.dispose();
		}
	} finally {
		await runtime.dispose().catch(() => {});
		await rm(cwd, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});

test("sessionDelta reports what changed since the previous session", async () => {
	await withRuntime(async (runtime) => {
		// Session markers have millisecond resolution, so leave a gap around each
		// marker: a note written in the same millisecond belongs to *both* sessions
		// (better a duplicate notification than a missed one).
		const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
		// First session: no previous marker, nothing to report.
		assert.equal(await runtime.sessionDelta(5), undefined);
		await runtime.flushUsageNow();
		await tick();
		const note = await runtime.write({ topic: "Release window", content: "Releases go out on Tuesdays.", category: "workflows" });
		const delta = await runtime.sessionDelta(5);
		assert.ok(delta, "a recorded session marker enables the summary");
		assert.equal(delta!.created.length, 1);
		assert.equal(delta!.created[0].id, note.result.doc.id);
		assert.deepEqual(delta!.updated, []);
		// A quiet session reports nothing.
		await tick();
		await runtime.sessionDelta(5);
		await tick();
		const quiet = await runtime.sessionDelta(5);
		assert.equal(quiet!.created.length, 0);
		assert.equal(quiet!.updated.length, 0);
	});
});
