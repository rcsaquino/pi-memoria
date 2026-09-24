import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontmatter, serializeFrontmatter, stringifyWithFrontmatter, parseDateValue } from "../src/frontmatter.ts";

test("parses scalar, arrays, booleans and numbers", () => {
	const source = `---\nid: mem_1\ntitle: Hello world\ntags: [a, b, "c d"]\ncount: 3\nflag: true\nempty:\nsummary: "Quoted: value"\n---\n\n# Body\n\nText.\n`;
	const split = splitFrontmatter(source);
	assert.equal(split.hasFrontmatter, true);
	assert.equal(split.frontmatter.id, "mem_1");
	assert.equal(split.frontmatter.title, "Hello world");
	assert.deepEqual(split.frontmatter.tags, ["a", "b", "c d"]);
	assert.equal(split.frontmatter.count, 3);
	assert.equal(split.frontmatter.flag, true);
	assert.equal(split.frontmatter.empty, null);
	assert.equal(split.frontmatter.summary, "Quoted: value");
	assert.equal(split.body, "# Body\n\nText.\n");
});

test("parses block arrays and block scalars", () => {
	const source = `---\ntags:\n  - one\n  - two\nnotes: |\n  line one\n  line two\nfolded: >-\n  a\n  b\n---\nbody\n`;
	const split = splitFrontmatter(source);
	assert.deepEqual(split.frontmatter.tags, ["one", "two"]);
	assert.equal(split.frontmatter.notes, "line one\nline two");
	assert.equal(split.frontmatter.folded, "a b");
	assert.equal(split.body, "body\n");
});

test("returns whole text when there is no frontmatter", () => {
	const split = splitFrontmatter("# Just a note\n");
	assert.equal(split.hasFrontmatter, false);
	assert.equal(split.body, "# Just a note\n");
});

test("unterminated frontmatter is treated as body", () => {
	const source = `---\nid: mem_1\n\nbody without fence`;
	const split = splitFrontmatter(source);
	assert.equal(split.hasFrontmatter, false);
	assert.equal(split.body, source);
});

test("serialize round-trips through the parser", () => {
	const data = {
		id: "mem_1",
		title: "A title: with colon",
		tags: ["a", "b"],
		nested: { key: "value" },
		count: 12,
		flag: false,
		multiline: "one\ntwo",
	};
	const text = serializeFrontmatter(data);
	const parsed = splitFrontmatter(`---\n${text}\n---\n\nbody`).frontmatter;
	assert.equal(parsed.id, "mem_1");
	assert.equal(parsed.title, "A title: with colon");
	assert.deepEqual(parsed.tags, ["a", "b"]);
	assert.deepEqual(parsed.nested, { key: "value" });
	assert.equal(parsed.count, 12);
	assert.equal(parsed.flag, false);
	assert.equal(parsed.multiline, "one\ntwo");
});

test("stringifyWithFrontmatter produces a parseable document", () => {
	const text = stringifyWithFrontmatter({ id: "x", title: "T" }, "# T\n\nBody");
	const split = splitFrontmatter(text);
	assert.equal(split.frontmatter.id, "x");
	assert.equal(split.body, "# T\n\nBody\n");
});

test("parseDateValue handles ISO and space separated dates", () => {
	assert.ok(parseDateValue("2025-09-24T17:34:05.123Z") > 0);
	assert.equal(parseDateValue("2025-09-24T17:34:05.123Z"), parseDateValue("2025-09-24 17:34:05.123Z"));
	assert.equal(parseDateValue("nonsense"), 0);
	assert.equal(parseDateValue(1234), 1234);
});
