import {
	readAuthSession,
	setAuthSessionSecret,
} from '../server/auth-session.ts'
import { getEnv } from '../server/env.ts'

export const chatTurnPath = '/chat/turn'

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
}: {
	request: Request
	env: Env
}) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const appEnv = getEnv(env)
	// `setAuthSessionSecret` is idempotent and caches per-isolate, so calling it
	// per request is safe and avoids having to thread the secret elsewhere.
	setAuthSessionSecret(appEnv.COOKIE_SECRET)
	const session = await readAuthSession(request)
	if (!session) {
		return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 })
	}

	// Route to a stable chat agent instance per signed-in user, so we can keep
	// MCP session state across turns without needing the browser to manage it.
	const chatAgentId = env.CHAT_AGENT.idFromName(session.id)
	return env.CHAT_AGENT.get(chatAgentId).fetch(request)
}
