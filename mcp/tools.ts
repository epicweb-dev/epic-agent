import { z } from 'zod'
import { type MCP } from './index.ts'
import { toolsMetadata } from './server-metadata.ts'
import {
	buildQuizInstructionsResult,
	retrieveQuizInstructionsInputSchema,
} from './quiz-instructions.ts'
import {
	listWorkshopsInputSchema,
	searchTopicContextInputSchema,
	retrieveDiffContextInputSchema,
	retrieveLearningContextInputSchema,
} from './workshop-contracts.ts'
import {
	retrieveDiffContext,
	retrieveLearningContext,
	searchTopicContext,
	retrieveWorkshopList,
} from './workshop-retrieval.ts'

function buildErrorResult({
	title,
	message,
	next,
	structuredContent,
}: {
	title: string
	message: string
	next?: Array<string>
	structuredContent?: Record<string, unknown>
}) {
	const nextSteps = next?.filter(Boolean) ?? []
	return {
		isError: true,
		content: [
			{
				type: 'text' as const,
				text: [
					`## ❌ ${title}`,
					'',
					message.trim(),
					...(nextSteps.length > 0
						? ['', 'Next:', ...nextSteps.map((step) => `- ${step}`)]
						: []),
				].join('\n'),
			},
		],
		...(structuredContent ? { structuredContent } : {}),
	}
}

function buildInputValidationErrorResult({
	tool,
	error,
}: {
	tool: string
	error: z.ZodError
}) {
	return buildErrorResult({
		title: 'Input validation error',
		message: `Tool: \`${tool}\`\n\n${error.message}`,
		next: [
			'Double-check required fields and value ranges in the tool description.',
			'When scoping by stepNumber, also provide exerciseNumber.',
		],
		structuredContent: {
			error: 'INPUT_VALIDATION_ERROR',
			tool,
			message: error.message,
			issues: error.issues,
		},
	})
}

function formatOptionalCursor(cursor: string | undefined) {
	return cursor ? `\`${cursor}\`` : '_none_'
}

function formatOptionalStep(stepNumber: number | undefined) {
	return typeof stepNumber === 'number' ? String(stepNumber) : '_all steps_'
}

function formatSectionsMarkdown(
	sections: Array<{
		label: string
		kind: string
		sourcePath?: string
		content: string
	}>,
) {
	if (sections.length === 0) return '_No sections returned._'
	return sections
		.map((section, index) => {
			const source = section.sourcePath
				? `\n_Source_: \`${section.sourcePath}\``
				: ''
			const heading = `### ${index + 1}) ${section.label}\n_kind_: \`${section.kind}\`${source}`
			const body = section.content.trim()
			return `${heading}\n\n${body.length > 0 ? body : '_Empty section content._'}`
		})
		.join('\n\n---\n\n')
}

function formatDiffSectionsMarkdown(
	sections: Array<{
		label: string
		kind: string
		sourcePath?: string
		content: string
	}>,
) {
	if (sections.length === 0) return '_No diff sections returned._'
	return sections
		.map((section, index) => {
			const source = section.sourcePath
				? `\n_Source_: \`${section.sourcePath}\``
				: ''
			const heading = `### ${index + 1}) ${section.label}\n_kind_: \`${section.kind}\`${source}`
			const body = section.content.trim()
			const fencedBody =
				body.length > 0 ? ['```diff', body, '```'].join('\n') : '_Empty diff._'
			return `${heading}\n\n${fencedBody}`
		})
		.join('\n\n---\n\n')
}

export async function registerTools(agent: MCP) {
	agent.server.registerTool(
		toolsMetadata.list_workshops.name,
		{
			title: toolsMetadata.list_workshops.title,
			description: toolsMetadata.list_workshops.description,
			inputSchema: listWorkshopsInputSchema,
			annotations: toolsMetadata.list_workshops.annotations,
			outputSchema: toolsMetadata.list_workshops.outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(listWorkshopsInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: toolsMetadata.list_workshops.name,
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
				const filters = [
					`product: ${args.data.product ? `\`${args.data.product}\`` : '_any_'}`,
					`hasDiffs: ${
						typeof args.data.hasDiffs === 'boolean'
							? `\`${String(args.data.hasDiffs)}\``
							: '_any_'
					}`,
					`all: ${
						typeof args.data.all === 'boolean'
							? `\`${String(args.data.all)}\``
							: '_default_'
					}`,
				].join('\n- ')
				return {
					content: [
						{
							type: 'text',
							text: [
								'## ✅ Indexed workshops',
								'',
								`Returned: **${workshops.length}**`,
								`Next cursor: ${formatOptionalCursor(result.nextCursor)}`,
								'',
								'Filters:',
								`- ${filters}`,
								'',
								`Showing: **${preview.length}** of **${workshops.length}** workshop(s)`,
								'',
								...preview.map((workshop) => {
									const product = workshop.product
										? ` (${workshop.product})`
										: ''
									return `- \`${workshop.workshop}\` — ${workshop.title}${product} • exercises: ${workshop.exerciseCount} • diffs: ${workshop.hasDiffs ? 'yes' : 'no'} • lastIndexedAt: ${workshop.lastIndexedAt}`
								}),
								...(workshops.length > preview.length
									? [
											'',
											`_…and ${workshops.length - preview.length} more. Full list is in structuredContent._`,
										]
									: []),
							].join('\n'),
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
					structuredContent: {
						error: 'LIST_WORKSHOPS_FAILED',
						message,
					},
				})
			}
		},
	)

	agent.server.registerTool(
		toolsMetadata.retrieve_learning_context.name,
		{
			title: toolsMetadata.retrieve_learning_context.title,
			description: toolsMetadata.retrieve_learning_context.description,
			inputSchema: retrieveLearningContextInputSchema,
			annotations: toolsMetadata.retrieve_learning_context.annotations,
			outputSchema: toolsMetadata.retrieve_learning_context.outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = retrieveLearningContextInputSchema.safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: toolsMetadata.retrieve_learning_context.name,
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
				return {
					content: [
						{
							type: 'text',
							text: [
								'## ✅ Learning context',
								'',
								'Scope:',
								`- workshop: \`${result.workshop}\``,
								`- exerciseNumber: ${result.exerciseNumber}`,
								`- stepNumber: ${formatOptionalStep(result.stepNumber)}`,
								`- random: ${args.data.random === true ? '`true`' : '`false`'}`,
								'',
								'Payload:',
								`- maxChars (requested): ${maxCharsLabel}`,
								`- truncated: \`${String(result.truncated)}\``,
								`- nextCursor: ${formatOptionalCursor(result.nextCursor)}`,
								`- sections: **${result.sections.length}**`,
								'',
								formatSectionsMarkdown(result.sections),
							].join('\n'),
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
					structuredContent: {
						error: 'RETRIEVE_LEARNING_CONTEXT_FAILED',
						message,
					},
				})
			}
		},
	)

	agent.server.registerTool(
		toolsMetadata.retrieve_diff_context.name,
		{
			title: toolsMetadata.retrieve_diff_context.title,
			description: toolsMetadata.retrieve_diff_context.description,
			inputSchema: retrieveDiffContextInputSchema,
			annotations: toolsMetadata.retrieve_diff_context.annotations,
			outputSchema: toolsMetadata.retrieve_diff_context.outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(retrieveDiffContextInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: toolsMetadata.retrieve_diff_context.name,
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
				return {
					content: [
						{
							type: 'text',
							text: [
								'## ✅ Diff context',
								'',
								'Scope:',
								`- workshop: \`${result.workshop}\``,
								`- exerciseNumber: ${result.exerciseNumber}`,
								`- stepNumber: ${formatOptionalStep(result.stepNumber)}`,
								`- focus: ${focusLabel}`,
								'',
								'Payload:',
								`- maxChars (requested): ${maxCharsLabel}`,
								`- truncated: \`${String(result.truncated)}\``,
								`- nextCursor: ${formatOptionalCursor(result.nextCursor)}`,
								`- diffSections: **${result.diffSections.length}**`,
								'',
								formatDiffSectionsMarkdown(result.diffSections),
							].join('\n'),
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
					structuredContent: {
						error: 'RETRIEVE_DIFF_CONTEXT_FAILED',
						message,
					},
				})
			}
		},
	)

	agent.server.registerTool(
		toolsMetadata.search_topic_context.name,
		{
			title: toolsMetadata.search_topic_context.title,
			description: toolsMetadata.search_topic_context.description,
			inputSchema: searchTopicContextInputSchema,
			annotations: toolsMetadata.search_topic_context.annotations,
			outputSchema: toolsMetadata.search_topic_context.outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(searchTopicContextInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: toolsMetadata.search_topic_context.name,
					error: args.error,
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
				return {
					content: [
						{
							type: 'text',
							text: [
								'## ✅ Topic search',
								'',
								`**Query**: \`${result.query}\``,
								`**Mode**: \`${result.mode}\``,
								`**Vector search available**: \`${String(
									result.vectorSearchAvailable,
								)}\``,
								`**Matches**: **${result.matches.length}** (limit: ${result.limit})`,
								...(warnings.length > 0
									? [
											'',
											'### ⚠️ Warnings',
											...warnings.map((warning) => `- ${warning}`),
										]
									: []),
								...(result.matches.length > 0
									? [
											'',
											'### Matches',
											...result.matches.map((match, index) => {
												const scopeParts: Array<string> = [
													`\`${match.workshop}\``,
												]
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
												return [
													`#### ${index + 1}) ${scopeLabel} — score: ${match.score.toFixed(
														3,
													)}`,
													`_vectorId_: \`${match.vectorId}\`${source}`,
													'',
													match.chunk.trim(),
												].join('\n')
											}),
										]
									: ['', '_No matches returned._']),
							].join('\n'),
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
					structuredContent: {
						error: 'SEARCH_TOPIC_CONTEXT_FAILED',
						message,
					},
				})
			}
		},
	)

	agent.server.registerTool(
		toolsMetadata.retrieve_quiz_instructions.name,
		{
			title: toolsMetadata.retrieve_quiz_instructions.title,
			description: toolsMetadata.retrieve_quiz_instructions.description,
			inputSchema: retrieveQuizInstructionsInputSchema,
			annotations: toolsMetadata.retrieve_quiz_instructions.annotations,
			outputSchema: toolsMetadata.retrieve_quiz_instructions.outputSchema,
		},
		async (rawArgs: unknown) => {
			const args = retrieveQuizInstructionsInputSchema.safeParse(rawArgs ?? {})
			if (!args.success) {
				return buildInputValidationErrorResult({
					tool: toolsMetadata.retrieve_quiz_instructions.name,
					error: args.error,
				})
			}

			try {
				const result = buildQuizInstructionsResult(args.data)
				return {
					content: [
						{
							type: 'text',
							text: [
								`## ✅ Quiz protocol`,
								'',
								`topic: ${result.topic ? `\`${result.topic}\`` : '_ask the learner_'}`,
								`learnerGoal: ${
									result.learnerGoal
										? `\`${result.learnerGoal}\``
										: '_unspecified_'
								}`,
								`targetQuestionCount: \`${String(result.targetQuestionCount)}\``,
								'',
								result.instructionsMarkdown,
							].join('\n'),
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
					structuredContent: {
						error: 'RETRIEVE_QUIZ_INSTRUCTIONS_FAILED',
						message,
					},
				})
			}
		},
	)
}
