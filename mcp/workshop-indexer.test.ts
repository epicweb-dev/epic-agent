/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { workshopIndexBatchDefaultSize } from '../shared/workshop-index-constants.ts'
import {
	WorkshopIndexInputError,
	workshopIndexerTestUtils,
} from './workshop-indexer.ts'

test('parseExerciseFromPath supports workshop exercise paths', () => {
	const parsed = workshopIndexerTestUtils.parseExerciseFromPath(
		'exercises/01.ping/01.problem.connect/src/index.ts',
	)
	expect(parsed).toEqual({
		exerciseDir: '01.ping',
		exerciseNumber: 1,
	})
})

test('parseStepFromPath supports both dotted and plain step directories', () => {
	const dotted = workshopIndexerTestUtils.parseStepFromPath(
		'exercises/02.tools/01.problem.simple/src/index.ts',
	)
	expect(dotted).toEqual({
		exerciseNumber: 2,
		stepNumber: 1,
		stepType: 'problem',
		stepDir: 'exercises/02.tools/01.problem.simple',
	})

	const plain = workshopIndexerTestUtils.parseStepFromPath(
		'exercises/02.elicitation/01.solution/src/index.ts',
	)
	expect(plain).toEqual({
		exerciseNumber: 2,
		stepNumber: 1,
		stepType: 'solution',
		stepDir: 'exercises/02.elicitation/01.solution',
	})
})

test('groupStepFilesByDirectory groups only step blob entries', () => {
	const grouped = workshopIndexerTestUtils.groupStepFilesByDirectory([
		{
			path: 'exercises/01.ping/01.problem.connect/README.mdx',
			mode: '100644',
			type: 'blob',
			sha: 'sha-problem-readme',
			url: 'https://example.test/blob/1',
		},
		{
			path: 'exercises/01.ping/01.problem.connect/src/index.ts',
			mode: '100644',
			type: 'blob',
			sha: 'sha-problem-index',
			url: 'https://example.test/blob/2',
		},
		{
			path: 'exercises/01.ping/01.solution.connect/src/index.ts',
			mode: '100644',
			type: 'blob',
			sha: 'sha-solution-index',
			url: 'https://example.test/blob/3',
		},
		{
			path: 'README.md',
			mode: '100644',
			type: 'blob',
			sha: 'sha-root-readme',
			url: 'https://example.test/blob/4',
		},
		{
			path: 'exercises/01.ping/01.problem.connect',
			mode: '040000',
			type: 'tree',
			sha: 'sha-problem-dir',
			url: 'https://example.test/tree/1',
		},
	])

	expect(grouped.size).toBe(2)
	expect(
		grouped
			.get('exercises/01.ping/01.problem.connect')
			?.map((entry) => entry.sha),
	).toEqual(['sha-problem-readme', 'sha-problem-index'])
	expect(
		grouped
			.get('exercises/01.ping/01.solution.connect')
			?.map((entry) => entry.sha),
	).toEqual(['sha-solution-index'])
})

test('filterRequestedRepositories returns all when filters are absent', () => {
	const repositories = [
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
		{
			owner: 'epicweb-dev',
			name: 'advanced-typescript',
			defaultBranch: 'main',
		},
	]
	const filtered = workshopIndexerTestUtils.filterRequestedRepositories({
		repositories,
	})
	expect(filtered).toEqual(repositories)
})

test('filterRequestedRepositories trims, lowercases, dedupes, and filters selected workshops', () => {
	const repositories = [
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
		{
			owner: 'epicweb-dev',
			name: 'advanced-typescript',
			defaultBranch: 'main',
		},
		{
			owner: 'epicweb-dev',
			name: 'react-fundamentals',
			defaultBranch: 'main',
		},
	]
	const filtered = workshopIndexerTestUtils.filterRequestedRepositories({
		repositories,
		onlyWorkshops: [
			' MCP-FUNDAMENTALS ',
			'Advanced-TypeScript',
			'mcp-fundamentals',
		],
	})
	expect(filtered).toEqual([
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
		{
			owner: 'epicweb-dev',
			name: 'advanced-typescript',
			defaultBranch: 'main',
		},
	])
})

test('reindex cursor encoding and decoding is stable', () => {
	const encoded = workshopIndexerTestUtils.encodeReindexCursor({ offset: 5 })
	expect(workshopIndexerTestUtils.decodeReindexCursor(encoded)).toEqual({
		offset: 5,
	})
	expect(workshopIndexerTestUtils.decodeReindexCursor('not-base64')).toEqual({
		offset: 0,
	})
	expect(workshopIndexerTestUtils.decodeReindexCursor(undefined)).toEqual({
		offset: 0,
	})
})

test('resolveReindexRepositoryBatch slices repositories and returns next cursor', () => {
	const repositories = Array.from({ length: 5 }, (_value, index) => ({
		owner: 'epicweb-dev',
		name: `workshop-${index + 1}`,
		defaultBranch: 'main',
	}))
	const firstBatch = workshopIndexerTestUtils.resolveReindexRepositoryBatch({
		repositories,
		batchSize: 2,
	})
	expect(firstBatch.offset).toBe(0)
	expect(firstBatch.limit).toBe(2)
	expect(firstBatch.batch.map((repo) => repo.name)).toEqual([
		'workshop-1',
		'workshop-2',
	])
	expect(firstBatch.nextCursor).toBeTruthy()

	const secondBatch = workshopIndexerTestUtils.resolveReindexRepositoryBatch({
		repositories,
		batchSize: 2,
		cursor: firstBatch.nextCursor,
	})
	expect(secondBatch.offset).toBe(2)
	expect(secondBatch.batch.map((repo) => repo.name)).toEqual([
		'workshop-3',
		'workshop-4',
	])
	expect(secondBatch.nextCursor).toBeTruthy()

	const finalBatch = workshopIndexerTestUtils.resolveReindexRepositoryBatch({
		repositories,
		batchSize: 20,
		cursor: secondBatch.nextCursor,
	})
	expect(finalBatch.offset).toBe(4)
	expect(finalBatch.batch.map((repo) => repo.name)).toEqual(['workshop-5'])
	expect(finalBatch.nextCursor).toBeUndefined()
})

test('resolveReindexRepositoryBatch defaults to configured batch size', () => {
	const repositories = Array.from({ length: 40 }, (_value, index) => ({
		owner: 'epicweb-dev',
		name: `workshop-${index + 1}`,
		defaultBranch: 'main',
	}))
	const batch = workshopIndexerTestUtils.resolveReindexRepositoryBatch({
		repositories,
	})
	expect(batch.limit).toBe(workshopIndexBatchDefaultSize)
	expect(batch.batch).toHaveLength(workshopIndexBatchDefaultSize)
	expect(batch.nextCursor).toBeTruthy()
})

test('resolveReindexRepositoryBatch clamps batch size to max limit', () => {
	const repositories = Array.from({ length: 40 }, (_value, index) => ({
		owner: 'epicweb-dev',
		name: `workshop-${index + 1}`,
		defaultBranch: 'main',
	}))
	const batch = workshopIndexerTestUtils.resolveReindexRepositoryBatch({
		repositories,
		batchSize: 100,
	})
	expect(batch.limit).toBe(20)
	expect(batch.batch).toHaveLength(20)
	expect(batch.nextCursor).toBeTruthy()
})

test('filterRequestedRepositories throws for unknown requested workshops', () => {
	const repositories = [
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
	]
	expect(() =>
		workshopIndexerTestUtils.filterRequestedRepositories({
			repositories,
			onlyWorkshops: ['mcp-fundamentals', 'missing-workshop'],
		}),
	).toThrow('Unknown workshop filter(s): missing-workshop.')
})

test('filterRequestedRepositories reports unknown workshops in normalized lowercase form', () => {
	const repositories = [
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
	]
	expect(() =>
		workshopIndexerTestUtils.filterRequestedRepositories({
			repositories,
			onlyWorkshops: ['Missing-Workshop'],
		}),
	).toThrow('Unknown workshop filter(s): missing-workshop.')
})

test('filterRequestedRepositories reports missing workshops in sorted order', () => {
	const repositories = [
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
	]
	expect(() =>
		workshopIndexerTestUtils.filterRequestedRepositories({
			repositories,
			onlyWorkshops: ['z-workshop', 'a-workshop'],
		}),
	).toThrow('Unknown workshop filter(s): a-workshop, z-workshop.')
})

test('filterRequestedRepositories throws WorkshopIndexInputError for invalid selections', () => {
	const repositories = [
		{
			owner: 'epicweb-dev',
			name: 'mcp-fundamentals',
			defaultBranch: 'main',
		},
	]
	let thrownError: unknown
	try {
		workshopIndexerTestUtils.filterRequestedRepositories({
			repositories,
			onlyWorkshops: ['missing-workshop'],
		})
	} catch (error) {
		thrownError = error
	}
	expect(thrownError).toBeInstanceOf(WorkshopIndexInputError)
	expect((thrownError as Error).message).toBe(
		'Unknown workshop filter(s): missing-workshop.',
	)
})

test('splitIntoChunks is deterministic with overlap', () => {
	const longContent = Array.from(
		{ length: 220 },
		(_, index) => `line-${index.toString().padStart(3, '0')}`,
	).join('\n')
	const chunks = workshopIndexerTestUtils.splitIntoChunks({
		content: longContent,
		chunkSize: 320,
		chunkOverlap: 60,
	})
	expect(chunks.length).toBeGreaterThan(2)
	expect(chunks[0]?.chunkIndex).toBe(0)
	expect(chunks[1]?.chunkIndex).toBe(1)
	expect(chunks[0]?.content.length).toBeLessThanOrEqual(320)
	expect(chunks[1]?.content.length).toBeLessThanOrEqual(320)
	expect(chunks[0]?.content).not.toBe(chunks[1]?.content)
})

test('chunkIntoBatches creates stable slices', () => {
	const batches = workshopIndexerTestUtils.chunkIntoBatches({
		items: [1, 2, 3, 4, 5],
		batchSize: 2,
	})
	expect(batches).toEqual([[1, 2], [3, 4], [5]])
})

test('chunkIntoBatches clamps invalid batch sizes', () => {
	const batches = workshopIndexerTestUtils.chunkIntoBatches({
		items: [1, 2, 3],
		batchSize: 0,
	})
	expect(batches).toEqual([[1], [2], [3]])
})

test('buildUniqueVectorIdBatches dedupes and chunks vector ids', () => {
	const batches = workshopIndexerTestUtils.buildUniqueVectorIdBatches({
		vectorIds: [' alpha ', 'beta', '', 'beta', 'gamma', 'delta'],
		batchSize: 2,
	})
	expect(batches).toEqual([
		['alpha', 'beta'],
		['gamma', 'delta'],
	])
})

test('collectVectorIds trims and drops empty values', () => {
	const vectorIds = workshopIndexerTestUtils.collectVectorIds([
		{ vectorId: ' first ' },
		{ vectorId: '' },
		{},
		{ vectorId: 'second' },
	])
	expect(vectorIds).toEqual(['first', 'second'])
})

test('deleteVectorIdsIfConfigured deletes deduped vector batches', async () => {
	const calls: Array<Array<string>> = []
	const deletedCount =
		await workshopIndexerTestUtils.deleteVectorIdsIfConfigured({
			env: {
				WORKSHOP_VECTOR_INDEX: {
					deleteByIds: async (ids: Array<string>) => {
						calls.push(ids)
						return { count: ids.length }
					},
				} as unknown as Vectorize,
			} as Env,
			runId: 'run-test',
			workshopSlug: 'example-workshop',
			vectorIds: [' v1 ', 'v2', 'v2', 'v3'],
			batchSize: 3,
		})
	expect(calls).toEqual([['v1', 'v2', 'v3']])
	expect(deletedCount).toBe(3)
})

test('deleteVectorIdsIfConfigured continues when one batch fails', async () => {
	const calls: Array<Array<string>> = []
	const deletedCount =
		await workshopIndexerTestUtils.deleteVectorIdsIfConfigured({
			env: {
				WORKSHOP_VECTOR_INDEX: {
					deleteByIds: async (ids: Array<string>) => {
						calls.push(ids)
						if (ids.includes('v1')) {
							throw new Error('simulated delete failure')
						}
						return { count: ids.length }
					},
				} as unknown as Vectorize,
			} as Env,
			runId: 'run-test',
			workshopSlug: 'example-workshop',
			vectorIds: ['v1', 'v2', 'v3', 'v4'],
			batchSize: 3,
		})
	expect(calls).toEqual([['v1', 'v2', 'v3'], ['v4']])
	expect(deletedCount).toBe(1)
})

test('createSimpleUnifiedDiff includes changed lines', () => {
	const diff = workshopIndexerTestUtils.createSimpleUnifiedDiff({
		path: 'src/index.ts',
		problemContent: 'const value = 1\nconsole.log(value)\n',
		solutionContent: 'const value = 2\nconsole.log(value)\n',
	})
	expect(diff).toContain('diff --git a/src/index.ts b/src/index.ts')
	expect(diff).toContain('-const value = 1')
	expect(diff).toContain('+const value = 2')
})

test('createSimpleUnifiedDiff keeps aligned lines after insertions', () => {
	const diff = workshopIndexerTestUtils.createSimpleUnifiedDiff({
		path: 'src/index.ts',
		problemContent: 'const value = 1\nconsole.log(value)\n',
		solutionContent:
			'const value = 1\nconsole.log(value)\nconsole.log("added")\n',
	})
	expect(diff).toContain('+console.log("added")')
	expect(diff).toContain(' console.log(value)')
	expect(diff).not.toContain('-console.log(value)')
})

test('shouldIgnoreDiffPath respects wildcard patterns', () => {
	const ignored = workshopIndexerTestUtils.shouldIgnoreDiffPath('README.mdx', [
		'README.*',
	])
	const notIgnored = workshopIndexerTestUtils.shouldIgnoreDiffPath(
		'src/index.ts',
		['README.*'],
	)
	expect(ignored).toBe(true)
	expect(notIgnored).toBe(false)
})

test('formatGitHubApiError suggests adding token for unauthenticated rate limits', () => {
	const message = workshopIndexerTestUtils.formatGitHubApiError({
		status: 403,
		pathname: '/repos/epicweb-dev/mcp-fundamentals/git/blobs/demo',
		responseBody: 'API rate limit exceeded for 1.2.3.4',
		tokenProvided: false,
		rateLimitRemaining: '0',
		rateLimitReset: '1730000000',
	})
	expect(message).toContain(
		'Set GITHUB_TOKEN to increase GitHub API rate limits',
	)
	expect(message).toContain('Rate limit remaining: 0')
	expect(message).toContain('Rate limit reset epoch: 1730000000')
})

test('formatGitHubApiError suggests retry for tokened rate limits', () => {
	const message = workshopIndexerTestUtils.formatGitHubApiError({
		status: 403,
		pathname: '/search/repositories',
		responseBody: 'Secondary rate limit exceeded',
		tokenProvided: true,
		rateLimitRemaining: '12',
	})
	expect(message).toContain('configured GITHUB_TOKEN appears rate-limited')
	expect(message).toContain('Rate limit remaining: 12')
})

test('shouldRetryGitHubRequest retries transient statuses', () => {
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubRequest({
			status: 500,
			responseBody: 'internal error',
			attempt: 1,
			maxAttempts: 3,
		}),
	).toBe(true)
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubRequest({
			status: 429,
			responseBody: 'too many requests',
			attempt: 2,
			maxAttempts: 3,
		}),
	).toBe(true)
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubRequest({
			status: 403,
			responseBody: 'Secondary rate limit exceeded',
			attempt: 1,
			maxAttempts: 3,
		}),
	).toBe(true)
})

test('shouldRetryGitHubRequest stops at max attempts and non-retriable errors', () => {
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubRequest({
			status: 500,
			responseBody: 'internal error',
			attempt: 3,
			maxAttempts: 3,
		}),
	).toBe(false)
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubRequest({
			status: 404,
			responseBody: 'not found',
			attempt: 1,
			maxAttempts: 3,
		}),
	).toBe(false)
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubRequest({
			status: 403,
			responseBody: 'API rate limit exceeded',
			attempt: 1,
			maxAttempts: 3,
		}),
	).toBe(false)
})

test('shouldRetryGitHubFetchError retries until max attempts', () => {
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubFetchError({
			attempt: 1,
			maxAttempts: 3,
		}),
	).toBe(true)
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubFetchError({
			attempt: 2,
			maxAttempts: 3,
		}),
	).toBe(true)
	expect(
		workshopIndexerTestUtils.shouldRetryGitHubFetchError({
			attempt: 3,
			maxAttempts: 3,
		}),
	).toBe(false)
})

test('formatGitHubFetchError includes path and error details', () => {
	const message = workshopIndexerTestUtils.formatGitHubFetchError({
		pathname: '/repos/epicweb-dev/mcp-fundamentals/git/trees/main',
		errorMessage: 'network socket disconnected',
	})
	expect(message).toContain(
		'GitHub API request failed for /repos/epicweb-dev/mcp-fundamentals/git/trees/main',
	)
	expect(message).toContain('network socket disconnected')
})

test('resolveRetryDelayMs prefers retry-after header and falls back to backoff', () => {
	expect(
		workshopIndexerTestUtils.resolveRetryDelayMs({
			attempt: 2,
			retryAfterHeader: '7',
		}),
	).toBe(7_000)
	const nowMs = Date.parse('2026-01-01T00:00:00.000Z')
	expect(
		workshopIndexerTestUtils.resolveRetryDelayMs({
			nowMs,
			attempt: 2,
			retryAfterHeader: 'Thu, 01 Jan 2026 00:00:03 GMT',
		}),
	).toBe(3_000)
	expect(
		workshopIndexerTestUtils.resolveRetryDelayMs({
			attempt: 3,
			retryAfterHeader: 'invalid',
		}),
	).toBe(2_000)
	expect(
		workshopIndexerTestUtils.resolveRetryDelayMs({
			attempt: 2,
			baseDelayMs: 200,
		}),
	).toBe(400)
})

test('resolveRetryDelayMs caps long retry delays', () => {
	expect(
		workshopIndexerTestUtils.resolveRetryDelayMs({
			attempt: 2,
			retryAfterHeader: '120',
			maxDelayMs: 10_000,
		}),
	).toBe(10_000)
	expect(
		workshopIndexerTestUtils.resolveRetryDelayMs({
			attempt: 10,
			baseDelayMs: 5_000,
			maxDelayMs: 9_000,
		}),
	).toBe(9_000)
})
