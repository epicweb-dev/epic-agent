import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { createIndexRun, markIndexRunComplete } from '../mcp/workshop-data.ts'
import {
	indexWorkshopFromResult,
	listWorkshopRepositories,
	resolveReindexRepositoryBatch,
} from '../mcp/workshop-indexer.ts'
import { parseEpicshopContextToRepoIndexResult } from './workshop-context-adapter.ts'
import { createTemporaryDirectory } from './temp-directory.ts'
import {
	workshopFilterMaxCount,
	workshopIndexBatchMaxSize,
} from '../shared/workshop-index-constants.ts'

type WorkshopRepository = {
	owner: string
	name: string
	defaultBranch: string
}

function stripJsonc(value: string) {
	return value
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/,\s*([}\]])/g, '$1')
}

type WranglerConfig = {
	name?: string
	env?: Record<
		string,
		{
			d1_databases?: Array<{
				binding?: string
				database_id?: string
			}>
			vectorize?: Array<{
				binding?: string
				index_name?: string
			}>
		}
	>
}

function loadWranglerConfig(): WranglerConfig {
	const raw = readFileSync('wrangler.jsonc', 'utf8')
	return JSON.parse(stripJsonc(raw)) as WranglerConfig
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

function resolveDefaultVectorizeIndexName({
	config,
	environment,
}: {
	config: WranglerConfig
	environment: 'production' | 'preview'
}) {
	const baseName = (config.name ?? 'epic-agent').trim() || 'epic-agent'
	const suffix = environment === 'preview' ? '-preview' : ''
	return `${baseName}-workshop-vector-index${suffix}`
}

type VectorizeIndexResolution =
	| { enabled: false }
	| { enabled: true; indexName: string; source: 'wrangler' | 'env' | 'default' }

function resolveVectorizeIndexName({
	config,
	environment,
}: {
	config: WranglerConfig
	environment: 'production' | 'preview'
}): VectorizeIndexResolution {
	const disabledValue = (process.env.WORKSHOP_VECTORIZE_DISABLED ?? '')
		.trim()
		.toLowerCase()
	if (
		disabledValue === '1' ||
		disabledValue === 'true' ||
		disabledValue === 'yes'
	) {
		return { enabled: false }
	}

	const configured = config.env?.[environment]?.vectorize?.find(
		(binding) => binding.binding === 'WORKSHOP_VECTOR_INDEX',
	)?.index_name
	if (configured && configured.trim().length > 0) {
		return { enabled: true, indexName: configured.trim(), source: 'wrangler' }
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
	if (resolved.length > 0) {
		return { enabled: true, indexName: resolved, source: 'env' }
	}

	return {
		enabled: true,
		indexName: resolveDefaultVectorizeIndexName({ config, environment }),
		source: 'default',
	}
}

function normalizeOptionalCsvInput(value: string) {
	return Array.from(
		new Set(
			value
				.replaceAll(/\r?\n/g, ',')
				.split(',')
				.map((item) => item.trim().toLowerCase())
				.filter(Boolean),
		),
	)
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

function exec(
	cmd: string,
	args: Array<string>,
	opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
	return new Promise<{ stdout: string; stderr: string; code: number | null }>(
		(resolve, reject) => {
			const child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			let stdout = ''
			let stderr = ''
			child.stdout?.on('data', (chunk) => {
				stdout += chunk.toString()
			})
			child.stderr?.on('data', (chunk) => {
				stderr += chunk.toString()
			})
			child.on('close', (code) => {
				resolve({ stdout, stderr, code: code ?? null })
			})
			child.on('error', reject)
		},
	)
}

async function gitClone({
	repo,
	destDir,
	depth = 1,
	token,
}: {
	repo: WorkshopRepository
	destDir: string
	depth?: number
	token?: string
}) {
	const url = token
		? `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`
		: `https://github.com/${repo.owner}/${repo.name}.git`
	const { code, stderr } = await exec(
		'git',
		[
			'clone',
			'--depth',
			String(depth),
			'--single-branch',
			'--branch',
			repo.defaultBranch,
			url,
			destDir,
		],
		{},
	)
	if (code !== 0) {
		throw new Error(`git clone failed: ${stderr}`)
	}
}

async function gitRevParse(repoDir: string): Promise<string> {
	const { stdout, code, stderr } = await exec('git', ['rev-parse', 'HEAD'], {
		cwd: repoDir,
	})
	if (code !== 0) {
		throw new Error(`git rev-parse failed: ${stderr}`)
	}
	return stdout.trim()
}

async function runEpicshopContext({
	workshopDir,
	outputPath,
}: {
	workshopDir: string
	outputPath: string
}) {
	const { code, stderr } = await exec(
		'bunx',
		['epicshop', 'exercises', 'context', '-o', outputPath, '-s'],
		{ cwd: workshopDir },
	)
	if (code !== 0) {
		throw new Error(`epicshop exercises context failed: ${stderr}`)
	}
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

	const cloneDepth =
		parseIntegerInput(
			process.env.WORKSHOP_CLONE_DEPTH ?? '1',
			'WORKSHOP_CLONE_DEPTH',
		) ?? 1

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

	const { buildWorkshopLoadEnv } = await import('./workshop-content-load.ts')
	const { db, env } = await buildWorkshopLoadEnv({
		parsedEnv,
		d1DatabaseId,
		vectorizeIndexName,
	})

	const startedAt = Date.now()
	const runIds: Array<string> = []
	let totalWorkshopCount = 0
	let totalExerciseCount = 0
	let totalStepCount = 0
	let totalSectionCount = 0
	let totalSectionChunkCount = 0

	let cursor: string | undefined =
		(process.env.WORKSHOP_REINDEX_CURSOR ?? '').trim() || undefined
	let iteration = 0

	try {
		const repositories = await listWorkshopRepositories({
			env: env as Parameters<typeof listWorkshopRepositories>[0]['env'],
			onlyWorkshops,
		})

		while (true) {
			iteration += 1
			if (iteration > 500) {
				throw new Error(
					'Exceeded maximum pagination iterations while indexing.',
				)
			}

			const batch = resolveReindexRepositoryBatch({
				repositories,
				cursor,
				batchSize,
			})

			console.info(
				'workshop-reindex-discovery',
				JSON.stringify({
					runId: 'pending',
					repositoryCount: repositories.length,
					offset: batch.offset,
					limit: batch.limit,
					batchCount: batch.batch.length,
				}),
			)

			if (batch.batch.length === 0) break

			const runId = await createIndexRun(db)
			let batchWorkshopCount = 0
			let batchExerciseCount = 0
			let batchStepCount = 0
			let batchSectionCount = 0
			let batchSectionChunkCount = 0

			for (const repo of batch.batch) {
				const repoStart = Date.now()
				await using tmp = await createTemporaryDirectory('workshop-clone-')
				const repoDir = join(tmp.path, repo.name)

				await gitClone({
					repo,
					destDir: repoDir,
					depth: cloneDepth,
					token: process.env.GITHUB_TOKEN,
				})

				const sourceSha = await gitRevParse(repoDir)

				const contextPath = join(tmp.path, 'context.json')
				await runEpicshopContext({
					workshopDir: repoDir,
					outputPath: contextPath,
				})

				const contextRaw = readFileSync(contextPath, 'utf8')
				const context = JSON.parse(contextRaw) as Parameters<
					typeof parseEpicshopContextToRepoIndexResult
				>[0]['context']

				const packagePath = join(repoDir, 'package.json')
				const packageRaw = readFileSync(packagePath, 'utf8')
				const packageMetadata = JSON.parse(packageRaw) as Parameters<
					typeof parseEpicshopContextToRepoIndexResult
				>[0]['packageMetadata']

				const result = parseEpicshopContextToRepoIndexResult({
					context,
					packageMetadata,
					repo: {
						owner: repo.owner,
						name: repo.name,
						defaultBranch: repo.defaultBranch,
						sourceSha,
					},
				})

				const stats = await indexWorkshopFromResult({
					env: env as Parameters<typeof indexWorkshopFromResult>[0]['env'],
					runId,
					workshopSlug: repo.name,
					result,
				})

				batchWorkshopCount += 1
				batchExerciseCount += stats.exerciseCount
				batchStepCount += stats.stepCount
				batchSectionCount += stats.sectionCount
				batchSectionChunkCount += stats.sectionChunkCount

				totalWorkshopCount += 1
				totalExerciseCount += stats.exerciseCount
				totalStepCount += stats.stepCount
				totalSectionCount += stats.sectionCount
				totalSectionChunkCount += stats.sectionChunkCount

				console.info(
					'workshop-reindex-repository-complete',
					JSON.stringify({
						runId,
						repository: repo.name,
						exerciseCount: stats.exerciseCount,
						stepCount: stats.stepCount,
						sectionCount: stats.sectionCount,
						sectionChunkCount: stats.sectionChunkCount,
						insertedVectorCount: stats.insertedVectorCount,
						deletedVectorCount: stats.deletedVectorCount,
						durationMs: Date.now() - repoStart,
					}),
				)
			}

			await markIndexRunComplete({
				db,
				runId,
				workshopCount: batchWorkshopCount,
				exerciseCount: batchExerciseCount,
				stepCount: batchStepCount,
				sectionCount: batchSectionCount,
				sectionChunkCount: batchSectionChunkCount,
			})

			runIds.push(runId)

			cursor = batch.nextCursor
			if (!cursor) break
		}

		const durationMs = Date.now() - startedAt
		const workshopsLabel = onlyWorkshops?.length
			? onlyWorkshops.join(', ')
			: 'all discovered workshop repositories'

		appendStepSummary(
			[
				'## Workshop content load complete (clone-based)',
				'',
				`- Environment: ${parsedEnv.TARGET_ENVIRONMENT}`,
				`- D1 database id: ${d1DatabaseId}`,
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
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(
			'workshop-reindex-failed',
			JSON.stringify({
				error: message,
				durationMs: Date.now() - startedAt,
			}),
		)
		throw error
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(message)
	process.exitCode = 1
})
