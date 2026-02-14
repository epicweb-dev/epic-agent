/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { searchTopicContext } from './workshop-retrieval.ts'

type MockQueryMatch = {
	id: string
	score: number
}

function createMockDb({
	rowsByVectorId,
}: {
	rowsByVectorId: Record<
		string,
		{
			chunk_content: string
			workshop_slug: string
			exercise_number?: number | null
			step_number?: number | null
			section_kind?: string | null
			label?: string | null
		}
	>
}) {
	return {
		prepare() {
			return {
				bind(vectorId: string) {
					return {
						async first() {
							return rowsByVectorId[vectorId] ?? null
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('searchTopicContext throws clear error without bindings', async () => {
	const env = {
		APP_DB: createMockDb({ rowsByVectorId: {} }),
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: 'model context protocol',
		}),
	).rejects.toThrow(
		'Vector search is unavailable because WORKSHOP_VECTOR_INDEX and AI bindings are not configured.',
	)
})

test('searchTopicContext returns ranked matches from vector ids', async () => {
	let observedTopK = 0
	let observedFilter: unknown = null
	const ai = {
		async run() {
			return {
				data: [[0.12, 0.34, 0.56]],
			}
		},
	} as unknown as Ai

	const mockMatches: Array<MockQueryMatch> = [
		{ id: 'run:workshop:10:0', score: 0.91 },
		{ id: 'run:workshop:20:0', score: 0.75 },
	]
	const vectorIndex = {
		async query(_embedding: Array<number>, options?: VectorizeQueryOptions) {
			observedTopK = options?.topK ?? 0
			observedFilter = options?.filter ?? null
			return {
				matches: mockMatches,
				count: mockMatches.length,
			}
		},
	} as unknown as Vectorize

	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: createMockDb({
			rowsByVectorId: {
				'run:workshop:10:0': {
					chunk_content: 'MCP intro and architecture',
					workshop_slug: 'mcp-fundamentals',
					exercise_number: 1,
					step_number: 1,
					section_kind: 'problem-instructions',
					label: 'Problem instructions',
				},
				'run:workshop:20:0': {
					chunk_content: 'Tool schemas and validation',
					workshop_slug: 'mcp-fundamentals',
					exercise_number: 2,
					step_number: 1,
					section_kind: 'solution-instructions',
					label: 'Solution instructions',
				},
			},
		}),
	} as unknown as Env

	const result = await searchTopicContext({
		env,
		query: 'schema validation',
		limit: 4,
		workshop: 'mcp-fundamentals',
		exerciseNumber: 2,
	})

	expect(observedTopK).toBe(4)
	expect(observedFilter).toEqual({
		workshop_slug: 'mcp-fundamentals',
		exercise_number: 2,
	})
	expect(result.matches.length).toBe(2)
	expect(result.matches[0]).toEqual({
		score: 0.91,
		workshop: 'mcp-fundamentals',
		exerciseNumber: 1,
		stepNumber: 1,
		sectionKind: 'problem-instructions',
		sectionLabel: 'Problem instructions',
		chunk: 'MCP intro and architecture',
		vectorId: 'run:workshop:10:0',
	})
})
