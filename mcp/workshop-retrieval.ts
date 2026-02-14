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
import { type RetrieveLearningContextInput } from './workshop-contracts.ts'

const defaultContextMaxChars = 50_000
const defaultHardMaxChars = 80_000

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
	const maxLimit = Math.min(Math.max(limit ?? 20, 1), 100)
	const result = await listIndexedWorkshops({
		db: env.APP_DB,
		limit: maxLimit,
		cursor,
		product,
		hasDiffs,
	})
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
	const focusedSections =
		typeof focus === 'string'
			? filterByFocus(diffSections, focus)
			: diffSections
	if (focusedSections.length === 0) {
		throw new Error(
			`No diff context found for workshop "${workshop}" exercise ${exerciseNumber}.`,
		)
	}

	const truncatedResult = truncateSections({
		sections: focusedSections,
		maxChars: effectiveMaxChars,
		cursor,
	})

	return {
		workshop,
		exerciseNumber,
		stepNumber,
		diffSections: truncatedResult.sections,
		truncated: truncatedResult.truncated,
		nextCursor: truncatedResult.nextCursor,
	}
}
