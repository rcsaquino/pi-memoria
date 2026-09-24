/**
 * Fixtures for the recall evaluation: a realistic corpus plus questions whose
 * expected note is known. Kept separate from the test files so the runner
 * (`tests/eval.ts`) and the assertion suite (`tests/eval.test.ts`) share one
 * source of truth.
 */

export interface EvalNote {
	topic: string;
	content: string;
	category: string;
	tags: string[];
	aliases?: string[];
	related?: string[];
	supersedes?: string[];
	label?: string;
}

export interface EvalQuestion {
	/** What the user would ask. */
	query: string;
	/** `relPath` of the note that must be retrieved. */
	expect: string;
	/** What makes this question hard (for reporting). */
	kind: "keyword" | "paraphrase" | "alias" | "typo" | "identifier" | "cjk" | "relational" | "supersedes";
}

export const EVAL_NOTES: EvalNote[] = [
	{
		topic: "Alice",
		category: "people",
		content: "Alice drinks oat milk in her flat white and avoids dairy; she is lactose intolerant. She is a staff engineer on the platform team.",
		tags: ["alice", "food", "dairy"],
		aliases: ["Alice Smith"],
	},
	{
		topic: "Bob",
		category: "people",
		content: "Bob is John's father. He is a retired teacher, lives in Cebu, and plays chess on Sundays.",
		tags: ["family", "cebu"],
		aliases: ["Robert", "Bobby", "John's father", "dad", "my dad"],
	},
	{
		topic: "Project Nightingale",
		category: "projects",
		content: "Project Nightingale runs on Postgres 16 with pgvector. Migrations live in db/migrations and deploys use the release script.",
		tags: ["nightingale", "postgres"],
	},
	{
		topic: "Deploy process",
		category: "workflows",
		content: "Deploys happen on Thursday mornings. Run npm run build, then npm run release.",
		tags: ["deploy", "release"],
	},
	{
		topic: "Deploy schedule update",
		category: "workflows",
		content: "Deploys moved to Tuesday mornings after the March incident.",
		tags: ["deploy", "release"],
		supersedes: ["Deploy process"],
	},
	{
		topic: "Incident 2025-03",
		category: "decisions",
		content: "The outage was caused by a misconfigured liveness probe on the Kubernetes cluster; the fix was to raise initialDelaySeconds from 5 to 30.",
		tags: ["incident", "kubernetes"],
	},
	{
		topic: "Cold start optimization",
		category: "knowledge",
		content: "Cold starts were optimized by lazy-loading the AWS SDK and memoizing config parsing; p95 dropped from 1.2s to 340ms.",
		tags: ["performance", "aws"],
	},
	{
		topic: "Commit conventions",
		category: "preferences",
		content: "The user prefers terse conventional commits and dislikes multi-paragraph commit bodies.",
		tags: ["git", "commits"],
	},
	{
		topic: "Editor preferences",
		category: "preferences",
		content: "The user uses vim keybindings, four-space indentation, and never wants tabs.",
		tags: ["editor", "vim"],
	},
	{
		topic: "Dietary preferences",
		category: "preferences",
		content: "The user dislikes cilantro and durian and avoids spicy food.",
		tags: ["food"],
	},
	{
		topic: "Tokyo office",
		category: "knowledge",
		content: "The Tokyo office is on the 12th floor of the Shibuya tower; the wifi network is called sakura-5g.",
		tags: ["tokyo", "office"],
	},
	{
		topic: "Tokyo trip",
		category: "knowledge",
		content: "東京タワーは港区にあり、展望台は150メートルです。週末は人が多い。",
		tags: ["tokyo", "travel"],
	},
	{
		topic: "On-call rotation",
		category: "workflows",
		content: "On-call rotates weekly; the primary is pinged in #incidents and is expected to acknowledge within five minutes.",
		tags: ["oncall"],
	},
	{
		topic: "Pager escalation",
		category: "workflows",
		content: "If the on-call does not acknowledge, the secondary is paged after 10 minutes and the incident commander after 20.",
		tags: ["oncall", "escalation"],
	},
	{
		topic: "Remote work policy",
		category: "decisions",
		content: "The team is remote-first and meets in person twice a year for a week-long offsite.",
		tags: ["remote", "policy"],
	},
	{
		topic: "Analytics warehouse",
		category: "projects",
		content: "Analytics serves dashboards from a Snowflake warehouse refreshed hourly by dbt models.",
		tags: ["analytics", "snowflake"],
	},
	{
		topic: "Vendor contract",
		category: "knowledge",
		content: "The Datadog contract renews each August and covers 40 hosts with a 12-month term.",
		tags: ["vendor", "datadog"],
	},
	{
		topic: "Security baseline",
		category: "decisions",
		content: "SSH password authentication is disabled everywhere and secrets live in 1Password vaults only.",
		tags: ["security"],
	},
	{
		topic: "Legacy monolith",
		category: "projects",
		content: "The legacy monolith is scheduled for sunset in 2027; new features go into the new services only.",
		tags: ["migration", "legacy"],
	},
	{
		topic: "Machine learning notebook",
		category: "knowledge",
		content: "A feature store was evaluated but rejected in favour of a simple Postgres materialized view.",
		tags: ["ml", "feature-store"],
	},
	{
		topic: "Standup format",
		category: "workflows",
		content: "Standups are async in Slack before 10:00 and the weekly sync is on Monday afternoons.",
		tags: ["standup"],
	},
	{
		topic: "Kubernetes cluster",
		category: "knowledge",
		content: "The production cluster runs Kubernetes 1.31 on EKS in eu-west-1 with three node groups.",
		tags: ["kubernetes", "eks"],
	},
	{
		topic: "Interview process",
		category: "workflows",
		content: "Candidate interviews are two technical rounds plus a systems design round; feedback is due within 24 hours.",
		tags: ["hiring"],
	},
	{
		topic: "Office coffee machine",
		category: "knowledge",
		content: "The coffee machine is on floor three; it takes oat milk capsules from the drawer.",
		tags: ["office"],
	},
	{
		topic: "Budget planning",
		category: "decisions",
		content: "Q3 budget planning starts in June and requires vendor spend to be re-justified.",
		tags: ["budget"],
	},
	{
		topic: "Journaling habit",
		category: "preferences",
		content: "The user writes a short journal entry every evening and reviews it on Sundays.",
		tags: ["habit"],
	},
];

export const EVAL_QUESTIONS: EvalQuestion[] = [
	{ query: "who is lactose intolerant", expect: "library/people/alice.md", kind: "paraphrase" },
	{ query: "oat milk in her coffee", expect: "library/people/alice.md", kind: "paraphrase" },
	{ query: "staff engineer platform team", expect: "library/people/alice.md", kind: "keyword" },
	{ query: "Alice Smith", expect: "library/people/alice.md", kind: "alias" },
	{ query: "Robert", expect: "library/people/bob.md", kind: "alias" },
	{ query: "Bobby chess", expect: "library/people/bob.md", kind: "alias" },
	{ query: "who is John's father", expect: "library/people/bob.md", kind: "relational" },
	{ query: "where does my dad live", expect: "library/people/bob.md", kind: "relational" },
	{ query: "retired teacher in Cebu", expect: "library/people/bob.md", kind: "keyword" },
	{ query: "postgres 16 pgvector", expect: "library/projects/project-nightingale.md", kind: "identifier" },
	{ query: "where do database migrations live", expect: "library/projects/project-nightingale.md", kind: "paraphrase" },
	{ query: "Snowflake dbt refresh", expect: "library/projects/analytics-warehouse.md", kind: "keyword" },
	{ query: "when do deploys happen now", expect: "library/workflows/deploy-schedule-update.md", kind: "supersedes" },
	{ query: "release script name", expect: "library/workflows/deploy-process.md", kind: "keyword" },
	{ query: "kubernetse probe outage", expect: "library/decisions/incident-2025-03.md", kind: "typo" },
	{ query: "liveness probe fix", expect: "library/decisions/incident-2025-03.md", kind: "keyword" },
	{ query: "initialDelaySeconds", expect: "library/decisions/incident-2025-03.md", kind: "identifier" },
	{ query: "cold start p95 improvement", expect: "library/knowledge/cold-start-optimization.md", kind: "keyword" },
	{ query: "AWS SDK lazy loading", expect: "library/knowledge/cold-start-optimization.md", kind: "paraphrase" },
	{ query: "commit message style", expect: "library/preferences/commit-conventions.md", kind: "paraphrase" },
	{ query: "does the user like tabs", expect: "library/preferences/editor-preferences.md", kind: "paraphrase" },
	{ query: "vim keybindings indentation", expect: "library/preferences/editor-preferences.md", kind: "keyword" },
	{ query: "spicy food", expect: "library/preferences/dietary-preferences.md", kind: "keyword" },
	{ query: "cilantro durian", expect: "library/preferences/dietary-preferences.md", kind: "keyword" },
	{ query: "which floor is the Tokyo office", expect: "library/knowledge/tokyo-office.md", kind: "paraphrase" },
	{ query: "sakura-5g wifi", expect: "library/knowledge/tokyo-office.md", kind: "identifier" },
	{ query: "東京タワー", expect: "library/knowledge/tokyo-trip.md", kind: "cjk" },
	{ query: "on-call acknowledge five minutes", expect: "library/workflows/on-call-rotation.md", kind: "keyword" },
	{ query: "who gets paged second", expect: "library/workflows/pager-escalation.md", kind: "paraphrase" },
	{ query: "remote first offsite twice a year", expect: "library/decisions/remote-work-policy.md", kind: "keyword" },
	{ query: "password authentication disabled", expect: "library/decisions/security-baseline.md", kind: "keyword" },
	{ query: "when is the monolith retired", expect: "library/projects/legacy-monolith.md", kind: "paraphrase" },
	{ query: "feature store evaluated", expect: "library/knowledge/machine-learning-notebook.md", kind: "keyword" },
	{ query: "async standup slack", expect: "library/workflows/standup-format.md", kind: "keyword" },
	{ query: "EKS eu-west-1 node groups", expect: "library/knowledge/kubernetes-cluster.md", kind: "identifier" },
	{ query: "interview feedback deadline", expect: "library/workflows/interview-process.md", kind: "keyword" },
	{ query: "coffee machine floor three", expect: "library/knowledge/office-coffee-machine.md", kind: "keyword" },
	{ query: "Q3 budget vendor spend", expect: "library/decisions/budget-planning.md", kind: "keyword" },
	{ query: "journal entry every evening", expect: "library/preferences/journaling-habit.md", kind: "keyword" },
	{ query: "Datadog contract renewal", expect: "library/knowledge/vendor-contract.md", kind: "keyword" },
];
