/**
 * Tests for the "housekeeping" modules: usage tracking, similarity, time
 * expressions, synonyms and JSONL transfer. All pure or filesystem-local.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore, describeAge } from "../src/usage.ts";
import { cosineSimilarity, jaccard, hasNegation, contentTokens, suggestMerges, detectContradictions, mergesFor, compareDocs, makeIdf, namesLinked, type SimilarityDoc } from "../src/similarity.ts";
import { parseTimeExpression } from "../src/timeexpr.ts";
import { normalizeSynonymTable, mergeSynonymTables, expandSynonymTable, loadSynonymsFile, synonymsFor, synonymsFileTemplate } from "../src/synonyms.ts";
import { decodeJsonl, encodeJsonl, sanitizeRelPath, writeImportedNote } from "../src/transfer.ts";
import { ensureStore, readMemoryDoc } from "../src/store.ts";

async function tempRoot(prefix = "memoria-knowledge-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

/* ------------------------------------------------------------------ */
/* Usage tracking                                                      */
/* ------------------------------------------------------------------ */

test("usage store records hits and writes and round-trips through disk", async () => {
	const root = await tempRoot();
	try {
		const store = new UsageStore(root);
		store.record("mem_a", "hit");
		store.record("mem_a", "hit");
		store.record("mem_a", "write");
		store.record("mem_b", "write");
		await store.save();
		const reloaded = await UsageStore.load(root);
		assert.equal(reloaded.get("mem_a")?.hits, 2);
		assert.equal(reloaded.get("mem_a")?.writes, 1);
		assert.equal(reloaded.get("mem_b")?.writes, 1);
		assert.equal(reloaded.get("mem_b")?.hits, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("usage store ignores corrupt files and prunes missing notes", async () => {
	const root = await tempRoot();
	try {
		await mkdir(join(root, ".index"), { recursive: true });
		await writeFile(join(root, ".index", "usage.json"), "{not json", "utf8");
		const store = await UsageStore.load(root);
		assert.equal(store.size, 0);
		store.record("mem_a", "hit");
		store.record("mem_b", "hit");
		const removed = store.prune(new Set(["mem_a"]));
		assert.equal(removed, 1);
		assert.equal(store.get("mem_b"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("usage store finds stale and promotion candidates", () => {
	const store = new UsageStore("/tmp/unused");
	const now = Date.now();
	store.record("mem_old", "hit", now - 400 * 86_400_000);
	store.record("mem_new", "hit", now);
	store.record("mem_hot", "write", now);
	store.record("mem_hot", "write", now);
	store.record("mem_hot", "write", now);
	assert.deepEqual(store.stale(365 * 86_400_000, now).map((entry) => entry.id), ["mem_old"]);
	assert.deepEqual(store.promotionCandidates(3).map((entry) => entry.id), ["mem_hot"]);
	assert.equal(describeAge(86_400_000), "1 day");
	assert.equal(describeAge(86_400_000 * 3), "3 days");
	assert.equal(describeAge(86_400_000 * 400), "13 months");
	assert.equal(describeAge(86_400_000 * 800), "2 years");
});

/* ------------------------------------------------------------------ */
/* Similarity                                                          */
/* ------------------------------------------------------------------ */

test("cosine and jaccard similarity behave", () => {
	assert.equal(cosineSimilarity({ a: 1 }, { a: 1 }), 1);
	assert.equal(cosineSimilarity({ a: 1 }, { b: 1 }), 0);
	assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
	assert.equal(jaccard(["a", "b"], ["c", "d"]), 0);
	assert.equal(jaccard(["a", "b"], ["a", "b", "c"]), 2 / 3);
});

test("negation detection and content tokens", () => {
	assert.ok(hasNegation("Deploys no longer happen on Thursdays"));
	assert.ok(hasNegation("The user dislikes dark mode"));
	assert.ok(!hasNegation("Deploys happen on Thursdays"));
	const tokens = contentTokens(["deploys", "not", "thursdays", "a"]);
	assert.deepEqual(tokens, ["deploys", "thursdays"]);
});

test("suggestMerges finds the same subject in two notes but not unrelated ones", () => {
	const docs: SimilarityDoc[] = [
		{
			id: "mem_father",
			title: "Johns father",
			relPath: "library/people/johns-father.md",
			category: "people",
			tokens: { john: 3, father: 4, retired: 3, teacher: 3, cebu: 3, lives: 1, city: 1 },
		},
		{
			id: "mem_bob",
			title: "Bob",
			relPath: "library/people/bob.md",
			category: "people",
			tokens: { bob: 4, father: 3, retired: 3, teacher: 3, cebu: 3, john: 2 },
		},
		{
			id: "mem_deploy",
			title: "Deploy process",
			relPath: "library/workflows/deploy-process.md",
			category: "workflows",
			tokens: { deploy: 4, process: 3, thursday: 3, release: 3, script: 2 },
		},
	];
	const suggestions = suggestMerges(docs, { threshold: 0.5 });
	assert.equal(suggestions.length, 1);
	assert.deepEqual([suggestions[0].a.id, suggestions[0].b.id].sort(), ["mem_bob", "mem_father"]);
	assert.ok(suggestions[0].shared.includes("teacher"));
	assert.equal(mergesFor(suggestions, "mem_bob").length, 1);
	assert.equal(mergesFor(suggestions, "mem_deploy").length, 0);
});

test("detectContradictions pairs opposite-polarity facts", () => {
	const units = [
		{ id: "mem_a", relPath: "library/workflows/deploys.md", text: "Deploys happen on Thursday mornings." },
		{ id: "mem_b", relPath: "library/workflows/release.md", text: "Deploys no longer happen on Thursday mornings." },
		{ id: "mem_c", relPath: "library/knowledge/unrelated.md", text: "The office coffee machine is on floor three." },
	];
	const contradictions = detectContradictions(units);
	assert.equal(contradictions.length, 1);
	assert.deepEqual([contradictions[0].a.id, contradictions[0].b.id].sort(), ["mem_a", "mem_b"]);
	assert.ok(contradictions[0].shared.includes("deploys"));
});

/* ------------------------------------------------------------------ */
/* Time expressions                                                    */
/* ------------------------------------------------------------------ */

test("time expressions parse into windows", () => {
	const now = Date.UTC(2026, 8, 24, 12);
	const day = 86_400_000;
	const today = parseTimeExpression("what did we do today?", now);
	assert.ok(today);
	assert.ok(today!.since! <= now && today!.until! >= now);
	assert.equal(parseTimeExpression("nothing temporal here", now), undefined);
	const yesterday = parseTimeExpression("what happened yesterday", now)!;
	assert.equal(yesterday.until! - yesterday.since!, day);
	const count = parseTimeExpression("summarise the last 3 days", now)!;
	assert.equal(Math.round((count.until! - count.since!) / day), 3);
	const week = parseTimeExpression("what did we deploy last week", now)!;
	assert.ok(week.until! - week.since! === 7 * day, `week window was ${(week.until! - week.since!) / day} days`);
	assert.equal(week.until! <= now, true);
	const month = parseTimeExpression("decisions in March 2024", now)!;
	// Windows are local-calendar based, so compare in local time.
	assert.equal(new Date(month.since!).getMonth(), 2);
	assert.equal(new Date(month.since!).getFullYear(), 2024);
	const quarter = parseTimeExpression("what shipped this quarter", now)!;
	assert.ok(quarter.since! <= now);
});

/* ------------------------------------------------------------------ */
/* Synonyms                                                            */
/* ------------------------------------------------------------------ */

test("synonym tables normalize, merge and expand symmetrically", () => {
	const table = normalizeSynonymTable({ K8s: ["Kubernetes", "k8s"], empty: [] });
	assert.deepEqual(table, { k8s: ["kubernetes"] });
	const merged = mergeSynonymTables({ k8s: ["kubernetes"] }, { kubernetes: ["kube"] });
	const expanded = expandSynonymTable(merged);
	assert.deepEqual(new Set(expanded.k8s), new Set(["kubernetes"]));
	assert.ok(expanded.kubernetes.includes("k8s"));
	assert.ok(expanded.kube.includes("kubernetes"));
	assert.deepEqual(synonymsFor(expanded, "k8s"), ["kubernetes"]);
	assert.equal(synonymsFor(expanded, "missing").length, 0);
	assert.ok(synonymsFileTemplate().includes("kubernetes"));
});

test("loadSynonymsFile reads a store file and tolerates junk", async () => {
	const root = await tempRoot();
	try {
		assert.deepEqual(await loadSynonymsFile(root), {});
		await writeFile(join(root, "synonyms.json"), '{"pg": ["postgres"]}', "utf8");
		assert.deepEqual(await loadSynonymsFile(root), { pg: ["postgres"] });
		await writeFile(join(root, "synonyms.json"), "oops", "utf8");
		assert.deepEqual(await loadSynonymsFile(root), {});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ */
/* JSONL transfer                                                      */
/* ------------------------------------------------------------------ */

test("sanitizeRelPath rejects traversal and non-library paths", () => {
	assert.equal(sanitizeRelPath("library/people/alice.md"), "library/people/alice.md");
	assert.equal(sanitizeRelPath("/etc/passwd"), undefined);
	assert.equal(sanitizeRelPath("library/../../etc/passwd.md"), undefined);
	assert.equal(sanitizeRelPath("library/.hidden/x.md"), undefined);
	assert.equal(sanitizeRelPath("MEMORY.md"), undefined);
	assert.equal(sanitizeRelPath("library/people/alice.txt"), undefined);
	assert.equal(sanitizeRelPath("library/INDEX.md"), undefined);
	assert.equal(sanitizeRelPath("library/people\\alice.md"), "library/people/alice.md");
});

test("jsonl encode/decode round-trips and reports bad lines", () => {
	const line = encodeJsonl({
		type: "memory",
		id: "mem_1_ab",
		relPath: "library/people/alice.md",
		title: "Alice",
		category: "people",
		tags: ["a"],
		aliases: ["Alice Smith"],
		related: [],
		supersedes: [],
		summary: "s",
		priority: "high",
		confidence: "medium",
		body: "# Alice\n\nLikes tea.",
	});
	const hot = encodeJsonl({ type: "hot", content: "# Memory\n\nAlice likes tea." });
	const { records, errors } = decodeJsonl(`${line}\n${hot}\nnot json\n{"type":"mystery"}\n`);
	assert.equal(records.length, 2);
	assert.equal(errors.length, 2);
	const memory = records[0];
	assert.equal(memory.type, "memory");
	if (memory.type === "memory") {
		assert.equal(memory.id, "mem_1_ab");
		assert.equal(memory.priority, "high");
		assert.deepEqual(memory.aliases, ["Alice Smith"]);
	}
	assert.equal(records[1].type, "hot");
});

test("writeImportedNote preserves ids and never overwrites another note", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000, "inbox");
		const base = {
			relPath: "library/people/alice.md",
			title: "Alice",
			category: "people",
			tags: ["alice"],
			aliases: [],
			related: [],
			supersedes: [],
			summary: "Alice facts",
			priority: "normal",
			confidence: "medium",
			body: "# Alice\n\nLikes tea.",
		};
		const first = await writeImportedNote(root, { ...base, id: "mem_import_1" });
		assert.equal(first.id, "mem_import_1");
		assert.equal(first.relPath, "library/people/alice.md");
		// A different id at the same path must land in a sibling file.
		const second = await writeImportedNote(root, { ...base, id: "mem_import_2" });
		assert.equal(second.id, "mem_import_2");
		assert.notEqual(second.relPath, first.relPath);
		const reread = await readMemoryDoc(root, first.path);
		assert.equal(reread?.id, "mem_import_1");
		assert.ok(reread?.body.includes("Likes tea."));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a name link needs more than a shared word", () => {
	const john: SimilarityDoc = { id: "j", title: "John Doe", relPath: "library/people/john-doe.md", category: "people", aliases: [], tokens: {} };
	const bob: SimilarityDoc = {
		id: "b",
		title: "Bob",
		relPath: "library/people/bob.md",
		category: "people",
		aliases: ["John Doe's father", "John's father", "dad"],
		tokens: {},
	};
	const alice: SimilarityDoc = { id: "a", title: "Alice", relPath: "library/people/alice.md", category: "people", aliases: [], tokens: {} };
	const aliceSmith: SimilarityDoc = { id: "as", title: "Alice Smith", relPath: "library/people/alice-smith.md", category: "people", aliases: [], tokens: {} };
	const nightingale: SimilarityDoc = { id: "n", title: "Project Nightingale", relPath: "library/projects/project-nightingale.md", category: "projects", aliases: [], tokens: {} };
	const nightingaleDb: SimilarityDoc = { id: "nd", title: "Nightingale", relPath: "library/projects/nightingale.md", category: "projects", aliases: [], tokens: {} };
	const legacyFather: SimilarityDoc = { id: "lf", title: "Johns father", relPath: "library/people/johns-father.md", category: "people", aliases: [], tokens: {} };

	assert.equal(namesLinked(john, bob), false, "a person and their parent are not the same note");
	assert.equal(namesLinked(alice, aliceSmith), true, "a shorter full name is the same subject");
	assert.equal(namesLinked(nightingale, nightingaleDb), true, "a suffix name is the same subject");
	assert.equal(namesLinked(legacyFather, bob), true, "the legacy relation name is listed as an alias");
});

test("two people who share a paragraph are not reported as duplicates", () => {
	// The live-session regression: John's note says "my father is Bob, retired in
	// Cebu" and Bob's note says the same, but they are two different people.
	const john: SimilarityDoc = {
		id: "j",
		title: "John Doe",
		relPath: "library/people/john-doe.md",
		category: "people",
		aliases: [],
		tokens: { john: 4, doe: 3, staff: 3, engineer: 3, father: 3, retired: 3, cebu: 3, facts: 2, fact: 2 },
	};
	const bob: SimilarityDoc = {
		id: "b",
		title: "Bob",
		relPath: "library/people/bob.md",
		category: "people",
		aliases: ["John Doe's father", "John's father", "dad"],
		tokens: { john: 4, father: 4, retired: 3, cebu: 3, lives: 2, live: 2, facts: 2, fact: 2 },
	};
	const df = new Map<string, number>();
	for (const doc of [john, bob]) for (const term of Object.keys(doc.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
	const idf = makeIdf(df, 2);
	const comparison = compareDocs(john, bob, idf, { threshold: 0.62 });
	assert.ok(comparison.score > 0.7, `containment is high (${comparison.score}) but must not be reported`);
	assert.equal(comparison.linked, false);
	assert.equal(comparison.duplicate, false);
	assert.equal(suggestMerges([john, bob], { threshold: 0.62 }).length, 0);
});
