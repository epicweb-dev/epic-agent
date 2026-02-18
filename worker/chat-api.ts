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

const chatTurnRequestSchema = z.object({
	message: z.string().trim().min(1).max(10_000),
	mcpSessionId: z.string().trim().min(1).optional(),
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
		'- `/tool <tool_name> <json_args>` — call a tool (example: `/tool do_math {"left": 8, "right": 4, "operator": "+"}`)',
		'',
		'Shortcuts:',
		'- `8 + 4` (or `8*4`) — calls `do_math`',
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
			const message = error instanceof Error ? error.message : String(error)
			return {
				kind: 'help',
				content: `Invalid JSON args for /tool: ${message}\n\n${buildHelpMessage()}`,
			}
		}
	}

	const mathMatch = text.match(
		/^\s*(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)\s*$/,
	)
	if (mathMatch) {
		const left = Number(mathMatch[1])
		const operator = mathMatch[2] as '+' | '-' | '*' | '/'
		const right = Number(mathMatch[3])
		if (!Number.isFinite(left) || !Number.isFinite(right)) {
			return {
				kind: 'help',
				content: `Invalid numbers.\n\n${buildHelpMessage()}`,
			}
		}
		return {
			kind: 'call-tool',
			toolName: 'do_math',
			toolArguments: { left, right, operator },
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

	const mcpCtx = ctx as ExecutionContext<{ baseUrl: string }>
	;(mcpCtx as unknown as { props?: { baseUrl: string } }).props = {
		baseUrl: origin,
	}

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
			mcpSessionId: parsed.data.mcpSessionId,
		})

		try {
			if (plan.kind === 'list-tools') {
				const result = await mcp.client.listTools()
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

			const result = (await mcp.client.callTool({
				name: plan.toolName,
				arguments: plan.toolArguments,
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
			await mcp.close()
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return jsonResponse(
			{
				ok: false,
				error: `Unable to run MCP turn: ${message}`,
			},
			{ status: 500 },
		)
	}
}
