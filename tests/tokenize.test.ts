import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, tokenizeRaw, stem, splitSurfaceTokens, termCounts, editDistance, termTrigrams } from "../src/tokenize.ts";

test("splits camelCase, snake_case, kebab-case and paths", () => {
	const tokens = splitSurfaceTokens("getUserById snake_case kebab-case src/core/index.ts");
	assert.ok(tokens.includes("getuserbyid"));
	assert.ok(tokens.includes("get"));
	assert.ok(tokens.includes("user"));
	assert.ok(tokens.includes("snake_case"));
	assert.ok(tokens.includes("snake"));
	assert.ok(tokens.includes("case"));
	assert.ok(tokens.includes("kebab-case"));
	assert.ok(tokens.includes("src/core/index.ts"));
	assert.ok(tokens.includes("src"));
	assert.ok(tokens.includes("index.ts"));
});

test("stopword removal keeps identifiers and numbers", () => {
	const tokens = tokenizeRaw("the user is at v1.2.3 with 42 items");
	assert.ok(!tokens.includes("the"));
	assert.ok(tokens.includes("user"));
	assert.ok(tokens.includes("v1.2.3"));
	assert.ok(tokens.includes("42"));
	assert.ok(tokens.includes("items"));
});

test("stemming converges verb and plural variants", () => {
	assert.equal(stem("optimizing"), stem("optimized"));
	assert.equal(stem("optimization"), stem("optimize"));
	assert.equal(stem("studies"), "study");
	assert.equal(stem("running"), "run");
	assert.equal(stem("king"), "king");
	assert.equal(stem("class"), "class");
	assert.equal(stem("status"), "status");
});

test("tokenize emits both surface and stemmed forms", () => {
	const tokens = tokenize("optimizing");
	assert.ok(tokens.includes("optimizing"));
	assert.ok(tokens.includes("optimiz"));
});

test("preserves diacritics folding", () => {
	const tokens = tokenizeRaw("café naïve");
	assert.ok(tokens.includes("cafe"));
	assert.ok(tokens.includes("naive"));
});

test("CJK text yields unigrams and bigrams", () => {
	const tokens = tokenizeRaw("東京タワー");
	assert.ok(tokens.includes("東"));
	assert.ok(tokens.includes("東京"));
	assert.ok(tokens.includes("タワー"));
});

test("term frequencies are counted", () => {
	const counts = termCounts("apple apple banana");
	assert.equal(counts.get("apple"), 2);
	assert.equal(counts.get("banana"), 1);
});

test("edit distance respects the band", () => {
	assert.equal(editDistance("kitten", "sitting", 3), 3);
	assert.equal(editDistance("memory", "memry", 2), 1);
	assert.ok(editDistance("memory", "completely", 2) > 2);
});

test("trigrams include padding", () => {
	const grams = termTrigrams("cat");
	assert.deepEqual(grams, ["^ca", "cat", "at$"]);
});
