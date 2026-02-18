import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export const serverMetadata = {
	implementation: {
		name: 'epic-agent-mcp',
		version: '1.0.0',
	},
	instructions: `
Quick start
- Call 'list_workshops' first to discover valid workshop slugs and coverage metadata.
- Then use 'retrieve_learning_context' to fetch the actual indexed context you will use for quiz authoring.
- If you have a topic and need to find where it is taught, use 'search_topic_context' (semantic when Vectorize + AI are configured; keyword fallback otherwise).
- If you need code-change focused context, use 'retrieve_diff_context' (and optionally 'focus' on a filename/symbol).
- If the learner asks to be quizzed or wants to solidify understanding, call 'retrieve_quiz_instructions' and follow the protocol (one question at a time).

Default behavior
- Tools return human-readable markdown in 'content' and machine-friendly data in 'structuredContent'.
- 'list_workshops.all' defaults to true (fetches all pages). Set { all: false } to paginate manually with { limit, cursor }.
- Retrieval tools may truncate payloads; check 'truncated' and keep calling with 'cursor' until you have enough context.
- 'search_topic_context' falls back to keyword search when Vectorize/AI bindings are unavailable; check 'mode', 'vectorSearchAvailable', and 'warnings'.
- 'retrieve_learning_context' is deterministic for explicit scopes, but { random: true } is non-deterministic.

How to chain tools safely
- Use 'list_workshops' to obtain a valid 'workshop' slug before calling any scoped retrieval tool.
- Prefer using 'cursor' pagination instead of increasing 'maxChars' aggressively.
- When scoping 'search_topic_context', 'stepNumber' requires 'exerciseNumber' (and optionally 'workshop').

Common patterns & examples
- "What workshops are indexed?" → call 'list_workshops' with {}
- "Get context for workshop X exercise 2" → call 'retrieve_learning_context' with { workshop: "x", exerciseNumber: 2 }
- "Find where 'closures' are taught" → call 'search_topic_context' with { query: "closures", limit: 5 }
- "Show diffs for workshop X exercise 2 step 1" → call 'retrieve_diff_context' with { workshop: "x", exerciseNumber: 2, stepNumber: 1 }
	`.trim(),
}

export const readOnlyToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} satisfies ToolAnnotations

export const nonDeterministicReadOnlyToolAnnotations = {
	...readOnlyToolAnnotations,
	idempotentHint: false,
} satisfies ToolAnnotations

export const openWorldReadOnlyToolAnnotations = {
	...readOnlyToolAnnotations,
	openWorldHint: true,
} satisfies ToolAnnotations

export const toolsMetadata = {
	list_workshops: {
		name: 'list_workshops',
		title: 'List Workshops',
		description: `
List indexed workshops and metadata coverage.

Behavior:
- By default, this tool fetches all pages so callers get the full list.
- Set { all: false } to paginate manually using { limit, cursor } and the returned nextCursor.

Returns (structuredContent): { workshops: Array<{ workshop, title, product?, exerciseCount, hasDiffs, lastIndexedAt }>, nextCursor? }

Examples:
- "Show me everything" → {}
- "Fetch 1 page at a time" → { all: false, limit: 20 }
- "Only workshops with diffs" → { hasDiffs: true }

Next:
- Use the returned 'workshop' slug with 'retrieve_learning_context', 'retrieve_diff_context', or 'search_topic_context'.
		`.trim(),
		annotations: readOnlyToolAnnotations,
	},

	retrieve_learning_context: {
		name: 'retrieve_learning_context',
		title: 'Retrieve Learning Context',
		description: `
Retrieve indexed workshop context sections for quiz authoring.

Modes:
- Explicit scope: provide { workshop, exerciseNumber, stepNumber? }
- Random scope: provide { random: true } (non-deterministic)

Behavior:
- Responses may be truncated; when truncated is true, pass nextCursor back as cursor to continue.
- Explicit scope is deterministic; random scope is not.

Returns (structuredContent): { workshop, exerciseNumber, stepNumber?, sections[], truncated, nextCursor? }

Examples:
- "Get context for exercise 1" → { workshop: "mcp-fundamentals", exerciseNumber: 1 }
- "Pick a random exercise" → { random: true }
- "Continue after truncation" → { workshop: "...", exerciseNumber: 1, cursor: "<nextCursor>" }

Next:
- If you need code-change context, call 'retrieve_diff_context' for the same scope.
- If you need where a topic is taught, call 'search_topic_context' with a query (and optional scope filters).
		`.trim(),
		annotations: nonDeterministicReadOnlyToolAnnotations,
	},

	retrieve_diff_context: {
		name: 'retrieve_diff_context',
		title: 'Retrieve Diff Context',
		description: `
Retrieve diff-focused context sections for a scoped workshop exercise/step.

Behavior:
- Optional focus filtering is case-insensitive; whitespace-only focus values are treated as omitted.
- Responses may be truncated; when truncated is true, pass nextCursor back as cursor to continue.

Returns (structuredContent): { workshop, exerciseNumber, stepNumber?, diffSections[], truncated, nextCursor? }

Examples:
- "Get all diff context for step 1" → { workshop: "mcp-fundamentals", exerciseNumber: 1, stepNumber: 1 }
- "Focus on a file" → { workshop: "...", exerciseNumber: 1, stepNumber: 1, focus: "src/index.ts" }

Next:
- If focus yields no matches, adjust focus or omit it to see the full diff context.
- Pair with 'retrieve_learning_context' to get the surrounding non-diff context for the same scope.
		`.trim(),
		annotations: readOnlyToolAnnotations,
	},

	search_topic_context: {
		name: 'search_topic_context',
		title: 'Search Topic Context',
		description: `
Search indexed workshop content to find where a topic is taught.

Behavior:
- Uses semantic vector search when Vectorize + Workers AI bindings are configured.
- Falls back to keyword search when vector bindings are absent or when vector search fails.
- If you provide stepNumber, you must also provide exerciseNumber.

Returns (structuredContent): { query, limit, mode, vectorSearchAvailable, warnings?, matches[] }

Examples:
- "Find closures" → { query: "closures" }
- "Search within a workshop" → { query: "durable objects", workshop: "mcp-fundamentals" }
- "Search within a specific step" → { query: "OAuth", workshop: "...", exerciseNumber: 1, stepNumber: 1 }

Next:
- Use the returned scope metadata (workshop/exercise/step) to call 'retrieve_learning_context' or 'retrieve_diff_context'.
		`.trim(),
		annotations: openWorldReadOnlyToolAnnotations,
	},

	retrieve_quiz_instructions: {
		name: 'retrieve_quiz_instructions',
		title: 'Retrieve Quiz Instructions',
		description: `
Return evidence-based instructions for conducting a quiz (one question at a time, immediate feedback, spaced retrieval).

Use this tool when:
- The learner asks to be quizzed.
- You want to solidify understanding with retrieval practice.

Returns (structuredContent): { tool, version, topic, learnerGoal, targetQuestionCount, instructionsMarkdown, checklist, questionTypes, closingSteps }

Examples:
- "Quiz me on closures" → { topic: "JavaScript closures" }
- "Short quiz" → { topic: "OAuth", questionCount: 5 }

Next:
- Follow the protocol in the markdown output.
- Pair with 'retrieve_learning_context' or 'search_topic_context' to gather source material for questions.
		`.trim(),
		annotations: readOnlyToolAnnotations,
	},
} as const
