import { z } from 'zod'
import { type MCP } from './index.ts'
import { promptsMetadata } from './metadata.ts'

export function registerPrompts(agent: MCP) {
	agent.server.registerPrompt(
		'quiz_me',
		{
			title: promptsMetadata.quiz_me.title,
			description: promptsMetadata.quiz_me.description,
			argsSchema: {
				topic: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe('Quiz topic label (optional).'),
				questionCount: z.coerce
					.number()
					.int()
					.positive()
					.max(20)
					.optional()
					.describe('Target number of quiz questions (1-20, default: 8).'),
				workshop: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe(
						'Optional workshop slug to scope context retrieval. Use `list_workshops` to discover slugs.',
					),
				exerciseNumber: z.coerce
					.number()
					.int()
					.positive()
					.optional()
					.describe('Optional exercise number for scoping context retrieval.'),
				stepNumber: z.coerce
					.number()
					.int()
					.positive()
					.optional()
					.describe('Optional step number for scoping context retrieval.'),
			},
		},
		async (args) => {
			const topicLabel = args.topic ? `Topic: ${args.topic}` : 'Topic: (ask me)'
			const countLabel =
				typeof args.questionCount === 'number'
					? `Target question count: ${args.questionCount}`
					: 'Target question count: (default)'
			const scopeLines = [
				`- workshop: ${args.workshop ?? '(any)'}`,
				`- exerciseNumber: ${
					typeof args.exerciseNumber === 'number'
						? args.exerciseNumber
						: '(any)'
				}`,
				`- stepNumber: ${
					typeof args.stepNumber === 'number' ? args.stepNumber : '(any)'
				}`,
			].join('\n')

			return {
				description: promptsMetadata.quiz_me.description,
				messages: [
					{
						role: 'user' as const,
						content: {
							type: 'text' as const,
							text: [
								'I want to be quizzed. Please run a quiz session with me.',
								'',
								topicLabel,
								countLabel,
								'',
								'Preferred scope (optional):',
								scopeLines,
								'',
								'Instructions:',
								'1) Call `retrieve_quiz_instructions` first (pass `topic` and `questionCount` if provided).',
								'2) Fetch source material with `retrieve_learning_context` (use explicit scope when provided, otherwise consider `random: true`).',
								'3) Ask exactly one question at a time, wait for my attempt, then give immediate feedback.',
								'4) If context is truncated, continue with `cursor: nextCursor`.',
							].join('\n'),
						},
					},
				],
			}
		},
	)

	agent.server.registerPrompt(
		'find_where_topic_is_taught',
		{
			title: promptsMetadata.find_where_topic_is_taught.title,
			description: promptsMetadata.find_where_topic_is_taught.description,
			argsSchema: {
				query: z
					.string()
					.trim()
					.min(3)
					.describe('Search query (min 3 chars), e.g. "oauth pkce"'),
				workshop: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe('Optional workshop slug to scope search.'),
				limit: z.coerce
					.number()
					.int()
					.positive()
					.max(20)
					.optional()
					.describe('Max matches to return (1-20, default: 8).'),
			},
		},
		async (args) => {
			return {
				description: promptsMetadata.find_where_topic_is_taught.description,
				messages: [
					{
						role: 'user' as const,
						content: {
							type: 'text' as const,
							text: [
								'I want to find where a topic is taught in the indexed workshops.',
								'',
								`Query: ${args.query}`,
								`Workshop scope: ${args.workshop ?? '(any)'}`,
								`Limit: ${typeof args.limit === 'number' ? args.limit : '(default)'}`,
								'',
								'Instructions:',
								'1) Call `search_topic_context` with the query (and optional filters).',
								'2) Pick the best match, then call `retrieve_learning_context` using that match scope to get the full sections.',
								'3) Summarize where it is taught and what the learner should read next.',
							].join('\n'),
						},
					},
				],
			}
		},
	)
}
