import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export const serverMetadata = {
	name: 'epic-agent-mcp',
	version: '1.1.0',
	instructions: [
		'Quick start',
		'- Call `list_workshops` first to discover valid workshop slugs and whether diff context is available (`hasDiffs`).',
		'- If the learner asks to be quizzed: call `retrieve_quiz_instructions` first, then fetch source material with `retrieve_learning_context` (explicit scope or `random: true`) and ask one question at a time.',
		'- To locate where a topic is taught: call `search_topic_context`, then use the returned scope (`workshop`, `exerciseNumber`, `stepNumber`) with `retrieve_learning_context` or `retrieve_diff_context`.',
		'',
		'Default behavior',
		'- `list_workshops`: `all` defaults to `true` (fetches all pages). Set `all: false` to paginate manually with `limit` + `cursor`.',
		'- `retrieve_learning_context` / `retrieve_diff_context`: use `maxChars` to limit payload size, and use `cursor` + `nextCursor` to continue when `truncated: true`.',
		'- `search_topic_context`: uses semantic (Vectorize + Workers AI) search when bindings are configured; otherwise falls back to a case-insensitive keyword search. The response includes `mode`, `vectorSearchAvailable`, and optional `warnings`.',
		'',
		'How to chain tools safely',
		'- Workshop slugs come from `list_workshops`.',
		'- `exerciseNumber` and `stepNumber` are scoped per workshop; when scoping `search_topic_context` by `stepNumber`, you must also provide `exerciseNumber`.',
		'- Always check `truncated` + `nextCursor` and loop until you have the context you need.',
		'',
		'Common patterns & examples',
		'- "Quiz me on X" → `retrieve_quiz_instructions` → `retrieve_learning_context` (explicit or random) → ask questions one at a time.',
		'- "Where is X taught?" → `search_topic_context` → `retrieve_learning_context` for the best match scope → summarize + cite.',
		'- "Show me the diff for exercise Y" → `retrieve_diff_context` (optionally `focus`) → if truncated, call again with `cursor`.',
		'',
		'Resources',
		'- `epic://server`: server info + links to docs.',
		'- `epic://docs/mcp-server-best-practices`: guidance for designing MCP servers (tool metadata, annotations, schemas, responses).',
	].join('\n'),
} as const

type ToolMetadata = {
	title: string
	description: string
	annotations: ToolAnnotations
}

const readOnlyAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: false,
} satisfies ToolAnnotations

export const toolsMetadata = {
	list_workshops: {
		title: 'List Workshops',
		description: [
			'List indexed workshops and coverage metadata.',
			'',
			'Inputs:',
			'- limit?: number (1-100, default: 100) — max workshops per page when `all: false`, or page size when `all: true`.',
			'- all?: boolean (default: true) — when true, fetch all pages; when false, return a single page and a `nextCursor` when more results exist.',
			'- cursor?: string — pagination cursor from a previous call when `all: false`.',
			'- product?: string — filter by product label (exact match).',
			'- hasDiffs?: boolean — filter by whether diff sections exist for the workshop.',
			'',
			'Returns: { workshops: Array<{ workshop, title, product?, exerciseCount, hasDiffs, lastIndexedAt }>, nextCursor? }',
			'',
			'Examples:',
			'- "List everything" → {}',
			'- "First page only" → { all: false, limit: 25 }',
			'- "Next page" → { all: false, limit: 25, cursor: "<nextCursor>" }',
			'',
			'Next: Use `retrieve_learning_context` (or `retrieve_diff_context`) with a chosen `workshop` + `exerciseNumber`.',
		].join('\n'),
		annotations: {
			...readOnlyAnnotations,
			idempotentHint: true,
		},
	},
	retrieve_learning_context: {
		title: 'Retrieve Learning Context',
		description: [
			'Retrieve ordered workshop context sections for quiz authoring.',
			'',
			'Inputs (explicit scope mode):',
			'- workshop: string (required) — workshop slug from `list_workshops`.',
			'- exerciseNumber: number (required) — exercise number within the workshop.',
			'- stepNumber?: number — optional step number to narrow scope.',
			'- random?: false — omit or set false for explicit mode.',
			'',
			'Inputs (random mode):',
			'- random: true (required) — sample a random indexed exercise.',
			'',
			'Shared inputs:',
			'- maxChars?: number — max characters to return (server default + hard max apply).',
			'- cursor?: string — opaque continuation cursor from a previous response.',
			'',
			'Returns: { workshop, exerciseNumber, stepNumber?, sections: Array<{ label, kind, content, sourcePath?, exerciseNumber?, stepNumber? }>, truncated, nextCursor? }',
			'',
			'Examples:',
			'- "Exercise 1 step 1" → { workshop: "mcp-fundamentals", exerciseNumber: 1, stepNumber: 1 }',
			'- "Random scope" → { random: true, maxChars: 50000 }',
			'- "Continue" → { workshop: "...", exerciseNumber: 1, cursor: "<nextCursor>" }',
			'',
			'Next: If `truncated: true`, call again with `cursor: nextCursor`. Pair with `retrieve_quiz_instructions` when running a quiz.',
		].join('\n'),
		annotations: {
			...readOnlyAnnotations,
			idempotentHint: false, // random mode is explicitly non-deterministic
		},
	},
	retrieve_diff_context: {
		title: 'Retrieve Diff Context',
		description: [
			'Retrieve diff-focused context sections for an indexed workshop exercise (and optional step).',
			'',
			'Inputs:',
			'- workshop: string (required) — workshop slug from `list_workshops`.',
			'- exerciseNumber: number (required).',
			'- stepNumber?: number — optional step number to narrow scope.',
			'- focus?: string — optional case-insensitive filter applied to section label/kind/source path/content; whitespace-only is treated as omitted.',
			'- maxChars?: number — max characters to return (server default + hard max apply).',
			'- cursor?: string — opaque continuation cursor from a previous response.',
			'',
			'Returns: { workshop, exerciseNumber, stepNumber?, diffSections: Array<{ label, kind, content, sourcePath?, exerciseNumber?, stepNumber? }>, truncated, nextCursor? }',
			'',
			'Examples:',
			'- "All diffs for exercise 1" → { workshop: "mcp-fundamentals", exerciseNumber: 1 }',
			'- "Only diffs mentioning src/index.ts" → { workshop: "mcp-fundamentals", exerciseNumber: 1, focus: "src/index.ts" }',
			'',
			'Next: If you get a focus-specific no-match error, broaden/adjust `focus` (or omit it). If `truncated: true`, continue with `cursor: nextCursor`.',
		].join('\n'),
		annotations: {
			...readOnlyAnnotations,
			idempotentHint: true,
		},
	},
	search_topic_context: {
		title: 'Search Topic Context',
		description: [
			'Search indexed workshop content to locate where a topic is taught.',
			'Uses semantic vector search when configured (Vectorize + Workers AI) and falls back to keyword search otherwise.',
			'',
			'Inputs:',
			'- query: string (required) — at least 3 non-whitespace characters.',
			'- limit?: number (1-20, default: 8) — max matches to return.',
			'- workshop?: string — optional workshop slug filter.',
			'- exerciseNumber?: number — optional exercise filter (requires `workshop` only if you want workshop-scoped validation).',
			'- stepNumber?: number — optional step filter; requires `exerciseNumber`.',
			'',
			'Returns: { query, limit, mode: "vector" | "keyword", vectorSearchAvailable, warnings?, matches: Array<{ score, workshop, exerciseNumber?, stepNumber?, sectionKind?, sectionLabel?, sourcePath?, chunk, vectorId }> }',
			'',
			'Examples:',
			'- "Find where MCP is taught" → { query: "model context protocol" }',
			'- "Within a workshop" → { query: "oauth", workshop: "mcp-fundamentals" }',
			'- "Within a step" → { query: "durable object", workshop: "mcp-fundamentals", exerciseNumber: 1, stepNumber: 1 }',
			'',
			'Next: Use the returned scope (workshop/exercise/step) with `retrieve_learning_context` to get full sections for quiz authoring or explanation.',
		].join('\n'),
		annotations: {
			...readOnlyAnnotations,
			idempotentHint: true,
			openWorldHint: true, // may call Workers AI / Vectorize
		},
	},
	retrieve_quiz_instructions: {
		title: 'Retrieve Quiz Instructions',
		description: [
			'Return evidence-based instructions for running a quiz (one question at a time, immediate feedback, spaced retrieval).',
			'Use when the learner wants to be quizzed or to solidify understanding.',
			'',
			'Inputs:',
			'- topic?: string — optional quiz topic label.',
			'- learnerGoal?: string — optional learner goal to optimize for.',
			'- questionCount?: number (1-20, default: 8) — desired number of questions.',
			'',
			'Returns: { tool, version, topic, learnerGoal, targetQuestionCount, instructionsMarkdown, checklist, questionTypes, closingSteps }',
			'',
			'Examples:',
			'- "Quiz me on closures" → { topic: "JavaScript closures", questionCount: 5 }',
			'- "Generic quiz flow" → {}',
			'',
			'Next: Use `retrieve_learning_context` or `search_topic_context` to fetch source material, then follow the protocol in `instructionsMarkdown`.',
		].join('\n'),
		annotations: {
			...readOnlyAnnotations,
			idempotentHint: true,
		},
	},
} satisfies Record<string, ToolMetadata>

export const resourcesMetadata = {
	server: {
		name: 'server',
		uri: 'epic://server',
		title: 'Epic Agent MCP Server',
		description: 'Server overview, tool surface, and documentation links.',
		mimeType: 'text/markdown',
	},
	mcp_server_best_practices: {
		name: 'mcp_server_best_practices',
		uri: 'epic://docs/mcp-server-best-practices',
		title: 'MCP Server Best Practices',
		description:
			'Best practices for MCP server instructions, tool metadata, annotations, schemas, responses, resources, and prompts.',
		mimeType: 'text/markdown',
	},
} as const

export const promptsMetadata = {
	quiz_me: {
		title: 'Quiz me',
		description:
			'Conversation starter for a quiz session. Asks for topic/scope, then uses the retrieval tools + quiz protocol.',
	},
	find_where_topic_is_taught: {
		title: 'Find where a topic is taught',
		description:
			'Conversation starter that uses `search_topic_context` to find where a concept is covered, then drills into the best match.',
	},
} as const
