/**
 * Index-engine level tests: binary persistence, watch filtering and the
 * link/posting helpers the search layer relies on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, INDEX_VERSION, isIgnoredWatchPath } from "../src/index-engine.ts";
import { createMemory, ensureStore } from "../src/store.ts";

async function tempRoot(prefix = "memoria-engine-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

const NOTES: Array<{ topic: string; content: string; category: string; tags?: string[] }> = [
	{ topic: "Alice", content: "Alice drinks oat milk and avoids dairy.", category: "people", tags: ["alice", "food"] },
	{ topic: "Project Nightingale", content: "Project Nightingale runs on Postgres 16 with pgvector.", category: "projects", tags: ["nightingale"] },
	{ topic: "Deploy process", content: "Deploys happen on Thursday mornings via the release script.", category: "workflows", tags: ["deploy"] },
	{ topic: "Kubernetes incident", content: "A misconfigured liveness probe caused the outage.", category: "decisions", tags: ["incident", "kubernetes"] },
];

async function seed(root: string): Promise<void> {
	await ensureStore(root, 5000);
	for (const note of NOTES) {
		await createMemory(root, { topic: note.topic, content: note.content, category: note.category, tags: note.tags });
	}
}

test("watch filtering ignores derived and generated paths", () => {
	assert.equal(isIgnoredWatchPath(""), true);
	assert.equal(isIgnoredWatchPath(".index/index.json"), true);
	assert.equal(isIgnoredWatchPath(".index/usage.json"), true);
	assert.equal(isIgnoredWatchPath(".trash/2025-01-01__alice.md"), true);
	assert.equal(isIgnoredWatchPath("library/people/INDEX.md"), true);
	assert.equal(isIgnoredWatchPath("library/INDEX.md"), true);
	assert.equal(isIgnoredWatchPath("library/people/INDEX.md.bak"), false);
	assert.equal(isIgnoredWatchPath("MEMORY.md"), false);
	assert.equal(isIgnoredWatchPath("library/people/alice.md"), false);
	assert.equal(isIgnoredWatchPath("library\\people\\alice.md"), false);
});

test("binary persistence round-trips exactly and removes the JSON index", async () => {
	const root = await tempRoot();
	try {
		await seed(root);
		const index = new MemoryIndex(root, { indexFormat: "binary" });
		await index.load();
		assert.equal(index.aliveCount, NOTES.length);
		const before = await index.search("pgvector liveness probe");
		const bytes = await index.save();
		assert.ok(bytes > 0);
		assert.ok(existsSync(join(root, ".index", "index.bin")));
		assert.ok(!existsSync(join(root, ".index", "index.json")), "the JSON index is removed when binary is chosen");
		assert.equal(index.persistedFormat, "binary");

		const reloaded = new MemoryIndex(root, { indexFormat: "binary" });
		await reloaded.load();
		assert.equal(reloaded.aliveCount, NOTES.length);
		assert.equal(reloaded.persistedFormat, "binary");
		const after = await reloaded.search("pgvector liveness probe");
		assert.deepEqual(
			after.hits.map((hit) => [hit.doc.id, hit.score]),
			before.hits.map((hit) => [hit.doc.id, hit.score]),
			"binary round-trip preserves ids and scores",
		);
		// Postings survive: term lookups still work.
		const alice = reloaded.liveDocs().find((entry) => entry.meta.title === "Alice")!;
		assert.ok(reloaded.docTokens(alice.idx).alice > 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("auto format stays JSON for small stores and honours an explicit format", async () => {
	const root = await tempRoot();
	try {
		await seed(root);
		const auto = new MemoryIndex(root, { indexFormat: "auto" });
		await auto.load();
		await auto.save();
		assert.equal(auto.persistedFormat, "json");
		assert.ok(existsSync(join(root, ".index", "index.json")));
		assert.ok(!existsSync(join(root, ".index", "index.bin")));

		const json = new MemoryIndex(root, { indexFormat: "json" });
		await json.load();
		assert.equal(json.persistedFormat, "json");

		// Switching format rewrites the index in place.
		json.setIndexFormat("binary");
		await json.save();
		assert.equal(json.persistedFormat, "binary");
		const back = new MemoryIndex(root, { indexFormat: "json" });
		await back.load();
		assert.equal(back.aliveCount, NOTES.length);
		assert.equal(back.persistedFormat, "binary", "load prefers an existing binary file");
		await back.save();
		assert.equal(back.persistedFormat, "json", "an explicit JSON format wins on the next save");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a corrupt binary index is ignored and rebuilt from markdown", async () => {
	const root = await tempRoot();
	try {
		await seed(root);
		const index = new MemoryIndex(root, { indexFormat: "binary" });
		await index.load();
		await index.save();
		const binaryPath = join(root, ".index", "index.bin");
		const good = await readFile(binaryPath);
		await writeFile(binaryPath, Buffer.concat([good.subarray(0, 32), Buffer.from("garbage")]));
		const reloaded = new MemoryIndex(root, { indexFormat: "binary" });
		await reloaded.load();
		assert.equal(reloaded.aliveCount, NOTES.length, "rebuilt from the markdown files");
		const result = await reloaded.search("oat milk");
		assert.equal(result.hits[0].doc.title, "Alice");

		// A foreign/old version is rejected as well.
		const header = Buffer.from(good.subarray(0, 48));
		header.writeUInt32LE(INDEX_VERSION + 99, 4);
		await writeFile(binaryPath, Buffer.concat([header, good.subarray(48)]));
		const stale = new MemoryIndex(root, { indexFormat: "binary" });
		await stale.load();
		assert.equal(stale.aliveCount, NOTES.length);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("postingTfFor finds single documents without scanning", async () => {
	const root = await tempRoot();
	try {
		await seed(root);
		const index = new MemoryIndex(root);
		await index.load();
		const alice = index.liveDocs().find((entry) => entry.meta.title === "Alice")!;
		const other = index.liveDocs().find((entry) => entry.meta.title === "Deploy process")!;
		const termId = index.termId("milk");
		assert.ok(termId >= 0);
		assert.ok(index.postingTfFor(termId, alice.idx) > 0);
		assert.equal(index.postingTfFor(termId, other.idx), 0);
		assert.equal(index.postingTfFor(-1, alice.idx), 0);
		assert.equal(index.postingTfFor(9999, alice.idx), 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("link helpers resolve ids, paths and titles and cache invalidation is correct", async () => {
	const root = await tempRoot();
	try {
		await ensureStore(root, 5000);
		const bob = await createMemory(root, { topic: "Bob", content: "Bob lives in Cebu.", category: "people" });
		const alice = await createMemory(root, {
			topic: "Alice",
			content: "Alice is Bob's manager.",
			category: "people",
			related: ["Bob"],
		});
		const index = new MemoryIndex(root);
		await index.load();
		assert.equal(index.resolveLink("Bob"), index.idxForId(bob.doc.id));
		assert.equal(index.resolveLink("library/people/bob.md"), index.idxForId(bob.doc.id));
		assert.equal(index.resolveLink(bob.doc.id), index.idxForId(bob.doc.id));
		assert.equal(index.resolveLink("nobody"), undefined);
		const aliceIdx = index.idxForId(alice.doc.id)!;
		assert.deepEqual(index.relatedDocs(aliceIdx), [index.idxForId(bob.doc.id)]);
		assert.equal(index.supersedeMap().size, 0);
		// Removing the target invalidates the link cache.
		index.removeDoc(index.idxForId(bob.doc.id)!);
		assert.equal(index.resolveLink("Bob"), undefined);
		assert.deepEqual(index.relatedDocs(aliceIdx), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
