import { z } from 'zod'
import {
	WorkshopIndexInputError,
	runWorkshopReindex,
} from '../mcp/workshop-indexer.ts'
import {
	workshopFilterMaxCount,
	workshopIndexBatchMaxSize,
	workshopIndexRequestBodyMaxChars,
} from '../shared/workshop-index-constants.ts'

export const workshopIndexRoutePath = '/internal/workshop-index/reindex'
export {
	workshopFilterMaxCount,
	workshopIndexBatchMaxSize,
	workshopIndexRequestBodyMaxChars,
}
const workshopFilterMaxErrorMessage = `workshops must include at most ${workshopFilterMaxCount} entries.`
const requestBodyMaxErrorMessage = `Request body must be at most ${workshopIndexRequestBodyMaxChars} characters.`
const batchSizeMaxErrorMessage = `batchSize must be at most ${workshopIndexBatchMaxSize}.`
const batchSizeMinErrorMessage = 'batchSize must be at least 1.'

const workshopFilterSchema = z.array(z.string().trim().min(1))

function stripLeadingBom(value: string) {
	return value.startsWith('\uFEFF') ? value.slice(1) : value
}

function looksLikeJson(value: string) {
	const trimmed = value.trim()
	if (trimmed.length === 0) return false
	const firstChar = trimmed[0]
	return firstChar === '{' || firstChar === '['
}

function parseBatchSizeFromString(value: string) {
	const trimmed = value.trim()
	if (trimmed.length === 0) return undefined
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) return undefined
	// Mirror the workflow behavior: treat "5.0" like 5, but preserve non-integers
	// so the schema can reject them with a clear message.
	const floored = Math.floor(parsed)
	return floored === parsed ? floored : parsed
}

function tryParseJsonBody(
	value: string,
): { ok: true; body: unknown } | { ok: false } {
	try {
		const parsed = JSON.parse(value) as unknown
		if (typeof parsed === 'string' && looksLikeJson(parsed)) {
			try {
				return { ok: true, body: JSON.parse(parsed) as unknown }
			} catch {
				// Fall through and let the schema handle the string body.
			}
		}
		return { ok: true, body: parsed }
	} catch {
		return { ok: false }
	}
}

function tryParseFormBody(
	value: string,
): { ok: true; body: unknown } | { ok: false } {
	// Basic heuristic: only treat input as form-encoded if it contains obvious
	// separators. This avoids mis-parsing arbitrary text.
	if (!value.includes('=') && !value.includes('&')) return { ok: false }
	const params = new URLSearchParams(value)
	if (Array.from(params.keys()).length === 0) return { ok: false }

	const payload = params.get('payload')?.trim()
	if (payload) {
		const parsedPayload = tryParseJsonBody(payload)
		if (parsedPayload.ok) {
			return parsedPayload
		}
	}

	const body: Record<string, unknown> = {}

	const workshopValues = [
		...params.getAll('workshops'),
		...params.getAll('workshops[]'),
	]
		.map((workshop) => workshop.trim())
		.filter(Boolean)
	if (workshopValues.length === 1) {
		// Allow a single string value (comma/newline-separated) so the zod
		// preprocess path still works.
		body.workshops = workshopValues[0]
	} else if (workshopValues.length > 1) {
		body.workshops = workshopValues
	}

	const cursor = params.get('cursor')?.trim()
	if (cursor) body.cursor = cursor

	const batchSizeRaw = params.get('batchSize')
	if (typeof batchSizeRaw === 'string') {
		const batchSize = parseBatchSizeFromString(batchSizeRaw)
		if (typeof batchSize !== 'undefined') {
			body.batchSize = batchSize
		} else if (batchSizeRaw.trim().length > 0) {
			// Preserve invalid values so the schema can reject them.
			body.batchSize = batchSizeRaw
		}
	}

	return Object.keys(body).length > 0 ? { ok: true, body } : { ok: false }
}

function parseReindexRequestBody(
	requestBody: string,
): { ok: true; body: unknown } | { ok: false } {
	const normalized = stripLeadingBom(requestBody)
	const trimmed = normalized.trim()
	if (trimmed.length === 0) {
		return { ok: true, body: {} }
	}

	const parsedJson = tryParseJsonBody(trimmed)
	if (parsedJson.ok) return parsedJson

	// Handle common shell quoting mistakes: "'{...}'".
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) {
		const inner = trimmed.slice(1, -1).trim()
		const innerParsed = tryParseJsonBody(inner)
		if (innerParsed.ok) return innerParsed
	}

	return tryParseFormBody(trimmed)
}

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
	cursor: z.string().trim().min(1).optional(),
	batchSize: z
		.number()
		.int()
		.min(1, { message: batchSizeMinErrorMessage })
		.max(workshopIndexBatchMaxSize, { message: batchSizeMaxErrorMessage })
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
	if (!header) return null
	const bearerTokenMatch = header.match(/^bearer\s+(.+)$/i)
	if (!bearerTokenMatch) return null
	const token = bearerTokenMatch[1]?.trim()
	return token && token.length > 0 ? token : null
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
		const parsedRequestBody = parseReindexRequestBody(requestBody)
		if (!parsedRequestBody.ok) {
			return invalidReindexPayloadResponse(['Request body must be valid JSON.'])
		}
		body = parsedRequestBody.body
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
	const cursor = parsedBody.data.cursor?.trim() || undefined
	const batchSize = parsedBody.data.batchSize
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
			cursor,
			batchSize,
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
