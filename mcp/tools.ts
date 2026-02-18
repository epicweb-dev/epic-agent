import { z } from 'zod'
import { type MCP } from './index.ts'
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

function formatJson(value: unknown) {
	return JSON.stringify(value, null, 2)
}

function buildErrorResult(message: string) {
	return {
		isError: true,
		content: [{ type: 'text' as const, text: message }],
	}
}

export async function registerTools(agent: MCP) {
	agent.server.registerTool(
		'list_workshops',
		{
			description: 'List indexed workshops and metadata coverage',
			inputSchema: listWorkshopsInputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(listWorkshopsInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult(`Invalid input: ${args.error.message}`)
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
				return {
					content: [{ type: 'text', text: formatJson(result) }],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult(`Unable to list workshops: ${message}`)
			}
		},
	)

	agent.server.registerTool(
		'retrieve_learning_context',
		{
			description:
				'Retrieve workshop context for quiz authoring by scope or random',
			inputSchema: retrieveLearningContextInputSchema,
		},
		async (rawArgs: unknown) => {
			const args = retrieveLearningContextInputSchema.safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult(`Invalid input: ${args.error.message}`)
			}
			try {
				const result = await retrieveLearningContext({
					env: agent.requireEnv(),
					input: args.data,
				})
				return {
					content: [{ type: 'text', text: formatJson(result) }],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult(
					`Unable to retrieve learning context: ${message}`,
				)
			}
		},
	)

	agent.server.registerTool(
		'retrieve_diff_context',
		{
			description: 'Retrieve diff-focused context for an indexed exercise step',
			inputSchema: retrieveDiffContextInputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(retrieveDiffContextInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult(`Invalid input: ${args.error.message}`)
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
					content: [{ type: 'text', text: formatJson(result) }],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult(`Unable to retrieve diff context: ${message}`)
			}
		},
	)

	agent.server.registerTool(
		'search_topic_context',
		{
			description:
				'Search workshop content to find where topics are taught (semantic when Vectorize + AI are configured)',
			inputSchema: searchTopicContextInputSchema,
		},
		async (rawArgs: unknown) => {
			const args = z.object(searchTopicContextInputSchema).safeParse(rawArgs)
			if (!args.success) {
				return buildErrorResult(`Invalid input: ${args.error.message}`)
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
					content: [{ type: 'text', text: formatJson(result) }],
					structuredContent: result,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return buildErrorResult(`Unable to search topic context: ${message}`)
			}
		},
	)
}
