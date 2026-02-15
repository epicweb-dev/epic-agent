/// <reference types="bun" />
import { expect, test } from 'bun:test'
import {
	retrieveDiffContext,
	retrieveWorkshopList,
	searchTopicContext,
} from './workshop-retrieval.ts'
import {
	listWorkshopsMaxLimit,
	topicSearchMaxLimit,
} from './workshop-contracts.ts'

type MockQueryMatch = {
	id: string
	score: number
}

type MockSectionRow = {
	workshop_slug: string
	label: string
	section_kind: string
	content: string
	source_path?: string | null
	exercise_number?: number | null
	step_number?: number | null
	is_diff?: number
}

function createMockDb({
	rowsByVectorId,
	sectionRows = [],
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
			source_path?: string | null
		}
	>
	sectionRows?: Array<MockSectionRow>
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
				if (query.includes('FROM indexed_sections')) {
					return {
						bind(...scopeArgs: Array<string | number>) {
							return {
								async all() {
									const [workshop, exerciseNumber, stepNumber] = scopeArgs
									const isDiffOnly = query.includes('is_diff = 1')
									const filtered = sectionRows.filter((row) => {
										if (row.workshop_slug !== workshop) return false
										if (
											typeof exerciseNumber === 'number' &&
											row.exercise_number !== null &&
											row.exercise_number !== undefined &&
											row.exercise_number !== exerciseNumber
										) {
											return false
										}
										if (
											typeof stepNumber === 'number' &&
											row.step_number !== null &&
											row.step_number !== undefined &&
											row.step_number !== stepNumber
										) {
											return false
										}
										if (isDiffOnly && row.is_diff !== 1) return false
										return true
									})
									return {
										results: filtered.map((row) => ({
											label: row.label,
											section_kind: row.section_kind,
											content: row.content,
											source_path: row.source_path ?? null,
											exercise_number: row.exercise_number ?? null,
											step_number: row.step_number ?? null,
										})),
									}
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

test('retrieveWorkshopList clamps limit to shared max', async () => {
	const observedListBindCalls: Array<Array<number>> = []
	const db = {
		prepare() {
			return {
				bind(...args: Array<number>) {
					observedListBindCalls.push(args)
					return {
						async all() {
							return {
								results: [
									{
										workshop_slug: 'mcp-fundamentals',
										title: 'MCP Fundamentals',
										exercise_count: 3,
										has_diffs: 1,
										last_indexed_at: '2026-02-14T00:00:00.000Z',
										product: 'epicweb',
									},
								],
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const env = { APP_DB: db } as unknown as Env

	const result = await retrieveWorkshopList({
		env,
		limit: 999,
	})

	expect(observedListBindCalls).toEqual([[listWorkshopsMaxLimit + 1, 0]])
	expect(result.workshops).toHaveLength(1)
})

test('searchTopicContext validates workshop scope before binding checks', async () => {
	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: [],
	})
	const env = {
		APP_DB: db,
	} as unknown as Env

	await expect(
		searchTopicContext({
			env,
			query: 'model context protocol',
			workshop: 'unknown-workshop',
		}),
	).rejects.toThrow('Unknown workshop "unknown-workshop".')
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
				source_path: 'exercises/01/README.mdx',
			},
			'run:workshop:20:0': {
				chunk_content: 'Tool schemas and validation',
				workshop_slug: 'mcp-fundamentals',
				exercise_number: 2,
				step_number: 1,
				section_kind: 'solution-instructions',
				label: 'Solution instructions',
				source_path: 'exercises/02/README.mdx',
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
		query: '  schema validation  ',
		limit: 4,
		workshop: 'mcp-fundamentals',
		exerciseNumber: 2,
	})

	expect(result.query).toBe('schema validation')
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
		sourcePath: 'exercises/01/README.mdx',
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

test('searchTopicContext validates global exercise scope before embedding', async () => {
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
		globalExercises: [1],
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
			exerciseNumber: 9,
		}),
	).rejects.toThrow('Unknown exercise 9.')
	expect(embeddingCalls).toBe(0)
})

test('searchTopicContext clamps limit to shared max', async () => {
	let observedTopK = 0
	const ai = {
		async run() {
			return {
				data: [[0.12, 0.34, 0.56]],
			}
		},
	} as unknown as Ai
	const vectorIndex = {
		async query(_embedding: Array<number>, options?: VectorizeQueryOptions) {
			observedTopK = options?.topK ?? 0
			return {
				matches: [],
				count: 0,
			}
		},
	} as unknown as Vectorize
	const { db } = createMockDb({
		rowsByVectorId: {},
		globalExercises: [1],
	})
	const env = {
		AI: ai,
		WORKSHOP_VECTOR_INDEX: vectorIndex,
		APP_DB: db,
	} as unknown as Env

	const result = await searchTopicContext({
		env,
		query: 'schema validation',
		limit: 999,
		exerciseNumber: 1,
	})

	expect(observedTopK).toBe(topicSearchMaxLimit)
	expect(result.limit).toBe(topicSearchMaxLimit)
})

test('retrieveDiffContext includes trimmed focus and step scope in no-match errors', async () => {
	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: ['mcp-fundamentals'],
		workshopExercises: { 'mcp-fundamentals': [1] },
		workshopSteps: { 'mcp-fundamentals': ['1:1'] },
		sectionRows: [
			{
				workshop_slug: 'mcp-fundamentals',
				exercise_number: 1,
				step_number: 1,
				section_kind: 'diff-hunk',
				label: 'Diff hunk',
				content: 'diff --git a/src/index.ts b/src/index.ts',
				source_path: 'src/index.ts',
				is_diff: 1,
			},
		],
	})
	const env = { APP_DB: db } as unknown as Env

	await expect(
		retrieveDiffContext({
			env,
			workshop: 'mcp-fundamentals',
			exerciseNumber: 1,
			stepNumber: 1,
			focus: '   no-such-file   ',
		}),
	).rejects.toThrow(
		'No diff context matched focus "no-such-file" for workshop "mcp-fundamentals" exercise 1 step 1.',
	)
})

test('retrieveDiffContext includes step scope when diff sections are missing', async () => {
	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: ['mcp-fundamentals'],
		workshopExercises: { 'mcp-fundamentals': [1] },
		workshopSteps: { 'mcp-fundamentals': ['1:1'] },
		sectionRows: [],
	})
	const env = { APP_DB: db } as unknown as Env

	await expect(
		retrieveDiffContext({
			env,
			workshop: 'mcp-fundamentals',
			exerciseNumber: 1,
			stepNumber: 1,
		}),
	).rejects.toThrow(
		'No diff context found for workshop "mcp-fundamentals" exercise 1 step 1.',
	)
})

test('retrieveDiffContext focus filter is case-insensitive across diff fields', async () => {
	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: ['mcp-fundamentals'],
		workshopExercises: { 'mcp-fundamentals': [1] },
		workshopSteps: { 'mcp-fundamentals': ['1:1'] },
		sectionRows: [
			{
				workshop_slug: 'mcp-fundamentals',
				exercise_number: 1,
				step_number: 1,
				section_kind: 'diff-summary',
				label: 'API route diff',
				content: 'Changed form action and request handlers.',
				source_path: 'app/routes/login.tsx',
				is_diff: 1,
			},
			{
				workshop_slug: 'mcp-fundamentals',
				exercise_number: 1,
				step_number: 1,
				section_kind: 'diff-hunk',
				label: 'Validation notes',
				content: 'Added schema validation guard.',
				source_path: 'app/lib/schema.ts',
				is_diff: 1,
			},
		],
	})
	const env = { APP_DB: db } as unknown as Env

	const sourcePathMatch = await retrieveDiffContext({
		env,
		workshop: 'mcp-fundamentals',
		exerciseNumber: 1,
		stepNumber: 1,
		focus: 'SCHEMA.TS',
	})
	expect(sourcePathMatch.diffSections).toHaveLength(1)
	expect(sourcePathMatch.diffSections[0]?.label).toBe('Validation notes')

	const contentMatch = await retrieveDiffContext({
		env,
		workshop: 'mcp-fundamentals',
		exerciseNumber: 1,
		stepNumber: 1,
		focus: 'FORM ACTION',
	})
	expect(contentMatch.diffSections).toHaveLength(1)
	expect(contentMatch.diffSections[0]?.label).toBe('API route diff')
})

test('retrieveDiffContext ignores whitespace-only focus filters', async () => {
	const { db } = createMockDb({
		rowsByVectorId: {},
		workshops: ['mcp-fundamentals'],
		workshopExercises: { 'mcp-fundamentals': [1] },
		workshopSteps: { 'mcp-fundamentals': ['1:1'] },
		sectionRows: [
			{
				workshop_slug: 'mcp-fundamentals',
				exercise_number: 1,
				step_number: 1,
				section_kind: 'diff-summary',
				label: 'API route diff',
				content: 'Changed form action and request handlers.',
				source_path: 'app/routes/login.tsx',
				is_diff: 1,
			},
			{
				workshop_slug: 'mcp-fundamentals',
				exercise_number: 1,
				step_number: 1,
				section_kind: 'diff-hunk',
				label: 'Validation notes',
				content: 'Added schema validation guard.',
				source_path: 'app/lib/schema.ts',
				is_diff: 1,
			},
		],
	})
	const env = { APP_DB: db } as unknown as Env

	const result = await retrieveDiffContext({
		env,
		workshop: 'mcp-fundamentals',
		exerciseNumber: 1,
		stepNumber: 1,
		focus: '   ',
	})

	expect(result.diffSections).toHaveLength(2)
})
