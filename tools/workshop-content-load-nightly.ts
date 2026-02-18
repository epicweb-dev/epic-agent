import { appendFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { listWorkshopRepositories } from '../mcp/workshop-indexer.ts'
import { stripJsonc } from './strip-jsonc.ts'
import { buildWorkshopLoadEnv } from './workshop-content-load.ts'

type WranglerConfig = {
	env?: Record<
		string,
		{
			d1_databases?: Array<{
				binding?: string
				database_id?: string
			}>
		}
	>
}

function appendStepSummary(markdown: string) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY
	if (!summaryPath) return
	appendFileSync(
		summaryPath,
		markdown.endsWith('\n') ? markdown : `${markdown}\n`,
	)
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

const envSchema = z.object({
	CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
	CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1),
	TARGET_ENVIRONMENT: z.enum(['production', 'preview']),
	GITHUB_TOKEN: z.string().trim().optional(),
	WORKSHOP_BATCH_SIZE: z.string().trim().optional(),
})

type GitHubCompareResponse = {
	status?: string
	ahead_by?: number
	behind_by?: number
	total_commits?: number
	files?: Array<{ filename?: string }>
}

export function isWorkshopContentPath(pathname: string) {
	return pathname.startsWith('exercises/') || pathname.startsWith('extra/')
}

export function changedFilesIncludeWorkshopContent(
	files: ReadonlyArray<string>,
) {
	return files.some((filename) => isWorkshopContentPath(filename))
}

export function diffIncludesWorkshopContent(diffText: string) {
	// The compare diff includes lines like: `diff --git a/exercises/... b/exercises/...`
	return /(^|\n)diff --git a\/(exercises|extra)\//.test(diffText)
}

async function fetchGitHub({
	url,
	token,
	accept,
}: {
	url: string
	token?: string
	accept: string
}) {
	const response = await fetch(url, {
		headers: {
			Accept: accept,
			'User-Agent': 'epic-agent-workshop-content-load-nightly',
			'X-GitHub-Api-Version': '2022-11-28',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	})
	return response
}

async function compareIncludesWorkshopContent({
	owner,
	repo,
	baseSha,
	headRef,
	token,
}: {
	owner: string
	repo: string
	baseSha: string
	headRef: string
	token?: string
}) {
	const compareUrl = `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${headRef}`

	const jsonResponse = await fetchGitHub({
		url: compareUrl,
		token,
		accept: 'application/vnd.github+json',
	})

	if (!jsonResponse.ok) {
		const body = await jsonResponse.text()
		throw new Error(
			`GitHub compare failed for ${owner}/${repo} (${jsonResponse.status}): ${body}`,
		)
	}

	const payload = (await jsonResponse.json()) as GitHubCompareResponse
	const aheadBy = typeof payload.ahead_by === 'number' ? payload.ahead_by : 0
	if (aheadBy === 0) return false

	const filenames = (payload.files ?? [])
		.map((entry) => entry.filename?.trim())
		.filter((filename): filename is string => Boolean(filename))

	if (filenames.length > 0 && filenames.length < 300) {
		return changedFilesIncludeWorkshopContent(filenames)
	}

	const diffResponse = await fetchGitHub({
		url: compareUrl,
		token,
		accept: 'application/vnd.github.v3.diff',
	})
	if (!diffResponse.ok) {
		const body = await diffResponse.text()
		throw new Error(
			`GitHub compare diff failed for ${owner}/${repo} (${diffResponse.status}): ${body}`,
		)
	}

	const diffText = await diffResponse.text()
	return diffIncludesWorkshopContent(diffText)
}

async function listLastIndexedShas(db: D1Database) {
	const result = await db
		.prepare(`SELECT workshop_slug, source_sha FROM indexed_workshops`)
		.all<{ workshop_slug: string; source_sha: string }>()
	const rows = result.results ?? []

	const map = new Map<string, string>()
	for (const row of rows) {
		if (!row?.workshop_slug || !row?.source_sha) continue
		map.set(row.workshop_slug.trim().toLowerCase(), row.source_sha.trim())
	}
	return map
}

function shortSha(sha: string | undefined) {
	const trimmed = (sha ?? '').trim()
	if (trimmed.length === 0) return null
	return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed
}

async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	mapper: (item: T) => Promise<R>,
) {
	const results: Array<R> = []
	const queue = items.slice()
	const normalizedLimit = Math.max(1, Math.floor(limit))

	async function runWorker() {
		while (queue.length > 0) {
			const next = queue.shift()
			if (typeof next === 'undefined') return
			results.push(await mapper(next))
		}
	}

	const workers = Array.from({ length: normalizedLimit }, () => runWorker())
	await Promise.all(workers)
	return results
}

async function runIndexForWorkshops(workshops: ReadonlyArray<string>) {
	const workshopListInput = workshops.join('\n')
	console.info(
		'workshop-nightly-reindex-start',
		JSON.stringify({ workshopCount: workshops.length, workshops }),
	)
	const child = spawn('bun', ['tools/workshop-content-load-from-clones.ts'], {
		stdio: 'inherit',
		env: {
			...process.env,
			WORKSHOP_LIST_INPUT: workshopListInput,
		},
	})
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (code) => resolve(code ?? 1))
	})
	if (exitCode !== 0) {
		throw new Error(
			`Index run exited with non-zero status code: ${exitCode} (workshops: ${workshops.join(
				', ',
			)})`,
		)
	}
	console.info(
		'workshop-nightly-reindex-complete',
		JSON.stringify({ workshopCount: workshops.length }),
	)
}

async function main() {
	const parsed = envSchema.parse({
		CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
		CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
		TARGET_ENVIRONMENT: process.env.TARGET_ENVIRONMENT ?? 'production',
		GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		WORKSHOP_BATCH_SIZE: process.env.WORKSHOP_BATCH_SIZE,
	})

	const wranglerConfig = loadWranglerConfig()
	const d1DatabaseId = resolveD1DatabaseId({
		config: wranglerConfig,
		environment: parsed.TARGET_ENVIRONMENT,
	})

	const { db, env } = await buildWorkshopLoadEnv({
		parsedEnv: parsed,
		d1DatabaseId,
		vectorizeIndexName: { enabled: false },
	})

	const lastIndexed = await listLastIndexedShas(db)
	const repositories = await listWorkshopRepositories({
		env: env as Parameters<typeof listWorkshopRepositories>[0]['env'],
	})

	const startedAt = Date.now()
	const token = parsed.GITHUB_TOKEN
	console.info(
		'workshop-nightly-discovery',
		JSON.stringify({
			targetEnvironment: parsed.TARGET_ENVIRONMENT,
			repositoryCount: repositories.length,
			indexedWorkshopCount: lastIndexed.size,
		}),
	)

	const comparisons = await mapWithConcurrency(
		repositories,
		4,
		async (repo) => {
			const slug = repo.name.trim().toLowerCase()
			const baseSha = lastIndexed.get(slug)
			if (!baseSha) {
				console.info(
					'workshop-nightly-check',
					JSON.stringify({
						workshop: slug,
						repository: `${repo.owner}/${repo.name}`,
						defaultBranch: repo.defaultBranch,
						result: 'index',
						reason: 'missing-index',
					}),
				)
				return { slug, shouldIndex: true, reason: 'missing-index' as const }
			}

			try {
				const changed = await compareIncludesWorkshopContent({
					owner: repo.owner,
					repo: repo.name,
					baseSha,
					headRef: repo.defaultBranch,
					token,
				})
				console.info(
					'workshop-nightly-check',
					JSON.stringify({
						workshop: slug,
						repository: `${repo.owner}/${repo.name}`,
						defaultBranch: repo.defaultBranch,
						baseSha: shortSha(baseSha),
						result: changed ? 'index' : 'skip',
						reason: changed ? 'content-changed' : 'unchanged',
					}),
				)
				return {
					slug,
					shouldIndex: changed,
					reason: changed
						? ('content-changed' as const)
						: ('unchanged' as const),
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				console.warn(
					'workshop-nightly-check',
					JSON.stringify({ workshop: slug, error: message }),
				)
				return { slug, shouldIndex: true, reason: 'compare-failed' as const }
			}
		},
	)

	const toIndex = comparisons
		.filter((entry) => entry.shouldIndex)
		.map((entry) => entry.slug)
		.sort((a, b) => a.localeCompare(b))

	const skipped = comparisons.filter((entry) => !entry.shouldIndex)
	appendStepSummary(
		[
			'## Nightly workshop reindex',
			'',
			`- Target environment: ${parsed.TARGET_ENVIRONMENT}`,
			`- Discovered workshops: ${repositories.length}`,
			`- Skipped workshops: ${skipped.length}`,
			`- Workshops to index: ${toIndex.length}`,
			`- Duration (detect): ${Math.round((Date.now() - startedAt) / 1000)}s`,
			'',
			...(toIndex.length
				? ['Workshops to index:', '', ...toIndex.map((slug) => `- ${slug}`), '']
				: ['No workshop content changes detected.', '']),
		].join('\n'),
	)

	if (toIndex.length === 0) return

	await runIndexForWorkshops(toIndex)
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(message)
	process.exitCode = 1
})
