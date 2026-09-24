/**
 * Recall evaluation runner: `npm run eval`.
 *
 * Builds a temporary store from a realistic fixture corpus, asks every question
 * and reports recall@1 / recall@5 / MRR plus the questions that missed. Exits
 * non-zero when recall@5 drops below the threshold so it can gate CI.
 */

import { buildEvalStore, failuresByKind, runEval } from "./eval-support.ts";

const RECALL5_FLOOR = 0.95;

const { index, cleanup } = await buildEvalStore();
try {
	const report = await runEval(index);
	const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
	console.log("memoria recall evaluation");
	console.log(`  questions: ${report.questions}`);
	console.log(`  recall@1:  ${pct(report.recall1)}`);
	console.log(`  recall@5:  ${pct(report.recall5)}`);
	console.log(`  MRR:       ${report.mrr.toFixed(3)}`);
	console.log(`  avg query: ${report.avgMs.toFixed(2)}ms`);

	const failures = failuresByKind(report, 1);
	if (failures.size > 0) {
		console.log("\nquestions not ranked first:");
		for (const [kind, outcomes] of failures) {
			for (const outcome of outcomes) {
				console.log(`  [${kind}] "${outcome.question.query}" -> rank ${outcome.rank || "miss"} (got: ${outcome.titles.slice(0, 3).join(" | ")})`);
			}
		}
	}
	const misses = report.outcomes.filter((outcome) => outcome.rank === 0 || outcome.rank > 5);
	if (misses.length > 0) {
		console.log("\nrecall@5 misses:");
		for (const outcome of misses) {
			console.log(`  [${outcome.question.kind}] "${outcome.question.query}" -> expected ${outcome.question.expect} (got: ${outcome.titles.slice(0, 5).join(" | ")})`);
		}
	}
	if (report.recall5 < RECALL5_FLOOR) {
		console.error(`\nFAIL: recall@5 ${pct(report.recall5)} is below the ${pct(RECALL5_FLOOR)} floor`);
		process.exitCode = 1;
	}
} finally {
	await cleanup();
}
