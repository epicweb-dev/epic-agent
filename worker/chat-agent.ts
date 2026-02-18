import { Agent } from 'agents'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
	type CallToolResult,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import { MCP } from '../mcp/index.ts'
import { chatTurnPath } from './chat-api.ts'
import { mcpResourcePath } from './mcp-auth.ts'

type ChatAgentState = {
	turnCount: number
	mcpSessionId: string | null
}

const mcpOperationTimeoutMs = 10_000

const chatTurnRequestSchema = z.object({
	message: z.string().trim().min(1).max(10_000),
	// Deprecated: streamable-http sessions cannot be reconnected by session id
	// because initialization requests must not include an MCP session header.
	// We keep accepting this field for backwards compatibility, but ignore it.
	mcpSessionId: z.string().trim().min(1).nullable().optional(),
})

type ToolCallPlan =
	| { kind: 'help'; content: string }
	| { kind: 'list-tools' }
	| {
			kind: 'call-tool'
			toolName: string
			toolArguments: Record<string, unknown>
	  }

type McpContextProps = { baseUrl: string }
type McpExecutionContext = ExecutionContext<McpContextProps>

type McpConnection = {
	client: Client
	transport: StreamableHTTPClientTransport
}

function getTextResultContent(result: CallToolResult) {
	return (
		result.content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	)
}

function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...init?.headers,
		},
	})
}

function buildHelpMessage() {
	return [
		'Commands:',
		'- `/tools` — list available MCP tools',
		'- `/tool <tool_name> <json_args>` — call a tool (example: `/tool list_workshops {"limit": 5}`)',
		'',
		'Shortcuts:',
		'- `list workshops` — calls `list_workshops`',
		'- `search <query>` — calls `search_topic_context`',
	].join('\n')
}

function planTurn(message: string): ToolCallPlan {
	const text = message.trim()
	if (!text) return { kind: 'help', content: buildHelpMessage() }

	if (text === '/tools') return { kind: 'list-tools' }

	const toolMatch = text.match(/^\/tool\s+([a-zA-Z0-9_:-]+)(?:\s+(.+))?$/)
	if (toolMatch) {
		const toolName = toolMatch[1]
		if (!toolName) {
			return { kind: 'help', content: buildHelpMessage() }
		}
		const argsText = toolMatch[2]?.trim() ?? ''
		if (!argsText) {
			return { kind: 'call-tool', toolName, toolArguments: {} }
		}
		try {
			const parsed = JSON.parse(argsText) as unknown
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return {
					kind: 'help',
					content: `Tool arguments must be a JSON object.\n\n${buildHelpMessage()}`,
				}
			}
			return {
				kind: 'call-tool',
				toolName,
				toolArguments: parsed as Record<string, unknown>,
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			return {
				kind: 'help',
				content: `Invalid JSON args for /tool: ${errorMessage}\n\n${buildHelpMessage()}`,
			}
		}
	}

	if (/^list\s+workshops\b/i.test(text)) {
		return {
			kind: 'call-tool',
			toolName: 'list_workshops',
			toolArguments: { limit: 10 },
		}
	}

	const searchMatch = text.match(/^search\s+(.+)$/i)
	if (searchMatch) {
		const query = searchMatch[1]?.trim() ?? ''
		if (query.length < 3) {
			return {
				kind: 'help',
				content: `Search query must be at least 3 characters.\n\n${buildHelpMessage()}`,
			}
		}
		return {
			kind: 'call-tool',
			toolName: 'search_topic_context',
			toolArguments: { query, limit: 8 },
		}
	}

	return { kind: 'help', content: buildHelpMessage() }
}

async function raceWithTimeout<T>({
	action,
	timeoutMs,
	onTimeout,
	timeoutMessage,
}: {
	action: Promise<T>
	timeoutMs: number
	onTimeout: () => void | Promise<void>
	timeoutMessage: string
}): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			void onTimeout()
			reject(new Error(timeoutMessage))
		}, timeoutMs)
	})

	try {
		return await Promise.race([action, timeoutPromise])
	} finally {
		if (timeoutId) clearTimeout(timeoutId)
	}
}

function createMcpExecutionContext(
	ctx: { waitUntil: (promise: Promise<unknown>) => void },
	baseUrl: string,
): McpExecutionContext {
	return {
		waitUntil: (promise) => ctx.waitUntil(promise),
		passThroughOnException: () => {},
		// The MCP handler requires an ExecutionContext, but for Durable Object -> DO
		// internal calls we only rely on waitUntil + props. Exports are unused here.
		exports: {} as unknown as Cloudflare.Exports,
		props: { baseUrl },
	}
}

const fetchMcp = MCP.serve(mcpResourcePath, {
	binding: 'MCP_OBJECT',
}).fetch

export class ChatAgent extends Agent<Env, ChatAgentState> {
	initialState: ChatAgentState = { turnCount: 0, mcpSessionId: null }

	private mcpConnection: McpConnection | null = null
	private mcpConnectionPromise: Promise<McpConnection> | null = null

	private async resetMcpConnection() {
		if (!this.mcpConnection) return
		const current = this.mcpConnection
		this.mcpConnection = null
		try {
			await current.client.close()
		} catch (error) {
			console.warn('chat-agent-mcp-close-failed', error)
		}
	}

	private async ensureMcpConnection({
		origin,
	}: {
		origin: string
	}): Promise<McpConnection> {
		if (this.mcpConnection) return this.mcpConnection
		if (this.mcpConnectionPromise) return this.mcpConnectionPromise

		this.mcpConnectionPromise = (async () => {
			const serverUrl = new URL(mcpResourcePath, origin)
			const mcpCtx = createMcpExecutionContext(
				this.ctx as unknown as {
					waitUntil: (promise: Promise<unknown>) => void
				},
				origin,
			)

			const transport = new StreamableHTTPClientTransport(serverUrl, {
				fetch: (input, init) => {
					const nextRequest = new Request(input, init)
					return fetchMcp(nextRequest, this.env, mcpCtx)
				},
			})

			const client = new Client(
				{ name: 'epic-agent-chat', version: '1.0.0' },
				{ capabilities: {} },
			)

			await raceWithTimeout({
				action: client.connect(transport),
				timeoutMs: mcpOperationTimeoutMs,
				onTimeout: async () => {
					try {
						await client.close()
					} catch {
						// noop
					}
				},
				timeoutMessage: `Timed out connecting to MCP after ${mcpOperationTimeoutMs}ms.`,
			})

			const sessionId =
				typeof transport.sessionId === 'string' ? transport.sessionId : null
			if (sessionId && this.state.mcpSessionId !== sessionId) {
				this.setState({
					...this.state,
					mcpSessionId: sessionId,
				})
			}

			this.mcpConnection = { client, transport }
			return this.mcpConnection
		})().finally(() => {
			this.mcpConnectionPromise = null
		})

		return this.mcpConnectionPromise
	}

	async onRequest(request: Request) {
		const url = new URL(request.url)
		if (url.pathname !== chatTurnPath) {
			return new Response('Not Found', { status: 404 })
		}

		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 })
		}

		const body = (await request.json().catch(() => null)) as unknown
		const parsed = chatTurnRequestSchema.safeParse(body)
		if (!parsed.success) {
			console.warn('chat-turn-invalid-request', {
				issues: parsed.error.issues.map((issue) => ({
					code: issue.code,
					message: issue.message,
					path: issue.path,
				})),
			})
			return jsonResponse(
				{ ok: false, error: 'Invalid request body.' },
				{ status: 400 },
			)
		}

		const plan = planTurn(parsed.data.message)
		if (plan.kind === 'help') {
			return jsonResponse({
				ok: true,
				assistant: { content: plan.content },
				mcpSessionId: this.state.mcpSessionId,
			})
		}

		try {
			const start = Date.now()
			const mcp = await this.ensureMcpConnection({ origin: url.origin })

			if (plan.kind === 'list-tools') {
				const result = await raceWithTimeout({
					action: mcp.client.listTools(),
					timeoutMs: mcpOperationTimeoutMs,
					onTimeout: this.resetMcpConnection.bind(this),
					timeoutMessage: `Timed out listing MCP tools after ${mcpOperationTimeoutMs}ms.`,
				})

				const lines = [
					'Available MCP tools:',
					...result.tools.map((tool) => {
						const description = tool.description ? ` — ${tool.description}` : ''
						return `- ${tool.name}${description}`
					}),
					'',
					'Tip: Call a tool with `/tool <tool_name> <json_args>`.',
				]

				this.setState({
					...this.state,
					turnCount: this.state.turnCount + 1,
				})

				this.observability?.emit(
					{
						displayMessage: 'Chat turn: list tools',
						id: crypto.randomUUID(),
						payload: { event: 'chat:turn', durationMs: Date.now() - start },
						timestamp: Date.now(),
						type: 'rpc',
					},
					this.ctx,
				)

				return jsonResponse({
					ok: true,
					assistant: { content: lines.join('\n') },
					mcpSessionId: mcp.transport.sessionId ?? null,
				})
			}

			const result = (await raceWithTimeout({
				action: mcp.client.callTool({
					name: plan.toolName,
					arguments: plan.toolArguments,
				}),
				timeoutMs: mcpOperationTimeoutMs,
				onTimeout: this.resetMcpConnection.bind(this),
				timeoutMessage: `Timed out calling MCP tool "${plan.toolName}" after ${mcpOperationTimeoutMs}ms.`,
			})) as CallToolResult

			const text = getTextResultContent(result)
			const content = text || 'Tool returned no text content.'

			this.setState({
				...this.state,
				turnCount: this.state.turnCount + 1,
			})

			this.observability?.emit(
				{
					displayMessage: `Chat turn: tool ${plan.toolName}`,
					id: crypto.randomUUID(),
					payload: {
						event: 'chat:turn',
						durationMs: Date.now() - start,
						toolName: plan.toolName,
					},
					timestamp: Date.now(),
					type: 'rpc',
				},
				this.ctx,
			)

			return jsonResponse({
				ok: true,
				assistant: {
					content,
					debug: {
						toolName: plan.toolName,
						toolArguments: plan.toolArguments,
					},
				},
				mcpSessionId: mcp.transport.sessionId ?? null,
			})
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			console.error('chat-turn-mcp-failed', errorMessage, error)
			await this.resetMcpConnection()
			return jsonResponse(
				{
					ok: false,
					error: 'Unable to run MCP turn.',
				},
				{ status: 500 },
			)
		}
	}
}
