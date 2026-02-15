/// <reference types="bun" />
import { expect, test } from 'bun:test'
import {
	listIndexedWorkshops,
	listStoredVectorIdsForWorkshop,
} from './workshop-data.ts'

type IndexedWorkshopRow = {
	workshop_slug: string
	title: string
	exercise_count: number
	has_diffs: number
	last_indexed_at: string
	product?: string | null
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
