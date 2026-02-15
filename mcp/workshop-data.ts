import { z } from 'zod'
import { type RetrievalSection } from './workshop-truncation.ts'

const workshopRowSchema = z.object({
	workshop_slug: z.string(),
	title: z.string(),
	exercise_count: z.number(),
	has_diffs: z.number(),
	last_indexed_at: z.string(),
	product: z.string().nullable().optional(),
})

const exerciseScopeSchema = z.object({
	workshop_slug: z.string(),
	exercise_number: z.number(),
})

const sectionRowSchema = z.object({
	label: z.string(),
	section_kind: z.string(),
	content: z.string(),
	source_path: z.string().nullable().optional(),
	exercise_number: z.number().nullable().optional(),
	step_number: z.number().nullable().optional(),
})

type PaginationCursor = {
	offset: number
}

export type WorkshopSummary = {
	workshop: string
	title: string
	exerciseCount: number
	hasDiffs: boolean
	lastIndexedAt: string
	product?: string
}

export type IndexedWorkshopWrite = {
	workshopSlug: string
	title: string
	product?: string
	repoOwner: string
	repoName: string
	defaultBranch: string
	sourceSha: string
	exerciseCount: number
	hasDiffs: boolean
}

export type IndexedExerciseWrite = {
	exerciseNumber: number
	title: string
	stepCount: number
}

export type IndexedStepWrite = {
	exerciseNumber: number
	stepNumber: number
	problemDir?: string
	solutionDir?: string
	hasDiff: boolean
}

export type IndexedSectionWrite = {
	exerciseNumber?: number
	stepNumber?: number
	sectionOrder: number
	sectionKind: string
	label: string
	sourcePath?: string
	content: string
	isDiff?: boolean
}

export type IndexedSectionChunkWrite = {
	exerciseNumber?: number
	stepNumber?: number
	sectionOrder: number
	chunkIndex: number
	content: string
	vectorId?: string
}

async function clearWorkshopIndexScope({
	db,
	workshopSlug,
}: {
	db: D1Database
	workshopSlug: string
}) {
	await db.batch([
		db
			.prepare(`DELETE FROM indexed_sections WHERE workshop_slug = ?`)
			.bind(workshopSlug),
		db
			.prepare(`DELETE FROM indexed_section_chunks WHERE workshop_slug = ?`)
			.bind(workshopSlug),
		db
			.prepare(`DELETE FROM indexed_steps WHERE workshop_slug = ?`)
			.bind(workshopSlug),
		db
			.prepare(`DELETE FROM indexed_exercises WHERE workshop_slug = ?`)
			.bind(workshopSlug),
		db
			.prepare(`DELETE FROM indexed_workshops WHERE workshop_slug = ?`)
			.bind(workshopSlug),
	])
}

function encodeCursor(cursor: PaginationCursor) {
	return btoa(JSON.stringify(cursor))
}

function decodeCursor(cursor: string | undefined) {
	if (!cursor) return { offset: 0 }
	try {
		const parsed = JSON.parse(atob(cursor)) as unknown
		if (
			parsed &&
			typeof parsed === 'object' &&
			'offset' in parsed &&
			typeof parsed.offset === 'number' &&
			parsed.offset >= 0
		) {
			return { offset: Math.floor(parsed.offset) }
		}
		return { offset: 0 }
	} catch {
		return { offset: 0 }
	}
}

function mapSectionRow(
	row: z.infer<typeof sectionRowSchema>,
): RetrievalSection {
	return {
		label: row.label,
		kind: row.section_kind,
		content: row.content,
		sourcePath: row.source_path ?? undefined,
		exerciseNumber: row.exercise_number ?? undefined,
		stepNumber: row.step_number ?? undefined,
	}
}

export async function listIndexedWorkshops({
	db,
	limit,
	cursor,
	product,
	hasDiffs,
}: {
	db: D1Database
	limit: number
	cursor?: string
	product?: string
	hasDiffs?: boolean
}) {
	const pagination = decodeCursor(cursor)
	const whereClauses: Array<string> = []
	const params: Array<string | number> = []

	if (product) {
		whereClauses.push('product = ?')
		params.push(product)
	}
	if (typeof hasDiffs === 'boolean') {
		whereClauses.push('has_diffs = ?')
		params.push(hasDiffs ? 1 : 0)
	}

	const whereSql =
		whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
	const query = `
		SELECT workshop_slug, title, exercise_count, has_diffs, last_indexed_at, product
		FROM indexed_workshops
		${whereSql}
		ORDER BY workshop_slug ASC
		LIMIT ? OFFSET ?
	`

	const result = await db
		.prepare(query)
		.bind(...params, limit + 1, pagination.offset)
		.all()
	const rows = workshopRowSchema.array().parse(result.results ?? [])
	const hasNextPage = rows.length > limit
	const pagedRows = hasNextPage ? rows.slice(0, limit) : rows
	const workshops: Array<WorkshopSummary> = pagedRows.map((row) => ({
		workshop: row.workshop_slug,
		title: row.title,
		exerciseCount: row.exercise_count,
		hasDiffs: row.has_diffs === 1,
		lastIndexedAt: row.last_indexed_at,
		product: row.product ?? undefined,
	}))

	const nextCursor = hasNextPage
		? encodeCursor({ offset: pagination.offset + workshops.length })
		: null

	return { workshops, nextCursor }
}

export async function pickRandomExerciseScope(db: D1Database) {
	const row = await db
		.prepare(
			`
		SELECT workshop_slug, exercise_number
		FROM indexed_exercises
		ORDER BY RANDOM()
		LIMIT 1
	`,
		)
		.first()
	if (!row) return null
	return exerciseScopeSchema.parse(row)
}

export async function listSectionsForScope({
	db,
	workshop,
	exerciseNumber,
	stepNumber,
	diffOnly,
}: {
	db: D1Database
	workshop: string
	exerciseNumber?: number
	stepNumber?: number
	diffOnly?: boolean
}) {
	const whereClauses: Array<string> = ['workshop_slug = ?']
	const params: Array<string | number> = [workshop]

	if (typeof exerciseNumber === 'number') {
		whereClauses.push('(exercise_number IS NULL OR exercise_number = ?)')
		params.push(exerciseNumber)
	}
	if (typeof stepNumber === 'number') {
		whereClauses.push('(step_number IS NULL OR step_number = ?)')
		params.push(stepNumber)
	}
	if (diffOnly) {
		whereClauses.push('is_diff = 1')
	}

	const query = `
		SELECT
			label,
			section_kind,
			content,
			source_path,
			exercise_number,
			step_number
		FROM indexed_sections
		WHERE ${whereClauses.join(' AND ')}
		ORDER BY section_order ASC, id ASC
	`
	const result = await db
		.prepare(query)
		.bind(...params)
		.all()
	const rows = sectionRowSchema.array().parse(result.results ?? [])
	return rows.map(mapSectionRow)
}

export async function listStoredVectorIdsForWorkshop({
	db,
	workshop,
}: {
	db: D1Database
	workshop: string
}) {
	const result = await db
		.prepare(
			`
		SELECT DISTINCT vector_id
		FROM indexed_section_chunks
		WHERE workshop_slug = ? AND vector_id IS NOT NULL AND LENGTH(vector_id) > 0
	`,
		)
		.bind(workshop)
		.all<{ vector_id?: string | null }>()

	return Array.from(
		new Set(
			(result.results ?? [])
				.map((row) => row.vector_id?.trim())
				.filter((vectorId): vectorId is string => Boolean(vectorId)),
		),
	)
}

export async function createIndexRun(db: D1Database) {
	const runId = crypto.randomUUID()
	await db
		.prepare(
			`
		INSERT INTO workshop_index_runs (id, status, started_at)
		VALUES (?, 'running', ?)
	`,
		)
		.bind(runId, new Date().toISOString())
		.run()
	return runId
}

export async function markIndexRunComplete({
	db,
	runId,
	workshopCount,
	exerciseCount,
	stepCount,
	sectionCount,
	sectionChunkCount,
}: {
	db: D1Database
	runId: string
	workshopCount: number
	exerciseCount: number
	stepCount: number
	sectionCount: number
	sectionChunkCount: number
}) {
	await db
		.prepare(
			`
		UPDATE workshop_index_runs
		SET
			status = 'completed',
			completed_at = ?,
			workshop_count = ?,
			exercise_count = ?,
			step_count = ?,
			section_count = ?,
			section_chunk_count = ?
		WHERE id = ?
	`,
		)
		.bind(
			new Date().toISOString(),
			workshopCount,
			exerciseCount,
			stepCount,
			sectionCount,
			sectionChunkCount,
			runId,
		)
		.run()
}

export async function markIndexRunFailed({
	db,
	runId,
	errorMessage,
}: {
	db: D1Database
	runId: string
	errorMessage: string
}) {
	await db
		.prepare(
			`
		UPDATE workshop_index_runs
		SET status = 'failed', completed_at = ?, error_message = ?
		WHERE id = ?
	`,
		)
		.bind(new Date().toISOString(), errorMessage, runId)
		.run()
}

export async function replaceWorkshopIndex({
	db,
	runId,
	workshop,
	exercises,
	steps,
	sections,
	sectionChunks,
}: {
	db: D1Database
	runId: string
	workshop: IndexedWorkshopWrite
	exercises: Array<IndexedExerciseWrite>
	steps: Array<IndexedStepWrite>
	sections: Array<IndexedSectionWrite>
	sectionChunks: Array<IndexedSectionChunkWrite>
}) {
	try {
		await clearWorkshopIndexScope({
			db,
			workshopSlug: workshop.workshopSlug,
		})

		const statements: Array<D1PreparedStatement> = [
			db
				.prepare(
					`
			INSERT INTO indexed_workshops (
				workshop_slug,
				title,
				product,
				repo_owner,
				repo_name,
				default_branch,
				source_sha,
				exercise_count,
				has_diffs,
				last_indexed_at,
				index_run_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
				)
				.bind(
					workshop.workshopSlug,
					workshop.title,
					workshop.product ?? null,
					workshop.repoOwner,
					workshop.repoName,
					workshop.defaultBranch,
					workshop.sourceSha,
					workshop.exerciseCount,
					workshop.hasDiffs ? 1 : 0,
					new Date().toISOString(),
					runId,
				),
		]

		for (const exercise of exercises) {
			statements.push(
				db
					.prepare(
						`
				INSERT INTO indexed_exercises (
					workshop_slug,
					exercise_number,
					title,
					step_count
				) VALUES (?, ?, ?, ?)
			`,
					)
					.bind(
						workshop.workshopSlug,
						exercise.exerciseNumber,
						exercise.title,
						exercise.stepCount,
					),
			)
		}

		for (const step of steps) {
			statements.push(
				db
					.prepare(
						`
				INSERT INTO indexed_steps (
					workshop_slug,
					exercise_number,
					step_number,
					problem_dir,
					solution_dir,
					has_diff
				) VALUES (?, ?, ?, ?, ?, ?)
			`,
					)
					.bind(
						workshop.workshopSlug,
						step.exerciseNumber,
						step.stepNumber,
						step.problemDir ?? null,
						step.solutionDir ?? null,
						step.hasDiff ? 1 : 0,
					),
			)
		}

		for (const section of sections) {
			statements.push(
				db
					.prepare(
						`
				INSERT INTO indexed_sections (
					workshop_slug,
					exercise_number,
					step_number,
					section_order,
					section_kind,
					label,
					source_path,
					content,
					char_count,
					is_diff,
					index_run_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
					)
					.bind(
						workshop.workshopSlug,
						section.exerciseNumber ?? null,
						section.stepNumber ?? null,
						section.sectionOrder,
						section.sectionKind,
						section.label,
						section.sourcePath ?? null,
						section.content,
						section.content.length,
						section.isDiff ? 1 : 0,
						runId,
					),
			)
		}

		for (const sectionChunk of sectionChunks) {
			statements.push(
				db
					.prepare(
						`
				INSERT INTO indexed_section_chunks (
					workshop_slug,
					exercise_number,
					step_number,
					section_order,
					chunk_index,
					content,
					char_count,
					vector_id,
					index_run_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
					)
					.bind(
						workshop.workshopSlug,
						sectionChunk.exerciseNumber ?? null,
						sectionChunk.stepNumber ?? null,
						sectionChunk.sectionOrder,
						sectionChunk.chunkIndex,
						sectionChunk.content,
						sectionChunk.content.length,
						sectionChunk.vectorId ?? null,
						runId,
					),
			)
		}

		const batchSize = 100
		for (let index = 0; index < statements.length; index += batchSize) {
			await db.batch(statements.slice(index, index + batchSize))
		}
	} catch (error) {
		const originalMessage =
			error instanceof Error ? error.message : String(error)
		try {
			await clearWorkshopIndexScope({
				db,
				workshopSlug: workshop.workshopSlug,
			})
		} catch (cleanupError) {
			const cleanupMessage =
				cleanupError instanceof Error
					? cleanupError.message
					: String(cleanupError)
			console.warn(
				'workshop-index-write-cleanup-failed',
				JSON.stringify({
					workshopSlug: workshop.workshopSlug,
					originalError: originalMessage,
					cleanupError: cleanupMessage,
				}),
			)
		}
		throw error
	}
}
