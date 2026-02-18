import { z } from 'zod'
import { type MCP } from '../index.ts'
import {
	readOnlyToolAnnotations,
	retrievalSectionOutputSchema,
} from '../mcp-utils.ts'
import { retrieveDiffContextInputSchema } from '../workshop-contracts.ts'
import { retrieveDiffContext } from '../workshop-retrieval.ts'
import {
	buildErrorResult,
	buildInputValidationErrorResult,
	formatBullets,
	formatDiffSectionsMarkdown,
	formatOptionalCursor,
	formatOptionalStep,
} from '../mcp-utils.ts'

const name = 'retrieve_diff_context' as const

const description = `
Retrieve diff-focused context sections for a scoped workshop exercise/step.

Use when:
- You need code-change context for an exercise or step.
- You want to narrow down diff sections using a focus string.
- You need to page through large diffs using cursors.
`.trim()

const outputSchema = z.object({
	workshop: z.string(),
	exerciseNumber: z.number().int().positive(),
	stepNumber: z.number().int().positive().optional(),
	diffSections: z.array(retrievalSectionOutputSchema),
	truncated: z.boolean(),
	nextCursor: z.string().optional(),
})

export function registerRetrieveDiffContextTool(agent: MCP) {
	agent.server.registerTool(
		name,
		{
			title: 'Retrieve Diff Context',
			description,
			inputSchema: retrieveDiffContextInputSchema,
			annotations: readOnlyToolAnnotations,
			outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(retrieveDiffContextInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: name,
					error: args.error,
				})
			}

			try {
				const result = await retrieveDiffContext({
					env: agent.requireEnv(),
					workshop: args.data.workshop,
					exerciseNumber: args.data.exerciseNumber,
					stepNumber: args.data.stepNumber,
					focus: args.data.focus,
					maxChars: args.data.maxChars,
					cursor: args.data.cursor,
				})

				const maxCharsLabel =
					typeof args.data.maxChars === 'number'
						? `\`${String(args.data.maxChars)}\``
						: '_default_'
				const focusLabel =
					typeof args.data.focus === 'string' && args.data.focus.trim()
						? `\`${args.data.focus.trim()}\``
						: '_none_'

				const continuationSteps: Array<string> = []
				if (result.truncated && result.nextCursor) {
					const stepNumberPart =
						typeof result.stepNumber === 'number'
							? `, stepNumber: ${result.stepNumber}`
							: ''
					const focusPart =
						typeof args.data.focus === 'string' && args.data.focus.trim()
							? `, focus: "${args.data.focus.trim()}"`
							: ''
					continuationSteps.push(
						`Call \`${name}\` again with { workshop: "${result.workshop}", exerciseNumber: ${result.exerciseNumber}${stepNumberPart}${focusPart}, cursor: nextCursor }.`,
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
## ✅ Diff context

Scope:
- workshop: \`${result.workshop}\`
- exerciseNumber: ${result.exerciseNumber}
- stepNumber: ${formatOptionalStep(result.stepNumber)}
- focus: ${focusLabel}

Payload:
- maxChars (requested): ${maxCharsLabel}
- truncated: \`${String(result.truncated)}\`
- nextCursor: ${formatOptionalCursor(result.nextCursor)}
- diffSections: **${result.diffSections.length}**

${formatDiffSectionsMarkdown(result.diffSections)}${continuationSection}
							`.trim(),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					title: 'Unable to retrieve diff context',
					message,
					next: [
						'Verify the workshop slug with list_workshops.',
						'If focus yields no matches, adjust or omit focus.',
					],
				})
			}
		},
	)
}
