import { type MCP } from './index.ts'
import {
	buildQuizInstructionsResult,
	retrieveQuizInstructionsInputSchema,
} from './quiz-instructions.ts'
import {
	retrieveLearningContextInputSchema,
	listWorkshopsInputSchema,
	retrieveDiffContextInputSchema,
	searchTopicContextInputSchema,
} from './workshop-contracts.ts'
import {
	retrieveDiffContext,
	retrieveLearningContext,
	searchTopicContext,
	retrieveWorkshopList,
} from './workshop-retrieval.ts'
import { toolsMetadata } from './metadata.ts'

function buildErrorResult({
	message,
	next,
}: {
	message: string
	next?: Array<string>
}) {
	const nextLines =
		next && next.length > 0
			? ['', 'Next:', ...next.map((line) => `- ${line}`)]
			: []
	return {
		isError: true,
		content: [
			{
				type: 'text' as const,
				text: [message, ...nextLines].join('\n'),
			},
		],
	}
}

function formatCursor(value: string | undefined) {
	return value ? `\`${value}\`` : '(none)'
}

function trimSnippet(value: string, maxChars: number) {
	const normalized = value.trim()
	if (normalized.length <= maxChars) return normalized
	return `${normalized.slice(0, Math.max(0, maxChars)).trimEnd()}...`
}

function formatWorkshopsMarkdown({
	workshops,
	nextCursor,
	limit,
	all,
	product,
	hasDiffs,
}: {
	workshops: Array<{
		workshop: string
		title: string
		product?: string
		exerciseCount: number
		hasDiffs: boolean
		lastIndexedAt: string
	}>
	nextCursor?: string
	limit: number
	all: boolean
	product?: string
	hasDiffs?: boolean
}) {
	const shown = workshops.slice(0, 25)
	const lines = shown.map((workshop) => {
		const productLabel = workshop.product ? ` (${workshop.product})` : ''
		const diffsLabel = workshop.hasDiffs ? 'Yes' : 'No'
		return `- \`${workshop.workshop}\`${productLabel} — ${workshop.title} — exercises: ${workshop.exerciseCount} — diffs: ${diffsLabel}`
	})
	const hiddenCount = Math.max(0, workshops.length - shown.length)
	if (hiddenCount > 0) {
		lines.push(`- ...and ${hiddenCount} more`)
	}

	const filterLines: Array<string> = []
	if (product) filterLines.push(`- product: \`${product}\``)
	if (typeof hasDiffs === 'boolean')
		filterLines.push(`- hasDiffs: ${hasDiffs ? 'true' : 'false'}`)
	if (filterLines.length === 0) filterLines.push('- (none)')

	return [
		'## Workshops',
		`Returned: ${workshops.length}`,
		'',
		'Filters:',
		...filterLines,
		'',
		'Pagination:',
		`- all: ${all ? 'true' : 'false'}`,
		`- limit: ${limit}`,
		`- nextCursor: ${formatCursor(nextCursor)}`,
		'',
		'Workshops:',
		...lines,
		'',
		'Next:',
		'- Use `retrieve_learning_context` with { workshop, exerciseNumber, stepNumber? } to fetch source material.',
		'- Use `search_topic_context` to locate where a concept is taught.',
	].join('\n')
}

function formatLearningContextMarkdown({
	workshop,
	exerciseNumber,
	stepNumber,
	sections,
	truncated,
	nextCursor,
}: {
	workshop: string
	exerciseNumber: number
	stepNumber?: number
	sections: Array<{
		label: string
		kind: string
		sourcePath?: string
		content: string
	}>
	truncated: boolean
	nextCursor?: string
}) {
	const sectionLines = sections.slice(0, 10).map((section) => {
		const sourceLabel = section.sourcePath ? ` — \`${section.sourcePath}\`` : ''
		return `- ${section.label} (\`${section.kind}\`)${sourceLabel}`
	})
	const remainingCount = Math.max(0, sections.length - sectionLines.length)
	if (remainingCount > 0) {
		sectionLines.push(`- ...and ${remainingCount} more sections`)
	}

	const scopeLabel =
		typeof stepNumber === 'number'
			? `workshop \`${workshop}\`, exercise ${exerciseNumber}, step ${stepNumber}`
			: `workshop \`${workshop}\`, exercise ${exerciseNumber}`

	return [
		'## Learning context',
		`Scope: ${scopeLabel}`,
		`Sections returned: ${sections.length}`,
		`Truncated: ${truncated ? 'true' : 'false'}`,
		`Next cursor: ${formatCursor(nextCursor)}`,
		'',
		'Sections:',
		...sectionLines,
		'',
		'Next:',
		truncated
			? '- Call `retrieve_learning_context` again with `cursor: nextCursor` to continue.'
			: '- You have the full context for this scope.',
	].join('\n')
}

function formatDiffContextMarkdown({
	workshop,
	exerciseNumber,
	stepNumber,
	diffSections,
	truncated,
	nextCursor,
}: {
	workshop: string
	exerciseNumber: number
	stepNumber?: number
	diffSections: Array<{
		label: string
		kind: string
		sourcePath?: string
		content: string
	}>
	truncated: boolean
	nextCursor?: string
}) {
	const sectionLines = diffSections.slice(0, 10).map((section) => {
		const sourceLabel = section.sourcePath ? ` — \`${section.sourcePath}\`` : ''
		return `- ${section.label} (\`${section.kind}\`)${sourceLabel}`
	})
	const remainingCount = Math.max(0, diffSections.length - sectionLines.length)
	if (remainingCount > 0) {
		sectionLines.push(`- ...and ${remainingCount} more sections`)
	}

	const scopeLabel =
		typeof stepNumber === 'number'
			? `workshop \`${workshop}\`, exercise ${exerciseNumber}, step ${stepNumber}`
			: `workshop \`${workshop}\`, exercise ${exerciseNumber}`

	return [
		'## Diff context',
		`Scope: ${scopeLabel}`,
		`Diff sections returned: ${diffSections.length}`,
		`Truncated: ${truncated ? 'true' : 'false'}`,
		`Next cursor: ${formatCursor(nextCursor)}`,
		'',
		'Diff sections:',
		...sectionLines,
		'',
		'Next:',
		truncated
			? '- Call `retrieve_diff_context` again with `cursor: nextCursor` to continue.'
			: '- You have the full diff context for this scope.',
	].join('\n')
}

function formatTopicSearchMarkdown({
	query,
	mode,
	vectorSearchAvailable,
	warnings,
	matches,
}: {
	query: string
	mode: string
	vectorSearchAvailable: boolean
	warnings?: Array<string>
	matches: Array<{
		score: number
		workshop: string
		exerciseNumber?: number
		stepNumber?: number
		sourcePath?: string
		chunk: string
	}>
}) {
	const warningLines =
		warnings && warnings.length > 0
			? ['', 'Warnings:', ...warnings.map((warning) => `- ${warning}`)]
			: []

	const matchLines = matches.slice(0, 10).map((match) => {
		const scopeParts = [
			`\`${match.workshop}\``,
			typeof match.exerciseNumber === 'number'
				? `exercise ${match.exerciseNumber}`
				: null,
			typeof match.stepNumber === 'number' ? `step ${match.stepNumber}` : null,
		].filter(Boolean)
		const scopeLabel = scopeParts.join(', ')
		const sourceLabel = match.sourcePath ? ` — \`${match.sourcePath}\`` : ''
		return `- score: ${match.score.toFixed(3)} — ${scopeLabel}${sourceLabel}\n  - ${trimSnippet(match.chunk, 160)}`
	})
	if (matches.length > 10) {
		matchLines.push(`- ...and ${matches.length - 10} more`)
	}

	return [
		'## Topic search',
		`Query: \`${query}\``,
		`Mode: \`${mode}\``,
		`Vector search available: ${vectorSearchAvailable ? 'true' : 'false'}`,
		`Matches returned: ${matches.length}`,
		...warningLines,
		'',
		'Top matches:',
		...(matchLines.length > 0 ? matchLines : ['- (none)']),
		'',
		'Next:',
		'- Use `retrieve_learning_context` with the best match scope to fetch full sections.',
	].join('\n')
}

export async function registerTools(agent: MCP) {
	agent.server.registerTool(
		'list_workshops',
		{
			title: toolsMetadata.list_workshops.title,
			description: toolsMetadata.list_workshops.description,
			inputSchema: listWorkshopsInputSchema,
			annotations: toolsMetadata.list_workshops.annotations,
		},
		async (rawArgs: unknown) => {
			const args = listWorkshopsInputSchema.safeParse(rawArgs ?? {})
			if (!args.success) {
				return buildErrorResult({
					message: args.error.message,
					next: [
						'Review tool inputs in the tool description.',
						'Try calling with {}.',
					],
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
				const pagination = {
					all: args.data.all,
					limit: args.data.limit,
					hasMore: Boolean(!args.data.all && result.nextCursor),
					nextCursor: result.nextCursor,
					itemsReturned: result.workshops.length,
				}
				const structuredContent = { ...result, pagination }
				return {
					content: [
						{
							type: 'text',
							text: formatWorkshopsMarkdown({
								workshops: result.workshops,
								nextCursor: result.nextCursor,
								limit: args.data.limit,
								all: args.data.all,
								product: args.data.product,
								hasDiffs: args.data.hasDiffs,
							}),
						},
					],
					structuredContent,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					message: `Unable to list workshops: ${message}`,
				})
			}
		},
	)

	agent.server.registerTool(
		'retrieve_learning_context',
		{
			title: toolsMetadata.retrieve_learning_context.title,
			description: toolsMetadata.retrieve_learning_context.description,
			inputSchema: retrieveLearningContextInputSchema,
			annotations: toolsMetadata.retrieve_learning_context.annotations,
		},
		async (rawArgs: unknown) => {
			const args = retrieveLearningContextInputSchema.safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult({
					message: args.error.message,
					next: [
						'Call `list_workshops` to discover workshop slugs.',
						'Use { random: true } if you do not have a specific workshop/exercise scope.',
					],
				})
			}
			try {
				const result = await retrieveLearningContext({
					env: agent.requireEnv(),
					input: args.data,
				})
				return {
					content: [
						{
							type: 'text',
							text: formatLearningContextMarkdown({
								workshop: result.workshop,
								exerciseNumber: result.exerciseNumber,
								stepNumber: result.stepNumber,
								sections: result.sections,
								truncated: result.truncated,
								nextCursor: result.nextCursor,
							}),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const next: Array<string> = []
				if (message.startsWith('Unknown workshop')) {
					next.push('Call `list_workshops` to see available workshop slugs.')
				}
				return buildErrorResult({
					message: `Unable to retrieve learning context: ${message}`,
					next,
				})
			}
		},
	)

	agent.server.registerTool(
		'retrieve_diff_context',
		{
			title: toolsMetadata.retrieve_diff_context.title,
			description: toolsMetadata.retrieve_diff_context.description,
			inputSchema: retrieveDiffContextInputSchema,
			annotations: toolsMetadata.retrieve_diff_context.annotations,
		},
		async (rawArgs: unknown) => {
			const args = retrieveDiffContextInputSchema.safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult({
					message: args.error.message,
					next: ['Call `list_workshops` to discover workshop slugs.'],
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
				return {
					content: [
						{
							type: 'text',
							text: formatDiffContextMarkdown({
								workshop: result.workshop,
								exerciseNumber: result.exerciseNumber,
								stepNumber: result.stepNumber,
								diffSections: result.diffSections,
								truncated: result.truncated,
								nextCursor: result.nextCursor,
							}),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const next: Array<string> = []
				if (message.startsWith('Unknown workshop')) {
					next.push('Call `list_workshops` to see available workshop slugs.')
				}
				if (message.startsWith('No diff context matched focus')) {
					next.push('Broaden or omit `focus` to retrieve more diff context.')
				}
				return buildErrorResult({
					message: `Unable to retrieve diff context: ${message}`,
					next: next.length > 0 ? next : undefined,
				})
			}
		},
	)

	agent.server.registerTool(
		'search_topic_context',
		{
			title: toolsMetadata.search_topic_context.title,
			description: toolsMetadata.search_topic_context.description,
			inputSchema: searchTopicContextInputSchema,
			annotations: toolsMetadata.search_topic_context.annotations,
		},
		async (rawArgs: unknown) => {
			const args = searchTopicContextInputSchema.safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult({
					message: args.error.message,
					next: [
						'Ensure `query` is at least 3 characters.',
						'If providing `stepNumber`, also provide `exerciseNumber`.',
					],
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
				return {
					content: [
						{
							type: 'text',
							text: formatTopicSearchMarkdown({
								query: result.query,
								mode: result.mode,
								vectorSearchAvailable: result.vectorSearchAvailable,
								warnings: result.warnings,
								matches: result.matches.map((match) => ({
									score: match.score,
									workshop: match.workshop,
									exerciseNumber: match.exerciseNumber,
									stepNumber: match.stepNumber,
									sourcePath: match.sourcePath,
									chunk: match.chunk,
								})),
							}),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const next: Array<string> = []
				if (message.startsWith('Unknown workshop')) {
					next.push('Call `list_workshops` to see available workshop slugs.')
				}
				return buildErrorResult({
					message: `Unable to search topic context: ${message}`,
					next: next.length > 0 ? next : undefined,
				})
			}
		},
	)

	agent.server.registerTool(
		'retrieve_quiz_instructions',
		{
			title: toolsMetadata.retrieve_quiz_instructions.title,
			description: toolsMetadata.retrieve_quiz_instructions.description,
			inputSchema: retrieveQuizInstructionsInputSchema,
			annotations: toolsMetadata.retrieve_quiz_instructions.annotations,
		},
		async (rawArgs: unknown) => {
			const args = retrieveQuizInstructionsInputSchema.safeParse(rawArgs ?? {})
			if (!args.success) {
				return buildErrorResult({
					message: args.error.message,
				})
			}

			try {
				const result = buildQuizInstructionsResult(args.data)
				return {
					content: [
						{ type: 'text', text: result.instructionsMarkdown },
						{
							type: 'text',
							text: [
								'Next:',
								'- Fetch source material with `retrieve_learning_context` (explicit scope or { random: true }).',
								'- Use `search_topic_context` if you need to locate where a concept is taught.',
							].join('\n'),
						},
					],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult({
					message: `Unable to retrieve quiz instructions: ${message}`,
				})
			}
		},
	)
}
