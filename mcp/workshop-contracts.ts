import { z } from 'zod'

export const listWorkshopsMaxLimit = 100
export const topicSearchMaxLimit = 20

export const listWorkshopsInputSchema = {
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(listWorkshopsMaxLimit)
		.optional()
		.describe(
			`Page size when paginating manually (1-${listWorkshopsMaxLimit}).`,
		),
	all: z
		.boolean()
		.optional()
		.describe(
			'When true (default), fetches all pages to return the full list. Set false to return a single page and use cursor/nextCursor.',
		),
	cursor: z
		.string()
		.optional()
		.describe('Pagination cursor from a previous { all: false } call.'),
	product: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe('Optional product filter (exact match).'),
	hasDiffs: z
		.boolean()
		.optional()
		.describe(
			'Optional filter for whether diff context is available for the workshop.',
		),
}

const commonRetrievalSchema = {
	maxChars: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Soft maximum for returned section content size in characters. The server will clamp to configured hard limits.',
		),
	cursor: z
		.string()
		.optional()
		.describe('Continuation cursor from a previous truncated response.'),
}

const explicitLearningContextSchema = z.object({
	workshop: z
		.string()
		.trim()
		.min(1)
		.describe('Workshop slug from list_workshops.'),
	exerciseNumber: z.coerce
		.number()
		.int()
		.positive()
		.describe('Exercise number within the workshop.'),
	stepNumber: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe('Optional step number within the exercise.'),
	random: z
		.literal(false)
		.optional()
		.describe('Explicit scope mode (default).'),
	...commonRetrievalSchema,
})

const randomLearningContextSchema = z.object({
	random: z
		.literal(true)
		.describe('When true, chooses a random indexed exercise scope.'),
	...commonRetrievalSchema,
})

export const retrieveLearningContextInputSchema = z.union([
	explicitLearningContextSchema,
	randomLearningContextSchema,
])

export const retrieveDiffContextInputSchema = {
	workshop: z
		.string()
		.trim()
		.min(1)
		.describe('Workshop slug from list_workshops.'),
	exerciseNumber: z.coerce
		.number()
		.int()
		.positive()
		.describe('Exercise number within the workshop.'),
	stepNumber: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe('Optional step number within the exercise.'),
	focus: z
		.string()
		.trim()
		.optional()
		.describe(
			'Optional case-insensitive filter over diff label/kind/source path/content. Whitespace-only values are treated as omitted.',
		),
	...commonRetrievalSchema,
}

export const searchTopicContextInputSchema = {
	query: z
		.string()
		.trim()
		.min(3, 'query must be at least 3 characters for topic search.')
		.describe('Topic query to search for (min 3 non-whitespace characters).'),
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(topicSearchMaxLimit)
		.optional()
		.describe(`Max matches to return (1-${topicSearchMaxLimit}).`),
	workshop: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe('Optional workshop slug filter.'),
	exerciseNumber: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe('Optional exercise number filter.'),
	stepNumber: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe('Optional step number filter (requires exerciseNumber).'),
}

export type RetrieveLearningContextInput = z.infer<
	typeof retrieveLearningContextInputSchema
>
