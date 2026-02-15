import { readFileSync, appendFileSync } from 'node:fs'
import { z } from 'zod'
import { runWorkshopReindex } from '../mcp/workshop-indexer.ts'
import {
	workshopFilterMaxCount,
	workshopIndexBatchMaxSize,
} from '../shared/workshop-index-constants.ts'

type CloudflareApiError = {
	code?: number
	message?: string
}

type CloudflareApiEnvelope<T> = {
	success: boolean
	result: T
	errors?: Array<CloudflareApiError>
	messages?: Array<unknown>
}

type WranglerConfig = {
	env?: Record<
		string,
		{
			d1_databases?: Array<{
				binding?: string
				database_id?: string
				database_name?: string
			}>
			vectorize?: Array<{
				binding?: string
				index_name?: string
			}>
		}
	>
}

type D1Query = {
	sql: string
	params?: Array<unknown>
}

function stripJsonc(value: string) {
	return value
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/,\s*([}\]])/g, '$1')
}

function loadWranglerConfig(): WranglerConfig {
	const raw = readFileSync('wrangler.jsonc', 'utf8')
	return JSON.parse(stripJsonc(raw)) as WranglerConfig
}

function normalizeOptionalCsvInput(value: string) {
	const normalized = value
		.replaceAll(/\r?\n/g, ',')
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
	return Array.from(new Set(normalized))
}

function parseWorkshopsInput(value: string | undefined) {
	const trimmed = (value ?? '').trim()
	if (trimmed.length === 0) return undefined
	const workshops = normalizeOptionalCsvInput(trimmed)
	if (workshops.length === 0) return undefined
	if (workshops.length > workshopFilterMaxCount) {
		throw new Error(
			`workshops input must contain at most ${workshopFilterMaxCount} unique slugs after normalization.`,
		)
	}
	return workshops
}

function parseIntegerInput(value: string, label: string) {
	const trimmed = value.trim()
	if (trimmed.length === 0) return null
	const numeric = Number(trimmed)
	if (!Number.isFinite(numeric)) {
		throw new Error(`${label} must be a whole number (received: ${value}).`)
	}
	const floored = Math.floor(numeric)
	if (floored !== numeric) {
		throw new Error(`${label} must be a whole number (received: ${value}).`)
	}
	return floored
}

function resolveVectorizeIndexName({
	config,
	environment,
}: {
	config: WranglerConfig
	environment: 'production' | 'preview'
}) {
	const configured = config.env?.[environment]?.vectorize?.find(
		(binding) => binding.binding === 'WORKSHOP_VECTOR_INDEX',
	)?.index_name
	if (configured && configured.trim().length > 0) {
		return configured.trim()
	}

	const envSpecific =
		environment === 'preview'
			? (process.env.WORKSHOP_VECTORIZE_INDEX_NAME_PREVIEW ??
				process.env.WORKSHOP_VECTOR_INDEX_NAME_PREVIEW)
			: undefined
	const shared =
		process.env.WORKSHOP_VECTORIZE_INDEX_NAME ??
		process.env.WORKSHOP_VECTOR_INDEX_NAME

	const resolved = (envSpecific ?? shared ?? '').trim()
	return resolved.length > 0 ? resolved : undefined
}

function resolveD1DatabaseId({
	config,
	environment,
}: {
	config: WranglerConfig
	environment: 'production' | 'preview'
}) {
	const binding = config.env?.[environment]?.d1_databases?.find(
		(database) => database.binding === 'APP_DB',
	)
	const databaseId = binding?.database_id?.trim()
	if (!databaseId) {
		throw new Error(
			`Unable to resolve APP_DB database_id from wrangler.jsonc for environment "${environment}".`,
		)
	}
	return databaseId
}

function formatCloudflareErrors(errors: Array<CloudflareApiError> | undefined) {
	if (!errors || errors.length === 0) return ''
	return errors
		.map((error) => {
			const code = typeof error.code === 'number' ? ` (${error.code})` : ''
			const message =
				typeof error.message === 'string' ? error.message : 'unknown'
			return `${message}${code}`.trim()
		})
		.join('; ')
}

async function cloudflareRequestJson<T>({
	apiToken,
	path,
	method = 'GET',
	body,
	headers,
}: {
	apiToken: string
	path: string
	method?: string
	body?: unknown
	headers?: Record<string, string>
}) {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			...(body ? { 'Content-Type': 'application/json' } : {}),
			...(headers ?? {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	})

	const payload = (await response
		.json()
		.catch(() => null)) as CloudflareApiEnvelope<T> | null
	if (!payload || typeof payload !== 'object') {
		throw new Error(
			`Cloudflare API ${method} ${path} returned a non-JSON response (HTTP ${response.status}).`,
		)
	}
	if (!response.ok || payload.success !== true) {
		const errorDetails = formatCloudflareErrors(payload.errors)
		const suffix = errorDetails ? `: ${errorDetails}` : ''
		throw new Error(
			`Cloudflare API ${method} ${path} failed (HTTP ${response.status})${suffix}`,
		)
	}
	return payload.result
}

class RemoteD1PreparedStatement {
	#db: RemoteD1Database
	#sql: string
	#params: Array<unknown>

	constructor(db: RemoteD1Database, sql: string, params: Array<unknown> = []) {
		this.#db = db
		this.#sql = sql
		this.#params = params
	}

	bind(...values: Array<unknown>) {
		this.#params = values
		return this as unknown as D1PreparedStatement
	}

	async run<T = Record<string, unknown>>() {
		return this.#db.executeStatement<T>({
			sql: this.#sql,
			params: this.#params,
		})
	}

	async all<T = Record<string, unknown>>() {
		return this.#db.executeStatement<T>({
			sql: this.#sql,
			params: this.#params,
		})
	}

	async first<T = Record<string, unknown>>(colName?: string) {
		const result = await this.#db.executeStatement<T>({
			sql: this.#sql,
			params: this.#params,
		})
		const row = result.results[0] ?? null
		if (!row) return null
		if (!colName) return row
		if (row && typeof row === 'object' && colName in row) {
			return (row as Record<string, unknown>)[colName] as T
		}
		return null
	}

	// `raw()` is unused by the indexing flow.
	async raw() {
		throw new Error('RemoteD1PreparedStatement.raw is not implemented.')
	}

	toQuery(): D1Query {
		return {
			sql: this.#sql,
			...(this.#params.length > 0 ? { params: this.#params } : {}),
		}
	}
}

class RemoteD1Database {
	#accountId: string
	#apiToken: string
	#databaseId: string

	constructor({
		accountId,
		apiToken,
		databaseId,
	}: {
		accountId: string
		apiToken: string
		databaseId: string
	}) {
		this.#accountId = accountId
		this.#apiToken = apiToken
		this.#databaseId = databaseId
	}

	prepare(query: string) {
		return new RemoteD1PreparedStatement(
			this,
			query,
		) as unknown as D1PreparedStatement
	}

	async batch<T = unknown>(statements: Array<D1PreparedStatement>) {
		const queries = statements.map((statement) => {
			if (statement instanceof RemoteD1PreparedStatement) {
				return statement.toQuery()
			}
			throw new Error(
				'RemoteD1Database.batch received a non-RemoteD1PreparedStatement value.',
			)
		})

		const path = `/accounts/${this.#accountId}/d1/database/${this.#databaseId}/query`
		const result = await cloudflareRequestJson<Array<D1Result<T>>>({
			apiToken: this.#apiToken,
			path,
			method: 'POST',
			body: queries,
		})
		return result
	}

	async exec(query: string) {
		// D1 exec returns a reduced shape; emulate with a query call so callers still
		// get an error if the SQL fails.
		const result = await this.execute(query)
		return {
			count: (result.meta?.changes as number | undefined) ?? 0,
			duration: (result.meta?.duration as number | undefined) ?? 0,
		}
	}

	withSession() {
		throw new Error(
			'RemoteD1Database.withSession is not implemented (not needed for indexing).',
		)
	}

	async dump() {
		throw new Error(
			'RemoteD1Database.dump is not implemented (not needed for indexing).',
		)
	}

	async executeStatement<T = Record<string, unknown>>({
		sql,
		params,
	}: D1Query): Promise<D1Result<T>> {
		const path = `/accounts/${this.#accountId}/d1/database/${this.#databaseId}/query`
		const body = {
			sql,
			...(params && params.length > 0 ? { params } : {}),
		}
		const result = await cloudflareRequestJson<Array<D1Result<T>>>({
			apiToken: this.#apiToken,
			path,
			method: 'POST',
			body,
		})

		const first = result[0]
		if (!first) {
			throw new Error('Cloudflare D1 query returned an empty result array.')
		}
		return first
	}

	async execute(query: string): Promise<D1Result<Record<string, unknown>>> {
		return this.executeStatement<Record<string, unknown>>({ sql: query })
	}
}

function buildVectorizeClient({
	accountId,
	apiToken,
	indexName,
}: {
	accountId: string
	apiToken: string
	indexName: string
}) {
	async function upsert(vectors: Array<VectorizeVector>) {
		const path = `/accounts/${accountId}/vectorize/v2/indexes/${indexName}/upsert`
		const lines = vectors.map((vector) => JSON.stringify(vector)).join('\n')
		const response = await fetch(
			`https://api.cloudflare.com/client/v4${path}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiToken}`,
					'Content-Type': 'application/x-ndjson',
				},
				body: `${lines}\n`,
			},
		)

		const payload = (await response
			.json()
			.catch(() => null)) as CloudflareApiEnvelope<unknown> | null
		if (!payload || typeof payload !== 'object') {
			throw new Error(
				`Cloudflare Vectorize upsert returned a non-JSON response (HTTP ${response.status}).`,
			)
		}
		if (!response.ok || payload.success !== true) {
			const errorDetails = formatCloudflareErrors(payload.errors)
			const suffix = errorDetails ? `: ${errorDetails}` : ''
			throw new Error(
				`Cloudflare Vectorize upsert failed (HTTP ${response.status})${suffix}`,
			)
		}

		return payload.result as VectorizeAsyncMutation
	}

	async function deleteByIds(ids: Array<string>) {
		const path = `/accounts/${accountId}/vectorize/v2/indexes/${indexName}/delete_by_ids`
		const result = await cloudflareRequestJson<VectorizeAsyncMutation>({
			apiToken,
			path,
			method: 'POST',
			body: { ids },
		})
		return result
	}

	return {
		upsert,
		deleteByIds,
	} as unknown as Vectorize
}

function buildAiClient({
	accountId,
	apiToken,
}: {
	accountId: string
	apiToken: string
}) {
	async function run(modelName: string, input: unknown) {
		const path = `/accounts/${accountId}/ai/run/${modelName}`
		const result = await cloudflareRequestJson<unknown>({
			apiToken,
			path,
			method: 'POST',
			body: input,
		})
		return result
	}

	return {
		run,
	} as unknown as Ai
}

function appendStepSummary(markdown: string) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY
	if (!summaryPath) return
	appendFileSync(
		summaryPath,
		markdown.endsWith('\n') ? markdown : `${markdown}\n`,
	)
}

const envSchema = z.object({
	CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
	CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1),
	TARGET_ENVIRONMENT: z.enum(['production', 'preview']),
})

async function main() {
	const environmentRaw = process.env.TARGET_ENVIRONMENT ?? 'production'
	const parsedEnv = envSchema.parse({
		CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
		CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
		TARGET_ENVIRONMENT: environmentRaw,
	})

	const batchSizeRaw = process.env.WORKSHOP_BATCH_SIZE ?? '5'
	const batchSize = parseIntegerInput(batchSizeRaw, 'batchSize')
	if (batchSize === null) {
		throw new Error('batchSize is required.')
	}
	if (batchSize < 1 || batchSize > workshopIndexBatchMaxSize) {
		throw new Error(
			`batchSize must be between 1 and ${workshopIndexBatchMaxSize} (received: ${batchSize}).`,
		)
	}

	const onlyWorkshops = parseWorkshopsInput(process.env.WORKSHOP_LIST_INPUT)
	const wranglerConfig = loadWranglerConfig()
	const d1DatabaseId = resolveD1DatabaseId({
		config: wranglerConfig,
		environment: parsedEnv.TARGET_ENVIRONMENT,
	})

	const vectorizeIndexName = resolveVectorizeIndexName({
		config: wranglerConfig,
		environment: parsedEnv.TARGET_ENVIRONMENT,
	})

	const db = new RemoteD1Database({
		accountId: parsedEnv.CLOUDFLARE_ACCOUNT_ID,
		apiToken: parsedEnv.CLOUDFLARE_API_TOKEN,
		databaseId: d1DatabaseId,
	}) as unknown as D1Database

	const vectorizeEnabled = Boolean(vectorizeIndexName)
	const env: Env = {
		APP_DB: db,
		...(process.env.GITHUB_TOKEN
			? { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
			: {}),
		...(vectorizeEnabled && vectorizeIndexName
			? {
					WORKSHOP_VECTOR_INDEX: buildVectorizeClient({
						accountId: parsedEnv.CLOUDFLARE_ACCOUNT_ID,
						apiToken: parsedEnv.CLOUDFLARE_API_TOKEN,
						indexName: vectorizeIndexName,
					}),
					AI: buildAiClient({
						accountId: parsedEnv.CLOUDFLARE_ACCOUNT_ID,
						apiToken: parsedEnv.CLOUDFLARE_API_TOKEN,
					}),
				}
			: {}),
	} as unknown as Env

	const startedAt = Date.now()
	const runIds: Array<string> = []
	let totalWorkshopCount = 0
	let totalExerciseCount = 0
	let totalStepCount = 0
	let totalSectionCount = 0
	let totalSectionChunkCount = 0

	let cursor: string | undefined
	let iteration = 0
	while (true) {
		iteration += 1
		if (iteration > 500) {
			throw new Error('Exceeded maximum pagination iterations while indexing.')
		}

		const summary = await runWorkshopReindex({
			env: env as unknown as Env & {
				GITHUB_TOKEN?: string
				WORKSHOP_VECTOR_INDEX?: Vectorize
				AI?: Ai
			},
			onlyWorkshops,
			cursor,
			batchSize,
		})

		runIds.push(summary.runId)
		totalWorkshopCount += summary.workshopCount
		totalExerciseCount += summary.exerciseCount
		totalStepCount += summary.stepCount
		totalSectionCount += summary.sectionCount
		totalSectionChunkCount += summary.sectionChunkCount

		cursor = summary.nextCursor
		if (!cursor) break
	}

	const durationMs = Date.now() - startedAt
	const workshopsLabel = onlyWorkshops?.length
		? onlyWorkshops.join(', ')
		: 'all discovered workshop repositories'
	const vectorizeLabel = vectorizeEnabled
		? `enabled (${vectorizeIndexName})`
		: 'disabled (no Vectorize index configured)'

	appendStepSummary(
		[
			'## Workshop content load complete',
			'',
			`- Environment: ${parsedEnv.TARGET_ENVIRONMENT}`,
			`- D1 database id: ${d1DatabaseId}`,
			`- Vectorize: ${vectorizeLabel}`,
			`- Batch size: ${batchSize}`,
			`- Requested workshops: ${workshopsLabel}`,
			`- Reindex run ids: ${runIds.join(', ')}`,
			`- Workshop count: ${totalWorkshopCount}`,
			`- Exercise count: ${totalExerciseCount}`,
			`- Step count: ${totalStepCount}`,
			`- Section count: ${totalSectionCount}`,
			`- Section chunk count: ${totalSectionChunkCount}`,
			`- Duration: ${Math.round(durationMs / 1000)}s`,
			'',
		].join('\n'),
	)
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(message)
	process.exitCode = 1
})
