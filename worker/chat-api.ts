import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
	type CallToolResult,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import { MCP } from '../mcp/index.ts'
import {
	readAuthSession,
	setAuthSessionSecret,
} from '../server/auth-session.ts'
import { getEnv } from '../server/env.ts'
import { mcpResourcePath } from './mcp-auth.ts'

export const chatTurnPath = '/chat/turn'

const mcpOperationTimeoutMs = 10_000

const chatTurnRequestSchema = z.object({
	message: z.string().trim().min(1).max(10_000),
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

function getTextResultContent(result: CallToolResult) {
	return (
		result.content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	)
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

type ExecutionContextWithProps<TProps> = ExecutionContext & { props?: TProps }
type McpContextProps = { baseUrl: string }

function injectBaseUrlIntoExecutionContext(
	ctx: ExecutionContext,
	baseUrl: string,
): ExecutionContextWithProps<McpContextProps> {
	// MCP agent instances depend on ctx.props.baseUrl (normally set by `worker/mcp-auth.ts`
	// for external `/mcp` requests). Chat turns call MCP internally, so we replicate the
	// same contract here.
	const context = ctx as ExecutionContextWithProps<unknown>
	const existingProps =
		context.props && typeof context.props === 'object'
			? (context.props as Record<string, unknown>)
			: {}

	context.props = { ...existingProps, baseUrl }
	return ctx as ExecutionContextWithProps<McpContextProps>
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

async function withMcpClient({
	request,
	env,
	ctx,
	mcpSessionId,
}: {
	request: Request
	env: Env
	ctx: ExecutionContext
	mcpSessionId: string | undefined
}) {
	const origin = new URL(request.url).origin
	const serverUrl = new URL(mcpResourcePath, origin)
	const fetchMcp = MCP.serve(mcpResourcePath, {
		binding: 'MCP_OBJECT',
	}).fetch

	const mcpCtx = injectBaseUrlIntoExecutionContext(ctx, origin)

	const transport = new StreamableHTTPClientTransport(serverUrl, {
		sessionId: mcpSessionId,
		fetch: (input, init) => {
			const nextRequest =
				input instanceof Request ? input : new Request(input, init)
			return fetchMcp(nextRequest, env, mcpCtx)
		},
	})
	const client = new Client(
		{ name: 'epic-agent-chat', version: '1.0.0' },
		{ capabilities: {} },
	)

	await client.connect(transport)

	return {
		client,
		transport,
		close: async () => {
			await client.close()
		},
	}
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

export async function handleChatTurnRequest({
	request,
	env,
	ctx,
}: {
	request: Request
	env: Env
	ctx: ExecutionContext
}) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const appEnv = getEnv(env)
	setAuthSessionSecret(appEnv.COOKIE_SECRET)
	const session = await readAuthSession(request)
	if (!session) {
		return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 })
	}

	const body = (await request.json().catch(() => null)) as unknown
	const parsed = chatTurnRequestSchema.safeParse(body)
	if (!parsed.success) {
		return jsonResponse(
			{ ok: false, error: `Invalid request: ${parsed.error.message}` },
			{ status: 400 },
		)
	}

	const plan = planTurn(parsed.data.message)
	if (plan.kind === 'help') {
		return jsonResponse({
			ok: true,
			assistant: { content: plan.content },
			mcpSessionId: parsed.data.mcpSessionId ?? null,
		})
	}

	try {
		const mcp = await withMcpClient({
			request,
			env,
			ctx,
			mcpSessionId: parsed.data.mcpSessionId ?? undefined,
		})

		try {
			if (plan.kind === 'list-tools') {
				const result = await raceWithTimeout({
					action: mcp.client.listTools(),
					timeoutMs: mcpOperationTimeoutMs,
					onTimeout: mcp.close,
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
				onTimeout: mcp.close,
				timeoutMessage: `Timed out calling MCP tool "${plan.toolName}" after ${mcpOperationTimeoutMs}ms.`,
			})) as CallToolResult

			const text = getTextResultContent(result)
			const content = text || 'Tool returned no text content.'

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
		} finally {
			try {
				await mcp.close()
			} catch (error) {
				console.warn('Failed to close MCP client', error)
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error('chat-turn-mcp-failed', message, error)
		return jsonResponse(
			{
				ok: false,
				error: 'Unable to run MCP turn.',
			},
			{ status: 500 },
		)
	}
}
