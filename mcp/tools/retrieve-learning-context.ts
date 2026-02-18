import { z } from 'zod'
import { type MCP } from '../index.ts'
import { nonDeterministicReadOnlyToolAnnotations } from '../server-metadata.ts'
import { retrievalSectionOutputSchema } from '../tool-output-schemas.ts'
import { retrieveLearningContextInputSchema } from '../workshop-contracts.ts'
import { retrieveLearningContext } from '../workshop-retrieval.ts'
import {
	buildErrorResult,
	buildInputValidationErrorResult,
	formatBullets,
	formatOptionalCursor,
	formatOptionalStep,
	formatSectionsMarkdown,
} from '../tool-helpers.ts'

const name = 'retrieve_learning_context' as const

const description = `
Retrieve indexed workshop context sections for quiz authoring.

Use when:
- You need source material to create questions or explanations for a specific scope.
- You want a random indexed scope to practice or sample.
- You need to page through large contexts using cursors.
`.trim()

const outputSchema = z.object({
	workshop: z.string(),
	exerciseNumber: z.number().int().positive(),
	stepNumber: z.number().int().positive().optional(),
	sections: z.array(retrievalSectionOutputSchema),
	truncated: z.boolean(),
	nextCursor: z.string().optional(),
})

export function registerRetrieveLearningContextTool(agent: MCP) {
	agent.server.registerTool(
		name,
		{
			title: 'Retrieve Learning Context',
			description,
			inputSchema: retrieveLearningContextInputSchema,
			annotations: nonDeterministicReadOnlyToolAnnotations,
			outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = retrieveLearningContextInputSchema.safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: name,
					error: args.error,
				})
			}

			try {
				const result = await retrieveLearningContext({
					env: agent.requireEnv(),
					input: args.data,
				})

				const maxCharsLabel =
					typeof args.data.maxChars === 'number'
						? `\`${String(args.data.maxChars)}\``
						: '_default_'

				const continuationSteps: Array<string> = []
				if (result.truncated && result.nextCursor) {
					const stepNumberPart =
						typeof result.stepNumber === 'number'
							? `, stepNumber: ${result.stepNumber}`
							: ''
					continuationSteps.push(
						`Call \`${name}\` again with { workshop: "${result.workshop}", exerciseNumber: ${result.exerciseNumber}${stepNumberPart}, cursor: nextCursor }.`,
					)
				}
				const continuationSection =
					continuationSteps.length > 0
						? `\n\nNext:\n${formatBullets(continuationSteps)}`
						: ''

				return {
					content: [
						{
							type: 'text' as const,
							text: `
## ✅ Learning context

Scope:
- workshop: \`${result.workshop}\`
- exerciseNumber: ${result.exerciseNumber}
- stepNumber: ${formatOptionalStep(result.stepNumber)}
- random: ${args.data.random === true ? '`true`' : '`false`'}

Payload:
- maxChars (requested): ${maxCharsLabel}
- truncated: \`${String(result.truncated)}\`
- nextCursor: ${formatOptionalCursor(result.nextCursor)}
- sections: **${result.sections.length}**

${formatSectionsMarkdown(result.sections)}${continuationSection}
							`.trim(),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					title: 'Unable to retrieve learning context',
					message,
					next: [
						'Verify the workshop slug with list_workshops.',
						'If this is a truncation issue, pass nextCursor back as cursor.',
					],
				})
			}
		},
	)
}
