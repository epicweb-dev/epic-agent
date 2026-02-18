import { MessageType } from '@cloudflare/ai-chat/types'
import { AgentClient } from 'agents/client'
import { type UIMessage } from 'ai'
import { type Handle } from 'remix/component'
import { colors, radius, spacing, typography } from './styles/tokens.ts'

type ChatStatus = 'idle' | 'connecting' | 'ready' | 'streaming' | 'error'

type ActiveStream = {
	id: string
	messageId: string
	parts: Array<Record<string, unknown>>
	metadata?: Record<string, unknown>
}

function createId(prefix: string) {
	const raw =
		typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: String(Math.random()).slice(2)
	return `${prefix}-${raw}`
}

function applyChunkToParts(
	parts: Array<Record<string, unknown>>,
	chunk: unknown,
) {
	if (!chunk || typeof chunk !== 'object') return false
	const type = (chunk as { type?: unknown }).type
	if (typeof type !== 'string') return false

	function findLastPartByType(matchType: string) {
		for (let index = parts.length - 1; index >= 0; index -= 1) {
			if (parts[index]?.type === matchType) return parts[index]
		}
		return undefined
	}

	function findToolPartByCallId(toolCallId: string) {
		for (let index = parts.length - 1; index >= 0; index -= 1) {
			const part = parts[index]
			if (part?.toolCallId === toolCallId) return part
		}
		return undefined
	}

	switch (type) {
		case 'text-start':
			parts.push({ type: 'text', text: '', state: 'streaming' })
			return true
		case 'text-delta': {
			const delta = (chunk as { delta?: unknown }).delta
			const value = typeof delta === 'string' ? delta : ''
			const lastText = findLastPartByType('text')
			if (lastText && typeof lastText.text === 'string') {
				lastText.text += value
			} else {
				parts.push({ type: 'text', text: value, state: 'streaming' })
			}
			return true
		}
		case 'text-end': {
			const lastText = findLastPartByType('text')
			if (lastText) lastText.state = 'done'
			return true
		}
		case 'reasoning-start':
			parts.push({ type: 'reasoning', text: '', state: 'streaming' })
			return true
		case 'reasoning-delta': {
			const delta = (chunk as { delta?: unknown }).delta
			const value = typeof delta === 'string' ? delta : ''
			const lastReasoning = findLastPartByType('reasoning')
			if (lastReasoning && typeof lastReasoning.text === 'string') {
				lastReasoning.text += value
			} else {
				parts.push({ type: 'reasoning', text: value, state: 'streaming' })
			}
			return true
		}
		case 'reasoning-end': {
			const lastReasoning = findLastPartByType('reasoning')
			if (lastReasoning) lastReasoning.state = 'done'
			return true
		}
		case 'tool-input-start': {
			const toolName = (chunk as { toolName?: unknown }).toolName
			const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId
			if (typeof toolName !== 'string' || typeof toolCallId !== 'string') {
				return false
			}
			parts.push({
				type: `tool-${toolName}`,
				toolCallId,
				toolName,
				state: 'input-streaming',
				input: undefined,
			})
			return true
		}
		case 'tool-input-delta': {
			const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId
			if (typeof toolCallId !== 'string') return false
			const existing = findToolPartByCallId(toolCallId)
			if (existing) {
				existing.input = (chunk as { input?: unknown }).input
			}
			return true
		}
		case 'tool-input-available': {
			const toolName = (chunk as { toolName?: unknown }).toolName
			const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId
			if (typeof toolName !== 'string' || typeof toolCallId !== 'string') {
				return false
			}
			const existing = findToolPartByCallId(toolCallId)
			if (existing) {
				existing.state = 'input-available'
				existing.input = (chunk as { input?: unknown }).input
			} else {
				parts.push({
					type: `tool-${toolName}`,
					toolCallId,
					toolName,
					state: 'input-available',
					input: (chunk as { input?: unknown }).input,
				})
			}
			return true
		}
		case 'tool-approval-request': {
			const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId
			const approvalId = (chunk as { approvalId?: unknown }).approvalId
			if (typeof toolCallId !== 'string' || typeof approvalId !== 'string')
				return false
			const existing = findToolPartByCallId(toolCallId)
			if (existing) {
				existing.state = 'approval-requested'
				existing.approval = { id: approvalId }
			}
			return true
		}
		case 'tool-output-available': {
			const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId
			if (typeof toolCallId !== 'string') return false
			const existing = findToolPartByCallId(toolCallId)
			if (existing) {
				existing.state = 'output-available'
				existing.output = (chunk as { output?: unknown }).output
				if ('preliminary' in (chunk as Record<string, unknown>)) {
					existing.preliminary = (
						chunk as { preliminary?: unknown }
					).preliminary
				}
			}
			return true
		}
		case 'tool-output-error': {
			const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId
			if (typeof toolCallId !== 'string') return false
			const existing = findToolPartByCallId(toolCallId)
			if (existing) {
				existing.state = 'output-error'
				existing.errorText = (chunk as { errorText?: unknown }).errorText
			}
			return true
		}
		case 'step-start':
		case 'start-step':
			parts.push({ type: 'step-start' })
			return true
		default:
			return type.startsWith('data-')
	}
}

function renderMessagePart(part: Record<string, unknown>, index: number) {
	if (part.type === 'text') {
		return (
			<p
				key={index}
				css={{
					margin: 0,
					whiteSpace: 'pre-wrap',
				}}
			>
				{typeof part.text === 'string' ? part.text : ''}
			</p>
		)
	}

	if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
		const toolName =
			typeof part.toolName === 'string'
				? part.toolName
				: part.type.slice('tool-'.length)
		const state = typeof part.state === 'string' ? part.state : 'unknown'
		const input =
			typeof part.input === 'undefined'
				? null
				: JSON.stringify(part.input, null, 2)
		const output =
			typeof part.output === 'undefined'
				? null
				: JSON.stringify(part.output, null, 2)
		const errorText = typeof part.errorText === 'string' ? part.errorText : null

		return (
			<details
				key={index}
				open={state !== 'output-available'}
				css={{
					border: `1px solid ${colors.border}`,
					borderRadius: radius.md,
					padding: spacing.sm,
					backgroundColor: colors.surface,
				}}
			>
				<summary
					css={{
						cursor: 'pointer',
						fontWeight: typography.fontWeight.medium,
					}}
				>
					Tool: {toolName} ({state})
				</summary>
				{input ? (
					<>
						<p css={{ margin: `${spacing.sm} 0 ${spacing.xs}` }}>Input</p>
						<pre
							css={{
								margin: 0,
								whiteSpace: 'pre-wrap',
								fontSize: typography.fontSize.sm,
							}}
						>
							{input}
						</pre>
					</>
				) : null}
				{output ? (
					<>
						<p css={{ margin: `${spacing.sm} 0 ${spacing.xs}` }}>Output</p>
						<pre
							css={{
								margin: 0,
								whiteSpace: 'pre-wrap',
								fontSize: typography.fontSize.sm,
							}}
						>
							{output}
						</pre>
					</>
				) : null}
				{errorText ? (
					<p css={{ marginTop: spacing.sm, color: colors.error }}>
						Error: {errorText}
					</p>
				) : null}
			</details>
		)
	}

	if (part.type === 'reasoning') {
		return (
			<details key={index} css={{ margin: 0 }}>
				<summary css={{ cursor: 'pointer' }}>Reasoning</summary>
				<pre css={{ margin: 0, whiteSpace: 'pre-wrap' }}>
					{typeof part.text === 'string' ? part.text : ''}
				</pre>
			</details>
		)
	}

	return null
}

function ChatPage(handle: Handle) {
	let status: ChatStatus = 'connecting'
	let errorMessage: string | null = null
	let messages: Array<UIMessage> = []
	let agent: AgentClient | null = null
	let activeStream: ActiveStream | null = null
	let currentRequestId: string | null = null

	function setStatus(next: ChatStatus, nextError: string | null = null) {
		status = next
		errorMessage = nextError
		handle.update()
	}

	function setMessages(next: Array<UIMessage>) {
		messages = next
		handle.update()
	}

	function flushActiveStreamToMessages(stream: ActiveStream) {
		const updatedMessage: UIMessage = {
			id: stream.messageId,
			role: 'assistant',
			parts: stream.parts as UIMessage['parts'],
			...(stream.metadata ? { metadata: stream.metadata } : {}),
		}

		const index = messages.findIndex(
			(message) => message.id === updatedMessage.id,
		)
		if (index >= 0) {
			const copy = [...messages]
			copy[index] = updatedMessage
			setMessages(copy)
			return
		}

		setMessages([...messages, updatedMessage])
	}

	async function loadInitialMessages(signal: AbortSignal) {
		const response = await fetch('/agents/chat-agent/default/get-messages', {
			credentials: 'include',
			signal,
		})
		if (!response.ok) {
			return
		}
		const text = await response.text()
		if (!text.trim()) return
		try {
			const parsed = JSON.parse(text) as Array<UIMessage>
			if (Array.isArray(parsed)) setMessages(parsed)
		} catch {
			// Ignore malformed message payloads; agent will re-sync on next message.
		}
	}

	function handleAgentMessage(event: MessageEvent) {
		if (typeof event.data !== 'string') return
		let data: Record<string, unknown>
		try {
			data = JSON.parse(event.data) as Record<string, unknown>
		} catch {
			return
		}
		const type = data.type
		if (typeof type !== 'string') return

		if (type === MessageType.CF_AGENT_CHAT_MESSAGES) {
			const next = data.messages
			if (Array.isArray(next)) {
				setMessages(next as Array<UIMessage>)
				return
			}
		}

		if (type === MessageType.CF_AGENT_CHAT_CLEAR) {
			currentRequestId = null
			activeStream = null
			setMessages([])
			setStatus('ready')
			return
		}

		if (type === MessageType.CF_AGENT_MESSAGE_UPDATED) {
			const updated = data.message
			if (!updated || typeof updated !== 'object') return
			const updatedId =
				typeof (updated as { id?: unknown }).id === 'string'
					? String((updated as { id: string }).id)
					: null
			if (!updatedId) return
			const index = messages.findIndex((message) => message.id === updatedId)
			if (index >= 0) {
				const copy = [...messages]
				copy[index] = updated as UIMessage
				setMessages(copy)
			} else {
				setMessages([...messages, updated as UIMessage])
			}
			return
		}

		if (type === MessageType.CF_AGENT_STREAM_RESUMING) {
			const streamId = typeof data.id === 'string' ? data.id : null
			if (!streamId || !agent) return
			activeStream = {
				id: streamId,
				messageId: createId('assistant'),
				parts: [],
			}
			agent.send(
				JSON.stringify({
					type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
					id: streamId,
				}),
			)
			return
		}

		if (type === MessageType.CF_AGENT_USE_CHAT_RESPONSE) {
			const responseId = typeof data.id === 'string' ? data.id : null
			if (!responseId) return

			// Ignore responses for old requests; this UI only tracks one at a time.
			if (currentRequestId && responseId !== currentRequestId) return

			const isContinuation = data.continuation === true
			if (!activeStream || activeStream.id !== responseId) {
				let messageId = createId('assistant')
				let existingParts: Array<Record<string, unknown>> = []
				let existingMetadata: Record<string, unknown> | undefined
				if (isContinuation) {
					for (let i = messages.length - 1; i >= 0; i -= 1) {
						if (messages[i]?.role === 'assistant') {
							messageId = messages[i]?.id ?? messageId
							const parts = messages[i]?.parts
							existingParts = Array.isArray(parts)
								? [...(parts as unknown as Array<Record<string, unknown>>)]
								: []
							existingMetadata =
								typeof messages[i]?.metadata === 'object' &&
								messages[i]?.metadata
									? (messages[i]?.metadata as Record<string, unknown>)
									: undefined
							break
						}
					}
				}
				activeStream = {
					id: responseId,
					messageId,
					parts: existingParts,
					metadata: existingMetadata,
				}
			}

			const body = typeof data.body === 'string' ? data.body : ''
			if (body.trim()) {
				try {
					const chunkData = JSON.parse(body) as Record<string, unknown>
					const handled = applyChunkToParts(activeStream.parts, chunkData)
					if (!handled) {
						if (chunkData.type === 'start') {
							if (typeof chunkData.messageId === 'string') {
								activeStream.messageId = chunkData.messageId
							}
						}
						if (
							chunkData.type === 'message-metadata' &&
							chunkData.messageMetadata &&
							typeof chunkData.messageMetadata === 'object'
						) {
							activeStream.metadata = activeStream.metadata
								? { ...activeStream.metadata, ...chunkData.messageMetadata }
								: { ...(chunkData.messageMetadata as Record<string, unknown>) }
						}
					}

					if (data.replay !== true) {
						flushActiveStreamToMessages(activeStream)
					}
				} catch {
					// Some server-side failures send plain text (not JSON chunk frames).
					// Treat it as assistant text so the user sees a useful error message.
					let lastText: Record<string, unknown> | undefined
					for (let i = activeStream.parts.length - 1; i >= 0; i -= 1) {
						if (activeStream.parts[i]?.type === 'text') {
							lastText = activeStream.parts[i]
							break
						}
					}

					if (lastText && typeof lastText.text === 'string') {
						lastText.text += body
					} else {
						activeStream.parts.push({
							type: 'text',
							text: body,
							state: 'streaming',
						})
					}

					if (data.replay !== true) {
						flushActiveStreamToMessages(activeStream)
					}
				}
			}

			const isError = data.error === true
			if (data.done === true || isError) {
				if (data.replay === true && activeStream) {
					flushActiveStreamToMessages(activeStream)
				}
				activeStream = null
				currentRequestId = null
				if (isError) {
					setStatus(
						'error',
						body.trim().length > 0 ? body.trim() : 'Chat request failed.',
					)
				} else {
					setStatus('ready')
				}
			} else {
				setStatus('streaming')
			}
		}
	}

	function ensureConnection(signal: AbortSignal) {
		if (agent) return
		agent = new AgentClient({
			agent: 'ChatAgent',
			name: 'default',
			host: typeof window === 'undefined' ? 'localhost' : window.location.host,
		})
		agent.addEventListener('message', handleAgentMessage)
		agent.addEventListener('close', () => {
			if (signal.aborted) return
			setStatus('error', 'Chat connection closed. Refresh to reconnect.')
		})
		agent.ready
			.then(() => {
				if (!signal.aborted) setStatus('ready')
			})
			.catch(() => {
				if (!signal.aborted)
					setStatus('error', 'Unable to connect to chat agent.')
			})

		agent.send(
			JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST }),
		)

		signal.addEventListener('abort', () => {
			try {
				agent?.close()
			} catch {
				// ignore close errors
			}
			agent = null
		})
	}

	handle.queueTask(async (signal) => {
		ensureConnection(signal)
		try {
			await loadInitialMessages(signal)
		} catch {
			// ignore initial message load failures
		}
	})

	async function sendMessage(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return

		const formData = new FormData(event.currentTarget)
		const text = String(formData.get('message') ?? '').trim()
		if (!text) return
		if (!agent) {
			setStatus('error', 'Chat agent connection not ready.')
			return
		}
		if (status === 'streaming') return

		const nextMessages = [
			...messages,
			{
				id: createId('user'),
				role: 'user',
				parts: [{ type: 'text', text }],
			},
		] as Array<UIMessage>

		setMessages(nextMessages)

		const requestId = createId('req')
		currentRequestId = requestId
		activeStream = null
		setStatus('streaming')

		agent.send(
			JSON.stringify({
				id: requestId,
				init: {
					method: 'POST',
					body: JSON.stringify({
						messages: nextMessages,
					}),
				},
				type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
			}),
		)

		const input = event.currentTarget.elements.namedItem('message')
		if (input instanceof HTMLInputElement) {
			input.value = ''
		}
	}

	function clearHistory() {
		if (!agent) return
		agent.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }))
	}

	return () => (
		<section css={{ display: 'grid', gap: spacing.lg }}>
			<header css={{ display: 'grid', gap: spacing.xs }}>
				<h1
					css={{
						margin: 0,
						fontSize: typography.fontSize.xl,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					}}
				>
					Chat
				</h1>
				<p css={{ margin: 0, color: colors.textMuted }}>
					Workers AI chat backed by our MCP workshop tools.
				</p>
			</header>

			{errorMessage ? (
				<p css={{ margin: 0, color: colors.error }} role="alert">
					{errorMessage}
				</p>
			) : null}

			<section
				css={{
					border: `1px solid ${colors.border}`,
					borderRadius: radius.lg,
					backgroundColor: colors.surface,
					padding: spacing.md,
					minHeight: '18rem',
					maxHeight: '55vh',
					overflow: 'auto',
					display: 'grid',
					gap: spacing.md,
				}}
				aria-live="polite"
			>
				{messages.length === 0 ? (
					<p css={{ margin: 0, color: colors.textMuted }}>
						Try: "List the indexed workshops" or "Find where closures are
						taught".
					</p>
				) : null}
				{messages.map((message) => (
					<article
						key={message.id}
						css={{
							display: 'grid',
							gap: spacing.xs,
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor:
								message.role === 'user'
									? colors.primarySoftSubtle
									: colors.primarySoftest,
						}}
					>
						<p
							css={{
								margin: 0,
								fontSize: typography.fontSize.sm,
								fontWeight: typography.fontWeight.medium,
								color: colors.textMuted,
								textTransform: 'capitalize',
							}}
						>
							{message.role}
						</p>
						<div css={{ display: 'grid', gap: spacing.sm }}>
							{(message.parts as unknown as Array<Record<string, unknown>>).map(
								(part, index) => renderMessagePart(part, index),
							)}
						</div>
					</article>
				))}
			</section>

			<form
				css={{
					display: 'grid',
					gap: spacing.sm,
					gridTemplateColumns: '1fr auto',
					alignItems: 'center',
				}}
				on={{ submit: sendMessage }}
			>
				<input
					name="message"
					placeholder="Ask something…"
					disabled={status === 'connecting'}
					css={{
						padding: spacing.sm,
						borderRadius: radius.md,
						border: `1px solid ${colors.border}`,
						fontSize: typography.fontSize.base,
						fontFamily: typography.fontFamily,
					}}
				/>
				<button
					type="submit"
					disabled={status === 'streaming' || status === 'connecting'}
					css={{
						padding: `${spacing.sm} ${spacing.md}`,
						borderRadius: radius.full,
						border: 'none',
						backgroundColor: colors.primary,
						color: colors.onPrimary,
						fontWeight: typography.fontWeight.semibold,
						cursor:
							status === 'streaming' || status === 'connecting'
								? 'not-allowed'
								: 'pointer',
						opacity:
							status === 'streaming' || status === 'connecting' ? 0.7 : 1,
					}}
				>
					{status === 'streaming' ? 'Sending…' : 'Send'}
				</button>
			</form>

			<div css={{ display: 'flex', gap: spacing.sm, alignItems: 'center' }}>
				<button
					type="button"
					on={{ click: clearHistory }}
					css={{
						padding: `${spacing.xs} ${spacing.md}`,
						borderRadius: radius.full,
						border: `1px solid ${colors.border}`,
						backgroundColor: 'transparent',
						color: colors.text,
						fontWeight: typography.fontWeight.medium,
						cursor: 'pointer',
					}}
				>
					Clear history
				</button>
				<p
					css={{
						margin: 0,
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
					}}
				>
					Status: {status}
				</p>
			</div>
		</section>
	)
}

export function ChatRoute() {
	return (_match: { path: string; params: Record<string, string> }) => (
		<ChatPage />
	)
}
