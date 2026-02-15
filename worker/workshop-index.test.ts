/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { WorkshopIndexInputError } from '../mcp/workshop-indexer.ts'
import {
	handleWorkshopIndexRequest,
	workshopFilterMaxCount,
	workshopIndexBatchMaxSize,
	workshopIndexRequestBodyMaxChars,
	workshopIndexRoutePath,
} from './workshop-index.ts'

function createEnv(overrides: Partial<Env> = {}) {
	return {
		WORKSHOP_INDEX_ADMIN_TOKEN: 'admin-token',
		...overrides,
	} as Env
}

const workshopFilterMaxErrorMessage = `workshops must include at most ${workshopFilterMaxCount} entries.`
const requestBodyMaxErrorMessage = `Request body must be at most ${workshopIndexRequestBodyMaxChars} characters.`
const batchSizeMaxErrorMessage = `batchSize must be at most ${workshopIndexBatchMaxSize}.`
const batchSizeMinErrorMessage = 'batchSize must be at least 1.'

test('workshop index route rejects non-POST methods', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'GET',
		}),
		createEnv(),
	)

	expect(response.status).toBe(405)
})

test('workshop index route returns 503 when token is missing', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
		}),
		createEnv({ WORKSHOP_INDEX_ADMIN_TOKEN: undefined }),
	)

	expect(response.status).toBe(503)
})

test('workshop index route rejects invalid bearer token', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer wrong-token',
			},
		}),
		createEnv(),
	)

	expect(response.status).toBe(401)
})

test('workshop index route accepts lowercase bearer authorization scheme', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: '{"workshops":["mcp-fundamentals"]',
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: ['Request body must be valid JSON.'],
	})
})

test('workshop index route validates payload shape', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ workshops: [123] }),
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
})

test('workshop index route rejects malformed json payloads', async () => {
	let reindexCalled = false
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: '{"workshops":["mcp-fundamentals"]',
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				reindexCalled = true
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(400)
	expect(reindexCalled).toBe(false)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: ['Request body must be valid JSON.'],
	})
})

test('workshop index route strips a leading BOM before parsing JSON', async () => {
	let capturedBatchSize: number | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: `\uFEFF${JSON.stringify({ batchSize: 5 })}`,
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ batchSize }) => {
				capturedBatchSize = batchSize
				return {
					runId: 'run-123',
					workshopCount: 0,
					exerciseCount: 0,
					stepCount: 0,
					sectionCount: 0,
					sectionChunkCount: 0,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedBatchSize).toBe(5)
})

test('workshop index route accepts single-quoted JSON bodies', async () => {
	let capturedBatchSize: number | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: `'${JSON.stringify({ batchSize: 5 })}'`,
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ batchSize }) => {
				capturedBatchSize = batchSize
				return {
					runId: 'run-123',
					workshopCount: 0,
					exerciseCount: 0,
					stepCount: 0,
					sectionCount: 0,
					sectionChunkCount: 0,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedBatchSize).toBe(5)
})

test('workshop index route accepts JSON string bodies containing JSON', async () => {
	let capturedBatchSize: number | undefined
	const doubleEncoded = JSON.stringify(JSON.stringify({ batchSize: 5 }))
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: doubleEncoded,
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ batchSize }) => {
				capturedBatchSize = batchSize
				return {
					runId: 'run-123',
					workshopCount: 0,
					exerciseCount: 0,
					stepCount: 0,
					sectionCount: 0,
					sectionChunkCount: 0,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedBatchSize).toBe(5)
})

test('workshop index route accepts urlencoded form bodies as a fallback', async () => {
	let capturedWorkshops: Array<string> | undefined
	let capturedCursor: string | undefined
	let capturedBatchSize: number | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				workshops: 'MCP-FUNDAMENTALS,Advanced-TypeScript',
				cursor: 'cursor-value',
				batchSize: '5',
			}).toString(),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops, cursor, batchSize }) => {
				capturedWorkshops = onlyWorkshops
				capturedCursor = cursor
				capturedBatchSize = batchSize
				return {
					runId: 'run-123',
					workshopCount: 0,
					exerciseCount: 0,
					stepCount: 0,
					sectionCount: 0,
					sectionChunkCount: 0,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toEqual(['mcp-fundamentals', 'advanced-typescript'])
	expect(capturedCursor).toBe('cursor-value')
	expect(capturedBatchSize).toBe(5)
})

test(
	'workshop index route accepts urlencoded bodies with empty optional fields',
	async () => {
		let capturedWorkshops: Array<string> | undefined
		let capturedCursor: string | undefined
		let capturedBatchSize: number | undefined
		const response = await handleWorkshopIndexRequest(
			new Request(`https://example.com${workshopIndexRoutePath}`, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer admin-token',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					workshops: '',
					cursor: '',
					batchSize: '5',
				}).toString(),
			}),
			createEnv(),
			{
				runWorkshopReindexFn: async ({ onlyWorkshops, cursor, batchSize }) => {
					capturedWorkshops = onlyWorkshops
					capturedCursor = cursor
					capturedBatchSize = batchSize
					return {
						runId: 'run-123',
						workshopCount: 0,
						exerciseCount: 0,
						stepCount: 0,
						sectionCount: 0,
						sectionChunkCount: 0,
					}
				},
			},
		)

		expect(response.status).toBe(200)
		expect(capturedWorkshops).toBeUndefined()
		expect(capturedCursor).toBeUndefined()
		expect(capturedBatchSize).toBe(5)
	},
)

test('workshop index route rejects oversized request bodies', async () => {
	let reindexCalled = false
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: 'x'.repeat(workshopIndexRequestBodyMaxChars + 1),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				reindexCalled = true
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(413)
	expect(reindexCalled).toBe(false)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Reindex payload is too large.',
		details: [requestBodyMaxErrorMessage],
	})
})

test('workshop index route rejects oversized content-length header values', async () => {
	let reindexCalled = false
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
				'Content-Length': String(workshopIndexRequestBodyMaxChars + 1),
			},
			body: '{}',
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				reindexCalled = true
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(413)
	expect(reindexCalled).toBe(false)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Reindex payload is too large.',
		details: [requestBodyMaxErrorMessage],
	})
})

test('workshop index route ignores malformed content-length headers', async () => {
	let reindexCalled = false
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
				'Content-Length': `${workshopIndexRequestBodyMaxChars + 1}abc`,
			},
			body: '{}',
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				reindexCalled = true
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(reindexCalled).toBe(true)
})

test('workshop index route accepts whitespace-padded content-length headers', async () => {
	let reindexCalled = false
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
				'Content-Length': ` ${workshopIndexRequestBodyMaxChars - 1} `,
			},
			body: '{}',
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				reindexCalled = true
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(reindexCalled).toBe(true)
})

test('workshop index route rejects oversized bodies even when content-length is underreported', async () => {
	let reindexCalled = false
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
				'Content-Length': '2',
			},
			body: 'x'.repeat(workshopIndexRequestBodyMaxChars + 1),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				reindexCalled = true
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(413)
	expect(reindexCalled).toBe(false)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Reindex payload is too large.',
		details: [requestBodyMaxErrorMessage],
	})
})

test('workshop index route rejects oversized workshop filters', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: Array.from(
					{ length: workshopFilterMaxCount + 1 },
					(_, index) => `workshop-${index}`,
				),
			}),
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: [workshopFilterMaxErrorMessage],
	})
})

test('workshop index route rejects oversized string workshop filters', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: Array.from(
					{ length: workshopFilterMaxCount + 1 },
					(_, index) => `workshop-${index}`,
				).join(','),
			}),
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: [workshopFilterMaxErrorMessage],
	})
})

test('workshop index route allows oversized duplicate workshop filters after normalization', async () => {
	let capturedWorkshops: Array<string> | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: Array.from(
					{ length: workshopFilterMaxCount + 1 },
					() => 'MCP-FUNDAMENTALS',
				),
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops }) => {
				capturedWorkshops = onlyWorkshops
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toEqual(['mcp-fundamentals'])
})

test('workshop index route returns reindex summary when authorized', async () => {
	let capturedWorkshops: Array<string> | undefined
	let capturedCursor: string | undefined
	let capturedBatchSize: number | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: ['mcp-fundamentals'],
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops }) => {
				capturedWorkshops = onlyWorkshops
				capturedCursor = undefined
				capturedBatchSize = undefined
				return {
					runId: 'run-123',
					workshopCount: 1,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 2,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toEqual(['mcp-fundamentals'])
	expect(capturedCursor).toBeUndefined()
	expect(capturedBatchSize).toBeUndefined()
	const payload = await response.json()
	expect(payload).toEqual({
		ok: true,
		runId: 'run-123',
		workshopCount: 1,
		exerciseCount: 1,
		stepCount: 1,
		sectionCount: 1,
		sectionChunkCount: 2,
	})
})

test('workshop index route forwards cursor and batch size to indexer', async () => {
	let capturedCursor: string | undefined
	let capturedBatchSize: number | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				cursor: 'cursor-value',
				batchSize: 5,
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ cursor, batchSize }) => {
				capturedCursor = cursor
				capturedBatchSize = batchSize
				return {
					runId: 'run-123',
					workshopCount: 0,
					exerciseCount: 0,
					stepCount: 0,
					sectionCount: 0,
					sectionChunkCount: 0,
					nextCursor: 'next-cursor',
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedCursor).toBe('cursor-value')
	expect(capturedBatchSize).toBe(5)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: true,
		runId: 'run-123',
		workshopCount: 0,
		exerciseCount: 0,
		stepCount: 0,
		sectionCount: 0,
		sectionChunkCount: 0,
		nextCursor: 'next-cursor',
	})
})

test('workshop index route rejects batch sizes above the max', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				batchSize: workshopIndexBatchMaxSize + 1,
			}),
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: [batchSizeMaxErrorMessage],
	})
})

test('workshop index route rejects batch sizes below 1', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				batchSize: 0,
			}),
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: [batchSizeMinErrorMessage],
	})
})

test('workshop index route normalizes and lowercases workshop filters', async () => {
	let capturedWorkshops: Array<string> | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: [
					' MCP-FUNDAMENTALS ',
					'Advanced-TypeScript',
					'mcp-fundamentals',
				],
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops }) => {
				capturedWorkshops = onlyWorkshops
				return {
					runId: 'run-123',
					workshopCount: 2,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toEqual(['mcp-fundamentals', 'advanced-typescript'])
})

test('workshop index route treats empty workshop filters as full reindex', async () => {
	let capturedWorkshops: Array<string> | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: [],
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops }) => {
				capturedWorkshops = onlyWorkshops
				return {
					runId: 'run-123',
					workshopCount: 2,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toBeUndefined()
})

test('workshop index route supports comma/newline workshop filter strings', async () => {
	let capturedWorkshops: Array<string> | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops:
					' MCP-FUNDAMENTALS,\nadvanced-typescript,\n\nmcp-fundamentals ',
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops }) => {
				capturedWorkshops = onlyWorkshops
				return {
					runId: 'run-123',
					workshopCount: 2,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toEqual(['mcp-fundamentals', 'advanced-typescript'])
})

test('workshop index route treats blank string workshop filters as full reindex', async () => {
	let capturedWorkshops: Array<string> | undefined
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: ' \n , \r\n ',
			}),
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async ({ onlyWorkshops }) => {
				capturedWorkshops = onlyWorkshops
				return {
					runId: 'run-123',
					workshopCount: 2,
					exerciseCount: 1,
					stepCount: 1,
					sectionCount: 1,
					sectionChunkCount: 1,
				}
			},
		},
	)

	expect(response.status).toBe(200)
	expect(capturedWorkshops).toBeUndefined()
})

test('workshop index route rejects null workshop filters', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				workshops: null,
			}),
		}),
		createEnv(),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: ['Invalid input: expected array, received null'],
	})
})

test('workshop index route returns 400 for reindex input errors', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
			},
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				throw new WorkshopIndexInputError(
					'Unknown workshop filter(s): not-a-workshop.',
				)
			},
		},
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Invalid reindex payload.',
		details: ['Unknown workshop filter(s): not-a-workshop.'],
	})
})

test('workshop index route returns 500 when reindex fails', async () => {
	const response = await handleWorkshopIndexRequest(
		new Request(`https://example.com${workshopIndexRoutePath}`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer admin-token',
			},
		}),
		createEnv(),
		{
			runWorkshopReindexFn: async () => {
				throw new Error('boom')
			},
		},
	)

	expect(response.status).toBe(500)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'boom',
	})
})
