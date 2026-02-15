import {
	listIndexedWorkshops,
	listSectionsForScope,
	pickRandomExerciseScope,
} from './workshop-data.ts'
import {
	clampMaxChars,
	truncateSections,
	type RetrievalSection,
} from './workshop-truncation.ts'
import {
	listWorkshopsMaxLimit,
	topicSearchMaxLimit,
	type RetrieveLearningContextInput,
} from './workshop-contracts.ts'

const defaultContextMaxChars = 50_000
const defaultHardMaxChars = 80_000
const defaultVectorSearchLimit = 8

type VectorSearchEnv = Env & {
	WORKSHOP_VECTOR_INDEX?: Vectorize
	AI?: Ai
}

function resolvePayloadLimits(env: Env) {
	const defaultMaxChars = Math.max(
		1,
		env.WORKSHOP_CONTEXT_DEFAULT_MAX_CHARS ?? defaultContextMaxChars,
	)
	const hardMaxChars = Math.max(
		defaultMaxChars,
		env.WORKSHOP_CONTEXT_HARD_MAX_CHARS ?? defaultHardMaxChars,
	)
	return { defaultMaxChars, hardMaxChars }
}

async function workshopExists(db: D1Database, workshop: string) {
	const row = await db
		.prepare(
			`SELECT workshop_slug FROM indexed_workshops WHERE workshop_slug = ? LIMIT 1`,
		)
		.bind(workshop)
		.first()
	return Boolean(row)
}

async function exerciseExists({
	db,
	workshop,
	exerciseNumber,
}: {
	db: D1Database
	workshop: string
	exerciseNumber: number
}) {
	const row = await db
		.prepare(
			`
		SELECT exercise_number
		FROM indexed_exercises
		WHERE workshop_slug = ? AND exercise_number = ?
		LIMIT 1
	`,
		)
		.bind(workshop, exerciseNumber)
		.first()
	return Boolean(row)
}

async function stepExists({
	db,
	workshop,
	exerciseNumber,
	stepNumber,
}: {
	db: D1Database
	workshop: string
	exerciseNumber: number
	stepNumber: number
}) {
	const row = await db
		.prepare(
			`
		SELECT step_number
		FROM indexed_steps
		WHERE workshop_slug = ? AND exercise_number = ? AND step_number = ?
		LIMIT 1
	`,
		)
		.bind(workshop, exerciseNumber, stepNumber)
		.first()
	return Boolean(row)
}

async function exerciseExistsAnywhere({
	db,
	exerciseNumber,
}: {
	db: D1Database
	exerciseNumber: number
}) {
	const row = await db
		.prepare(
			`
		SELECT exercise_number
		FROM indexed_exercises
		WHERE exercise_number = ?
		LIMIT 1
	`,
		)
		.bind(exerciseNumber)
		.first()
	return Boolean(row)
}

async function stepExistsAnywhere({
	db,
	exerciseNumber,
	stepNumber,
}: {
	db: D1Database
	exerciseNumber: number
	stepNumber: number
}) {
	const row = await db
		.prepare(
			`
		SELECT step_number
		FROM indexed_steps
		WHERE exercise_number = ? AND step_number = ?
		LIMIT 1
	`,
		)
		.bind(exerciseNumber, stepNumber)
		.first()
	return Boolean(row)
}

function filterByFocus(sections: Array<RetrievalSection>, focus: string) {
	const normalized = focus.trim().toLowerCase()
	if (normalized.length === 0) return sections
	return sections.filter((section) => {
		return (
			section.label.toLowerCase().includes(normalized) ||
			section.kind.toLowerCase().includes(normalized) ||
			(section.sourcePath ?? '').toLowerCase().includes(normalized) ||
			section.content.toLowerCase().includes(normalized)
		)
	})
}

export async function retrieveWorkshopList({
	env,
	limit,
	cursor,
	product,
	hasDiffs,
}: {
	env: Env
	limit?: number
	cursor?: string
	product?: string
	hasDiffs?: boolean
}) {
	const startedAt = Date.now()
	const maxLimit = Math.min(Math.max(limit ?? 20, 1), listWorkshopsMaxLimit)
	const result = await listIndexedWorkshops({
		db: env.APP_DB,
		limit: maxLimit,
		cursor,
		product,
		hasDiffs,
	})
	console.info(
		'mcp-list-workshops',
		JSON.stringify({
			limit: maxLimit,
			product,
			hasDiffs,
			workshopCount: result.workshops.length,
			hasNextCursor: Boolean(result.nextCursor),
			durationMs: Date.now() - startedAt,
		}),
	)
	return {
		workshops: result.workshops,
		nextCursor: result.nextCursor ?? undefined,
	}
}

export async function retrieveLearningContext({
	env,
	input,
}: {
	env: Env
	input: RetrieveLearningContextInput
}) {
	const startedAt = Date.now()
	const { defaultMaxChars, hardMaxChars } = resolvePayloadLimits(env)
	const maxChars = clampMaxChars({
		requested: input.maxChars,
		defaultMaxChars,
		hardMaxChars,
	})
	let workshop: string
	let exerciseNumber: number
	let stepNumber: number | undefined

	if (input.random === true) {
		const randomScope = await pickRandomExerciseScope(env.APP_DB)
		if (!randomScope) {
			throw new Error(
				'No indexed exercises are available. Run manual reindex first.',
			)
		}
		workshop = randomScope.workshop_slug
		exerciseNumber = randomScope.exercise_number
	} else {
		workshop = input.workshop
		exerciseNumber = input.exerciseNumber
		stepNumber = input.stepNumber

		const workshopFound = await workshopExists(env.APP_DB, workshop)
		if (!workshopFound) {
			throw new Error(`Unknown workshop "${workshop}".`)
		}
		const exerciseFound = await exerciseExists({
			db: env.APP_DB,
			workshop,
			exerciseNumber,
		})
		if (!exerciseFound) {
			throw new Error(
				`Unknown exercise ${exerciseNumber} for workshop "${workshop}".`,
			)
		}
		if (typeof stepNumber === 'number') {
			const stepFound = await stepExists({
				db: env.APP_DB,
				workshop,
				exerciseNumber,
				stepNumber,
			})
			if (!stepFound) {
				throw new Error(
					`Unknown step ${stepNumber} for workshop "${workshop}" exercise ${exerciseNumber}.`,
				)
			}
		}
	}

	const sections = await listSectionsForScope({
		db: env.APP_DB,
		workshop,
		exerciseNumber,
		stepNumber,
		diffOnly: false,
	})

	if (sections.length === 0) {
		throw new Error(
			`No indexed context found for workshop "${workshop}" exercise ${exerciseNumber}.`,
		)
	}

	const truncatedResult = truncateSections({
		sections,
		maxChars,
		cursor: input.cursor,
	})
	console.info(
		'mcp-retrieve-learning-context',
		JSON.stringify({
			workshop,
			exerciseNumber,
			stepNumber,
			random: input.random === true,
			sectionCount: truncatedResult.sections.length,
			truncated: truncatedResult.truncated,
			hasNextCursor: Boolean(truncatedResult.nextCursor),
			maxChars,
			durationMs: Date.now() - startedAt,
		}),
	)

	return {
		workshop,
		exerciseNumber,
		stepNumber,
		sections: truncatedResult.sections,
		truncated: truncatedResult.truncated,
		nextCursor: truncatedResult.nextCursor,
	}
}

export async function retrieveDiffContext({
	env,
	workshop,
	exerciseNumber,
	stepNumber,
	focus,
	maxChars,
	cursor,
}: {
	env: Env
	workshop: string
	exerciseNumber: number
	stepNumber?: number
	focus?: string
	maxChars?: number
	cursor?: string
}) {
	const startedAt = Date.now()
	const workshopFound = await workshopExists(env.APP_DB, workshop)
	if (!workshopFound) {
		throw new Error(`Unknown workshop "${workshop}".`)
	}
	const exerciseFound = await exerciseExists({
		db: env.APP_DB,
		workshop,
		exerciseNumber,
	})
	if (!exerciseFound) {
		throw new Error(
			`Unknown exercise ${exerciseNumber} for workshop "${workshop}".`,
		)
	}
	if (typeof stepNumber === 'number') {
		const stepFound = await stepExists({
			db: env.APP_DB,
			workshop,
			exerciseNumber,
			stepNumber,
		})
		if (!stepFound) {
			throw new Error(
				`Unknown step ${stepNumber} for workshop "${workshop}" exercise ${exerciseNumber}.`,
			)
		}
	}

	const { defaultMaxChars, hardMaxChars } = resolvePayloadLimits(env)
	const effectiveMaxChars = clampMaxChars({
		requested: maxChars,
		defaultMaxChars,
		hardMaxChars,
	})

	const diffSections = await listSectionsForScope({
		db: env.APP_DB,
		workshop,
		exerciseNumber,
		stepNumber,
		diffOnly: true,
	})
	const normalizedFocus = typeof focus === 'string' ? focus.trim() : ''
	const focusedSections =
		normalizedFocus.length > 0
			? filterByFocus(diffSections, normalizedFocus)
			: diffSections
	const scopeLabel =
		typeof stepNumber === 'number'
			? `workshop "${workshop}" exercise ${exerciseNumber} step ${stepNumber}`
			: `workshop "${workshop}" exercise ${exerciseNumber}`
	if (focusedSections.length === 0) {
		if (normalizedFocus.length > 0) {
			throw new Error(
				`No diff context matched focus "${normalizedFocus}" for ${scopeLabel}.`,
			)
		}
		throw new Error(`No diff context found for ${scopeLabel}.`)
	}

	const truncatedResult = truncateSections({
		sections: focusedSections,
		maxChars: effectiveMaxChars,
		cursor,
	})
	console.info(
		'mcp-retrieve-diff-context',
		JSON.stringify({
			workshop,
			exerciseNumber,
			stepNumber,
			focus,
			diffSectionCount: truncatedResult.sections.length,
			truncated: truncatedResult.truncated,
			hasNextCursor: Boolean(truncatedResult.nextCursor),
			maxChars: effectiveMaxChars,
			durationMs: Date.now() - startedAt,
		}),
	)

	return {
		workshop,
		exerciseNumber,
		stepNumber,
		diffSections: truncatedResult.sections,
		truncated: truncatedResult.truncated,
		nextCursor: truncatedResult.nextCursor,
	}
}

async function embedSearchQuery({ ai, query }: { ai: Ai; query: string }) {
	const response = (await ai.run('@cf/baai/bge-base-en-v1.5', {
		text: [query],
	})) as unknown

	if (Array.isArray(response)) {
		const first = response[0]
		if (Array.isArray(first)) return first
	}

	if (
		response &&
		typeof response === 'object' &&
		'data' in response &&
		Array.isArray((response as { data?: unknown }).data)
	) {
		const first = (response as { data: Array<Array<number>> }).data[0]
		if (Array.isArray(first)) return first
	}

	throw new Error('Embedding model did not return a valid vector response.')
}

type TopicChunkLookupRow = {
	vector_id?: string | null
	chunk_content?: string
	workshop_slug?: string
	exercise_number?: number | null
	step_number?: number | null
	section_kind?: string | null
	label?: string | null
	source_path?: string | null
}

async function loadTopicChunkRows({
	db,
	vectorIds,
}: {
	db: D1Database
	vectorIds: Array<string>
}) {
	if (vectorIds.length === 0) {
		return new Map<string, TopicChunkLookupRow>()
	}
	const placeholders = vectorIds.map(() => '?').join(', ')
	const result = await db
		.prepare(
			`
			SELECT
				c.vector_id,
				c.content AS chunk_content,
				c.workshop_slug,
				c.exercise_number,
				c.step_number,
				s.section_kind,
				s.label,
				s.source_path
			FROM indexed_section_chunks c
			LEFT JOIN indexed_sections s
				ON s.workshop_slug = c.workshop_slug
				AND s.exercise_number IS c.exercise_number
				AND s.step_number IS c.step_number
				AND s.section_order = c.section_order
			WHERE c.vector_id IN (${placeholders})
		`,
		)
		.bind(...vectorIds)
		.all<TopicChunkLookupRow>()

	const rowsByVectorId = new Map<string, TopicChunkLookupRow>()
	for (const row of result.results ?? []) {
		const vectorId = row.vector_id?.trim()
		if (!vectorId || rowsByVectorId.has(vectorId)) continue
		rowsByVectorId.set(vectorId, row)
	}
	return rowsByVectorId
}

export async function searchTopicContext({
	env,
	query,
	limit,
	workshop,
	exerciseNumber,
	stepNumber,
}: {
	env: Env
	query: string
	limit?: number
	workshop?: string
	exerciseNumber?: number
	stepNumber?: number
}) {
	const startedAt = Date.now()
	const normalizedQuery = query.trim()
	if (normalizedQuery.length < 3) {
		throw new Error('query must be at least 3 characters for topic search.')
	}
	if (typeof stepNumber === 'number' && typeof exerciseNumber !== 'number') {
		throw new Error(
			'exerciseNumber is required when stepNumber is provided for topic search.',
		)
	}
	if (workshop) {
		const workshopFound = await workshopExists(env.APP_DB, workshop)
		if (!workshopFound) {
			throw new Error(`Unknown workshop "${workshop}".`)
		}
	}
	if (typeof exerciseNumber === 'number') {
		const exerciseFound = workshop
			? await exerciseExists({
					db: env.APP_DB,
					workshop,
					exerciseNumber,
				})
			: await exerciseExistsAnywhere({
					db: env.APP_DB,
					exerciseNumber,
				})
		if (!exerciseFound) {
			throw new Error(
				workshop
					? `Unknown exercise ${exerciseNumber} for workshop "${workshop}".`
					: `Unknown exercise ${exerciseNumber}.`,
			)
		}
	}
	if (typeof stepNumber === 'number') {
		const requiredExerciseNumber = exerciseNumber
		if (typeof requiredExerciseNumber !== 'number') {
			throw new Error(
				'exerciseNumber is required when stepNumber is provided for topic search.',
			)
		}
		const stepFound = workshop
			? await stepExists({
					db: env.APP_DB,
					workshop,
					exerciseNumber: requiredExerciseNumber,
					stepNumber,
				})
			: await stepExistsAnywhere({
					db: env.APP_DB,
					exerciseNumber: requiredExerciseNumber,
					stepNumber,
				})
		if (!stepFound) {
			throw new Error(
				workshop
					? `Unknown step ${stepNumber} for workshop "${workshop}" exercise ${requiredExerciseNumber}.`
					: `Unknown step ${stepNumber} for exercise ${requiredExerciseNumber}.`,
			)
		}
	}
	const vectorEnv = env as VectorSearchEnv
	const vectorIndex = vectorEnv.WORKSHOP_VECTOR_INDEX
	const ai = vectorEnv.AI
	if (!vectorIndex || !ai) {
		throw new Error(
			'Vector search is unavailable because WORKSHOP_VECTOR_INDEX and AI bindings are not configured.',
		)
	}

	const topK = Math.min(
		Math.max(limit ?? defaultVectorSearchLimit, 1),
		topicSearchMaxLimit,
	)
	const embedding = await embedSearchQuery({ ai, query: normalizedQuery })
	const filter: Record<string, string | number> = {}
	if (workshop) filter.workshop_slug = workshop
	if (typeof exerciseNumber === 'number')
		filter.exercise_number = exerciseNumber
	if (typeof stepNumber === 'number') filter.step_number = stepNumber

	const vectorMatches = await vectorIndex.query(embedding, {
		topK,
		returnMetadata: 'indexed',
		filter: Object.keys(filter).length > 0 ? filter : undefined,
	})
	const vectorIds = Array.from(
		new Set(
			vectorMatches.matches
				.map((match) => match.id?.trim())
				.filter((vectorId): vectorId is string => Boolean(vectorId)),
		),
	)
	const chunkRowsByVectorId = await loadTopicChunkRows({
		db: env.APP_DB,
		vectorIds,
	})

	const results: Array<{
		score: number
		workshop: string
		exerciseNumber?: number
		stepNumber?: number
		sectionKind?: string
		sectionLabel?: string
		sourcePath?: string
		chunk: string
		vectorId: string
	}> = []
	const seenVectorIds = new Set<string>()

	for (const match of vectorMatches.matches) {
		const vectorId = match.id?.trim()
		if (!vectorId) continue
		if (seenVectorIds.has(vectorId)) continue
		seenVectorIds.add(vectorId)
		const row = chunkRowsByVectorId.get(vectorId)
		if (!row?.chunk_content || !row.workshop_slug) continue
		results.push({
			score: match.score,
			workshop: row.workshop_slug,
			exerciseNumber: row.exercise_number ?? undefined,
			stepNumber: row.step_number ?? undefined,
			sectionKind: row.section_kind ?? undefined,
			sectionLabel: row.label ?? undefined,
			sourcePath: row.source_path ?? undefined,
			chunk: row.chunk_content,
			vectorId,
		})
	}

	console.info(
		'mcp-search-topic-context',
		JSON.stringify({
			queryLength: normalizedQuery.length,
			topK,
			returned: results.length,
			filter,
			durationMs: Date.now() - startedAt,
		}),
	)

	return {
		query: normalizedQuery,
		limit: topK,
		matches: results,
	}
}
