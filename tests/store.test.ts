import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addHotEntry,
	appendFact,
	categoryFromRelPath,
	createMemory,
	deleteMemory,
	deriveTitle,
	ensureStore,
	extractFactUnits,
	hotIsEmpty,
	hotTemplate,
	looksAtomicTopic,
	moveMemory,
	parseMemoryDoc,
	readHot,
	readMemoryDoc,
	readStoreFile,
	recoverJournal,
	resolveMemoryRef,
	removeHotMatches,
	renderLibraryIndexes,
	resolveTopic,
	scanLibrary,
	slugify,
	splitHotParagraphs,
	trimHot,
	updateMemory,
} from "../src/store.ts";

async function tempRoot(prefix = "memoria-test-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

test("ensureStore creates the layout and MEMORY.md", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000, "inbox");
		assert.ok(existsSync(join(root, "MEMORY.md")));
		assert.ok(existsSync(join(root, "library", "inbox")));
		assert.ok(existsSync(join(root, ".index")));
		const hot = await readHot(root, 5000);
		assert.equal(hot.exists, true);
		assert.equal(hot.content.trim(), "");
		assert.ok(!hot.content.includes("<!--"), "MEMORY.md must not contain annotations");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("slugify produces filesystem-safe names", () => {
	assert.equal(slugify("Alice prefers oat milk!"), "alice-prefers-oat-milk");
	assert.equal(slugify("  C++ / Rust: which?  "), "c-rust-which");
	assert.equal(slugify("東京タワー"), "東京タワー");
	assert.equal(slugify("!!!"), "memory");
});

test("categoryFromRelPath returns the first folder under library", () => {
	assert.equal(categoryFromRelPath("library/people/alice.md"), "people");
	assert.equal(categoryFromRelPath("library/people/team/alice.md"), "people");
	assert.equal(categoryFromRelPath("library/alice.md"), "");
	assert.equal(categoryFromRelPath("MEMORY.md"), "");
});

test("createMemory files notes under a broad topic", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const { doc, path } = await createMemory(root, {
			topic: "Dietary preferences",
			content: "Alice drinks oat milk in coffee and is lactose intolerant.",
			category: "preferences",
			tags: ["alice", "dietary"],
			summary: "Oat milk, lactose intolerant",
		});
		assert.ok(doc.id.startsWith("mem_"));
		assert.equal(doc.category, "preferences");
		assert.equal(doc.topic, "Dietary preferences");
		assert.equal(doc.title, "Dietary preferences");
		assert.deepEqual(doc.tags, ["alice", "dietary"]);
		assert.equal(doc.summary, "Oat milk, lactose intolerant");
		assert.ok(path.endsWith("dietary-preferences.md"));
		assert.equal(doc.tokenCount > 0, true);
		const raw = await readFile(path, "utf8");
		assert.ok(raw.startsWith("---\n"));
		assert.ok(raw.includes("id: mem_"));
		assert.ok(raw.includes("topic: Dietary preferences"));
		assert.ok(raw.includes("# Dietary preferences"));
		assert.ok(raw.includes("## Facts"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fact-like topics are rejected in favor of the broad category", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		// The user says "I like apples"; a fact-shaped topic must never become a file name.
		const result = await createMemory(root, { topic: "likes apples", content: "Likes apples.", category: "preferences" });
		assert.equal(result.topicAdjusted, true);
		assert.equal(result.topic, "Preferences");
		assert.ok(result.relPath.endsWith("preferences.md"), result.relPath);
		assert.ok(result.topicNote?.includes("likes apples"));
		const second = await createMemory(root, { topic: "loves bananas", content: "Loves bananas.", category: "preferences" });
		assert.equal(second.topicAdjusted, true);
		assert.equal(second.relPath, result.relPath, "both facts land in the same broad note");
		const body = await readFile(result.path, "utf8");
		assert.ok(body.includes("Likes apples"));
		assert.ok(body.includes("Loves bananas"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("facts accumulate in one topic note instead of one file per fact", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const first = await createMemory(root, { topic: "Dietary preferences", content: "Likes apples.", label: "Fruit", category: "preferences" });
		assert.equal(first.merged, false);
		assert.equal(first.updated, false);
		const second = await createMemory(root, { topic: "Dietary preferences", content: "Dislikes bananas.", label: "Fruit", category: "preferences" });
		assert.equal(second.merged, true);
		assert.equal(second.updated, true);
		assert.equal(second.path, first.path);
		assert.equal(second.doc.tags.length, first.doc.tags.length);
		const body = await readFile(first.path, "utf8");
		assert.ok(body.includes("**Fruit** — Likes apples.") || body.includes("**Fruit** — Likes apples"), body);
		assert.ok(body.includes("Dislikes bananas."), body);
		// Re-adding the same fact is a no-op.
		const third = await createMemory(root, { topic: "Dietary preferences", content: "Likes apples.", category: "preferences" });
		assert.equal(third.duplicate, true);
		assert.equal(third.updated, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("mode=new forces a sibling file, mode=auto spills when full", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const big = "x".repeat(1000);
		const first = await createMemory(root, { topic: "Deploy process", content: big, mode: "new" }, "inbox", { topicMaxChars: 700 });
		const second = await createMemory(root, { topic: "Deploy process", content: "Two.", mode: "new" }, "inbox", { topicMaxChars: 700 });
		assert.notEqual(first.path, second.path);
		assert.ok(second.path.endsWith("deploy-process-2.md"), second.path);
		// auto skips the full primary note and merges into the under-limit sibling.
		const spilled = await createMemory(root, { topic: "Deploy process", content: "Three.", mode: "auto" }, "inbox", { topicMaxChars: 700 });
		assert.equal(spilled.path, second.path, "merges into the under-limit sibling");
		assert.equal(spilled.merged, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("appendFact groups facts under a single Facts section", () => {
	let body = "# Topic";
	const first = appendFact(body, "One", "First fact.");
	body = first.body;
	assert.equal(first.changed, true);
	assert.ok(body.includes("## Facts"));
	assert.ok(body.includes("- **One** — First fact."));
	const second = appendFact(body, undefined, "Second fact.");
	assert.equal(second.changed, true);
	assert.ok(second.body.includes("Second fact."));
	assert.equal((second.body.match(/## Facts/g) ?? []).length, 1);
	const duplicate = appendFact(second.body, undefined, "Second fact.");
	assert.equal(duplicate.changed, false);
	assert.equal(duplicate.duplicate, true);
});

test("updateMemory preserves frontmatter and moves category", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const { doc } = await createMemory(root, { topic: "Draft", content: "initial", category: "inbox", tags: ["x"] });
		const updated = await updateMemory(root, doc, { title: "Final", content: "revised", category: "decisions", priority: "high" });
		assert.equal(updated.id, doc.id);
		assert.equal(updated.title, "Final");
		assert.equal(updated.category, "decisions");
		assert.equal(updated.priority, "high");
		assert.deepEqual(updated.tags, ["x"]);
		assert.equal(updated.body.includes("revised"), true);
		assert.equal(existsSync(updated.path), true);
		assert.equal(existsSync(doc.path), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deleteMemory moves files to .trash", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const { doc } = await createMemory(root, { topic: "Old fact", content: "stale" });
		const trashPath = await deleteMemory(root, doc);
		assert.equal(existsSync(doc.path), false);
		assert.equal(existsSync(trashPath), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("soft deletes with the same basename keep both trashed copies", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const first = await createMemory(root, { topic: "Release notes", category: "alpha", content: "Alpha released." });
		const second = await createMemory(root, { topic: "Release notes", category: "beta", content: "Beta released." });
		const [firstTrash, secondTrash] = await Promise.all([deleteMemory(root, first.doc), deleteMemory(root, second.doc)]);
		assert.notEqual(firstTrash, secondTrash);
		assert.match(await readFile(firstTrash, "utf8"), /Alpha released/);
		assert.match(await readFile(secondTrash, "utf8"), /Beta released/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("files without frontmatter are still parsed and indexed", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const path = join(root, "library", "knowledge", "manual.md");
		await mkdir(join(root, "library", "knowledge"), { recursive: true });
		await writeFile(path, "# Manual note\n\nThis was written by hand and mentions Postgres.\n", "utf8");
		const scanned = await scanLibrary(root);
		assert.equal(scanned.size, 1);
		const doc = await readMemoryDoc(root, path);
		assert.ok(doc);
		assert.equal(doc!.title, "Manual note");
		assert.equal(doc!.category, "knowledge");
		assert.ok(doc!.body.includes("Postgres"));
		assert.ok(doc!.tokens["postgres"] > 0 || doc!.tokens["postgre"] > 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("scanLibrary ignores INDEX.md and dotfiles", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await writeFile(join(root, "library", "INDEX.md"), "# Index\n", "utf8");
		await writeFile(join(root, "library", "inbox", "INDEX.md"), "# Index\n", "utf8");
		await writeFile(join(root, "library", ".hidden.md"), "# Hidden\n", "utf8");
		const { doc } = await createMemory(root, { topic: "Real", content: "content" });
		const scanned = await scanLibrary(root);
		assert.deepEqual([...scanned.keys()], [doc.relPath]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("MEMORY.md is a plain-prose file with no annotations", () => {
	const template = hotTemplate();
	assert.equal(template.trim(), "# Memory");
	assert.ok(!template.includes("<!--"), "no HTML comment annotations");
	assert.ok(!template.includes("##"), "no headings");
	assert.equal(hotIsEmpty(template), true);
	assert.equal(hotIsEmpty("# Memory\n\nAlice drinks oat milk.\n"), false);
});

test("addHotEntry writes prose and never injects labels", () => {
	let content = hotTemplate();
	const first = addHotEntry(content, "Alice is lactose intolerant and drinks oat milk.");
	content = first.content;
	assert.equal(first.changed, true);
	assert.equal(first.created, true);
	assert.ok(content.includes("Alice is lactose intolerant and drinks oat milk."));
	assert.ok(!content.includes("- "), "no bullet added");
	assert.ok(!content.includes(" — "), "no 'Topic — fact' label written");

	// A related topic hint appends to the same paragraph.
	const second = addHotEntry(content, "She prefers terse answers.", "Alice lactose intolerant");
	content = second.content;
	assert.equal(second.created, false);
	assert.equal(splitHotParagraphs(content).length, 2, "title + one paragraph");
	assert.ok(/Alice is lactose intolerant[\s\S]*She prefers terse answers\./.test(content));
	assert.ok(!content.includes("Alice lactose intolerant — "), "the hint is not written into the file");

	// An unrelated fact starts a new paragraph, still with no label.
	const third = addHotEntry(content, "Deploys go out Thursday mornings.", "Postgres migration");
	content = third.content;
	assert.equal(third.created, true);
	assert.equal(splitHotParagraphs(content).length, 3);
	assert.ok(content.includes("Deploys go out Thursday mornings."));
	assert.ok(!content.includes("Postgres migration — "), "the hint is not written into the file");

	// Invalid input is rejected rather than silently rewritten.
	assert.throws(() => addHotEntry(content, "- Uses vim keybindings."), /plain prose/);
});

test("addHotEntry places facts with the paragraph that shares their topic", () => {
	let content = hotTemplate();
	content = addHotEntry(content, "The user is lactose intolerant and drinks oat milk.", "dietary").content;
	content = addHotEntry(content, "The user prefers terse answers and short updates.", "communication style").content;
	assert.equal(splitHotParagraphs(content).length, 3, "title + two paragraphs");

	const added = addHotEntry(content, "Avoids caffeine after 2pm.", "dietary lactose");
	assert.equal(added.created, false, "placed in the existing dietary paragraph");
	const paragraphs = splitHotParagraphs(added.content);
	assert.ok(paragraphs[1].includes("Avoids caffeine after 2pm."), paragraphs[1]);
	assert.ok(!paragraphs[2].includes("Avoids caffeine"), paragraphs[2]);

	// With no matching paragraph the sentence becomes its own paragraph.
	const separate = addHotEntry(added.content, "Nightingale runs Postgres 16.", "postgres nightingale");
	assert.equal(separate.created, true);
	assert.equal(splitHotParagraphs(separate.content).length, 4);
});

test("addHotEntry strips legacy annotation blocks", () => {
	const legacy = "# Long-Term Memory\n\n<!-- instructions -->\n\n## Preferences\n\n- Likes tea\n";
	const added = addHotEntry(legacy, "Prefers dark mode.", "Preferences");
	assert.ok(!added.content.includes("<!--"));
	assert.ok(added.content.includes("Likes tea"));
	assert.ok(added.content.includes("Prefers dark mode."));
});

test("removeHotMatches deletes sentences, not whole paragraphs", () => {
	let content = hotTemplate();
	content = addHotEntry(content, "Alice drinks oat milk.", "Alice").content;
	content = addHotEntry(content, "Alice prefers dark mode.", "Alice").content;
	content = addHotEntry(content, "Nightingale uses Postgres.", "Nightingale").content;
	const [pruned, removed] = removeHotMatches(content, "oat milk");
	assert.equal(removed, 1);
	assert.ok(!pruned.includes("oat milk"));
	assert.ok(pruned.includes("Alice prefers dark mode."), "the rest of the paragraph survives");
	assert.ok(pruned.includes("Nightingale uses Postgres."));
});

test("trimHot drops trailing paragraphs and reports the removed text", () => {
	let content = hotTemplate();
	content = addHotEntry(content, "First important fact about Alice.", "Alice").content;
	content = addHotEntry(content, "Second fact about the deployment process.", "Deployment").content;
	content = addHotEntry(content, "Third fact that should be dropped.", "Misc").content;
	const trimmed = trimHot(content, 120);
	assert.equal(trimmed.trimmed, true);
	assert.ok(trimmed.content.length <= 120, `trimmed length ${trimmed.content.length}`);
	assert.ok(trimmed.content.includes("First important fact"));
	assert.ok(!trimmed.content.includes("Third fact"));
	assert.ok(trimmed.removed.includes("Third fact"));
	assert.ok(!trimmed.content.includes("truncated"), "no marker is written into the file");
	assert.ok(!trimmed.content.includes("<!--"));
});

test("deriveTitle falls back to H1 then file name", () => {
	assert.equal(deriveTitle({}, "# Hello world\nbody", "library/x.md"), "Hello world");
	assert.equal(deriveTitle({}, "body only", "library/some-note.md"), "some note");
	assert.equal(deriveTitle({ title: "  From FM  " }, "# Other", "library/x.md"), "From FM");
});

test("renderLibraryIndexes groups by category", () => {
	const files = renderLibraryIndexes([
		{ relPath: "library/people/alice.md", title: "Alice", id: "mem_1", category: "people", tags: ["a"], summary: "s", priority: "normal", updated: 1 },
		{ relPath: "library/projects/pi.md", title: "Pi", id: "mem_2", category: "projects", tags: [], summary: "", priority: "high", updated: 2 },
	]);
	const rootIndex = files.get("INDEX.md")!;
	assert.ok(rootIndex.includes("## people"));
	assert.ok(rootIndex.includes("## projects"));
	assert.ok(rootIndex.includes("people/alice.md"));
	const peopleIndex = files.get("people/INDEX.md")!;
	assert.ok(peopleIndex.includes("alice.md"));
	assert.ok(!peopleIndex.includes("pi.md"));
});

test("looksAtomicTopic separates facts from topics", () => {
	for (const fact of [
		"likes apples",
		"I like apples",
		"user likes apples",
		"User prefers dark mode",
		"Alice prefers oat milk",
		"the user drinks tea",
		"Project Nightingale uses Postgres",
		"deploys happen on Thursdays",
	]) {
		assert.equal(looksAtomicTopic(fact), true, `expected fact-like: ${fact}`);
	}
	for (const topic of [
		"Dietary preferences",
		"Alice",
		"Project Nightingale",
		"Deployment conventions",
		"Kubernetes incident 2025-03",
		"Cold start optimization",
		"Staging deploy url",
		"On-call rotation",
		// Gerunds read as nouns in a topic name and must not be mistaken for a
		// live predicate ("learning" vs "likes").
		"Machine learning notebook",
		"Budget planning",
		"Feature engineering",
	]) {
		assert.equal(looksAtomicTopic(topic), false, `expected topic-like: ${topic}`);
	}
});

test("resolveTopic falls back to the category and reports why", () => {
	const rejected = resolveTopic("likes apples", "preferences", "inbox");
	assert.equal(rejected.topic, "Preferences");
	assert.equal(rejected.slug, "preferences");
	assert.equal(rejected.adjusted, true);
	assert.ok(rejected.note?.includes("likes apples"));

	const missing = resolveTopic(undefined, "people", "inbox");
	assert.equal(missing.topic, "People");
	assert.equal(missing.adjusted, false);

	const tooLong = resolveTopic("one two three four five six seven", "knowledge", "inbox", 6);
	assert.equal(tooLong.topic, "Knowledge");
	assert.equal(tooLong.adjusted, true);

	const accepted = resolveTopic("dietary preferences", "preferences", "inbox");
	assert.equal(accepted.topic, "Dietary preferences");
	assert.equal(accepted.slug, "dietary-preferences");
	assert.equal(accepted.adjusted, false);
});

test("parseMemoryDoc synthesizes an id for frontmatter-less files", () => {
	const doc = parseMemoryDoc({
		source: "# Hello\n\nBody text",
		root: "/tmp/x",
		path: "/tmp/x/library/a/b.md",
		relPath: "library/a/b.md",
		mtimeMs: 1000,
		size: 10,
	});
	assert.ok(doc.id.startsWith("mem_"));
	assert.equal(doc.category, "a");
	assert.equal(doc.created, 1000);
});

/* ------------------------------------------------------------------ */
/* Aliases and consolidation: relations become names                   */
/* ------------------------------------------------------------------ */

/** Write a legacy-shaped note whose file name is a relation, as older stores have. */
async function writeLegacyRelationNote(root: string, content = "John's father is retired and lives in Cebu."): Promise<string> {
	const dir = join(root, "library", "people");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "johns-father.md");
	const raw = [
		"---",
		"id: mem_legacy_father",
		'title: "John\'s father"',
		'topic: "John\'s father"',
		"category: people",
		"tags: [family]",
		'created: 2024-01-01T00:00:00.000Z',
		"---",
		"",
		"# John's father",
		"",
		"## Facts",
		"",
		`- **Father** — ${content}`,
		"",
	].join("\n");
	await writeFile(path, raw, "utf8");
	return path;
}

test("slugify joins possessives instead of splitting them", () => {
	assert.equal(slugify("John's father"), "johns-father");
	assert.equal(slugify("Alice\u2019s manager"), "alices-manager");
	assert.equal(slugify("Dietary preferences"), "dietary-preferences");
});

test("relation-shaped and possessive topics are treated as facts", () => {
	for (const relation of ["John's father", "my dad", "dad", "his mother", "Alice's manager", "bob's employer", "Johns' boss"]) {
		assert.equal(looksAtomicTopic(relation), true, `expected relational: ${relation}`);
	}
	// "People" is rejected by the pre-existing pronoun/collective guard, not by the relation rule.
	for (const topic of ["Family", "Friends", "Alice", "Bob Smith", "Dietary preferences", "Team"]) {
		assert.equal(looksAtomicTopic(topic), false, `expected topic-like: ${topic}`);
	}
	const resolved = resolveTopic("John's father", "people", "inbox");
	assert.equal(resolved.topic, "People");
	assert.equal(resolved.slug, "people");
	assert.equal(resolved.adjusted, true);
	assert.ok(resolved.note?.includes("John's father"));
});

test("a relation is filed as a fact under the broad topic, never as a file name", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const wrote = await createMemory(root, {
			topic: "John's father",
			category: "people",
			label: "Father",
			content: "John's father is retired and lives in Cebu.",
		});
		assert.equal(wrote.relPath, "library/people/people.md");
		assert.equal(wrote.topicAdjusted, true);
		assert.ok(wrote.doc.body.includes("John's father is retired"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("aliases are stored, deduplicated, merged on append and survive a re-read", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const created = await createMemory(root, {
			topic: "Bob",
			category: "people",
			content: "Bob is John's father.",
			aliases: ["Robert", "dad", "robert"],
		});
		assert.deepEqual(created.doc.aliases, ["Robert", "dad"], "case-insensitive dedupe");

		const appended = await createMemory(root, {
			topic: "Bob",
			category: "people",
			content: "Bob lives in Cebu.",
			aliases: ["Bobby"],
		});
		assert.equal(appended.merged, true);
		assert.deepEqual(appended.doc.aliases, ["Robert", "dad", "Bobby"]);

		const reread = await readMemoryDoc(root, created.doc.path);
		assert.deepEqual(reread?.aliases, ["Robert", "dad", "Bobby"]);
		assert.equal(reread?.frontmatter.aliases instanceof Array, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveMemoryRef finds a note by any of its aliases", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const created = await createMemory(root, {
			topic: "Bob",
			category: "people",
			content: "Bob is John's father.",
			aliases: ["Robert", "John's father"],
		});
		const byAlias = await resolveMemoryRef(root, "robert");
		assert.equal(byAlias?.id, created.doc.id);
		const byRelation = await resolveMemoryRef(root, "John's father");
		assert.equal(byRelation?.id, created.doc.id);
		const byId = await resolveMemoryRef(root, created.doc.id);
		assert.equal(byId?.id, created.doc.id);
		assert.equal(await resolveMemoryRef(root, "nobody"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("moveMemory re-files a relation note under the real name", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const legacyPath = await writeLegacyRelationNote(root);
		const legacy = await readMemoryDoc(root, legacyPath);
		assert.ok(legacy);

		const moved = await moveMemory(root, legacy, { topic: "Bob" });
		assert.equal(moved.moved, true);
		assert.equal(moved.merged, false);
		assert.equal(moved.doc.relPath, "library/people/bob.md");
		assert.equal(moved.doc.topic, "Bob");
		assert.equal(moved.doc.id, "mem_legacy_father", "identity survives the move");
		assert.equal(moved.doc.frontmatter.created, "2024-01-01T00:00:00.000Z");
		assert.ok(moved.doc.body.startsWith("# Bob\n"));
		assert.ok(moved.doc.body.includes("John's father is retired"));
		assert.deepEqual(moved.doc.aliases, ["John's father", "johns-father"]);
		assert.ok(moved.aliasesAdded.includes("John's father"));
		assert.ok(!existsSync(legacyPath), "the old file is gone");
		assert.ok(moved.trashPath && existsSync(moved.trashPath));

		// The old name still resolves, and the note keeps working by id.
		const byOldName = await resolveMemoryRef(root, "johns-father");
		assert.equal(byOldName?.id, "mem_legacy_father");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("memory path reads stay inside the library, including through symlinks", async () => {
	const root = await tempRoot();
	const outside = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const external = join(outside, "private.md");
		await writeFile(external, "# Private\n\nOutside the store.", "utf8");
		assert.equal(await resolveMemoryRef(root, external), undefined);
		await assert.rejects(() => readStoreFile(root, external), /Refusing to read/);
		const link = join(root, "library", "inbox", "linked.md");
		await symlink(external, link);
		assert.equal(await resolveMemoryRef(root, "library/inbox/linked.md"), undefined);
		await assert.rejects(() => readStoreFile(root, "library/inbox/linked.md"), /Refusing to read/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("journal recovery preserves a merge source until every fact reaches the target", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const source = await createMemory(root, { topic: "Alice work", category: "people", content: "Alice knows Rust." });
		const target = await createMemory(root, { topic: "Alice", category: "people", content: "Alice knows Go." });
		const journal = join(root, ".index", "journal.json");
		await writeFile(journal, JSON.stringify({ op: "move", from: source.relPath, to: target.relPath, merge: true, at: Date.now() }));
		assert.match(await recoverJournal(root) ?? "", /kept source/);
		assert.ok(existsSync(source.path));
		assert.ok(existsSync(journal));
		const moved = await moveMemory(root, source.doc, { topic: "Alice", merge: true });
		assert.equal(moved.doc.aliases.includes(source.doc.id), true);
		assert.ok(!existsSync(source.path));
		const another = await createMemory(root, { topic: "Alice hobbies", category: "people", content: "Alice plays chess." });
		await writeFile(journal, JSON.stringify({ op: "move", from: another.relPath, to: moved.doc.relPath, merge: true, at: Date.now() }));
		await updateMemory(root, moved.doc, {
			content: appendFact(moved.doc.body, undefined, "Alice plays chess.").body,
			aliases: [...moved.doc.aliases, another.doc.id],
		});
		assert.match(await recoverJournal(root) ?? "", /completed interrupted move/);
		assert.ok(!existsSync(another.path));
		assert.ok(!existsSync(journal));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("moveMemory merges into an existing note rather than clobbering it", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const target = await createMemory(root, {
			topic: "Bob",
			category: "people",
			label: "Home",
			content: "Bob lives in Cebu.",
			tags: ["family"],
			priority: "high",
		});
		const legacyPath = await writeLegacyRelationNote(root);
		const legacy = await readMemoryDoc(root, legacyPath);
		assert.ok(legacy);

		const moved = await moveMemory(root, legacy, { topic: "Bob", merge: true });
		assert.equal(moved.merged, true);
		assert.equal(moved.doc.id, target.doc.id, "the target note keeps its identity");
		assert.equal(moved.doc.relPath, target.doc.relPath);
		assert.ok(moved.doc.body.includes("Bob lives in Cebu."), "existing facts survive");
		assert.ok(moved.doc.body.includes("John's father is retired"), "incoming facts arrive");
		assert.equal((moved.doc.body.match(/## Facts/g) ?? []).length, 1, "one Facts section");
		assert.deepEqual(moved.doc.tags, ["family"]);
		assert.equal(moved.doc.priority, "high");
		assert.deepEqual(moved.doc.aliases, [legacy.id, "John's father", "johns-father"]);
		assert.equal((await resolveMemoryRef(root, legacy.id))?.id, target.doc.id, "the retired id still resolves");
		assert.ok(!existsSync(legacyPath));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("moveMemory refuses to touch an existing note unless merge is allowed", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		await createMemory(root, { topic: "Bob", category: "people", content: "Bob lives in Cebu." });
		const legacyPath = await writeLegacyRelationNote(root);
		const legacy = await readMemoryDoc(root, legacyPath);
		assert.ok(legacy);
		await assert.rejects(() => moveMemory(root, legacy, { topic: "Bob", merge: false }), /already exists/);
		await assert.rejects(() => moveMemory(root, legacy, { topic: "Bob" }), /already exists/);
		assert.ok(existsSync(legacyPath), "nothing was moved");
		const stillThere = await readMemoryDoc(root, legacyPath);
		assert.equal(stillThere?.topic, "John's father");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("merge refuses to discard old aliases when the alias limit is full", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const target = await createMemory(root, { topic: "Alice", category: "people", content: "Alice knows Go.", aliases: Array.from({ length: 24 }, (_, i) => `alice-name-${i}`) });
		const source = await createMemory(root, { topic: "Alice work", category: "people", content: "Alice knows Rust." });
		await assert.rejects(() => moveMemory(root, source.doc, { topic: "Alice", merge: true }), /alias limit/);
		assert.ok(existsSync(source.path));
		assert.equal((await readMemoryDoc(root, target.path))?.aliases.length, 24);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("merge refuses to discard links when the link limit is full", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const target = await createMemory(root, { topic: "Alice", category: "people", content: "Alice knows Go.", related: Array.from({ length: 16 }, (_, i) => `mem_link_${i}`) });
		const source = await createMemory(root, { topic: "Alice work", category: "people", content: "Alice knows Rust.", related: ["mem_extra_link"] });
		await assert.rejects(() => moveMemory(root, source.doc, { topic: "Alice", merge: true }), /link limit/);
		assert.ok(existsSync(source.path));
		assert.equal((await readMemoryDoc(root, target.path))?.related.length, 16);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("moveMemory reports no change when the note is already at the target topic", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const created = await createMemory(root, { topic: "Bob", category: "people", content: "Bob lives in Cebu." });
		const moved = await moveMemory(root, created.doc, { topic: "Bob" });
		assert.equal(moved.moved, false);
		assert.equal(moved.merged, false);
		assert.match(moved.reason ?? "", /Already filed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("extractFactUnits keeps labels, bullets and prose blocks apart", () => {
	const units = extractFactUnits(
		["# Title", "", "## Facts", "", "- **Drinks** — flat whites.", "- No dairy.", "", "### Home", "", "Lives in Cebu.", ""].join("\n"),
	);
	assert.deepEqual(units, [
		{ label: "Drinks", text: "flat whites." },
		{ label: undefined, text: "No dairy." },
		{ label: "Home", text: "Lives in Cebu." },
	]);
});
