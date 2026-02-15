/// <reference types="bun" />
import { expect, test } from 'bun:test'
import {
	handleWorkshopIndexRequest,
	workshopFilterMaxCount,
	workshopIndexRoutePath,
} from './workshop-index.ts'

function createEnv(overrides: Partial<Env> = {}) {
	return {
		WORKSHOP_INDEX_ADMIN_TOKEN: 'admin-token',
		...overrides,
	} as Env
}

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
		details: ['workshops must include at most 100 entries.'],
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
		details: ['workshops must include at most 100 entries.'],
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
