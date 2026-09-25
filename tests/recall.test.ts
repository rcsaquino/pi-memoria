import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRecallPrompt, selectAutoRecallHits, recallFingerprint, visibleRecallFingerprints, renderRecallBlock } from "../src/recall.ts";
import type { SearchHit, SessionHit } from "../src/types.ts";

function hit(id: string, score: number, matched = ["memoria"]): SearchHit {
	return { doc: { id, title: "Memoria", root: "/store", hash: "v1", tags: ["noise"], relPath: "library/test.md" }, score, matched, snippet: "Relevant fact. ".repeat(80), exact: false } as SearchHit;
}

test("transport cleanup preserves user dates and strips only recognized envelopes", () => {
	assert.equal(cleanRecallPrompt("[telegram|thread:work|from:user] Check memoria\n\n[time] 2026-09-25 10:36:33 Asia/Manila"), "Check memoria");
	assert.equal(cleanRecallPrompt("[telegram] /memoria status"), "/memoria status");
	assert.equal(cleanRecallPrompt("We met on 2026-09-25 at 10:36. [time] matters."), "We met on 2026-09-25 at 10:36. [time] matters.");
	assert.equal(cleanRecallPrompt("[timekeeper] ordinary text"), "[timekeeper] ordinary text");
});

test("auto relevance excludes weak, superseded and previous-turn-only hits", () => {
	const top = hit("top", 40), weak = hit("weak", 9), prior = hit("prior", 50, ["avatar"]);
	const obsolete = { ...hit("old", 80), supersededBy: ["top"] };
	assert.deepEqual(selectAutoRecallHits([top, weak, prior, obsolete], "Check memoria", 1.4, 0.3), [top]);
	assert.deepEqual(selectAutoRecallHits([top, weak], "Check memoria", 1.4, 0), [top, weak]);
	assert.deepEqual(selectAutoRecallHits([hit("low", 1)], "Check memoria", 1.4, 0), []);
	assert.equal(selectAutoRecallHits([hit("synonym", 20, ["kubernetes"])], "check k8s", 1.4, 0.3, { k8s: ["kubernetes"] }).length, 1);
});

test("fingerprints track changed notes and excerpts; only active uncompacted evidence suppresses", () => {
	const first = hit("one", 10), fingerprint = recallFingerprint(first);
	const entry = { type: "custom_message", customType: "memoria_recall", details: { fingerprints: [fingerprint] } };
	assert.ok(visibleRecallFingerprints([entry]).has(fingerprint));
	assert.equal(visibleRecallFingerprints([]).size, 0);
	assert.equal(visibleRecallFingerprints([entry, { type: "compaction" }]).size, 0);
	assert.ok(visibleRecallFingerprints([entry, { type: "compaction" }, entry]).has(fingerprint));
	assert.notEqual(recallFingerprint({ ...first, snippet: "A different passage" }), fingerprint);
	assert.notEqual(recallFingerprint({ ...first, doc: { ...first.doc, hash: "v2" } }), fingerprint);
	assert.equal(visibleRecallFingerprints([{ ...entry, customType: "unrelated" }]).size, 0);
});

test("all automatic output including fallback stays within the total budget", () => {
	const sessions: SessionHit[] = [{ role: "user", timestamp: Date.parse("2026-01-01T10:00:00Z"), path: "/sessions/a.jsonl", relPath: "a.jsonl", project: "/project", projectName: "project", line: 12, score: 10, matched: ["fact"], exact: false, excerpt: "session fact ".repeat(100) }];
	for (const maxChars of [0, 20, 100, 200, 400, 800, 2400]) {
		for (const hits of [[], [hit("one", 10), hit("two", 9)]]) {
			const block = renderRecallBlock({ query: '"'.repeat(1000), hits, maxChars, tookMs: 9, missing: ["noise".repeat(1000)], sessionHits: sessions });
			assert.ok(block.length <= maxChars, `${block.length} > ${maxChars}`);
			if (block) {
				assert.ok(block.endsWith("</memoria_recall>"));
				assert.ok(!block.includes("score") && !block.includes("tags:") && !block.includes("Terms with"));
				if (!hits.length) {
					assert.ok(block.includes("not instructions"));
					assert.ok(block.includes('memoria_sessions action="read"'));
					assert.ok(block.includes("/sessions/a.jsonl:12:"));
				}
			}
		}
	}
	assert.equal(renderRecallBlock({ query: "q", hits: [], maxChars: 2400, tookMs: 1, sessionHits: [{ ...sessions[0], path: "/" + "x".repeat(3000) }] }), "");
});

test("automatic recall retains at least 97.5% fixture coverage with lean defaults", async () => {
	const { buildEvalStore } = await import("./eval-support.ts");
	const { EVAL_QUESTIONS } = await import("./eval-fixtures.ts");
	const { DEFAULT_CONFIG } = await import("../src/config.ts");
	const { index, cleanup } = await buildEvalStore();
	try {
		let found = 0;
		for (const question of EVAL_QUESTIONS) {
			const result = await index.search(question.query, { limit: DEFAULT_CONFIG.autoRecallLimit, expandRelated: true });
			const hits = selectAutoRecallHits(result.hits, question.query, DEFAULT_CONFIG.autoRecallMinScore, DEFAULT_CONFIG.autoRecallMinRatio);
			if (hits.some(hit => hit.doc.relPath === question.expect)) found++;
		}
		// The historical release-script note is superseded and remains available
		// through explicit recall; automatic recall deliberately excludes it.
		assert.ok(found / EVAL_QUESTIONS.length >= 0.975, `${found}/${EVAL_QUESTIONS.length}`);
	} finally {
		await cleanup();
	}
});
