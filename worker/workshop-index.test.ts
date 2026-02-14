/// <reference types="bun" />
import { expect, test } from 'bun:test'
import {
	handleWorkshopIndexRequest,
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
