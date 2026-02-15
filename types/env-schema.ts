import { z } from 'zod'

const d1DatabaseSchema = z.custom<D1Database>((value) => Boolean(value), {
	message: 'Missing APP_DB binding for database access.',
})

const optionalNonEmptyString = z.preprocess((value) => {
	if (typeof value !== 'string') return value
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}, z.string().optional())

const resendApiBaseUrlSchema = z.preprocess((value) => {
	if (typeof value !== 'string') return value
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}, z.url().optional())

const appBaseUrlSchema = z.preprocess((value) => {
	if (typeof value !== 'string') return value
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}, z.url().optional())

const optionalPositiveInteger = z.preprocess((value) => {
	if (value === undefined || value === null) return undefined
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.trunc(value)
	}
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (trimmed.length === 0) return undefined
		const parsed = Number.parseInt(trimmed, 10)
		return Number.isFinite(parsed) ? parsed : value
	}
	return value
}, z.number().int().positive().optional())

export const EnvSchema = z.object({
	COOKIE_SECRET: z
		.string()
		.min(
			32,
			'COOKIE_SECRET must be at least 32 characters for session signing.',
		),
	APP_DB: d1DatabaseSchema,
	APP_BASE_URL: appBaseUrlSchema,
	RESEND_API_BASE_URL: resendApiBaseUrlSchema,
	RESEND_API_KEY: optionalNonEmptyString,
	RESEND_FROM_EMAIL: optionalNonEmptyString,
	GITHUB_TOKEN: optionalNonEmptyString,
	WORKSHOP_INDEX_ADMIN_TOKEN: optionalNonEmptyString,
	WORKSHOP_CONTEXT_DEFAULT_MAX_CHARS: optionalPositiveInteger,
	WORKSHOP_CONTEXT_HARD_MAX_CHARS: optionalPositiveInteger,
})

export type AppEnv = z.infer<typeof EnvSchema>
