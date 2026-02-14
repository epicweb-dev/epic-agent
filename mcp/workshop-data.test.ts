/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { listStoredVectorIdsForWorkshop } from './workshop-data.ts'

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
