import { z } from 'zod'

export const listWorkshopsMaxLimit = 100
export const topicSearchMaxLimit = 20

export const listWorkshopsInputSchema = {
	limit: z.coerce
		.number()
		.int()
		.positive()
		.max(listWorkshopsMaxLimit)
		.optional(),
	cursor: z.string().optional(),
	product: z.string().trim().min(1).optional(),
	hasDiffs: z.boolean().optional(),
}

const commonRetrievalSchema = {
	maxChars: z.coerce.number().int().positive().optional(),
	cursor: z.string().optional(),
}

const explicitLearningContextSchema = z.object({
	workshop: z.string().trim().min(1),
	exerciseNumber: z.coerce.number().int().positive(),
	stepNumber: z.coerce.number().int().positive().optional(),
	random: z.literal(false).optional(),
	...commonRetrievalSchema,
})

const randomLearningContextSchema = z.object({
	random: z.literal(true),
	...commonRetrievalSchema,
})

export const retrieveLearningContextInputSchema = z.union([
	explicitLearningContextSchema,
	randomLearningContextSchema,
])

export const retrieveDiffContextInputSchema = {
	workshop: z.string().trim().min(1),
	exerciseNumber: z.coerce.number().int().positive(),
	stepNumber: z.coerce.number().int().positive().optional(),
	focus: z.string().trim().optional(),
	...commonRetrievalSchema,
}

export const searchTopicContextInputSchema = {
	query: z
		.string()
		.trim()
		.min(3, 'query must be at least 3 characters for topic search.'),
	limit: z.coerce.number().int().positive().max(topicSearchMaxLimit).optional(),
	workshop: z.string().trim().min(1).optional(),
	exerciseNumber: z.coerce.number().int().positive().optional(),
	stepNumber: z.coerce.number().int().positive().optional(),
}

export type RetrieveLearningContextInput = z.infer<
	typeof retrieveLearningContextInputSchema
>
