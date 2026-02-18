import { z } from 'zod'

export const retrievalSectionOutputSchema = z.object({
	label: z.string(),
	kind: z.string(),
	content: z.string(),
	sourcePath: z.string().optional(),
	exerciseNumber: z.number().int().positive().optional(),
	stepNumber: z.number().int().positive().optional(),
})
