import { type Handle } from 'remix/component'
import { navigate } from './client-router.tsx'
import {
	colors,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from './styles/tokens.ts'

type ChatRole = 'assistant' | 'user' | 'system'

type ChatMessage = {
	id: string
	role: ChatRole
	content: string
	createdAt: number
	debug?: {
		toolName?: string
		toolArguments?: unknown
	}
}

type ChatStatus = 'idle' | 'sending' | 'error'

type ChatTurnResponse = {
	ok: true
	assistant: {
		content: string
		debug?: {
			toolName?: string
			toolArguments?: unknown
		}
	}
	mcpSessionId: string | null
}

type ChatTurnError = {
	ok: false
	error: string
}

function safeRandomId() {
	return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function createMessage(partial: Omit<ChatMessage, 'id' | 'createdAt'>) {
	return {
		id: safeRandomId(),
		createdAt: Date.now(),
		...partial,
	} satisfies ChatMessage
}

function formatDebugArgs(value: unknown) {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function ChatPage(handle: Handle) {
	let status: ChatStatus = 'idle'
	let errorMessage: string | null = null
	let inputValue = ''
	let mcpSessionId: string | null = null
	let shouldScrollToBottom = false

	let messages: Array<ChatMessage> = [
		createMessage({
			role: 'assistant',
			content:
				'Chat is connected to the app MCP server. Try `8 + 4`, `/tools`, or `/tool do_math {"left": 8, "right": 4, "operator": "+"}`.',
		}),
	]

	function queueScrollToBottom() {
		if (shouldScrollToBottom) return
		shouldScrollToBottom = true
		handle.queueTask(() => {
			shouldScrollToBottom = false
			const el = document.getElementById('chat-messages')
			if (!el) return
			el.scrollTop = el.scrollHeight
		})
	}

	function pushMessage(message: ChatMessage) {
		messages = [...messages, message]
		handle.update()
		queueScrollToBottom()
	}

	async function sendTurn(userText: string) {
		status = 'sending'
		errorMessage = null
		handle.update()

		try {
			const response = await fetch('/chat/turn', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					message: userText,
					mcpSessionId: mcpSessionId ?? undefined,
				}),
			})
			const payload = (await response.json().catch(() => null)) as
				| ChatTurnResponse
				| ChatTurnError
				| null

			if (!response.ok || !payload || payload.ok !== true) {
				const errorText =
					payload && typeof (payload as ChatTurnError).error === 'string'
						? (payload as ChatTurnError).error
						: `Request failed (${response.status}).`
				if (response.status === 401) {
					navigate('/login?redirectTo=/chat')
					return
				}
				status = 'error'
				errorMessage = errorText
				handle.update()
				return
			}

			mcpSessionId =
				typeof payload.mcpSessionId === 'string' ? payload.mcpSessionId : null

			pushMessage(
				createMessage({
					role: 'assistant',
					content: payload.assistant.content,
					debug: payload.assistant.debug,
				}),
			)

			status = 'idle'
			handle.update()
		} catch {
			status = 'error'
			errorMessage = 'Network error. Please try again.'
			handle.update()
		}
	}

	function handleInput(event: Event) {
		if (!(event.currentTarget instanceof HTMLTextAreaElement)) return
		inputValue = event.currentTarget.value
		handle.update()
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (!(event.currentTarget instanceof HTMLTextAreaElement)) return
		if (event.key !== 'Enter') return
		if (event.shiftKey) return
		event.preventDefault()
		void submitMessage()
	}

	async function submitMessage() {
		const text = inputValue.trim()
		if (!text) return
		if (status === 'sending') return

		inputValue = ''
		pushMessage(createMessage({ role: 'user', content: text }))
		status = 'sending'
		handle.update()
		queueScrollToBottom()

		await sendTurn(text)
	}

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		void submitMessage()
	}

	return () => {
		const isSending = status === 'sending'
		const canSend = inputValue.trim().length > 0 && !isSending

		return (
			<section
				css={{
					display: 'grid',
					gap: spacing.lg,
					maxWidth: '52rem',
					margin: '0 auto',
				}}
			>
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
						This UI calls the Worker MCP server on each turn.
					</p>
				</header>

				<div
					id="chat-messages"
					role="list"
					aria-label="Chat messages"
					css={{
						display: 'grid',
						gap: spacing.md,
						padding: spacing.lg,
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						boxShadow: shadows.sm,
						minHeight: '18rem',
						maxHeight: '28rem',
						overflow: 'auto',
					}}
				>
					{messages.map((message) => {
						const isUser = message.role === 'user'
						const bubbleBg = isUser ? colors.primary : colors.primarySoft
						const bubbleText = isUser ? colors.onPrimary : colors.text
						const bubbleAlign = isUser ? 'end' : 'start'

						return (
							<div
								key={message.id}
								role="listitem"
								css={{
									display: 'grid',
									justifyItems: bubbleAlign,
								}}
							>
								<div
									css={{
										maxWidth: '44rem',
										padding: `${spacing.sm} ${spacing.md}`,
										borderRadius: radius.lg,
										backgroundColor: bubbleBg,
										color: bubbleText,
										whiteSpace: 'pre-wrap',
										lineHeight: 1.35,
									}}
								>
									{message.content}
								</div>
								{message.debug?.toolName ? (
									<details
										css={{
											marginTop: spacing.xs,
											justifySelf: bubbleAlign,
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										}}
									>
										<summary css={{ cursor: 'pointer' }}>MCP details</summary>
										<div
											css={{
												marginTop: spacing.xs,
												padding: spacing.sm,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.surface,
												overflow: 'auto',
											}}
										>
											<p css={{ margin: 0 }}>
												Tool: <code>{message.debug.toolName}</code>
											</p>
											{message.debug.toolArguments !== undefined ? (
												<pre
													css={{
														margin: `${spacing.xs} 0 0`,
														whiteSpace: 'pre-wrap',
														color: colors.textMuted,
													}}
												>
													{formatDebugArgs(message.debug.toolArguments)}
												</pre>
											) : null}
										</div>
									</details>
								) : null}
							</div>
						)
					})}
				</div>

				{errorMessage ? (
					<p css={{ margin: 0, color: colors.error }} role="alert">
						{errorMessage}
					</p>
				) : null}

				<form
					css={{
						display: 'grid',
						gap: spacing.sm,
						padding: spacing.lg,
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						boxShadow: shadows.sm,
					}}
					on={{ submit: handleSubmit }}
				>
					<label css={{ display: 'grid', gap: spacing.xs }}>
						<span
							css={{
								color: colors.text,
								fontWeight: typography.fontWeight.medium,
								fontSize: typography.fontSize.sm,
							}}
						>
							Message
						</span>
						<textarea
							name="message"
							aria-label="Message"
							value={inputValue}
							rows={3}
							placeholder="Type a message..."
							disabled={isSending}
							on={{ input: handleInput, keydown: handleKeyDown }}
							css={{
								resize: 'vertical',
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								fontSize: typography.fontSize.base,
								fontFamily: typography.fontFamily,
							}}
						/>
					</label>
					<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
						<button
							type="submit"
							disabled={!canSend}
							css={{
								padding: `${spacing.sm} ${spacing.lg}`,
								borderRadius: radius.full,
								border: 'none',
								backgroundColor: colors.primary,
								color: colors.onPrimary,
								fontSize: typography.fontSize.base,
								fontWeight: typography.fontWeight.semibold,
								cursor: canSend ? 'pointer' : 'not-allowed',
								opacity: canSend ? 1 : 0.7,
								transition: `transform ${transitions.fast}, background-color ${transitions.normal}`,
								...(canSend
									? {
											'&:hover': {
												backgroundColor: colors.primaryHover,
												transform: 'translateY(-1px)',
											},
											'&:active': {
												backgroundColor: colors.primaryActive,
												transform: 'translateY(0)',
											},
										}
									: {}),
							}}
						>
							{isSending ? 'Sending...' : 'Send'}
						</button>
						<p
							css={{
								margin: 0,
								alignSelf: 'center',
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							}}
						>
							Press Enter to send, Shift+Enter for a newline.
						</p>
					</div>
				</form>
			</section>
		)
	}
}

export function ChatRoute() {
	return (_match: { path: string; params: Record<string, string> }) => (
		<ChatPage />
	)
}
