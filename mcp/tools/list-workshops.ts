import { z } from 'zod'
import { type MCP } from '../index.ts'
import { listWorkshopsInputSchema } from '../workshop-contracts.ts'
import { retrieveWorkshopList } from '../workshop-retrieval.ts'
import {
	buildErrorResult,
	buildInputValidationErrorResult,
	readOnlyToolAnnotations,
	formatBullets,
	formatOptionalCursor,
	joinLines,
} from '../mcp-utils.ts'

const name = 'list_workshops' as const

const description = `
List indexed workshops and metadata coverage.

Use when:
- You need valid workshop slugs to scope other tools.
- You want to filter by product or diff availability.
- You want to inspect indexing coverage (exercise counts, last indexed time).
`.trim()

const workshopSummaryOutputSchema = z.object({
	workshop: z.string(),
	title: z.string(),
	exerciseCount: z.number().int().nonnegative(),
	hasDiffs: z.boolean(),
	lastIndexedAt: z.string(),
	product: z.string().optional(),
})

const outputSchema = z.object({
	workshops: z.array(workshopSummaryOutputSchema),
	nextCursor: z.string().optional(),
})

export function registerListWorkshopsTool(agent: MCP) {
	agent.server.registerTool(
		name,
		{
			title: 'List Workshops',
			description,
			inputSchema: listWorkshopsInputSchema,
			annotations: readOnlyToolAnnotations,
			outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(listWorkshopsInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: name,
					error: args.error,
				})
			}

			try {
				const result = await retrieveWorkshopList({
					env: agent.requireEnv(),
					limit: args.data.limit,
					all: args.data.all,
					cursor: args.data.cursor,
					product: args.data.product,
					hasDiffs: args.data.hasDiffs,
				})

				const workshops = result.workshops ?? []
				const previewLimit = 50
				const preview = workshops.slice(0, previewLimit)

				const productLabel = args.data.product
					? `\`${args.data.product}\``
					: '_any_'
				const hasDiffsLabel =
					typeof args.data.hasDiffs === 'boolean'
						? `\`${String(args.data.hasDiffs)}\``
						: '_any_'
				const allLabel =
					typeof args.data.all === 'boolean'
						? `\`${String(args.data.all)}\``
						: '_default_'

				const filters = `
- product: ${productLabel}
- hasDiffs: ${hasDiffsLabel}
- all: ${allLabel}
				`.trim()

				const nextSteps: Array<string> = []
				if (args.data.all === false) {
					if (result.nextCursor) {
						nextSteps.push(
							`Call \`${name}\` again with { all: false, cursor: nextCursor } to fetch the next page.`,
						)
					} else {
						nextSteps.push('No nextCursor returned; this is the last page.')
					}
				}

				const workshopLines = joinLines(
					preview.map((workshop) => {
						const product = workshop.product ? ` (${workshop.product})` : ''
						return `- \`${workshop.workshop}\` — ${workshop.title}${product} • exercises: ${workshop.exerciseCount} • diffs: ${workshop.hasDiffs ? 'yes' : 'no'} • lastIndexedAt: ${workshop.lastIndexedAt}`
					}),
				)

				const moreLine =
					workshops.length > preview.length
						? `\n\n_…and ${workshops.length - preview.length} more. See the structured output for the full list._`
						: ''

				const nextSection =
					nextSteps.length > 0 ? `\n\nNext:\n${formatBullets(nextSteps)}` : ''

				return {
					content: [
						{
							type: 'text' as const,
							text: `
## ✅ Indexed workshops

Returned: **${workshops.length}**
Next cursor: ${formatOptionalCursor(result.nextCursor)}

Filters:
${filters}

Showing: **${preview.length}** of **${workshops.length}** workshop(s)

${workshopLines}${moreLine}${nextSection}
							`.trim(),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					title: 'Unable to list workshops',
					message,
					next: ['Try again with a smaller limit or with { all: false }.'],
				})
			}
		},
	)
}
