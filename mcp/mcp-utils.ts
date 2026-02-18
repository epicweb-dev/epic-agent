import { z } from 'zod'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export type MarkdownSection = {
	label: string
	kind: string
	content: string
	sourcePath?: string
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

export const retrievalSectionOutputSchema = z.object({
	label: z.string(),
	kind: z.string(),
	content: z.string(),
	sourcePath: z.string().optional(),
	exerciseNumber: z.number().int().positive().optional(),
	stepNumber: z.number().int().positive().optional(),
})

export function joinLines(lines: Array<string>) {
	return lines.join('\n')
}

export function formatBullets(items: Array<string>) {
	return joinLines(items.map((item) => `- ${item}`))
}

export function buildErrorResult({
	title,
	message,
	next,
}: {
	title: string
	message: string
	next?: Array<string>
}) {
	const nextSteps = next?.filter(Boolean) ?? []
	const nextSection =
		nextSteps.length > 0 ? `\n\nNext:\n${formatBullets(nextSteps)}` : ''

	return {
		isError: true,
		content: [
			{
				type: 'text' as const,
				text: `
## ❌ ${title}

${message.trim()}${nextSection}
				`.trim(),
			},
		],
	}
}

export function buildInputValidationErrorResult({
	tool,
	error,
	next,
}: {
	tool: string
	error: z.ZodError
	next?: Array<string>
}) {
	return buildErrorResult({
		title: 'Input validation error',
		message: `Tool: \`${tool}\`\n\n${error.message}`,
		next: [
			'Double-check required fields and value ranges in the tool schema.',
			...(next ?? []),
		],
	})
}

export function formatOptionalCursor(cursor: string | undefined) {
	return cursor ? `\`${cursor}\`` : '_none_'
}

export function formatOptionalStep(stepNumber: number | undefined) {
	return typeof stepNumber === 'number' ? String(stepNumber) : '_all steps_'
}

export function formatSectionsMarkdown(sections: Array<MarkdownSection>) {
	if (sections.length === 0) return '_No sections returned._'

	return sections.reduce((acc, section, index) => {
		const source = section.sourcePath
			? `\n_Source_: \`${section.sourcePath}\``
			: ''
		const heading = `### ${index + 1}) ${section.label}\n_kind_: \`${section.kind}\`${source}`
		const body = section.content.trim()
		const block = `${heading}\n\n${
			body.length > 0 ? body : '_Empty section content._'
		}`
		return acc.length > 0 ? `${acc}\n\n---\n\n${block}` : block
	}, '')
}

export function formatDiffSectionsMarkdown(sections: Array<MarkdownSection>) {
	if (sections.length === 0) return '_No diff sections returned._'

	return sections.reduce((acc, section, index) => {
		const source = section.sourcePath
			? `\n_Source_: \`${section.sourcePath}\``
			: ''
		const heading = `### ${index + 1}) ${section.label}\n_kind_: \`${section.kind}\`${source}`
		const body = section.content.trim()
		const fencedBody =
			body.length > 0 ? `\`\`\`diff\n${body}\n\`\`\`` : '_Empty diff._'
		const block = `${heading}\n\n${fencedBody}`
		return acc.length > 0 ? `${acc}\n\n---\n\n${block}` : block
	}, '')
}
