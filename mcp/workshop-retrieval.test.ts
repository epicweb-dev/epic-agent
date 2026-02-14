/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { searchTopicContext } from './workshop-retrieval.ts'

type MockQueryMatch = {
	id: string
	score: number
}

function createMockDb({
	rowsByVectorId,
	workshops = [],
	workshopExercises = {},
	globalExercises = [],
	workshopSteps = {},
	globalSteps = {},
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
	workshops?: Array<string>
	workshopExercises?: Record<string, Array<number>>
	globalExercises?: Array<number>
	workshopSteps?: Record<string, Array<string>>
	globalSteps?: Record<string, true>
}) {
	const observedBindCalls: Array<Array<string>> = []
	return {
		db: {
			prepare(query: string) {
				if (query.includes('FROM indexed_workshops')) {
					return {
						bind(workshop: string) {
							return {
								async first() {
									return workshops.includes(workshop)
										? { workshop_slug: workshop }
										: null
								},
							}
						},
					}
				}
				if (query.includes('FROM indexed_exercises')) {
					if (query.includes('workshop_slug = ?')) {
						return {
							bind(workshop: string, exerciseNumber: number) {
								return {
									async first() {
										const exercises = workshopExercises[workshop] ?? []
										return exercises.includes(exerciseNumber)
											? { exercise_number: exerciseNumber }
											: null
									},
								}
							},
						}
					}
					return {
						bind(exerciseNumber: number) {
							return {
								async first() {
									return globalExercises.includes(exerciseNumber)
										? { exercise_number: exerciseNumber }
										: null
								},
							}
						},
					}
				}
				if (query.includes('FROM indexed_steps')) {
					if (query.includes('workshop_slug = ?')) {
						return {
							bind(
								workshop: string,
								exerciseNumber: number,
								stepNumber: number,
							) {
								return {
									async first() {
										const key = `${exerciseNumber}:${stepNumber}`
										const stepKeys = workshopSteps[workshop] ?? []
										return stepKeys.includes(key)
											? { step_number: stepNumber }
											: null
									},
								}
							},
						}
					}
					return {
						bind(exerciseNumber: number, stepNumber: number) {
							return {
								async first() {
									const key = `${exerciseNumber}:${stepNumber}`
									return globalSteps[key] ? { step_number: stepNumber } : null
								},
							}
						},
					}
				}
				return {
					bind(...vectorIds: Array<string>) {
						observedBindCalls.push(vectorIds)
						return {
							async all() {
								const results = vectorIds
									.map((vectorId) => {
										const row = rowsByVectorId[vectorId]
										if (!row) return null
										return {
											vector_id: vectorId,
											...row,
										}
									})
									.filter(Boolean)
								return { results }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
		observedBindCalls,
	}
}

test('searchTopicContext throws clear error without bindings', async () => {
	const { db } = createMockDb({ rowsByVectorId: {} })
	const env = {
		APP_DB: db,
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

test('searchTopicContext requires exerciseNumber when stepNumber is provided', async () => {
	const { db } = createMockDb({ rowsByVectorId: {} })
	const env = {
		APP_DB: db,
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: 'topic placement',
			stepNumber: 2,
		}),
	).rejects.toThrow(
		'exerciseNumber is required when stepNumber is provided for topic search.',
	)
})

test('searchTopicContext rejects too-short queries before embedding', async () => {
	let embeddingCalls = 0
	const ai = {
		async run() {
			embeddingCalls += 1
			return {
				data: [[0.12, 0.34, 0.56]],
			}
		},
	} as unknown as Ai
	const vectorIndex = {
		async query() {
			return {
				matches: [],
				count: 0,
			}
		},
	} as unknown as Vectorize
	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: ['mcp-fundamentals'],
	})
	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: db,
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: '  a ',
			workshop: 'mcp-fundamentals',
		}),
	).rejects.toThrow('query must be at least 3 characters for topic search.')
	expect(embeddingCalls).toBe(0)
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
		{ id: ' run:workshop:10:0 ', score: 0.91 },
		{ id: 'run:workshop:10:0', score: 0.89 },
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

	const { db, observedBindCalls } = createMockDb({
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
		workshops: ['mcp-fundamentals'],
		workshopExercises: { 'mcp-fundamentals': [2] },
	})
	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: db,
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
	expect(observedBindCalls).toEqual([
		['run:workshop:10:0', 'run:workshop:20:0'],
	])
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

test('searchTopicContext validates workshop filter scope before embedding', async () => {
	let embeddingCalls = 0
	const ai = {
		async run() {
			embeddingCalls += 1
			return {
				data: [[0.12, 0.34, 0.56]],
			}
		},
	} as unknown as Ai
	const vectorIndex = {
		async query() {
			return {
				matches: [],
				count: 0,
			}
		},
	} as unknown as Vectorize

	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: [],
	})
	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: db,
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: 'schema validation',
			workshop: 'unknown-workshop',
		}),
	).rejects.toThrow('Unknown workshop "unknown-workshop".')
	expect(embeddingCalls).toBe(0)
})

test('searchTopicContext validates exercise filter scope before embedding', async () => {
	let embeddingCalls = 0
	const ai = {
		async run() {
			embeddingCalls += 1
			return {
				data: [[0.12, 0.34, 0.56]],
			}
		},
	} as unknown as Ai
	const vectorIndex = {
		async query() {
			return {
				matches: [],
				count: 0,
			}
		},
	} as unknown as Vectorize

	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: ['mcp-fundamentals'],
		workshopExercises: { 'mcp-fundamentals': [1] },
	})
	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: db,
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: 'schema validation',
			workshop: 'mcp-fundamentals',
			exerciseNumber: 2,
		}),
	).rejects.toThrow('Unknown exercise 2 for workshop "mcp-fundamentals".')
	expect(embeddingCalls).toBe(0)
})

test('searchTopicContext validates global step scope before embedding', async () => {
	let embeddingCalls = 0
	const ai = {
		async run() {
			embeddingCalls += 1
			return {
				data: [[0.12, 0.34, 0.56]],
			}
		},
	} as unknown as Ai
	const vectorIndex = {
		async query() {
			return {
				matches: [],
				count: 0,
			}
		},
	} as unknown as Vectorize

	const { db } = createMockDb({
		rowsByVectorId: {},
		globalExercises: [2],
		globalSteps: {},
	})
	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: db,
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: 'schema validation',
			exerciseNumber: 2,
			stepNumber: 3,
		}),
	).rejects.toThrow('Unknown step 3 for exercise 2.')
	expect(embeddingCalls).toBe(0)
})
