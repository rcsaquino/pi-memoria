/**
 * memoria benchmark: index build, load, save and search latency.
 *
 * Run: node tests/bench.ts [docs...] [--real] [--binary|--json]
 *
 * By default the corpus uses a 50-word vocabulary with 60-word documents, which
 * is a deliberate worst case: every term has a long posting list and BM25 has to
 * score almost the whole store. Pass `--real` for a realistic high-vocabulary
 * corpus (thousands of distinct terms, short posting lists), which is what a
 * real library looks like. `--binary` measures the binary index format.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../src/index-engine.ts";
import { createMemory, ensureStore } from "../src/store.ts";

const WORDS = `alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega
postgres sqlite kubernetes docker deploy release incident latency throughput cache redis queue worker migration schema index query
alice bob carol dave erin frank grace heidi ivan judy mallory niaj olivia peggy trent victor wendy yves zara
coffee tea milk oat lactose gluten vegan nut allergy dark-mode keyboard vim emacs tmux zsh bash fish
project nightingale falcon orion atlas zenith nova horizon beacon summit lighthouse`.split(/\s+/);

/** Realistic vocabulary: common words plus generated technical identifiers. */
const REAL_WORDS = [
	"the","user","prefers","project","service","database","migration","deploy","release","incident",
	"performance","latency","throughput","cache","queue","worker","schema","query","index","storage",
	"meeting","decision","vendor","budget","contract","policy","remote","office","team","rotation",
	"oncall","escalation","feedback","interview","candidate","security","secret","vault","backup","restore",
	"coffee","milk","lunch","travel","hotel","flight","morning","afternoon","evening","weekend",
	"alice","bob","carol","dave","erin","frank","grace","heidi","ivan","judy",
	"postgres","sqlite","kubernetes","docker","terraform","grafana","datadog","snowflake","dbt","redis",
	"typescript","python","rust","golang","react","vue","node","deno","bun","jvm",
	"refactor","cleanup","rename","upgrade","downgrade","rollback","hotfix","patch","release","tag",
	"dashboard","alert","threshold","timeout","retry","backoff","circuit","breaker","shard","replica",
];
const REAL_IDENTIFIERS = Array.from({ length: 4000 }, (_, i) => `svc${i.toString(36)}${i % 7 === 0 ? "-api" : ""}`);

function realisticSentence(rng: () => number, length = 24): string {
	const parts: string[] = [];
	for (let i = 0; i < length; i += 1) {
		const roll = rng();
		if (roll < 0.55) parts.push(REAL_WORDS[Math.floor(rng() * REAL_WORDS.length)]);
		else if (roll < 0.9) parts.push(REAL_IDENTIFIERS[Math.floor(rng() * REAL_IDENTIFIERS.length)]);
		else parts.push(`${REAL_WORDS[Math.floor(rng() * REAL_WORDS.length)]}-${Math.floor(rng() * 900 + 100)}`);
	}
	return `${parts.join(" ")}.`;
}

function randomSentence(rng: () => number, length = 16): string {
	const parts: string[] = [];
	for (let i = 0; i < length; i += 1) parts.push(WORDS[Math.floor(rng() * WORDS.length)]);
	return `${parts.join(" ")}.`;
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface BenchOptions {
	realistic: boolean;
	format: string;
}

async function bench(count: number, options: BenchOptions): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), `memoria-bench-${count}-`));
	const rng = mulberry32(42);
	const sentence = options.realistic ? realisticSentence : randomSentence;
	const vocabulary = options.realistic ? REAL_WORDS : WORDS;
	await ensureStore(root, 5000);
	const createStarted = performance.now();
	for (let i = 0; i < count; i += 1) {
		const titleWords = options.realistic
			? [vocabulary[Math.floor(rng() * vocabulary.length)], `note-${i}`]
			: [vocabulary[i % vocabulary.length], vocabulary[(i * 7) % vocabulary.length]];
		await createMemory(root, {
			title: `${titleWords.join(" ")} note ${i}`,
			content: `${sentence(rng, 30)}\n\n${sentence(rng, 30)}`,
			category: `cat${i % 12}`,
			tags: [vocabulary[Math.floor(rng() * vocabulary.length)], `tag${i % 97}`],
			summary: sentence(rng, 12),
		});
	}
	const createMs = performance.now() - createStarted;

	const buildIndex = new MemoryIndex(root, { indexFormat: options.format });
	const loadStarted = performance.now();
	await buildIndex.load();
	const coldLoadMs = performance.now() - loadStarted;
	const saveStarted = performance.now();
	await buildIndex.save();
	const saveMs = performance.now() - saveStarted;

	const warm = new MemoryIndex(root);
	const warmStarted = performance.now();
	await warm.load();
	const warmLoadMs = performance.now() - warmStarted;

	const queries = options.realistic
		? [
				"postgres migration rollback",
				"alice prefers coffee",
				"kubernetes replica shard",
				"release incident timeout retry",
				"svc3k-api dashboard alert",
				"budget vendor contract",
				`svc${(count % 4000).toString(36)}`,
				`note-${Math.floor(count / 2)}`,
			]
		: [
				"lactose intolerance",
				"postgres kubernetes deploy",
				"what does alice drink",
				"release incident postmortem",
				"optimal cache latency",
				"nightingale",
				"cat3 note",
				`note ${Math.floor(count / 2)}`,
			];
	// Warm up.
	for (const query of queries) await warm.search(query);
	const iterations = 500;
	const searchStarted = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		await warm.search(queries[i % queries.length]);
	}
	const searchMs = (performance.now() - searchStarted) / iterations;

	const prefixStarted = performance.now();
	for (let i = 0; i < 200; i += 1) await warm.search("postgr");
	const prefixMs = (performance.now() - prefixStarted) / 200;
	const fuzzyStarted = performance.now();
	for (let i = 0; i < 200; i += 1) await warm.search("kubernets deploi");
	const fuzzyMs = (performance.now() - fuzzyStarted) / 200;

	console.log(
		[
			`docs=${String(count).padStart(6)}`,
			`create=${createMs.toFixed(0).padStart(6)}ms`,
			`index=${coldLoadMs.toFixed(1).padStart(7)}ms`,
			`bytes=${String(buildIndex.persistedBytes).padStart(9)}`,
			`fmt=${buildIndex.persistedFormat.padEnd(6)}`,
			`save=${saveMs.toFixed(1).padStart(7)}ms`,
			`reload=${warmLoadMs.toFixed(1).padStart(7)}ms`,
			`search=${searchMs.toFixed(3).padStart(7)}ms`,
			`prefix=${prefixMs.toFixed(3).padStart(7)}ms`,
			`fuzzy=${fuzzyMs.toFixed(3).padStart(7)}ms`,
			`terms=${warm.terms.length}`,
		].join("  "),
	);
	await rm(root, { recursive: true, force: true });
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const sizes = args.filter((argument) => !argument.startsWith("--")).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const targets = sizes.length > 0 ? sizes : [100, 1000, 5000];
const options: BenchOptions = {
	realistic: flags.has("--real"),
	format: flags.has("--json") ? "json" : flags.has("--binary") ? "binary" : "auto",
};
console.log(`memoria benchmark (${options.realistic ? "realistic high-vocabulary corpus" : "worst-case tiny-vocabulary corpus"}, index=${options.format})`);
for (const target of targets) await bench(target, options);
