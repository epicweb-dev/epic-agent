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
