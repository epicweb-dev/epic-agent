import { AIChatAgent } from '@cloudflare/ai-chat'
import {
	convertToModelMessages,
	pruneMessages,
	stepCountIs,
	streamText,
	tool,
	type StreamTextOnFinishCallback,
	type ToolSet,
} from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import type { OnChatMessageOptions } from '@cloudflare/ai-chat'
import {
	listWorkshopsInputSchema,
	retrieveDiffContextInputSchema,
	retrieveLearningContextInputSchema,
	searchTopicContextInputSchema,
} from '../mcp/workshop-contracts.ts'
import {
	retrieveDiffContext,
	retrieveLearningContext,
	retrieveWorkshopList,
	searchTopicContext,
} from '../mcp/workshop-retrieval.ts'
import {
	buildQuizInstructionsResult,
	retrieveQuizInstructionsInputSchema,
} from '../mcp/quiz-instructions.ts'

type ChatAgentEnv = Env & {
	AI?: Ai
}

function buildSystemPrompt() {
	return [
		'You are epic-agent, a helpful assistant for Epic workshops.',
		'You have access to tools that can retrieve indexed workshop context from our MCP toolset.',
		'Use tools when you need exact source material or when the user asks about workshop content.',
		'If a tool returns an error, explain it briefly and ask for a narrower scope or corrected inputs.',
	].join('\n')
}

export class ChatAgent extends AIChatAgent<ChatAgentEnv> {
	async onChatMessage(
		onFinish: StreamTextOnFinishCallback<ToolSet>,
		options?: OnChatMessageOptions,
	) {
		if (!this.env.AI) {
			return new Response(
				[
					'Workers AI binding "AI" is not available in this environment.',
					'Local Wrangler mode does not provide Workers AI; deploy/preview or run Wrangler in remote mode to use chat responses.',
				].join('\n'),
				{
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				},
			)
		}

		const workersai = createWorkersAI({ binding: this.env.AI })

		const tools = {
			list_workshops: tool({
				description:
					'List indexed workshops and metadata (slugs, titles, exercise counts, diff availability).',
				inputSchema: z.object(listWorkshopsInputSchema),
				execute: async ({ limit, all, cursor, product, hasDiffs }) => {
					try {
						return await retrieveWorkshopList({
							env: this.env,
							limit,
							all,
							cursor,
							product,
							hasDiffs,
						})
					} catch (error) {
						return {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}
					}
				},
			}),
			retrieve_learning_context: tool({
				description:
					'Retrieve learning context sections for a workshop scope (workshop, exerciseNumber, optional stepNumber). Supports random scopes and pagination via cursor.',
				inputSchema: retrieveLearningContextInputSchema,
				execute: async (input) => {
					try {
						return await retrieveLearningContext({
							env: this.env,
							input,
						})
					} catch (error) {
						return {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}
					}
				},
			}),
			retrieve_diff_context: tool({
				description:
					'Retrieve code diff context for a workshop scope (workshop, exerciseNumber, optional stepNumber). Supports focus filtering and pagination.',
				inputSchema: z.object(retrieveDiffContextInputSchema),
				execute: async (input) => {
					try {
						return await retrieveDiffContext({
							env: this.env,
							...input,
						})
					} catch (error) {
						return {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}
					}
				},
			}),
			search_topic_context: tool({
				description:
					'Search indexed workshop content to find where a topic is taught (semantic when configured; keyword fallback otherwise).',
				inputSchema: z.object(searchTopicContextInputSchema),
				execute: async (input) => {
					try {
						return await searchTopicContext({
							env: this.env,
							...input,
						})
					} catch (error) {
						return {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}
					}
				},
			}),
			retrieve_quiz_instructions: tool({
				description:
					'Return a quiz facilitation protocol and question templates (one question at a time).',
				inputSchema: retrieveQuizInstructionsInputSchema,
				execute: async (input) => {
					try {
						return buildQuizInstructionsResult(input)
					} catch (error) {
						return {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}
					}
				},
			}),
		}

		const result = streamText({
			model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct'),
			system: buildSystemPrompt(),
			messages: pruneMessages({
				messages: await convertToModelMessages(this.messages),
				toolCalls: 'before-last-2-messages',
			}),
			tools,
			stopWhen: stepCountIs(6),
			onFinish,
		})

		return result.toUIMessageStreamResponse()
	}
}

