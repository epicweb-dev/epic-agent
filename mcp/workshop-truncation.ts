import { z } from 'zod'

export const retrievalCursorSchema = z.object({
	sectionIndex: z.number().int().nonnegative(),
	charOffset: z.number().int().nonnegative(),
})

export type RetrievalCursor = z.infer<typeof retrievalCursorSchema>

export type RetrievalSection = {
	label: string
	kind: string
	content: string
	sourcePath?: string
	exerciseNumber?: number
	stepNumber?: number
}

function encodeCursorValue(cursor: RetrievalCursor) {
	return btoa(JSON.stringify(cursor))
}

function decodeCursorValue(cursor: string) {
	try {
		const raw = atob(cursor)
		const parsed = JSON.parse(raw) as unknown
		const result = retrievalCursorSchema.safeParse(parsed)
		return result.success ? result.data : null
	} catch {
		return null
	}
}

export function clampMaxChars({
	requested,
	defaultMaxChars,
	hardMaxChars,
}: {
	requested?: number
	defaultMaxChars: number
	hardMaxChars: number
}) {
	if (hardMaxChars <= 0) return 1
	const fallback = Math.min(Math.max(defaultMaxChars, 1), hardMaxChars)
	if (!requested || !Number.isFinite(requested) || requested <= 0) {
		return fallback
	}
	return Math.min(Math.floor(requested), hardMaxChars)
}

export function truncateSections({
	sections,
	maxChars,
	cursor,
}: {
	sections: Array<RetrievalSection>
	maxChars: number
	cursor?: string
}) {
	const normalizedMaxChars = Math.max(1, Math.floor(maxChars))
	const decodedCursor = cursor ? decodeCursorValue(cursor) : null
	let sectionIndex = decodedCursor?.sectionIndex ?? 0
	let charOffset = decodedCursor?.charOffset ?? 0
	const output: Array<RetrievalSection> = []
	let remaining = normalizedMaxChars

	while (sectionIndex < sections.length && remaining > 0) {
		const section = sections[sectionIndex]
		if (!section) {
			sectionIndex += 1
			charOffset = 0
			continue
		}
		const sectionContent = section.content.slice(charOffset)
		if (sectionContent.length <= remaining) {
			output.push({
				...section,
				content: sectionContent,
			})
			remaining -= sectionContent.length
			sectionIndex += 1
			charOffset = 0
			continue
		}

		const includedContent = sectionContent.slice(0, remaining)
		output.push({
			...section,
			content: includedContent,
		})
		charOffset += includedContent.length
		remaining = 0
	}

	const truncated = sectionIndex < sections.length || charOffset > 0
	const nextCursor = truncated
		? encodeCursorValue({
				sectionIndex,
				charOffset,
			})
		: undefined

	return {
		sections: output,
		truncated,
		nextCursor,
	}
}
