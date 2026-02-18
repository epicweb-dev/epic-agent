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
import { prepareEmbeddingText } from './workshop-embeddings.ts'
import {
	getErrorMessage,
	isWorkersAiCapacityError,
} from './workers-ai-errors.ts'
import {
	listWorkshopsMaxLimit,
	topicSearchMaxLimit,
	type RetrieveLearningContextInput,
} from './workshop-contracts.ts'

const defaultContextMaxChars = 50_000
const defaultHardMaxChars = 80_000
const defaultVectorSearchLimit = 8
const defaultKeywordExcerptMaxChars = 900
const defaultKeywordExcerptContextChars = 260

type VectorSearchEnv = Env & {
	WORKSHOP_VECTOR_INDEX?: Vectorize
	AI?: Ai
}

function resolvePayloadLimits(env: Env) {
	const hardMaxChars = Math.max(
		1,
		env.WORKSHOP_CONTEXT_HARD_MAX_CHARS ?? defaultHardMaxChars,
	)
	const defaultMaxChars = Math.min(
		hardMaxChars,
		Math.max(
			1,
			env.WORKSHOP_CONTEXT_DEFAULT_MAX_CHARS ?? defaultContextMaxChars,
		),
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
	all,
	cursor,
	product,
	hasDiffs,
}: {
	env: Env
	limit?: number
	all?: boolean
	cursor?: string
	product?: string
	hasDiffs?: boolean
}) {
	const startedAt = Date.now()
	const requestedLimit =
		typeof limit === 'number' && Number.isFinite(limit)
			? limit
			: listWorkshopsMaxLimit
	const pageLimit = Math.min(Math.max(requestedLimit, 1), listWorkshopsMaxLimit)
	// Default to fetching all pages to avoid "it only returned the first 20/100"
	// surprises. Callers can opt into a single page response with `all: false`.
	const shouldFetchAll = all !== false

	if (!shouldFetchAll) {
		const result = await listIndexedWorkshops({
			db: env.APP_DB,
			limit: pageLimit,
			cursor,
			product,
			hasDiffs,
		})
		console.info(
			'mcp-list-workshops',
			JSON.stringify({
				all: false,
				limit: pageLimit,
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

	const maxPages = 500
	const maxWorkshops = 10_000
	const allWorkshops: Awaited<
		ReturnType<typeof listIndexedWorkshops>
	>['workshops'] = []
	let nextCursor = cursor
	let pageCount = 0

	while (true) {
		pageCount += 1
		if (pageCount > maxPages) {
			throw new Error(
				`Exceeded maximum list_workshops pagination pages (${maxPages}).`,
			)
		}
		const remaining = maxWorkshops - allWorkshops.length
		if (remaining <= 0) break
		const limitForPage = Math.min(pageLimit, remaining)
		const result = await listIndexedWorkshops({
			db: env.APP_DB,
			limit: limitForPage,
			cursor: nextCursor,
			product,
			hasDiffs,
		})
		allWorkshops.push(...result.workshops)
		nextCursor = result.nextCursor ?? undefined
		if (!nextCursor) break
	}

	console.info(
		'mcp-list-workshops',
		JSON.stringify({
			all: true,
			pageLimit,
			pageCount,
			product,
			hasDiffs,
			workshopCount: allWorkshops.length,
			hasNextCursor: Boolean(nextCursor),
			durationMs: Date.now() - startedAt,
		}),
	)
	return {
		workshops: allWorkshops,
		...(nextCursor ? { nextCursor } : {}),
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
		text: [prepareEmbeddingText({ content: query })],
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

function scoreFromMatchPos(matchPos: number) {
	if (!Number.isFinite(matchPos) || matchPos <= 0) return 0
	// Heuristic for keyword fallback: earlier hits are more relevant.
	return 1 / (1 + (matchPos - 1) / 80)
}

function buildKeywordExcerpt({
	content,
	query,
	maxChars = defaultKeywordExcerptMaxChars,
	contextChars = defaultKeywordExcerptContextChars,
}: {
	content: string
	query: string
	maxChars?: number
	contextChars?: number
}) {
	const normalizedContent = content ?? ''
	const normalizedQuery = query.trim()
	if (!normalizedContent || !normalizedQuery) {
		return normalizedContent.slice(0, Math.max(0, maxChars))
	}
	const haystack = normalizedContent.toLowerCase()
	const needle = normalizedQuery.toLowerCase()
	const matchIndex = haystack.indexOf(needle)
	if (matchIndex < 0) return normalizedContent.slice(0, Math.max(0, maxChars))

	const leftContext = Math.max(0, contextChars)
	const rightContext = Math.max(0, contextChars)
	const start = Math.max(0, matchIndex - leftContext)
	const end = Math.min(
		normalizedContent.length,
		matchIndex + normalizedQuery.length + rightContext,
	)
	let excerpt = normalizedContent.slice(start, end)
	if (start > 0) excerpt = `...${excerpt}`
	if (end < normalizedContent.length) excerpt = `${excerpt}...`
	if (excerpt.length <= maxChars) return excerpt
	return `${excerpt.slice(0, Math.max(0, maxChars))}...`
}

type KeywordChunkMatchRow = {
	chunk_id?: number | null
	vector_id?: string | null
	chunk_content?: string | null
	workshop_slug?: string | null
	exercise_number?: number | null
	step_number?: number | null
	section_kind?: string | null
	label?: string | null
	source_path?: string | null
	match_pos?: number | null
}

async function keywordSearchTopicChunks({
	db,
	query,
	limit,
	workshop,
	exerciseNumber,
	stepNumber,
}: {
	db: D1Database
	query: string
	limit: number
	workshop?: string
	exerciseNumber?: number
	stepNumber?: number
}) {
	const loweredQuery = query.toLowerCase()
	const whereClauses: Array<string> = ['instr(lower(c.content), ?1) > 0']
	const params: Array<string | number> = [loweredQuery]
	if (workshop) {
		whereClauses.push('c.workshop_slug = ?')
		params.push(workshop)
	}
	if (typeof exerciseNumber === 'number') {
		whereClauses.push('c.exercise_number = ?')
		params.push(exerciseNumber)
	}
	if (typeof stepNumber === 'number') {
		whereClauses.push('c.step_number = ?')
		params.push(stepNumber)
	}
	const querySql = `
		SELECT
			c.id AS chunk_id,
			c.vector_id,
			c.content AS chunk_content,
			c.workshop_slug,
			c.exercise_number,
			c.step_number,
			s.section_kind,
			s.label,
			s.source_path,
			instr(lower(c.content), ?1) AS match_pos
		FROM indexed_section_chunks c
		LEFT JOIN indexed_sections s
			ON s.workshop_slug = c.workshop_slug
			AND s.exercise_number IS c.exercise_number
			AND s.step_number IS c.step_number
			AND s.section_order = c.section_order
		WHERE ${whereClauses.join(' AND ')}
		ORDER BY match_pos ASC, c.char_count DESC, c.id ASC
		LIMIT ?
	`
	const result = await db
		.prepare(querySql)
		.bind(...params, limit)
		.all<KeywordChunkMatchRow>()
	return result.results ?? []
}

type KeywordSectionMatchRow = {
	section_id?: number | null
	content?: string | null
	workshop_slug?: string | null
	exercise_number?: number | null
	step_number?: number | null
	section_kind?: string | null
	label?: string | null
	source_path?: string | null
	match_pos?: number | null
}

async function keywordSearchTopicSections({
	db,
	query,
	limit,
	workshop,
	exerciseNumber,
	stepNumber,
}: {
	db: D1Database
	query: string
	limit: number
	workshop?: string
	exerciseNumber?: number
	stepNumber?: number
}) {
	const loweredQuery = query.toLowerCase()
	const whereClauses: Array<string> = ['instr(lower(content), ?1) > 0']
	const params: Array<string | number> = [loweredQuery]
	if (workshop) {
		whereClauses.push('workshop_slug = ?')
		params.push(workshop)
	}
	if (typeof exerciseNumber === 'number') {
		// Sections may be workshop-wide (NULL), but topic search scope is strict.
		whereClauses.push('exercise_number = ?')
		params.push(exerciseNumber)
	}
	if (typeof stepNumber === 'number') {
		whereClauses.push('step_number = ?')
		params.push(stepNumber)
	}
	const querySql = `
		SELECT
			id AS section_id,
			workshop_slug,
			exercise_number,
			step_number,
			section_kind,
			label,
			source_path,
			content,
			instr(lower(content), ?1) AS match_pos
		FROM indexed_sections
		WHERE ${whereClauses.join(' AND ')}
		ORDER BY match_pos ASC, char_count DESC, id ASC
		LIMIT ?
	`
	const result = await db
		.prepare(querySql)
		.bind(...params, limit)
		.all<KeywordSectionMatchRow>()
	return result.results ?? []
}

function buildVectorSearchSetupHint() {
	return [
		'To enable semantic topic search (Vectorize + Workers AI):',
		'- Create a Vectorize index (dimensions: 768, metric: cosine).',
		'- Add Wrangler bindings: `ai` binding "AI" and `vectorize` binding "WORKSHOP_VECTOR_INDEX" pointing at the index name.',
		'- Re-run workshop indexing to upsert vectors (GitHub Actions workflow "Load Workshop Content").',
	].join('\n')
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
	const topK = Math.min(
		Math.max(limit ?? defaultVectorSearchLimit, 1),
		topicSearchMaxLimit,
	)
	const filter: Record<string, string | number> = {}
	if (workshop) filter.workshop_slug = workshop
	if (typeof exerciseNumber === 'number')
		filter.exercise_number = exerciseNumber
	if (typeof stepNumber === 'number') filter.step_number = stepNumber

	const warnings: Array<string> = []
	let mode: 'vector' | 'keyword' = 'vector'
	let keywordSource: 'chunks' | 'sections' | null = null

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

	async function runKeywordFallback() {
		const keywordChunkRows = await keywordSearchTopicChunks({
			db: env.APP_DB,
			query: normalizedQuery,
			limit: topK,
			workshop,
			exerciseNumber,
			stepNumber,
		})
		if (keywordChunkRows.length > 0) {
			keywordSource = 'chunks'
			for (const row of keywordChunkRows) {
				const workshopSlug = row.workshop_slug?.trim()
				const chunkContent = row.chunk_content ?? ''
				if (!workshopSlug || chunkContent.trim().length === 0) continue
				const matchPos = typeof row.match_pos === 'number' ? row.match_pos : 0
				const vectorId =
					row.vector_id?.trim() ||
					`d1-chunk:${Math.max(0, Math.floor(row.chunk_id ?? 0))}`
				results.push({
					score: scoreFromMatchPos(matchPos),
					workshop: workshopSlug,
					exerciseNumber: row.exercise_number ?? undefined,
					stepNumber: row.step_number ?? undefined,
					sectionKind: row.section_kind ?? undefined,
					sectionLabel: row.label ?? undefined,
					sourcePath: row.source_path ?? undefined,
					chunk: chunkContent,
					vectorId,
				})
			}
		} else {
			keywordSource = 'sections'
			const keywordSectionRows = await keywordSearchTopicSections({
				db: env.APP_DB,
				query: normalizedQuery,
				limit: topK,
				workshop,
				exerciseNumber,
				stepNumber,
			})
			for (const row of keywordSectionRows) {
				const workshopSlug = row.workshop_slug?.trim()
				const content = row.content ?? ''
				if (!workshopSlug || content.trim().length === 0) continue
				const matchPos = typeof row.match_pos === 'number' ? row.match_pos : 0
				const vectorId = `d1-section:${Math.max(
					0,
					Math.floor(row.section_id ?? 0),
				)}`
				results.push({
					score: scoreFromMatchPos(matchPos),
					workshop: workshopSlug,
					exerciseNumber: row.exercise_number ?? undefined,
					stepNumber: row.step_number ?? undefined,
					sectionKind: row.section_kind ?? undefined,
					sectionLabel: row.label ?? undefined,
					sourcePath: row.source_path ?? undefined,
					chunk: buildKeywordExcerpt({ content, query: normalizedQuery }),
					vectorId,
				})
			}
		}
	}

	if (vectorIndex && ai) {
		try {
			const embedding = await embedSearchQuery({ ai, query: normalizedQuery })
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

			if (results.length === 0) {
				mode = 'keyword'
				warnings.push(
					'Vector search returned no resolved topic matches. Falling back to basic keyword search.',
				)
				await runKeywordFallback()
			}
		} catch (error) {
			mode = 'keyword'
			const message = getErrorMessage(error)
			if (isWorkersAiCapacityError(error)) {
				warnings.push(
					'Workers AI capacity temporarily exceeded while embedding the query. Falling back to basic keyword search.',
				)
			} else {
				warnings.push(
					`Vector search failed (${message.slice(0, 200)}). Falling back to basic keyword search.`,
				)
			}
			await runKeywordFallback()
		}
	} else {
		mode = 'keyword'
		warnings.push(
			'Vector search bindings are not configured (WORKSHOP_VECTOR_INDEX and/or AI). Falling back to basic keyword search.',
		)
		warnings.push(buildVectorSearchSetupHint())
		await runKeywordFallback()
	}

	console.info(
		'mcp-search-topic-context',
		JSON.stringify({
			mode,
			keywordSource,
			queryLength: normalizedQuery.length,
			topK,
			returned: results.length,
			filter,
			warningCount: warnings.length,
			durationMs: Date.now() - startedAt,
		}),
	)

	return {
		query: normalizedQuery,
		limit: topK,
		mode,
		vectorSearchAvailable: Boolean(vectorIndex && ai),
		keywordSource,
		warnings: warnings.length > 0 ? warnings : undefined,
		matches: results,
	}
}
