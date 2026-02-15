/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { RemoteD1Database } from './workshop-content-load.ts'

type FetchCall = {
	url: string
	init?: RequestInit
}

test('RemoteD1Database.batch sends { queries: [...] } payload to D1', async () => {
	const calls: Array<FetchCall> = []
	const originalFetch = globalThis.fetch

	const fetchMock = Object.assign(
		async (input: unknown, init?: RequestInit) => {
			const url =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.toString()
						: String(input)
			calls.push({ url, init })
			return new Response(
				JSON.stringify({
					success: true,
					result: [
						{ success: true, results: [], meta: {} },
						{ success: true, results: [], meta: {} },
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			)
		},
		{ preconnect() {} },
	) as unknown as typeof fetch

	globalThis.fetch = fetchMock

	try {
		const db = new RemoteD1Database({
			accountId: 'acct_123',
			apiToken: 'token_123',
			databaseId: 'db_123',
		})
		const statementOne = db.prepare('SELECT ? as value').bind(1)
		const statementTwo = db.prepare('SELECT ? as value').bind('two')

		await db.batch([statementOne, statementTwo])

		expect(calls).toHaveLength(1)
		const [call] = calls
		expect(call?.url).toContain(
			'/client/v4/accounts/acct_123/d1/database/db_123/query',
		)
		expect(call?.init?.method).toBe('POST')

		const rawBody = String(call?.init?.body ?? '')
		const parsed = JSON.parse(rawBody) as unknown
		expect(parsed).toEqual({
			queries: [
				{ sql: 'SELECT ? as value', params: [1] },
				{ sql: 'SELECT ? as value', params: ['two'] },
			],
		})
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('RemoteD1Database.batch returns empty array for empty input', async () => {
	let called = false
	const originalFetch = globalThis.fetch
	const fetchMock = Object.assign(
		async () => {
			called = true
			return new Response('unexpected')
		},
		{ preconnect() {} },
	) as unknown as typeof fetch

	globalThis.fetch = fetchMock

	try {
		const db = new RemoteD1Database({
			accountId: 'acct_123',
			apiToken: 'token_123',
			databaseId: 'db_123',
		})
		const result = await db.batch([])
		expect(result).toEqual([])
		expect(called).toBe(false)
	} finally {
		globalThis.fetch = originalFetch
	}
})
