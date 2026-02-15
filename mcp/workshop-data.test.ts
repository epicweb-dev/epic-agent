/// <reference types="bun" />
import { expect, test } from 'bun:test'
import {
	listIndexedWorkshops,
	listStoredVectorIdsForWorkshop,
	replaceWorkshopIndex,
} from './workshop-data.ts'

type IndexedWorkshopRow = {
	workshop_slug: string
	title: string
	exercise_count: number
	has_diffs: number
	last_indexed_at: string
	product?: string | null
}

function createReplaceWorkshopIndexFixture() {
	return {
		runId: 'run-123',
		workshop: {
			workshopSlug: 'mcp-fundamentals',
			title: 'MCP Fundamentals',
			product: 'epicweb',
			repoOwner: 'epicweb-dev',
			repoName: 'mcp-fundamentals',
			defaultBranch: 'main',
			sourceSha: 'abc123',
			exerciseCount: 1,
			hasDiffs: true,
		},
		exercises: [
			{
				exerciseNumber: 1,
				title: 'Exercise 1',
				stepCount: 1,
			},
		],
		steps: [
			{
				exerciseNumber: 1,
				stepNumber: 1,
				problemDir: 'exercises/01.problem',
				solutionDir: 'exercises/01.solution',
				hasDiff: true,
			},
		],
		sections: [
			{
				exerciseNumber: 1,
				stepNumber: 1,
				sectionOrder: 1,
				sectionKind: 'diff-hunk',
				label: 'Diff chunk',
				sourcePath: 'src/index.ts',
				content: '@@ -1 +1 @@',
				isDiff: true,
			},
		],
		sectionChunks: [
			{
				exerciseNumber: 1,
				stepNumber: 1,
				sectionOrder: 1,
				chunkIndex: 0,
				content: '@@ -1 +1 @@',
				vectorId: 'run-123:mcp-fundamentals:1:0',
			},
		],
	}
}

test('listStoredVectorIdsForWorkshop normalizes and dedupes ids', async () => {
	let observedWorkshop = ''
	const db = {
		prepare() {
			return {
				bind(workshop: string) {
					observedWorkshop = workshop
					return {
						async all() {
							return {
								results: [
									{ vector_id: ' run:one ' },
									{ vector_id: '' },
									{ vector_id: null },
									{ vector_id: 'run:two' },
									{ vector_id: 'run:one' },
								],
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const vectorIds = await listStoredVectorIdsForWorkshop({
		db,
		workshop: 'mcp-fundamentals',
	})

	expect(observedWorkshop).toBe('mcp-fundamentals')
	expect(vectorIds).toEqual(['run:one', 'run:two'])
})

test('listIndexedWorkshops paginates with lookahead rows', async () => {
	const rows: Array<IndexedWorkshopRow> = [
		{
			workshop_slug: 'a-workshop',
			title: 'A Workshop',
			exercise_count: 2,
			has_diffs: 1,
			last_indexed_at: '2026-02-14T00:00:00.000Z',
			product: 'epicweb',
		},
		{
			workshop_slug: 'b-workshop',
			title: 'B Workshop',
			exercise_count: 1,
			has_diffs: 0,
			last_indexed_at: '2026-02-14T00:00:01.000Z',
			product: 'epicweb',
		},
		{
			workshop_slug: 'c-workshop',
			title: 'C Workshop',
			exercise_count: 4,
			has_diffs: 1,
			last_indexed_at: '2026-02-14T00:00:02.000Z',
			product: null,
		},
	]
	const observedListBinds: Array<Array<number>> = []
	const db = {
		prepare(query: string) {
			expect(query).not.toContain('COUNT(*) AS total')
			return {
				bind(...args: Array<number>) {
					observedListBinds.push(args)
					const limit = Number(args.at(-2) ?? 0)
					const offset = Number(args.at(-1) ?? 0)
					return {
						async all() {
							return {
								results: rows.slice(offset, offset + limit),
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const firstPage = await listIndexedWorkshops({
		db,
		limit: 2,
	})
	expect(firstPage.workshops).toHaveLength(2)
	expect(typeof firstPage.nextCursor).toBe('string')

	const secondPage = await listIndexedWorkshops({
		db,
		limit: 2,
		cursor: firstPage.nextCursor ?? undefined,
	})
	expect(secondPage.workshops).toHaveLength(1)
	expect(secondPage.nextCursor).toBeNull()
	expect(observedListBinds).toEqual([
		[3, 0],
		[3, 2],
	])
})

test('listIndexedWorkshops resets invalid cursor offsets to zero', async () => {
	let observedOffset = -1
	let observedLimit = -1
	const db = {
		prepare() {
			return {
				bind(...args: Array<number>) {
					observedLimit = Number(args.at(-2) ?? -1)
					observedOffset = Number(args.at(-1) ?? -1)
					return {
						async all() {
							return {
								results: [],
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const result = await listIndexedWorkshops({
		db,
		limit: 5,
		cursor: 'not-valid-base64',
	})

	expect(observedOffset).toBe(0)
	expect(observedLimit).toBe(6)
	expect(result.workshops).toEqual([])
	expect(result.nextCursor).toBeNull()
})

test('replaceWorkshopIndex does not issue SQL transaction statements', async () => {
	const executedSql: Array<string> = []
	const execCalls: Array<string> = []
	const db = {
		exec(sql: string) {
			execCalls.push(sql)
			return Promise.resolve()
		},
		prepare(sql: string) {
			return {
				bind(..._params: Array<unknown>) {
					executedSql.push(sql)
					return {
						async run() {
							return {}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const fixture = createReplaceWorkshopIndexFixture()
	await replaceWorkshopIndex({
		db,
		...fixture,
	})

	expect(execCalls).toEqual([])
	expect(executedSql).toHaveLength(10)
	expect(
		executedSql.some(
			(sql) =>
				sql.includes('BEGIN') ||
				sql.includes('COMMIT') ||
				sql.includes('ROLLBACK'),
		),
	).toBe(false)
})

test('replaceWorkshopIndex clears workshop scope after partial write failures', async () => {
	const executedSql: Array<string> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(..._params: Array<unknown>) {
					executedSql.push(sql)
					return {
						async run() {
							if (sql.includes('INSERT INTO indexed_steps')) {
								throw new Error('step insert failed')
							}
							return {}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const fixture = createReplaceWorkshopIndexFixture()
	await expect(
		replaceWorkshopIndex({
			db,
			...fixture,
		}),
	).rejects.toThrow('step insert failed')

	expect(
		executedSql.filter(
			(sql) =>
				sql.includes('DELETE FROM indexed_') &&
				sql.includes('workshop_slug = ?'),
		),
	).toHaveLength(10)
	expect(
		executedSql.filter((sql) => sql.includes('DELETE FROM indexed_sections')),
	).toHaveLength(2)
	expect(
		executedSql.filter((sql) => sql.includes('DELETE FROM indexed_workshops')),
	).toHaveLength(2)
})

test('replaceWorkshopIndex preserves original write error when cleanup also fails', async () => {
	let deleteStatementCount = 0
	const db = {
		prepare(sql: string) {
			return {
				bind(..._params: Array<unknown>) {
					return {
						async run() {
							if (sql.includes('DELETE FROM indexed_')) {
								deleteStatementCount += 1
								if (deleteStatementCount > 5) {
									throw new Error('cleanup failed')
								}
								return {}
							}
							if (sql.includes('INSERT INTO indexed_steps')) {
								throw new Error('step insert failed')
							}
							return {}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const capturedWarnings: Array<string> = []
	const originalWarn = console.warn
	console.warn = (...args: Array<unknown>) => {
		capturedWarnings.push(args.map((item) => String(item)).join(' '))
	}

	try {
		const fixture = createReplaceWorkshopIndexFixture()
		await expect(
			replaceWorkshopIndex({
				db,
				...fixture,
			}),
		).rejects.toThrow('step insert failed')
	} finally {
		console.warn = originalWarn
	}

	expect(deleteStatementCount).toBe(6)
	expect(
		capturedWarnings.some((warning) =>
			warning.includes('workshop-index-write-cleanup-failed'),
		),
	).toBe(true)
	expect(
		capturedWarnings.some(
			(warning) =>
				warning.includes('"originalError":"step insert failed"') &&
				warning.includes('"cleanupError":"cleanup failed"'),
		),
	).toBe(true)
})

test('replaceWorkshopIndex re-clears workshop scope when initial clear fails', async () => {
	let deleteStatementCount = 0
	let insertAttempted = false
	const db = {
		prepare(sql: string) {
			return {
				bind(..._params: Array<unknown>) {
					return {
						async run() {
							if (sql.includes('DELETE FROM indexed_')) {
								deleteStatementCount += 1
								if (deleteStatementCount === 3) {
									throw new Error('initial clear failed')
								}
								return {}
							}
							insertAttempted = true
							return {}
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const fixture = createReplaceWorkshopIndexFixture()
	await expect(
		replaceWorkshopIndex({
			db,
			...fixture,
		}),
	).rejects.toThrow('initial clear failed')

	expect(deleteStatementCount).toBe(8)
	expect(insertAttempted).toBe(false)
})
