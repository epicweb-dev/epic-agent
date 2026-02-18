import { z } from 'zod'
import { type MCP } from '../index.ts'
import { readOnlyToolAnnotations } from '../server-metadata.ts'
import {
	buildQuizInstructionsResult,
	retrieveQuizInstructionsInputSchema,
} from '../quiz-instructions.ts'
import {
	buildErrorResult,
	buildInputValidationErrorResult,
} from '../tool-helpers.ts'

const name = 'retrieve_quiz_instructions' as const

const description = `
Return evidence-based instructions for conducting a quiz (one question at a time, immediate feedback, spaced retrieval).

Use this tool when:
- The learner asks to be quizzed.
- You want to solidify understanding with retrieval practice.

Use when:
- You want a consistent quiz protocol + checklist.
- You want a set of question types and follow-ups to guide the session.
`.trim()

const outputSchema = z.object({
	tool: z.literal(name),
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

export function registerRetrieveQuizInstructionsTool(agent: MCP) {
	agent.server.registerTool(
		name,
		{
			title: 'Retrieve Quiz Instructions',
			description,
			inputSchema: retrieveQuizInstructionsInputSchema,
			annotations: readOnlyToolAnnotations,
			outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = retrieveQuizInstructionsInputSchema.safeParse(rawArgs ?? {})
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: name,
					error: args.error,
				})
			}

			try {
				const result = buildQuizInstructionsResult(args.data)
				return {
					content: [
						{
							type: 'text' as const,
							text: `
## ✅ Quiz protocol

topic: ${result.topic ? `\`${result.topic}\`` : '_ask the learner_'}
learnerGoal: ${result.learnerGoal ? `\`${result.learnerGoal}\`` : '_unspecified_'}
targetQuestionCount: \`${String(result.targetQuestionCount)}\`

${result.instructionsMarkdown}

Next:
- Use retrieve_learning_context or search_topic_context to gather source material.
- Ask one question at a time and follow the protocol.
							`.trim(),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					title: 'Unable to retrieve quiz instructions',
					message,
					next: [
						'Try again with fewer inputs (all fields are optional).',
						'If topic/learnerGoal are provided, ensure they are non-empty strings.',
					],
				})
			}
		},
	)
}
