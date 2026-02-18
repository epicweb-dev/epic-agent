import { z } from 'zod'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

const workshopSummaryOutputSchema = z.object({
	workshop: z.string(),
	title: z.string(),
	exerciseCount: z.number().int().nonnegative(),
	hasDiffs: z.boolean(),
	lastIndexedAt: z.string(),
	product: z.string().optional(),
})

const retrievalSectionOutputSchema = z.object({
	label: z.string(),
	kind: z.string(),
	content: z.string(),
	sourcePath: z.string().optional(),
	exerciseNumber: z.number().int().positive().optional(),
	stepNumber: z.number().int().positive().optional(),
})

const topicMatchOutputSchema = z.object({
	score: z.number(),
	workshop: z.string(),
	exerciseNumber: z.number().int().positive().optional(),
	stepNumber: z.number().int().positive().optional(),
	sectionKind: z.string().optional(),
	sectionLabel: z.string().optional(),
	sourcePath: z.string().optional(),
	chunk: z.string(),
	vectorId: z.string(),
})

const quizInstructionsOutputSchema = z.object({
	tool: z.literal('retrieve_quiz_instructions'),
	version: z.literal('1'),
	topic: z.string().nullable(),
	learnerGoal: z.string().nullable(),
	targetQuestionCount: z.number().int().positive(),
	instructionsMarkdown: z.string(),
	checklist: z.array(z.string()),
	questionTypes: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			promptTemplate: z.string(),
			whatToListenFor: z.array(z.string()),
			followUps: z.array(z.string()),
		}),
	),
	closingSteps: z.array(z.string()),
})

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

Use when:
- You need valid workshop slugs to scope other tools.
- You want to filter by product or diff availability.
- You want to inspect indexing coverage (exercise counts, last indexed time).
		`.trim(),
		annotations: readOnlyToolAnnotations,
		outputSchema: z.object({
			workshops: z.array(workshopSummaryOutputSchema),
			nextCursor: z.string().optional(),
		}),
	},

	retrieve_learning_context: {
		name: 'retrieve_learning_context',
		title: 'Retrieve Learning Context',
		description: `
Retrieve indexed workshop context sections for quiz authoring.

Use when:
- You need source material to create questions or explanations for a specific scope.
- You want a random indexed scope to practice or sample.
- You need to page through large contexts using cursors.
		`.trim(),
		annotations: nonDeterministicReadOnlyToolAnnotations,
		outputSchema: z.object({
			workshop: z.string(),
			exerciseNumber: z.number().int().positive(),
			stepNumber: z.number().int().positive().optional(),
			sections: z.array(retrievalSectionOutputSchema),
			truncated: z.boolean(),
			nextCursor: z.string().optional(),
		}),
	},

	retrieve_diff_context: {
		name: 'retrieve_diff_context',
		title: 'Retrieve Diff Context',
		description: `
Retrieve diff-focused context sections for a scoped workshop exercise/step.

Use when:
- You need code-change context for an exercise or step.
- You want to narrow down diff sections using a focus string.
- You need to page through large diffs using cursors.
		`.trim(),
		annotations: readOnlyToolAnnotations,
		outputSchema: z.object({
			workshop: z.string(),
			exerciseNumber: z.number().int().positive(),
			stepNumber: z.number().int().positive().optional(),
			diffSections: z.array(retrievalSectionOutputSchema),
			truncated: z.boolean(),
			nextCursor: z.string().optional(),
		}),
	},

	search_topic_context: {
		name: 'search_topic_context',
		title: 'Search Topic Context',
		description: `
Search indexed workshop content to find where a topic is taught.

Use when:
- You have a concept/question and want to locate where it is covered.
- You want ranked matches (semantic when configured, keyword fallback otherwise).
- You want to identify a scope to retrieve via other tools.
		`.trim(),
		annotations: openWorldReadOnlyToolAnnotations,
		outputSchema: z.object({
			query: z.string(),
			limit: z.number().int().positive(),
			mode: z.enum(['vector', 'keyword']),
			vectorSearchAvailable: z.boolean(),
			keywordSource: z.enum(['chunks', 'sections']).nullable(),
			warnings: z.array(z.string()).optional(),
			matches: z.array(topicMatchOutputSchema),
		}),
	},

	retrieve_quiz_instructions: {
		name: 'retrieve_quiz_instructions',
		title: 'Retrieve Quiz Instructions',
		description: `
Return evidence-based instructions for conducting a quiz (one question at a time, immediate feedback, spaced retrieval).

Use this tool when:
- The learner asks to be quizzed.
- You want to solidify understanding with retrieval practice.

Use when:
- You want a consistent quiz protocol + checklist.
- You want a set of question types and follow-ups to guide the session.
		`.trim(),
		annotations: readOnlyToolAnnotations,
		outputSchema: quizInstructionsOutputSchema,
	},
} as const
