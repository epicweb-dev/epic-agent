import {
	createIndexRun,
	listStoredVectorIdsForWorkshop,
	markIndexRunComplete,
	markIndexRunFailed,
	replaceWorkshopIndex,
	type IndexedSectionChunkWrite,
	type IndexedExerciseWrite,
	type IndexedSectionWrite,
	type IndexedStepWrite,
	type IndexedWorkshopWrite,
} from './workshop-data.ts'

type WorkshopRepository = {
	owner: string
	name: string
	defaultBranch: string
}

type GitTreeEntry = {
	path: string
	mode: string
	type: 'blob' | 'tree' | 'commit'
	sha: string
	size?: number
	url: string
}

type RepoIndexResult = {
	workshop: IndexedWorkshopWrite
	exercises: Array<IndexedExerciseWrite>
	steps: Array<IndexedStepWrite>
	sections: Array<IndexedSectionWrite>
	sectionChunks: Array<IndexedSectionChunkWrite>
}

type IndexSummary = {
	runId: string
	workshopCount: number
	exerciseCount: number
	stepCount: number
	sectionCount: number
	sectionChunkCount: number
}

type WorkshopIndexEnv = Env & {
	GITHUB_TOKEN?: string
	WORKSHOP_VECTOR_INDEX?: Vectorize
	AI?: Ai
}

export class WorkshopIndexInputError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'WorkshopIndexInputError'
	}
}

const workshopOrg = 'epicweb-dev'
const defaultSearchPageSize = 100
const maxStoredSectionChars = 20_000
const defaultChunkSize = 1_600
const defaultChunkOverlap = 180
const defaultEmbeddingBatchSize = 64
const defaultVectorUpsertBatchSize = 200
const vectorDeleteBatchSize = 500
const githubRequestMaxAttempts = 3
const githubRetryBaseDelayMs = 500
const githubRetryMaxDelayMs = 30_000

const textFileExtensions = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json',
	'.md',
	'.mdx',
	'.txt',
	'.html',
	'.css',
	'.scss',
	'.sql',
	'.yaml',
	'.yml',
	'.toml',
	'.env',
	'.sh',
	'.bat',
	'.ps1',
	'.py',
	'.rb',
	'.go',
	'.rs',
	'.java',
	'.kt',
	'.swift',
	'.php',
	'.graphql',
])

const binaryFileExtensions = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.svg',
	'.ico',
	'.pdf',
	'.zip',
	'.tar',
	'.gz',
	'.mp3',
	'.mp4',
	'.mov',
	'.webm',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
])

const defaultDiffIgnore = [
	'README.*',
	'package-lock.json',
	'.DS_Store',
	'.git/*',
]

function normalizeNewlines(content: string) {
	return content.replaceAll('\r\n', '\n')
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function fileExtension(path: string) {
	const dotIndex = path.lastIndexOf('.')
	if (dotIndex < 0) return ''
	return path.slice(dotIndex).toLowerCase()
}

function isLikelyTextFile(path: string, size?: number) {
	if (typeof size === 'number' && size > 250_000) return false
	const extension = fileExtension(path)
	if (binaryFileExtensions.has(extension)) return false
	if (textFileExtensions.has(extension)) return true
	if (!extension) return true
	return extension.length <= 5
}

function readJson<T>(content: string): T | null {
	try {
		return JSON.parse(content) as T
	} catch {
		return null
	}
}

function cleanTitle(value: string | undefined, fallback: string) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function toSectionContent(content: string) {
	if (content.length <= maxStoredSectionChars) return content
	return `${content.slice(0, maxStoredSectionChars)}\n\n[truncated for storage]`
}

function splitIntoChunks({
	content,
	chunkSize = defaultChunkSize,
	chunkOverlap = defaultChunkOverlap,
}: {
	content: string
	chunkSize?: number
	chunkOverlap?: number
}) {
	const normalizedContent = normalizeNewlines(content).trim()
	if (normalizedContent.length === 0) return []
	const size = Math.max(300, chunkSize)
	const overlap = Math.max(0, Math.min(chunkOverlap, size - 100))
	const chunks: Array<{ chunkIndex: number; content: string }> = []
	let cursor = 0
	let chunkIndex = 0
	while (cursor < normalizedContent.length) {
		const end = Math.min(normalizedContent.length, cursor + size)
		const chunk = normalizedContent.slice(cursor, end).trim()
		if (chunk.length > 0) {
			chunks.push({ chunkIndex, content: chunk })
			chunkIndex += 1
		}
		if (end >= normalizedContent.length) break
		cursor = end - overlap
	}
	return chunks
}

function chunkIntoBatches<T>({
	items,
	batchSize,
}: {
	items: Array<T>
	batchSize: number
}) {
	const size = Math.max(1, batchSize)
	const batches: Array<Array<T>> = []
	for (let index = 0; index < items.length; index += size) {
		batches.push(items.slice(index, index + size))
	}
	return batches
}

function buildUniqueVectorIdBatches({
	vectorIds,
	batchSize = vectorDeleteBatchSize,
}: {
	vectorIds: Array<string>
	batchSize?: number
}) {
	const uniqueVectorIds = Array.from(
		new Set(vectorIds.map((vectorId) => vectorId.trim()).filter(Boolean)),
	)
	return chunkIntoBatches({ items: uniqueVectorIds, batchSize })
}

function collectVectorIds(
	sectionChunks: Array<{
		vectorId?: string
	}>,
) {
	return sectionChunks
		.map((sectionChunk) => sectionChunk.vectorId?.trim())
		.filter((vectorId): vectorId is string => Boolean(vectorId))
}

async function deleteVectorIdsIfConfigured({
	env,
	runId,
	workshopSlug,
	vectorIds,
	batchSize,
}: {
	env: WorkshopIndexEnv
	runId: string
	workshopSlug: string
	vectorIds: Array<string>
	batchSize?: number
}) {
	const vectorIndex = env.WORKSHOP_VECTOR_INDEX
	if (!vectorIndex || vectorIds.length === 0) return 0

	const batches = buildUniqueVectorIdBatches({ vectorIds, batchSize })
	let deletedVectorCount = 0
	for (const batch of batches) {
		try {
			await vectorIndex.deleteByIds(batch)
			deletedVectorCount += batch.length
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.warn(
				'workshop-reindex-vector-delete-failed',
				JSON.stringify({
					runId,
					workshopSlug,
					batchSize: batch.length,
					error: message,
				}),
			)
		}
	}

	return deletedVectorCount
}

async function embedChunksIfConfigured({
	env,
	runId,
	workshopSlug,
	sectionChunks,
}: {
	env: WorkshopIndexEnv
	runId: string
	workshopSlug: string
	sectionChunks: Array<
		IndexedSectionChunkWrite & {
			exerciseNumber?: number
			stepNumber?: number
			sectionOrder: number
		}
	>
}) {
	if (sectionChunks.length === 0) return sectionChunks
	const vectorIndex = env.WORKSHOP_VECTOR_INDEX
	const ai = env.AI
	if (!vectorIndex || !ai) {
		return sectionChunks
	}

	const vectors: Array<Array<number>> = []
	for (const chunkBatch of chunkIntoBatches({
		items: sectionChunks,
		batchSize: defaultEmbeddingBatchSize,
	})) {
		const embeddingResponse = (await ai.run('@cf/baai/bge-base-en-v1.5', {
			text: chunkBatch.map((chunk) => chunk.content),
		})) as unknown

		let batchVectors: Array<Array<number>> = []
		if (
			embeddingResponse &&
			typeof embeddingResponse === 'object' &&
			'data' in embeddingResponse &&
			Array.isArray((embeddingResponse as { data?: unknown }).data)
		) {
			batchVectors = (embeddingResponse as { data: Array<Array<number>> }).data
		} else if (Array.isArray(embeddingResponse)) {
			batchVectors = embeddingResponse as Array<Array<number>>
		}

		if (batchVectors.length !== chunkBatch.length) {
			console.warn(
				'workshop-reindex-embedding-length-mismatch',
				JSON.stringify({
					runId,
					workshopSlug,
					expected: chunkBatch.length,
					received: batchVectors.length,
				}),
			)
			return sectionChunks
		}

		vectors.push(...batchVectors)
	}

	const vectorIdsByIndex: Array<string | undefined> = []
	const vectorPayloads = sectionChunks.flatMap((chunk, index) => {
		const values = vectors[index]
		if (!Array.isArray(values) || values.length === 0) {
			vectorIdsByIndex[index] = undefined
			return []
		}
		const vectorId = `${runId}:${workshopSlug}:${chunk.sectionOrder}:${chunk.chunkIndex}`
		vectorIdsByIndex[index] = vectorId
		return [
			{
				id: vectorId,
				values,
				metadata: {
					workshop_slug: workshopSlug,
					exercise_number: chunk.exerciseNumber ?? -1,
					step_number: chunk.stepNumber ?? -1,
					section_order: chunk.sectionOrder,
					chunk_index: chunk.chunkIndex,
					index_run_id: runId,
				},
			},
		]
	})

	if (vectorPayloads.length > 0) {
		for (const vectorPayloadBatch of chunkIntoBatches({
			items: vectorPayloads,
			batchSize: defaultVectorUpsertBatchSize,
		})) {
			await vectorIndex.upsert(vectorPayloadBatch)
		}
	}

	return sectionChunks.map((chunk, index) => ({
		...chunk,
		vectorId: vectorIdsByIndex[index],
	}))
}

function wildcardToRegExp(pattern: string) {
	const escaped = pattern
		.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
		.replaceAll('*', '.*')
	return new RegExp(`^${escaped}$`, 'i')
}

function shouldIgnoreDiffPath(path: string, ignorePatterns: Array<string>) {
	return ignorePatterns.some((pattern) => wildcardToRegExp(pattern).test(path))
}

function createSimpleUnifiedDiff({
	path,
	problemContent,
	solutionContent,
}: {
	path: string
	problemContent?: string
	solutionContent?: string
}) {
	const oldContent = normalizeNewlines(problemContent ?? '')
	const newContent = normalizeNewlines(solutionContent ?? '')
	if (oldContent === newContent) {
		return null
	}

	const oldLines = oldContent.split('\n')
	const newLines = newContent.split('\n')
	const maxLength = Math.max(oldLines.length, newLines.length)
	const oldHeader = problemContent === undefined ? '/dev/null' : `a/${path}`
	const newHeader = solutionContent === undefined ? '/dev/null' : `b/${path}`
	const diffLines = [
		`diff --git a/${path} b/${path}`,
		`--- ${oldHeader}`,
		`+++ ${newHeader}`,
	]

	for (let index = 0; index < maxLength; index++) {
		const oldLine = oldLines[index]
		const newLine = newLines[index]
		if (oldLine === newLine) {
			if (oldLine !== undefined) {
				diffLines.push(` ${oldLine}`)
			}
			continue
		}
		if (oldLine !== undefined) {
			diffLines.push(`-${oldLine}`)
		}
		if (newLine !== undefined) {
			diffLines.push(`+${newLine}`)
		}
	}

	return diffLines.join('\n')
}

function buildDiffSummary({
	path,
	problemContent,
	solutionContent,
}: {
	path: string
	problemContent?: string
	solutionContent?: string
}) {
	if (problemContent === undefined && solutionContent !== undefined) {
		return `added ${path}`
	}
	if (problemContent !== undefined && solutionContent === undefined) {
		return `removed ${path}`
	}
	return `modified ${path}`
}

function parseExerciseFromPath(path: string) {
	const match = /^exercises\/(?<exerciseDir>\d+\.[^/]+)\//.exec(path)
	const exerciseDir = match?.groups?.exerciseDir
	if (!exerciseDir) return null
	const number = Number.parseInt(exerciseDir.split('.')[0] ?? '', 10)
	if (!Number.isFinite(number) || number <= 0) return null
	return {
		exerciseDir,
		exerciseNumber: number,
	}
}

function parseStepFromPath(path: string) {
	const match =
		/^exercises\/(?<exerciseDir>\d+\.[^/]+)\/(?<stepNumber>\d+)\.(?<stepType>problem|solution)(?:\.[^/]+)?\//.exec(
			path,
		)
	const exerciseDir = match?.groups?.exerciseDir
	const stepNumberValue = match?.groups?.stepNumber
	const stepTypeValue = match?.groups?.stepType
	if (!exerciseDir || !stepNumberValue || !stepTypeValue) return null
	const exerciseNumber = Number.parseInt(
		(exerciseDir.split('.')[0] ?? '').trim(),
		10,
	)
	const stepNumber = Number.parseInt(stepNumberValue, 10)
	if (
		!Number.isFinite(exerciseNumber) ||
		exerciseNumber <= 0 ||
		!Number.isFinite(stepNumber) ||
		stepNumber <= 0
	) {
		return null
	}
	const stepType = stepTypeValue as 'problem' | 'solution'
	const stepDir = path.split('/').slice(0, 3).join('/')
	return {
		exerciseNumber,
		stepNumber,
		stepType,
		stepDir,
	}
}

function groupStepFilesByDirectory(entries: Array<GitTreeEntry>) {
	const filesByStepDir = new Map<string, Array<GitTreeEntry>>()
	for (const entry of entries) {
		if (entry.type !== 'blob') continue
		const parsedStep = parseStepFromPath(entry.path)
		if (!parsedStep) continue
		const files = filesByStepDir.get(parsedStep.stepDir) ?? []
		files.push(entry)
		filesByStepDir.set(parsedStep.stepDir, files)
	}
	return filesByStepDir
}

function compareByNumberThenName(
	left: { exerciseNumber: number; title: string },
	right: { exerciseNumber: number; title: string },
) {
	if (left.exerciseNumber !== right.exerciseNumber) {
		return left.exerciseNumber - right.exerciseNumber
	}
	return left.title.localeCompare(right.title)
}

function formatGitHubApiError({
	status,
	pathname,
	responseBody,
	tokenProvided,
	rateLimitRemaining,
	rateLimitReset,
}: {
	status: number
	pathname: string
	responseBody: string
	tokenProvided: boolean
	rateLimitRemaining?: string | null
	rateLimitReset?: string | null
}) {
	const body = responseBody.trim()
	const lowerBody = body.toLowerCase()
	const isRateLimitError =
		status === 403 &&
		(lowerBody.includes('rate limit') ||
			lowerBody.includes('secondary rate limit'))
	const rateLimitDetails =
		rateLimitRemaining !== null && rateLimitRemaining !== undefined
			? ` Rate limit remaining: ${rateLimitRemaining}.`
			: ''
	const rateLimitResetDetails =
		rateLimitReset !== null && rateLimitReset !== undefined
			? ` Rate limit reset epoch: ${rateLimitReset}.`
			: ''

	if (isRateLimitError) {
		const guidance = tokenProvided
			? ' The configured GITHUB_TOKEN appears rate-limited; retry later or rotate the token.'
			: ' Set GITHUB_TOKEN to increase GitHub API rate limits for indexing.'
		return `GitHub API ${status} for ${pathname}: ${body}.${rateLimitDetails}${rateLimitResetDetails}${guidance}`.trim()
	}

	return `GitHub API ${status} for ${pathname}: ${body}`
}

function shouldRetryGitHubRequest({
	status,
	responseBody,
	attempt,
	maxAttempts,
}: {
	status: number
	responseBody: string
	attempt: number
	maxAttempts: number
}) {
	if (attempt >= maxAttempts) return false
	if (status === 429 || status >= 500) return true
	if (status === 403) {
		const normalized = responseBody.toLowerCase()
		if (normalized.includes('secondary rate limit')) {
			return true
		}
	}
	return false
}

function shouldRetryGitHubFetchError({
	attempt,
	maxAttempts,
}: {
	attempt: number
	maxAttempts: number
}) {
	return attempt < maxAttempts
}

function formatGitHubFetchError({
	pathname,
	errorMessage,
}: {
	pathname: string
	errorMessage: string
}) {
	return `GitHub API request failed for ${pathname}: ${errorMessage}`
}

function resolveRetryDelayMs({
	attempt,
	retryAfterHeader,
	baseDelayMs = githubRetryBaseDelayMs,
	maxDelayMs = githubRetryMaxDelayMs,
	nowMs = Date.now(),
}: {
	attempt: number
	retryAfterHeader?: string | null
	baseDelayMs?: number
	maxDelayMs?: number
	nowMs?: number
}) {
	const normalizedRetryAfterHeader = (retryAfterHeader ?? '').trim()
	const parsedRetryAfterSeconds = Number.parseInt(
		normalizedRetryAfterHeader,
		10,
	)
	if (Number.isFinite(parsedRetryAfterSeconds) && parsedRetryAfterSeconds > 0) {
		return Math.min(parsedRetryAfterSeconds * 1_000, maxDelayMs)
	}
	const parsedRetryAfterDate = Date.parse(normalizedRetryAfterHeader)
	if (Number.isFinite(parsedRetryAfterDate)) {
		const delayFromDateMs = Math.max(0, parsedRetryAfterDate - nowMs)
		if (delayFromDateMs > 0) {
			return Math.min(delayFromDateMs, maxDelayMs)
		}
	}
	return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs)
}

export const workshopIndexerTestUtils = {
	parseExerciseFromPath,
	parseStepFromPath,
	groupStepFilesByDirectory,
	filterRequestedRepositories,
	splitIntoChunks,
	chunkIntoBatches,
	buildUniqueVectorIdBatches,
	collectVectorIds,
	deleteVectorIdsIfConfigured,
	createSimpleUnifiedDiff,
	shouldIgnoreDiffPath,
	formatGitHubApiError,
	shouldRetryGitHubRequest,
	shouldRetryGitHubFetchError,
	formatGitHubFetchError,
	resolveRetryDelayMs,
}

async function githubJson<T>({
	env,
	path,
	query,
}: {
	env: WorkshopIndexEnv
	path: string
	query?: URLSearchParams
}) {
	const url = new URL(`https://api.github.com${path}`)
	if (query) {
		url.search = query.toString()
	}
	const token = env.GITHUB_TOKEN?.trim()
	for (let attempt = 1; attempt <= githubRequestMaxAttempts; attempt += 1) {
		let response: Response
		try {
			response = await fetch(url, {
				headers: {
					Accept: 'application/vnd.github+json',
					'User-Agent': 'epic-agent-workshop-indexer',
					'X-GitHub-Api-Version': '2022-11-28',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (
				shouldRetryGitHubFetchError({
					attempt,
					maxAttempts: githubRequestMaxAttempts,
				})
			) {
				const retryDelayMs = resolveRetryDelayMs({ attempt })
				console.warn(
					'workshop-reindex-github-request-retry',
					JSON.stringify({
						pathname: url.pathname,
						status: 'fetch-error',
						attempt,
						retryDelayMs,
						error: message,
					}),
				)
				await wait(retryDelayMs)
				continue
			}
			throw new Error(
				formatGitHubFetchError({
					pathname: url.pathname,
					errorMessage: message,
				}),
			)
		}
		if (response.ok) {
			return (await response.json()) as T
		}

		const message = await response.text()
		if (
			shouldRetryGitHubRequest({
				status: response.status,
				responseBody: message,
				attempt,
				maxAttempts: githubRequestMaxAttempts,
			})
		) {
			const retryDelayMs = resolveRetryDelayMs({
				attempt,
				retryAfterHeader: response.headers.get('retry-after'),
			})
			console.warn(
				'workshop-reindex-github-request-retry',
				JSON.stringify({
					pathname: url.pathname,
					status: response.status,
					attempt,
					retryDelayMs,
				}),
			)
			await wait(retryDelayMs)
			continue
		}

		throw new Error(
			formatGitHubApiError({
				status: response.status,
				pathname: url.pathname,
				responseBody: message,
				tokenProvided: Boolean(token),
				rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
				rateLimitReset: response.headers.get('x-ratelimit-reset'),
			}),
		)
	}

	throw new Error(`GitHub API request retries exhausted for ${url.pathname}.`)
}

function filterRequestedRepositories({
	repositories,
	onlyWorkshops,
}: {
	repositories: Array<WorkshopRepository>
	onlyWorkshops?: Array<string>
}) {
	const normalizedSelections = Array.from(
		new Set(
			(onlyWorkshops ?? [])
				.map((workshop) => workshop.trim().toLowerCase())
				.filter(Boolean),
		),
	)
	if (normalizedSelections.length === 0) {
		return repositories
	}

	const availableRepositoryNames = new Set(
		repositories.map((repository) => repository.name.toLowerCase()),
	)
	const missingSelections = normalizedSelections.filter(
		(workshop) => !availableRepositoryNames.has(workshop),
	)
	if (missingSelections.length > 0) {
		const orderedMissingSelections = [...missingSelections].sort((a, b) =>
			a.localeCompare(b),
		)
		throw new WorkshopIndexInputError(
			`Unknown workshop filter(s): ${orderedMissingSelections.join(', ')}.`,
		)
	}

	const selectedWorkshops = new Set(normalizedSelections)
	return repositories.filter((repository) =>
		selectedWorkshops.has(repository.name.toLowerCase()),
	)
}

async function listWorkshopRepositories({
	env,
	onlyWorkshops,
}: {
	env: WorkshopIndexEnv
	onlyWorkshops?: Array<string>
}) {
	const results: Array<WorkshopRepository> = []
	for (let page = 1; page < 10; page++) {
		const payload = await githubJson<{
			items: Array<{
				name: string
				default_branch: string
				archived: boolean
				owner: { login: string }
			}>
		}>({
			env,
			path: '/search/repositories',
			query: new URLSearchParams({
				q: `org:${workshopOrg} topic:workshop archived:false`,
				sort: 'updated',
				order: 'desc',
				per_page: String(defaultSearchPageSize),
				page: String(page),
			}),
		})

		const pageResults = payload.items
			.filter((repo) => repo.archived === false)
			.map((repo) => ({
				owner: repo.owner.login,
				name: repo.name,
				defaultBranch: repo.default_branch,
			}))
		results.push(...pageResults)

		if (pageResults.length < defaultSearchPageSize) {
			break
		}
	}

	const filtered = filterRequestedRepositories({
		repositories: results,
		onlyWorkshops,
	})

	return filtered.sort((left, right) => left.name.localeCompare(right.name))
}

async function getRepoTree({
	env,
	repo,
}: {
	env: WorkshopIndexEnv
	repo: WorkshopRepository
}) {
	const payload = await githubJson<{
		sha: string
		truncated: boolean
		tree: Array<GitTreeEntry>
	}>({
		env,
		path: `/repos/${repo.owner}/${repo.name}/git/trees/${repo.defaultBranch}`,
		query: new URLSearchParams({ recursive: '1' }),
	})

	if (payload.truncated) {
		throw new Error(
			`Git tree for ${repo.name} was truncated; cannot index safely.`,
		)
	}

	return payload
}

async function buildBlobReader({
	env,
	repo,
}: {
	env: WorkshopIndexEnv
	repo: WorkshopRepository
}) {
	const cache = new Map<string, string | null>()
	return async function readBlob(sha: string) {
		if (cache.has(sha)) {
			return cache.get(sha) ?? null
		}
		const blob = await githubJson<{ encoding: string; content: string }>({
			env,
			path: `/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
		})
		if (blob.encoding !== 'base64') {
			cache.set(sha, null)
			return null
		}
		const base64 = blob.content.replaceAll('\n', '')
		const content = new TextDecoder().decode(
			Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
		)
		cache.set(sha, content)
		return content
	}
}

function groupTreeEntries(tree: Array<GitTreeEntry>) {
	const byPath = new Map<string, GitTreeEntry>()
	for (const entry of tree) {
		if (entry.type !== 'blob') continue
		byPath.set(entry.path, entry)
	}
	return byPath
}

async function indexWorkshopRepository({
	env,
	repo,
}: {
	env: WorkshopIndexEnv
	repo: WorkshopRepository
}): Promise<RepoIndexResult> {
	const treePayload = await getRepoTree({ env, repo })
	const treeByPath = groupTreeEntries(treePayload.tree)
	const stepFilesByDirectory = groupStepFilesByDirectory(treePayload.tree)
	const readBlob = await buildBlobReader({ env, repo })
	const packageEntry = treeByPath.get('package.json')
	const packageJson = packageEntry ? await readBlob(packageEntry.sha) : null
	const packageMetadata = readJson<{
		epicshop?: {
			title?: string
			product?: { displayNameShort?: string; host?: string; slug?: string }
		}
	}>(packageJson ?? '{}')
	const workshopSlug = repo.name
	const title = cleanTitle(packageMetadata?.epicshop?.title, repo.name)
	const product = cleanTitle(
		packageMetadata?.epicshop?.product?.displayNameShort ??
			packageMetadata?.epicshop?.product?.host ??
			packageMetadata?.epicshop?.product?.slug,
		'',
	)

	const exerciseMap = new Map<
		number,
		{
			exerciseDir: string
			title: string
			stepMap: Map<
				number,
				{
					problemDir?: string
					solutionDir?: string
				}
			>
		}
	>()

	for (const path of treeByPath.keys()) {
		const exercise = parseExerciseFromPath(path)
		if (!exercise) continue
		if (!exerciseMap.has(exercise.exerciseNumber)) {
			exerciseMap.set(exercise.exerciseNumber, {
				exerciseDir: exercise.exerciseDir,
				title: exercise.exerciseDir.split('.').slice(1).join(' '),
				stepMap: new Map(),
			})
		}
		const step = parseStepFromPath(path)
		if (!step) continue
		const exerciseNode = exerciseMap.get(step.exerciseNumber)
		if (!exerciseNode) continue
		const stepNode = exerciseNode.stepMap.get(step.stepNumber) ?? {}
		if (step.stepType === 'problem') {
			stepNode.problemDir = step.stepDir
		} else {
			stepNode.solutionDir = step.stepDir
		}
		exerciseNode.stepMap.set(step.stepNumber, stepNode)
	}

	const workshopInstructionsEntry = treeByPath.get('exercises/README.mdx')
	const workshopFinishedEntry = treeByPath.get('exercises/FINISHED.mdx')
	const workshopInstructions = workshopInstructionsEntry
		? await readBlob(workshopInstructionsEntry.sha)
		: null
	const workshopFinished = workshopFinishedEntry
		? await readBlob(workshopFinishedEntry.sha)
		: null
	const diffIgnoreEntry = treeByPath.get('epicshop/.diffignore')
	const diffIgnoreContent =
		(diffIgnoreEntry ? await readBlob(diffIgnoreEntry.sha) : '') ?? ''
	const diffIgnorePatterns = [
		...defaultDiffIgnore,
		...diffIgnoreContent
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#')),
	]

	let sectionOrder = 10
	const sections: Array<IndexedSectionWrite> = []
	const sectionChunks: Array<IndexedSectionChunkWrite> = []
	const exercises: Array<IndexedExerciseWrite> = []
	const steps: Array<IndexedStepWrite> = []
	let hasDiffs = false

	if (workshopInstructions) {
		sections.push({
			sectionOrder: sectionOrder++,
			sectionKind: 'workshop-instructions',
			label: 'Workshop instructions',
			sourcePath: 'exercises/README.mdx',
			content: toSectionContent(workshopInstructions),
		})
	}
	if (workshopFinished) {
		sections.push({
			sectionOrder: sectionOrder++,
			sectionKind: 'workshop-finished',
			label: 'Workshop finished notes',
			sourcePath: 'exercises/FINISHED.mdx',
			content: toSectionContent(workshopFinished),
		})
	}

	const sortedExercises = Array.from(exerciseMap.entries())
		.map(([exerciseNumber, exercise]) => ({
			exerciseNumber,
			title: exercise.title,
			exercise,
		}))
		.sort(compareByNumberThenName)

	for (const exerciseEntry of sortedExercises) {
		const { exerciseNumber, exercise } = exerciseEntry
		const exerciseInstructionsPath = `exercises/${exercise.exerciseDir}/README.mdx`
		const exerciseFinishedPath = `exercises/${exercise.exerciseDir}/FINISHED.mdx`
		const exerciseInstructionsEntry = treeByPath.get(exerciseInstructionsPath)
		const exerciseFinishedEntry = treeByPath.get(exerciseFinishedPath)
		const exerciseInstructions = exerciseInstructionsEntry
			? await readBlob(exerciseInstructionsEntry.sha)
			: null
		const exerciseFinished = exerciseFinishedEntry
			? await readBlob(exerciseFinishedEntry.sha)
			: null

		const stepNumbers = Array.from(exercise.stepMap.keys()).sort(
			(left, right) => left - right,
		)
		exercises.push({
			exerciseNumber,
			title: exercise.title,
			stepCount: stepNumbers.length,
		})

		if (exerciseInstructions) {
			sections.push({
				exerciseNumber,
				sectionOrder: sectionOrder++,
				sectionKind: 'exercise-instructions',
				label: `Exercise ${exerciseNumber} instructions`,
				sourcePath: exerciseInstructionsPath,
				content: toSectionContent(exerciseInstructions),
			})
		}
		if (exerciseFinished) {
			sections.push({
				exerciseNumber,
				sectionOrder: sectionOrder++,
				sectionKind: 'exercise-finished',
				label: `Exercise ${exerciseNumber} finished notes`,
				sourcePath: exerciseFinishedPath,
				content: toSectionContent(exerciseFinished),
			})
		}

		for (const stepNumber of stepNumbers) {
			const step = exercise.stepMap.get(stepNumber)
			if (!step) continue
			const problemReadmePath = step.problemDir
				? `${step.problemDir}/README.mdx`
				: null
			const solutionReadmePath = step.solutionDir
				? `${step.solutionDir}/README.mdx`
				: null
			const problemReadmeEntry = problemReadmePath
				? treeByPath.get(problemReadmePath)
				: null
			const solutionReadmeEntry = solutionReadmePath
				? treeByPath.get(solutionReadmePath)
				: null
			const problemReadme = problemReadmeEntry
				? await readBlob(problemReadmeEntry.sha)
				: null
			const solutionReadme = solutionReadmeEntry
				? await readBlob(solutionReadmeEntry.sha)
				: null

			if (problemReadme) {
				sections.push({
					exerciseNumber,
					stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'problem-instructions',
					label: `Exercise ${exerciseNumber} step ${stepNumber} problem instructions`,
					sourcePath: problemReadmePath ?? undefined,
					content: toSectionContent(problemReadme),
				})
			}
			if (solutionReadme) {
				sections.push({
					exerciseNumber,
					stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'solution-instructions',
					label: `Exercise ${exerciseNumber} step ${stepNumber} solution instructions`,
					sourcePath: solutionReadmePath ?? undefined,
					content: toSectionContent(solutionReadme),
				})
			}

			const problemFiles = step.problemDir
				? (stepFilesByDirectory.get(step.problemDir) ?? [])
				: []
			const solutionFiles = step.solutionDir
				? (stepFilesByDirectory.get(step.solutionDir) ?? [])
				: []

			const problemFilesByRelativePath = new Map<string, GitTreeEntry>()
			for (const file of problemFiles) {
				const relativePath = file.path.replace(`${step.problemDir}/`, '')
				if (relativePath === 'README.mdx') continue
				if (!isLikelyTextFile(relativePath, file.size)) continue
				if (shouldIgnoreDiffPath(relativePath, diffIgnorePatterns)) continue
				problemFilesByRelativePath.set(relativePath, file)
			}
			const solutionFilesByRelativePath = new Map<string, GitTreeEntry>()
			for (const file of solutionFiles) {
				const relativePath = file.path.replace(`${step.solutionDir}/`, '')
				if (relativePath === 'README.mdx') continue
				if (!isLikelyTextFile(relativePath, file.size)) continue
				if (shouldIgnoreDiffPath(relativePath, diffIgnorePatterns)) continue
				solutionFilesByRelativePath.set(relativePath, file)
			}

			const allRelativePaths = new Set([
				...problemFilesByRelativePath.keys(),
				...solutionFilesByRelativePath.keys(),
			])

			const diffSummaries: Array<string> = []
			const diffChunks: Array<{ relativePath: string; diffText: string }> = []
			let stepHasDiff = false

			const sortedRelativePaths = Array.from(allRelativePaths).sort((a, b) =>
				a.localeCompare(b),
			)
			for (const relativePath of sortedRelativePaths) {
				const problemFile = problemFilesByRelativePath.get(relativePath)
				const solutionFile = solutionFilesByRelativePath.get(relativePath)
				if (problemFile?.sha === solutionFile?.sha) {
					continue
				}
				const problemContent = problemFile
					? await readBlob(problemFile.sha)
					: null
				const solutionContent = solutionFile
					? await readBlob(solutionFile.sha)
					: null
				if (problemContent && problemFile) {
					sections.push({
						exerciseNumber,
						stepNumber,
						sectionOrder: sectionOrder++,
						sectionKind: 'problem-code',
						label: `Problem code: ${relativePath}`,
						sourcePath: problemFile.path,
						content: toSectionContent(problemContent),
					})
				}
				if (solutionContent && solutionFile) {
					sections.push({
						exerciseNumber,
						stepNumber,
						sectionOrder: sectionOrder++,
						sectionKind: 'solution-code',
						label: `Solution code: ${relativePath}`,
						sourcePath: solutionFile.path,
						content: toSectionContent(solutionContent),
					})
				}

				const diffText = createSimpleUnifiedDiff({
					path: relativePath,
					problemContent: problemContent ?? undefined,
					solutionContent: solutionContent ?? undefined,
				})
				if (!diffText) continue
				stepHasDiff = true
				diffSummaries.push(
					buildDiffSummary({
						path: relativePath,
						problemContent: problemContent ?? undefined,
						solutionContent: solutionContent ?? undefined,
					}),
				)
				diffChunks.push({ relativePath, diffText })
			}

			if (diffSummaries.length > 0) {
				hasDiffs = true
				sections.push({
					exerciseNumber,
					stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'diff-summary',
					label: `Diff summary for exercise ${exerciseNumber} step ${stepNumber}`,
					content: diffSummaries.map((line) => `- ${line}`).join('\n'),
					isDiff: true,
				})
			}
			for (const chunk of diffChunks) {
				sections.push({
					exerciseNumber,
					stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'diff-hunk',
					label: `Diff chunk for exercise ${exerciseNumber} step ${stepNumber}`,
					sourcePath: chunk.relativePath,
					content: toSectionContent(chunk.diffText),
					isDiff: true,
				})
			}

			steps.push({
				exerciseNumber,
				stepNumber,
				problemDir: step.problemDir,
				solutionDir: step.solutionDir,
				hasDiff: stepHasDiff,
			})
		}
	}

	for (const section of sections) {
		const chunks = splitIntoChunks({ content: section.content })
		for (const chunk of chunks) {
			sectionChunks.push({
				exerciseNumber: section.exerciseNumber,
				stepNumber: section.stepNumber,
				sectionOrder: section.sectionOrder,
				chunkIndex: chunk.chunkIndex,
				content: chunk.content,
			})
		}
	}

	return {
		workshop: {
			workshopSlug,
			title,
			product: product.length > 0 ? product : undefined,
			repoOwner: repo.owner,
			repoName: repo.name,
			defaultBranch: repo.defaultBranch,
			sourceSha: treePayload.sha,
			exerciseCount: exercises.length,
			hasDiffs,
		},
		exercises,
		steps,
		sections,
		sectionChunks,
	}
}

export async function runWorkshopReindex({
	env,
	onlyWorkshops,
}: {
	env: WorkshopIndexEnv
	onlyWorkshops?: Array<string>
}): Promise<IndexSummary> {
	const db = env.APP_DB
	const runId = await createIndexRun(db)
	let workshopCount = 0
	let exerciseCount = 0
	let stepCount = 0
	let sectionCount = 0
	let sectionChunkCount = 0
	const startedAt = Date.now()
	console.info(
		'workshop-reindex-start',
		JSON.stringify({
			runId,
			onlyWorkshops: onlyWorkshops?.length ?? 0,
			timestamp: new Date(startedAt).toISOString(),
		}),
	)

	try {
		const repositories = await listWorkshopRepositories({ env, onlyWorkshops })
		console.info(
			'workshop-reindex-discovery',
			JSON.stringify({
				runId,
				repositoryCount: repositories.length,
			}),
		)
		for (const repository of repositories) {
			const repositoryStart = Date.now()
			const indexed = await indexWorkshopRepository({
				env,
				repo: repository,
			})
			const previousVectorIds = await listStoredVectorIdsForWorkshop({
				db,
				workshop: indexed.workshop.workshopSlug,
			})
			const embeddedSectionChunks = await embedChunksIfConfigured({
				env,
				runId,
				workshopSlug: indexed.workshop.workshopSlug,
				sectionChunks: indexed.sectionChunks,
			})
			const insertedVectorIds = collectVectorIds(embeddedSectionChunks)
			try {
				await replaceWorkshopIndex({
					db,
					runId,
					workshop: indexed.workshop,
					exercises: indexed.exercises,
					steps: indexed.steps,
					sections: indexed.sections,
					sectionChunks: embeddedSectionChunks,
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const rollbackVectorCount = await deleteVectorIdsIfConfigured({
					env,
					runId,
					workshopSlug: indexed.workshop.workshopSlug,
					vectorIds: insertedVectorIds,
				})
				console.warn(
					'workshop-reindex-repository-rollback',
					JSON.stringify({
						runId,
						repository: repository.name,
						insertedVectorCount: insertedVectorIds.length,
						rollbackVectorCount,
						error: message,
					}),
				)
				throw error
			}
			const deletedVectorCount = await deleteVectorIdsIfConfigured({
				env,
				runId,
				workshopSlug: indexed.workshop.workshopSlug,
				vectorIds: previousVectorIds,
			})
			workshopCount += 1
			exerciseCount += indexed.exercises.length
			stepCount += indexed.steps.length
			sectionCount += indexed.sections.length
			sectionChunkCount += embeddedSectionChunks.length
			console.info(
				'workshop-reindex-repository-complete',
				JSON.stringify({
					runId,
					repository: repository.name,
					exerciseCount: indexed.exercises.length,
					stepCount: indexed.steps.length,
					sectionCount: indexed.sections.length,
					sectionChunkCount: embeddedSectionChunks.length,
					insertedVectorCount: insertedVectorIds.length,
					deletedVectorCount,
					durationMs: Date.now() - repositoryStart,
				}),
			)
		}

		await markIndexRunComplete({
			db,
			runId,
			workshopCount,
			exerciseCount,
			stepCount,
			sectionCount,
			sectionChunkCount,
		})
		console.info(
			'workshop-reindex-complete',
			JSON.stringify({
				runId,
				workshopCount,
				exerciseCount,
				stepCount,
				sectionCount,
				sectionChunkCount,
				durationMs: Date.now() - startedAt,
			}),
		)
		return {
			runId,
			workshopCount,
			exerciseCount,
			stepCount,
			sectionCount,
			sectionChunkCount,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		try {
			await markIndexRunFailed({
				db,
				runId,
				errorMessage: message.slice(0, 4000),
			})
		} catch (markFailedError) {
			const markFailedMessage =
				markFailedError instanceof Error
					? markFailedError.message
					: String(markFailedError)
			console.error(
				'workshop-reindex-failed-status-write-error',
				JSON.stringify({
					runId,
					originalError: message,
					markFailedError: markFailedMessage,
				}),
			)
		}
		console.error(
			'workshop-reindex-failed',
			JSON.stringify({
				runId,
				error: message,
				durationMs: Date.now() - startedAt,
			}),
		)
		throw error
	}
}
