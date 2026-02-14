import { z } from 'zod'

export const listWorkshopsInputSchema = {
	limit: z.coerce.number().int().positive().max(100).optional(),
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
	focus: z.string().trim().min(1).optional(),
	...commonRetrievalSchema,
}

export type RetrieveLearningContextInput = z.infer<
	typeof retrieveLearningContextInputSchema
>
