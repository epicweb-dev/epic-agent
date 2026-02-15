import { z } from 'zod'
import { runWorkshopReindex } from '../mcp/workshop-indexer.ts'

export const workshopIndexRoutePath = '/internal/workshop-index/reindex'

const reindexBodySchema = z.object({
	workshops: z
		.array(z.string().trim().min(1))
		.max(100, 'workshops must include at most 100 entries.')
		.optional(),
})

function normalizeWorkshops(workshops: Array<string> | undefined) {
	if (!workshops || workshops.length === 0) return undefined
	const normalized = Array.from(
		new Set(
			workshops
				.map((workshop) => workshop.trim().toLowerCase())
				.filter(Boolean),
		),
	)
	return normalized.length > 0 ? normalized : undefined
}

function unauthorizedResponse() {
	return Response.json(
		{
			ok: false,
			error: 'Unauthorized',
		},
		{ status: 401 },
	)
}

function methodNotAllowedResponse() {
	return new Response('Method not allowed', {
		status: 405,
		headers: { Allow: 'POST' },
	})
}

function getBearerToken(request: Request) {
	const header = request.headers.get('Authorization')
	if (!header || !header.startsWith('Bearer ')) return null
	return header.slice('Bearer '.length).trim()
}

export async function handleWorkshopIndexRequest(
	request: Request,
	env: Env,
	options: {
		runWorkshopReindexFn?: typeof runWorkshopReindex
	} = {},
) {
	if (request.method !== 'POST') {
		return methodNotAllowedResponse()
	}

	const configuredToken = env.WORKSHOP_INDEX_ADMIN_TOKEN?.trim()
	if (!configuredToken) {
		return Response.json(
			{
				ok: false,
				error:
					'WORKSHOP_INDEX_ADMIN_TOKEN is not configured for manual reindexing.',
			},
			{ status: 503 },
		)
	}

	const token = getBearerToken(request)
	if (!token || token !== configuredToken) {
		return unauthorizedResponse()
	}

	let body: unknown = {}
	try {
		body = await request.json()
	} catch {
		// Body is optional. Continue with defaults when absent.
	}
	const parsedBody = reindexBodySchema.safeParse(body)
	if (!parsedBody.success) {
		return Response.json(
			{
				ok: false,
				error: 'Invalid reindex payload.',
				details: parsedBody.error.issues.map((issue) => issue.message),
			},
			{ status: 400 },
		)
	}

	const runWorkshopReindexFn =
		options.runWorkshopReindexFn ?? runWorkshopReindex
	const normalizedWorkshops = normalizeWorkshops(parsedBody.data.workshops)

	try {
		const summary = await runWorkshopReindexFn({
			env,
			onlyWorkshops: normalizedWorkshops,
		})
		return Response.json({
			ok: true,
			...summary,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(
			'workshop-index-route-reindex-failed',
			JSON.stringify({
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
			}),
		)
		return Response.json(
			{
				ok: false,
				error: message,
			},
			{ status: 500 },
		)
	}
}
