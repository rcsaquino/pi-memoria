/**
 * Recall regression guard: the fixture corpus from `eval-support.ts` must stay
 * retrievable. Thresholds sit below the current numbers on purpose — they are a
 * floor against ranking regressions, not a target.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvalStore, runEval } from "./eval-support.ts";

test("the fixture corpus is retrievable: recall@5 stays at 100%", async () => {
	const { index, cleanup } = await buildEvalStore();
	try {
		const report = await runEval(index);
		const missed = report.outcomes.filter((outcome) => outcome.rank === 0 || outcome.rank > 5);
		assert.equal(
			missed.length,
			0,
			`recall@5 regressed: ${missed.map((outcome) => `"${outcome.question.query}" (rank ${outcome.rank}, expected ${outcome.question.expect}, got ${outcome.titles.slice(0, 3).join(" | ")})`).join("; ")}`,
		);
		assert.ok(report.recall1 >= 0.75, `recall@1 ${report.recall1.toFixed(3)} fell below 0.75`);
		assert.ok(report.avgMs < 50, `average query took ${report.avgMs.toFixed(2)}ms`);
	} finally {
		await cleanup();
	}
});
