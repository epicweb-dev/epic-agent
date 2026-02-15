import { z } from 'zod'
import {
	WorkshopIndexInputError,
	runWorkshopReindex,
} from '../mcp/workshop-indexer.ts'
import {
	workshopFilterMaxCount,
	workshopIndexRequestBodyMaxChars,
} from '../shared/workshop-index-constants.ts'

export const workshopIndexRoutePath = '/internal/workshop-index/reindex'
export { workshopFilterMaxCount, workshopIndexRequestBodyMaxChars }
const workshopFilterMaxErrorMessage = `workshops must include at most ${workshopFilterMaxCount} entries.`
const requestBodyMaxErrorMessage = `Request body must be at most ${workshopIndexRequestBodyMaxChars} characters.`

const workshopFilterSchema = z.array(z.string().trim().min(1))

const reindexBodySchema = z.object({
	workshops: z
		.preprocess((value) => {
			if (typeof value !== 'string') return value
			return value
				.split(/[\r\n,]+/)
				.map((workshop) => workshop.trim())
				.filter(Boolean)
		}, workshopFilterSchema)
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

function invalidReindexPayloadResponse(details: Array<string>) {
	return Response.json(
		{
			ok: false,
			error: 'Invalid reindex payload.',
			details,
		},
		{ status: 400 },
	)
}

function oversizedReindexPayloadResponse(details: Array<string>) {
	return Response.json(
		{
			ok: false,
			error: 'Reindex payload is too large.',
			details,
		},
		{ status: 413 },
	)
}

function parseRequestContentLength(request: Request) {
	const contentLengthHeader = request.headers.get('Content-Length')
	if (!contentLengthHeader) return undefined
	const trimmedHeader = contentLengthHeader.trim()
	if (!/^\d+$/.test(trimmedHeader)) return undefined
	const parsed = Number.parseInt(trimmedHeader, 10)
	if (!Number.isFinite(parsed) || parsed < 0) return undefined
	return parsed
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
	const contentLength = parseRequestContentLength(request)
	if (
		typeof contentLength === 'number' &&
		contentLength > workshopIndexRequestBodyMaxChars
	) {
		return oversizedReindexPayloadResponse([requestBodyMaxErrorMessage])
	}

	let body: unknown = {}
	const requestBody = await request.text()
	if (requestBody.length > workshopIndexRequestBodyMaxChars) {
		return oversizedReindexPayloadResponse([requestBodyMaxErrorMessage])
	}
	if (requestBody.trim().length > 0) {
		try {
			body = JSON.parse(requestBody) as unknown
		} catch {
			return invalidReindexPayloadResponse(['Request body must be valid JSON.'])
		}
	}
	const parsedBody = reindexBodySchema.safeParse(body)
	if (!parsedBody.success) {
		return invalidReindexPayloadResponse(
			parsedBody.error.issues.map((issue) => issue.message),
		)
	}

	const runWorkshopReindexFn =
		options.runWorkshopReindexFn ?? runWorkshopReindex
	const normalizedWorkshops = normalizeWorkshops(parsedBody.data.workshops)
	if (
		normalizedWorkshops &&
		normalizedWorkshops.length > workshopFilterMaxCount
	) {
		return invalidReindexPayloadResponse([workshopFilterMaxErrorMessage])
	}

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
		if (error instanceof WorkshopIndexInputError) {
			return invalidReindexPayloadResponse([message])
		}
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
