import { z } from 'zod'

export const listWorkshopsMaxLimit = 100
export const topicSearchMaxLimit = 20

export const listWorkshopsInputSchema = z.object({
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(listWorkshopsMaxLimit)
		.optional()
		.default(listWorkshopsMaxLimit)
		.describe(
			`Max workshops per page (1-${listWorkshopsMaxLimit}, default: ${listWorkshopsMaxLimit}).`,
		),
	all: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'When true (default), fetch all pages and return a single combined result. When false, return a single page and include nextCursor when more results exist.',
		),
	cursor: z
		.string()
		.optional()
		.describe(
			'Pagination cursor from a previous response (only meaningful when all=false). Opaque base64 string.',
		),
	product: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe('Optional product label filter (exact match).'),
	hasDiffs: z
		.boolean()
		.optional()
		.describe(
			'Optional filter for whether diff sections exist for the workshop.',
		),
})

const commonRetrievalSchema = {
	maxChars: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Max characters to return. Server applies a default and hard maximum; use this to reduce payload size.',
		),
	cursor: z
		.string()
		.optional()
		.describe('Opaque continuation cursor from a previous response.'),
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
		.describe('Optional step number to narrow the scope.'),
	random: z
		.literal(false)
		.optional()
		.describe('Omit or set false to use explicit scope mode.'),
	...commonRetrievalSchema,
})

const randomLearningContextSchema = z.object({
	random: z
		.literal(true)
		.describe('When true, selects a random indexed exercise.'),
	...commonRetrievalSchema,
})

export const retrieveLearningContextInputSchema = z.union([
	explicitLearningContextSchema,
	randomLearningContextSchema,
])

const retrieveDiffContextInputShape = {
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
		.describe('Optional step number to narrow the scope.'),
	focus: z
		.string()
		.trim()
		.optional()
		.describe(
			'Optional case-insensitive filter applied to diff sections (label/kind/sourcePath/content). Whitespace-only is treated as omitted.',
		),
	...commonRetrievalSchema,
} satisfies Parameters<typeof z.object>[0]

export const retrieveDiffContextInputSchema = z.object(
	retrieveDiffContextInputShape,
)

const searchTopicContextInputShape = {
	query: z
		.string()
		.trim()
		.min(3, 'query must be at least 3 characters for topic search.'),
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(topicSearchMaxLimit)
		.optional()
		.default(8)
		.describe(`Max matches to return (1-${topicSearchMaxLimit}, default: 8).`),
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
		.describe('Optional exercise filter.'),
	stepNumber: z.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe('Optional step filter (requires exerciseNumber).'),
} satisfies Parameters<typeof z.object>[0]

export const searchTopicContextInputSchema = z.object(
	searchTopicContextInputShape,
)

export type RetrieveLearningContextInput = z.infer<
	typeof retrieveLearningContextInputSchema
>
