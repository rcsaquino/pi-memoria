/**
 * Shared evaluation plumbing: build a temporary store from the fixture corpus
 * and score questions against it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../src/index-engine.ts";
import { createMemory, ensureStore, slugify } from "../src/store.ts";
import { EVAL_NOTES, EVAL_QUESTIONS, type EvalQuestion } from "./eval-fixtures.ts";

export interface EvalOutcome {
	question: EvalQuestion;
	/** 1-based rank of the expected note, or 0 when it was not returned. */
	rank: number;
	tookMs: number;
	/** Titles returned, for diagnosing failures. */
	titles: string[];
}

export interface EvalReport {
	questions: number;
	recall1: number;
	recall5: number;
	mrr: number;
	avgMs: number;
	outcomes: EvalOutcome[];
}

/** Expected relative path for a fixture note, without needing to create it. */
export function expectedRelPath(topic: string, category: string): string {
	return `library/${category}/${slugify(topic)}.md`;
}

/** Write the fixture corpus into a temp root and return a warm index over it. */
export async function buildEvalStore(): Promise<{ root: string; index: MemoryIndex; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "memoria-eval-"));
	await ensureStore(root, 5000);
	for (const note of EVAL_NOTES) {
		await createMemory(root, {
			topic: note.topic,
			label: note.label,
			content: note.content,
			category: note.category,
			tags: note.tags,
			aliases: note.aliases,
			related: note.related,
			supersedes: note.supersedes,
		});
	}
	const index = new MemoryIndex(root);
	await index.load();
	return {
		root,
		index,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Run every question and score recall@1, recall@5 and MRR. */
export async function runEval(index: MemoryIndex, limit = 8): Promise<EvalReport> {
	const outcomes: EvalOutcome[] = [];
	let recall1 = 0;
	let recall5 = 0;
	let mrr = 0;
	let totalMs = 0;
	for (const question of EVAL_QUESTIONS) {
		const result = await index.search(question.query, { limit, expandRelated: true });
		const rank = result.hits.findIndex((hit) => hit.doc.relPath === question.expect) + 1;
		totalMs += result.tookMs;
		if (rank === 1) recall1 += 1;
		if (rank >= 1 && rank <= 5) recall5 += 1;
		if (rank >= 1) mrr += 1 / rank;
		outcomes.push({ question, rank, tookMs: result.tookMs, titles: result.hits.map((hit) => hit.doc.title) });
	}
	const questions = EVAL_QUESTIONS.length;
	return {
		questions,
		recall1: recall1 / questions,
		recall5: recall5 / questions,
		mrr: mrr / questions,
		avgMs: totalMs / questions,
		outcomes,
	};
}

/** Group failures by the kind of question that missed. */
export function failuresByKind(report: EvalReport, withinRank = 5): Map<string, EvalOutcome[]> {
	const out = new Map<string, EvalOutcome[]>();
	for (const outcome of report.outcomes) {
		if (outcome.rank >= 1 && outcome.rank <= withinRank) continue;
		const list = out.get(outcome.question.kind) ?? [];
		list.push(outcome);
		out.set(outcome.question.kind, list);
	}
	return out;
}
