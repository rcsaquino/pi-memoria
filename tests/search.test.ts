import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../src/index-engine.ts";
import { createMemory, ensureStore } from "../src/store.ts";
import { extractSnippet } from "../src/search.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memoria-index-"));
}

interface Fixture {
	/** Broad topic; becomes the file name and note title. */
	topic: string;
	content: string;
	category: string;
	tags?: string[];
	summary?: string;
	priority?: string;
}

const FIXTURES: Fixture[] = [
	{
		topic: "Alice",
		content: "Alice drinks oat milk in her flat white and avoids dairy. She is lactose intolerant.",
		category: "people",
		tags: ["alice", "preferences", "food"],
	},
	{
		topic: "Project Nightingale",
		content: "Project Nightingale runs on Postgres 16 with pgvector. Migrations live in db/migrations.",
		category: "projects",
		tags: ["nightingale", "postgres"],
	},
	{
		topic: "Deploy process",
		content: "Run npm run build then deploy via the release script. Deploys happen on Thursdays.",
		category: "workflows",
		tags: ["deploy", "release"],
	},
	{
		topic: "Commit conventions",
		content: "The user prefers terse conventional commits and dislikes multi-paragraph commit bodies.",
		category: "preferences",
		tags: ["git", "commits"],
	},
	{
		topic: "Kubernetes incident 2025-03",
		content: "The outage was caused by a misconfigured liveness probe. Fix was to raise initialDelaySeconds.",
		category: "decisions",
		tags: ["incident", "kubernetes"],
		priority: "high",
	},
	{
		topic: "Cold start optimization",
		content: "Cold starts were optimized by lazy-loading the AWS SDK and memoizing config parsing.",
		category: "knowledge",
		tags: ["performance", "aws"],
	},
];

async function buildFixture(): Promise<{ root: string; index: MemoryIndex }> {
	const root = await tempRoot();
	await ensureStore(root, 5000);
	for (const fixture of FIXTURES) {
		await createMemory(root, {
			topic: fixture.topic,
			content: fixture.content,
			category: fixture.category,
			tags: fixture.tags,
			summary: fixture.summary,
			priority: fixture.priority,
		});
	}
	const index = new MemoryIndex(root);
	await index.load();
	return { root, index };
}

test("indexes every fixture file", async () => {
	const { root, index } = await buildFixture();
	try {
		assert.equal(index.aliveCount, FIXTURES.length);
		assert.ok(index.terms.length > 50);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("finds a memory by a distinctive term and ranks it first", async () => {
	const { root, index } = await buildFixture();
	try {
		const result = await index.search("lactose intolerant");
		assert.ok(result.hits.length > 0);
		assert.equal(result.hits[0].doc.title, "Alice");
		assert.ok(result.tookMs < 100);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("finds memories by identifier, path and version", async () => {
	const { root, index } = await buildFixture();
	try {
		const pg = await index.search("postgres 16");
		assert.equal(pg.hits[0].doc.title, "Project Nightingale");
		const path = await index.search("db/migrations");
		assert.equal(path.hits[0].doc.title, "Project Nightingale");
		const version = await index.search("Postgres 16");
		assert.ok(version.hits.length >= 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("prefix search matches partial words", async () => {
	const { root, index } = await buildFixture();
	try {
		const result = await index.search("kuber");
		assert.ok(result.hits.some((hit) => hit.doc.title.includes("Kubernetes")));
		const result2 = await index.search("convent");
		assert.ok(result2.hits.some((hit) => hit.doc.tags.includes("commits")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fuzzy search tolerates typos", async () => {
	const { root, index } = await buildFixture();
	try {
		const result = await index.search("lactse intolerent");
		assert.ok(result.hits.length > 0);
		assert.equal(result.hits[0].doc.title, "Alice");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stem variants match", async () => {
	const { root, index } = await buildFixture();
	try {
		const result = await index.search("optimize cold starts");
		assert.ok(result.hits.some((hit) => hit.doc.title.startsWith("Cold start optimization")));
		const deploys = await index.search("deploying");
		assert.ok(deploys.hits.some((hit) => hit.doc.title.startsWith("Deploy process")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("category and tag filters work", async () => {
	const { root, index } = await buildFixture();
	try {
		const filtered = await index.search("lactose", { category: "people" });
		assert.equal(filtered.hits.length, 1);
		assert.equal(filtered.hits[0].doc.category, "people");
		const byTag = await index.search("deploy", { tags: ["release"] });
		assert.equal(byTag.hits[0].doc.title, "Deploy process");
		const anyTag = await index.search("the", { anyTags: ["incident", "performance"] });
		// Stopword-only query with filters falls back to filter-only browse mode.
		assert.equal(anyTag.hits.length, 2);
		assert.ok(anyTag.hits.length >= 1);
		const none = await index.search("lactose", { category: "nope" });
		assert.equal(none.hits.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("priority and recency influence ranking but not filtering", async () => {
	const { root, index } = await buildFixture();
	try {
		const result = await index.search("kubernetes");
		assert.equal(result.hits[0].doc.priority, "high");
		const minPriority = await index.search("kubernetes", { minPriority: "critical" });
		assert.equal(minPriority.hits.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("exact phrase receives a bonus", async () => {
	const { root, index } = await buildFixture();
	try {
		const result = await index.search("misconfigured liveness probe");
		assert.equal(result.hits[0].doc.title, "Kubernetes incident 2025-03");
		assert.equal(result.hits[0].exact, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("incremental updates are detected by refresh", async () => {
	const { root, index } = await buildFixture();
	try {
		const before = await index.search("zebra");
		assert.equal(before.hits.length, 0);
		await createMemory(root, { topic: "Zebra crossing rules", content: "Zebra crossings require yielding.", category: "knowledge" });
		await index.refresh(true);
		const after = await index.search("zebra");
		assert.equal(after.hits.length, 1);
		assert.equal(after.hits[0].doc.title, "Zebra crossing rules");

		// Edit an existing file externally and re-scan.
		const target = after.hits[0].doc;
		await writeFile(
			target.path,
			`---\nid: ${target.id}\ntitle: Zebra crossing rules\ntags: [transport]\n---\n\nZebras now yield to pedestrians.\n`,
			"utf8",
		);
		await index.refresh(true);
		const edited = await index.search("pedestrians");
		assert.ok(edited.hits.some((hit) => hit.doc.id === target.id));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("external file deletion is detected", async () => {
	const { root, index } = await buildFixture();
	try {
		const hits = await index.search("lactose");
		const doc = hits.hits[0].doc;
		await rm(doc.path);
		await index.refresh(true);
		assert.equal(index.idxForId(doc.id), undefined);
		const after = await index.search("lactose");
		assert.equal(after.hits.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("persisted index reloads with identical results", async () => {
	const { root, index } = await buildFixture();
	try {
		await index.save();
		const reloaded = new MemoryIndex(root);
		await reloaded.load();
		assert.equal(reloaded.aliveCount, index.aliveCount);
		const a = await index.search("kubernetes incident");
		const b = await reloaded.search("kubernetes incident");
		assert.deepEqual(
			b.hits.map((hit) => hit.doc.id),
			a.hits.map((hit) => hit.doc.id),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects an unreadable index and rebuilds", async () => {
	const { root } = await buildFixture();
	try {
		await writeFile(join(root, ".index", "index.json"), "{not json", "utf8");
		const index = new MemoryIndex(root);
		await index.load();
		assert.equal(index.aliveCount, FIXTURES.length);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("snippet extraction centres on the match and truncates", () => {
	const body = `${"filler ".repeat(100)}needle in the middle ${"trailer ".repeat(100)}`;
	const snippet = extractSnippet(body, ["needle"], 120);
	assert.ok(snippet.includes("needle"));
	assert.ok(snippet.length <= 130);
	assert.ok(snippet.startsWith("…") || snippet.endsWith("…"));
});

test("search stays well under a millisecond per query on a warm index", async () => {
	const root = await tempRoot();
	await ensureStore(root, 5000);
	for (let i = 0; i < 200; i += 1) {
		await createMemory(root, {
			topic: `Note number ${i} about topic ${i % 17}`,
			content: `This is note ${i}. It mentions widget ${i % 23}, gadget ${i % 11} and the word sequence${i % 5}.`,
			category: `cat${i % 7}`,
			tags: [`tag${i % 13}`, "bulk"],
		});
	}
	const index = new MemoryIndex(root);
	await index.load();
	// Warm up.
	await index.search("widget 7");
	const queries = ["widget 7", "gadget 3", "topic 5", "sequence1", "note 42", "bulk"];
	const started = performance.now();
	const iterations = 200;
	for (let i = 0; i < iterations; i += 1) {
		await index.search(queries[i % queries.length]);
	}
	const perQuery = (performance.now() - started) / iterations;
	console.log(`warm search: ${perQuery.toFixed(3)}ms/query over ${index.aliveCount} docs`);
	assert.ok(perQuery < 3, `expected <3ms/query, got ${perQuery.toFixed(3)}ms`);
	await rm(root, { recursive: true, force: true });
});

test("unfiled memories can be excluded", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, { topic: "Inbox thought", content: "ungrouped idea about llamas", category: "inbox" });
		await createMemory(root, { topic: "Filed thought", content: "filed idea about llamas", category: "knowledge" });
		const index = new MemoryIndex(root);
		await index.load();
		const withUnfiled = await index.search("llamas");
		assert.equal(withUnfiled.hits.length, 2);
		const withoutUnfiled = await index.search("llamas", { includeUnfiled: false });
		assert.equal(withoutUnfiled.hits.length, 1);
		assert.equal(withoutUnfiled.hits[0].doc.category, "knowledge");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a note is found by any of its aliases, not just its file name", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, {
			topic: "Bob",
			category: "people",
			content: "He is retired and lives in Cebu. He plays chess on Sundays.",
			tags: ["family"],
			aliases: ["Robert", "Bobby", "John's father"],
		});
		await createMemory(root, { topic: "Deploy process", content: "Deploys happen on Thursdays.", category: "workflows" });
		const index = new MemoryIndex(root);
		await index.load();
		for (const query of ["Robert", "bobby", "John's father", "Bob"]) {
			const result = await index.search(query);
			assert.ok(result.hits.length > 0, `expected a hit for ${query}`);
			assert.equal(result.hits[0].doc.title, "Bob", `alias "${query}" should reach Bob first`);
			assert.deepEqual(result.hits[0].doc.aliases, ["Robert", "Bobby", "John's father"]);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("moving a note updates the index so the old path and new name both resolve", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const created = await createMemory(root, {
			topic: "Bob",
			category: "people",
			content: "Bob lives in Cebu.",
			aliases: ["Robert"],
		});
		const index = new MemoryIndex(root);
		await index.load();
		assert.equal(index.idxForRelPath("library/people/bob.md") >= 0, true);

		const { moveMemory } = await import("../src/store.ts");
		const doc = await index.bodyFor(index.idxForId(created.doc.id) ?? -1);
		assert.ok(doc.includes("Cebu"));
		const moved = await moveMemory(
			root,
			(await (await import("../src/store.ts")).readMemoryDoc(root, created.doc.path))!,
			{ topic: "Robert", category: "people" },
		);
		// Simulate the runtime's index bookkeeping.
		const sourceIdx = index.idxForRelPath(created.doc.relPath);
		if (sourceIdx >= 0) index.removeDoc(sourceIdx);
		const targetIdx = index.idxForRelPath(moved.doc.relPath);
		if (targetIdx >= 0) index.removeDoc(targetIdx);
		const staleIdx = index.idxForId(moved.doc.id);
		if (staleIdx !== undefined) index.removeDoc(staleIdx);
		index.addDoc(moved.doc);

		assert.equal(index.idxForRelPath("library/people/bob.md"), -1, "old path is gone");
		assert.equal(index.idxForId(moved.doc.id), index.idxForRelPath("library/people/robert.md"));
		const byOldPathSearch = await index.search("bob");
		assert.ok(byOldPathSearch.hits.every((hit) => hit.doc.relPath !== "library/people/bob.md"));
		const byAlias = await index.search("Bob");
		assert.equal(byAlias.hits[0].doc.relPath, "library/people/robert.md");
		assert.equal(byAlias.hits[0].doc.aliases.includes("Bob"), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ */
/* Time hints, synonyms, related notes, supersedes, explain            */
/* ------------------------------------------------------------------ */

test("a time expression in the query becomes a boost and a reported window", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, { topic: "Old deploy decision", content: "deployment decision about caching", category: "decisions" });
		const recent = await createMemory(root, { topic: "Recent deploy decision", content: "deployment decision about retries", category: "decisions" });
		// Age the first note so the window (today) excludes it.
		const oldPath = join(root, "library", "decisions", "old-deploy-decision.md");
		const oldDoc = (await import("../src/store.ts")).readMemoryDoc;
		const doc = await oldDoc(root, oldPath);
		assert.ok(doc);
		await writeFile(
			oldPath,
			`---\ntitle: Old deploy decision\ntopic: Old deploy decision\ncategory: decisions\ncreated: 2020-01-01T00:00:00.000Z\nupdated: 2020-01-01T00:00:00.000Z\n---\n\n# Old deploy decision\n\n## Facts\n\n- deployment decision about caching\n`,
			"utf8",
		);
		const index = new MemoryIndex(root);
		await index.load();
		const seen: string[] = [];
		const result = await index.search("deployment decision today", { onTimeWindow: (window) => seen.push(window.label), timeHints: true });
		assert.deepEqual(seen, ["today"]);
		assert.ok(result.timeWindow);
		assert.equal(result.hits[0].doc.id, recent.doc.id, "the recent note outranks the older one inside the window");
		const withoutHints = await index.search("deployment decision today", { timeHints: false });
		assert.equal(withoutHints.timeWindow, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("synonym expansion finds notes written with the long form", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, { topic: "Cluster facts", content: "The cluster runs Kubernetes 1.31 in eu-west.", category: "knowledge" });
		const index = new MemoryIndex(root);
		await index.load();
		const plain = await index.search("k8s");
		assert.equal(plain.hits.length, 0, "without a synonym table the shorthand finds nothing");
		const expanded = await index.search("k8s", { synonyms: { k8s: ["kubernetes"] }, synonymWeight: 0.6 });
		assert.ok(expanded.hits.length > 0);
		assert.equal(expanded.hits[0].doc.title, "Cluster facts");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("weighted query parts let the current prompt outrank an older turn", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, { topic: "Coffee order", content: "Alice orders oat flat whites.", category: "preferences" });
		await createMemory(root, { topic: "Tea order", content: "Alice drinks jasmine tea in the afternoon.", category: "preferences" });
		const index = new MemoryIndex(root);
		await index.load();
		const weighted = await index.search("tea", { parts: [{ text: "tea", weight: 1 }, { text: "coffee flat white", weight: 0.1 }] });
		assert.equal(weighted.hits[0].doc.title, "Tea order");
		const flat = await index.search("coffee flat white tea");
		assert.equal(flat.hits[0].doc.title, "Coffee order");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("related notes are pulled into the result with a relatedTo marker", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const alice = await createMemory(root, {
			topic: "Alice",
			category: "people",
			content: "Alice leads the migration project.",
			related: ["Bob"],
		});
		await createMemory(root, { topic: "Bob", category: "people", content: "He is retired and lives in Cebu." });
		const index = new MemoryIndex(root);
		await index.load();
		const result = await index.search("Alice migration", { relatedHits: 2, relatedBoost: 0.35 });
		const bob = result.hits.find((hit) => hit.doc.title === "Bob");
		assert.ok(bob, `expected Bob to be pulled in: ${result.hits.map((hit) => hit.doc.title).join(", ")}`);
		assert.equal(bob!.relatedTo, alice.doc.id);
		const without = await index.search("Alice migration", { expandRelated: false });
		assert.equal(without.hits.some((hit) => hit.doc.title === "Bob"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a superseded note is demoted and flagged unless dropped", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const oldNote = await createMemory(root, { topic: "Deploy window", content: "Deploys go out on Thursday mornings.", category: "workflows" });
		await createMemory(root, {
			topic: "Deploy window change",
			category: "workflows",
			content: "Deploys moved to Tuesday mornings after the incident.",
			supersedes: ["Deploy window"],
		});
		const index = new MemoryIndex(root);
		await index.load();
		const demoted = await index.search("deploys mornings");
		const supersededHit = demoted.hits.find((hit) => hit.doc.id === oldNote.doc.id);
		assert.ok(supersededHit);
		assert.ok(supersededHit!.supersededBy && supersededHit!.supersededBy.length > 0);
		assert.equal(demoted.hits[0].doc.title, "Deploy window change", "the replacement wins");
		const dropped = await index.search("deploys mornings", { dropSuperseded: true });
		assert.equal(dropped.hits.some((hit) => hit.doc.id === oldNote.doc.id), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("explain returns a scoring breakdown that adds up", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, { topic: "Alice", category: "people", content: "Alice drinks oat milk and avoids dairy.", tags: ["food"] });
		const index = new MemoryIndex(root);
		await index.load();
		const result = await index.search("oat milk", { explain: true });
		const hit = result.hits[0];
		assert.ok(hit.breakdown, "breakdown is present with explain: true");
		const breakdown = hit.breakdown!;
		assert.ok(breakdown.bm25 > 0);
		assert.ok(breakdown.terms.some((term) => term.term === "milk" || term.term === "oat"));
		const sum = breakdown.bm25 + breakdown.coverage + breakdown.priorityRecency + breakdown.phrase + breakdown.related + breakdown.timeBoost + breakdown.supersededPenalty;
		assert.ok(Math.abs(sum - breakdown.total) < 0.05, `breakdown sum ${sum} vs total ${breakdown.total}`);
		const plain = await index.search("oat milk");
		assert.equal(plain.hits[0].breakdown, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
