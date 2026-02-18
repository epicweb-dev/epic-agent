import { z } from 'zod'
import { type MCP } from '../index.ts'
import { searchTopicContextInputSchema } from '../workshop-contracts.ts'
import { searchTopicContext } from '../workshop-retrieval.ts'
import {
	buildErrorResult,
	buildInputValidationErrorResult,
	openWorldReadOnlyToolAnnotations,
	formatBullets,
	joinLines,
} from '../mcp-utils.ts'

const name = 'search_topic_context' as const

const description = `
Search indexed workshop content to find where a topic is taught.

Use when:
- You have a concept/question and want to locate where it is covered.
- You want ranked matches (semantic when configured, keyword fallback otherwise).
- You want to identify a scope to retrieve via other tools.
`.trim()

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

const outputSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive(),
	mode: z.enum(['vector', 'keyword']),
	vectorSearchAvailable: z.boolean(),
	keywordSource: z.enum(['chunks', 'sections']).nullable(),
	warnings: z.array(z.string()).optional(),
	matches: z.array(topicMatchOutputSchema),
})

export function registerSearchTopicContextTool(agent: MCP) {
	agent.server.registerTool(
		name,
		{
			title: 'Search Topic Context',
			description,
			inputSchema: searchTopicContextInputSchema,
			annotations: openWorldReadOnlyToolAnnotations,
			outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(searchTopicContextInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: name,
					error: args.error,
					next: ['When scoping by stepNumber, also provide exerciseNumber.'],
				})
			}

			try {
				const result = await searchTopicContext({
					env: agent.requireEnv(),
					query: args.data.query,
					limit: args.data.limit,
					workshop: args.data.workshop,
					exerciseNumber: args.data.exerciseNumber,
					stepNumber: args.data.stepNumber,
				})

				const warnings = result.warnings ?? []
				const nextSteps: Array<string> = []
				if (result.matches.length > 0) {
					nextSteps.push(
						'Pick a match and retrieve full context with retrieve_learning_context or retrieve_diff_context using its workshop/exercise/step scope.',
					)
				}

				const warningsSection =
					warnings.length > 0
						? `\n\n### ⚠️ Warnings\n${formatBullets(warnings)}`
						: ''

				const matchesSection =
					result.matches.length > 0
						? `\n\n### Matches\n${joinLines(
								result.matches.map((match, index) => {
									const scopeParts: Array<string> = [`\`${match.workshop}\``]
									if (typeof match.exerciseNumber === 'number') {
										scopeParts.push(`exercise ${match.exerciseNumber}`)
									}
									if (typeof match.stepNumber === 'number') {
										scopeParts.push(`step ${match.stepNumber}`)
									}
									const scopeLabel = scopeParts.join(' ')
									const source = match.sourcePath
										? `\n_Source_: \`${match.sourcePath}\``
										: ''
									return `
#### ${index + 1}) ${scopeLabel} — score: ${match.score.toFixed(3)}
_vectorId_: \`${match.vectorId}\`${source}

${match.chunk.trim()}
									`.trim()
								}),
							)}`
						: `\n\n_No matches returned._`

				const nextSection =
					nextSteps.length > 0 ? `\n\nNext:\n${formatBullets(nextSteps)}` : ''

				return {
					content: [
						{
							type: 'text' as const,
							text: `
## ✅ Topic search

**Query**: \`${result.query}\`
**Mode**: \`${result.mode}\`
**Vector search available**: \`${String(result.vectorSearchAvailable)}\`
**Matches**: **${result.matches.length}** (limit: ${result.limit})${warningsSection}${matchesSection}${nextSection}
							`.trim(),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					title: 'Unable to search topic context',
					message,
					next: [
						'If query is too short, provide at least 3 characters.',
						'If scoping by stepNumber, also provide exerciseNumber.',
					],
				})
			}
		},
	)
}
