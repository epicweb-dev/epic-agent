import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
	auth,
	type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
	type OAuthClientInformationMixed,
	type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
	type CallToolResult,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import getPort from 'get-port'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workshopIndexRequestBodyMaxChars } from '../shared/workshop-index-constants.ts'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationsDir = join(projectRoot, 'migrations')
const bunBin = process.execPath
const defaultTimeoutMs = 60_000
const indexingTimeoutMs = 240_000
const testWorkshopIndexAdminToken = 'test-workshop-index-token'
const runWorkshopNetworkTests = process.env.RUN_WORKSHOP_NETWORK_TESTS === '1'
const runtimeGitHubToken = resolveRuntimeGitHubToken()
const runWorkshopNetworkReindexTest =
	runWorkshopNetworkTests && Boolean(runtimeGitHubToken)

const passwordHashPrefix = 'pbkdf2_sha256'
const passwordSaltBytes = 16
const passwordHashBytes = 32
const passwordHashIterations = 100_000

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveRuntimeGitHubToken() {
	const configuredToken =
		process.env.GITHUB_TOKEN?.trim() ?? process.env.GH_TOKEN?.trim()
	if (configuredToken) return configuredToken
	if (!runWorkshopNetworkTests) return undefined
	if (!Bun.which('gh')) return undefined

	try {
		const tokenLookup = Bun.spawnSync({
			cmd: ['gh', 'auth', 'token'],
			cwd: projectRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if (tokenLookup.exitCode !== 0) return undefined
		const token = tokenLookup.stdout.toString().trim()
		return token.length > 0 ? token : undefined
	} catch {
		return undefined
	}
}

function toHex(bytes: Uint8Array) {
	return Array.from(bytes)
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('')
}

async function createPasswordHash(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(passwordSaltBytes))
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	)
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt,
			iterations: passwordHashIterations,
			hash: 'SHA-256',
		},
		key,
		passwordHashBytes * 8,
	)
	return `${passwordHashPrefix}$${passwordHashIterations}$${toHex(salt)}$${toHex(
		new Uint8Array(derivedBits),
	)}`
}

function escapeSql(value: string) {
	return value.replace(/'/g, "''")
}

async function runWrangler(args: Array<string>) {
	const proc = Bun.spawn({
		cmd: [bunBin, 'x', 'wrangler', ...args],
		cwd: projectRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const stdoutPromise = proc.stdout
		? new Response(proc.stdout).text()
		: Promise.resolve('')
	const stderrPromise = proc.stderr
		? new Response(proc.stderr).text()
		: Promise.resolve('')
	const exitCode = await proc.exited
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
	if (exitCode !== 0) {
		throw new Error(
			`wrangler ${args.join(' ')} failed (${exitCode}). ${stderr || stdout}`,
		)
	}
	return { stdout, stderr }
}

async function createTestDatabase() {
	const persistDir = await mkdtemp(join(tmpdir(), 'epic-agent-mcp-e2e-'))
	const user = {
		email: `mcp-${crypto.randomUUID()}@example.com`,
		password: `pw-${crypto.randomUUID()}`,
	}

	await applyMigrations(persistDir)

	const passwordHash = await createPasswordHash(user.password)
	const username = user.email.split('@')[0] || 'user'
	const insertSql = `INSERT INTO users (username, email, password_hash) VALUES ('${escapeSql(
		username,
	)}', '${escapeSql(user.email)}', '${escapeSql(passwordHash)}');`

	await runWrangler([
		'd1',
		'execute',
		'APP_DB',
		'--local',
		'--env',
		'test',
		'--persist-to',
		persistDir,
		'--command',
		insertSql,
	])

	return {
		persistDir,
		user,
		[Symbol.asyncDispose]: async () => {
			await rm(persistDir, { recursive: true, force: true })
		},
	}
}

async function seedIndexedWorkshopData(persistDir: string) {
	const runId = `run-${crypto.randomUUID()}`
	const insertSql = `
		INSERT INTO workshop_index_runs (
			id,
			status,
			started_at,
			completed_at,
			workshop_count,
			exercise_count,
			step_count,
			section_count
		) VALUES (
			'${escapeSql(runId)}',
			'completed',
			CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP,
			1,
			1,
			1,
			5
		);
		INSERT INTO indexed_workshops (
			workshop_slug,
			title,
			product,
			repo_owner,
			repo_name,
			default_branch,
			source_sha,
			exercise_count,
			has_diffs,
			last_indexed_at,
			index_run_id
		) VALUES (
			'mcp-fundamentals',
			'MCP Fundamentals',
			'Epic AI',
			'epicweb-dev',
			'mcp-fundamentals',
			'main',
			'seed-sha',
			1,
			1,
			CURRENT_TIMESTAMP,
			'${escapeSql(runId)}'
		);
		INSERT INTO indexed_exercises (
			workshop_slug,
			exercise_number,
			title,
			step_count
		) VALUES (
			'mcp-fundamentals',
			1,
			'Ping',
			1
		);
		INSERT INTO indexed_steps (
			workshop_slug,
			exercise_number,
			step_number,
			problem_dir,
			solution_dir,
			has_diff
		) VALUES (
			'mcp-fundamentals',
			1,
			1,
			'exercises/01.ping/01.problem.connect',
			'exercises/01.ping/01.solution.connect',
			1
		);
		INSERT INTO indexed_sections (
			workshop_slug,
			exercise_number,
			step_number,
			section_order,
			section_kind,
			label,
			source_path,
			content,
			char_count,
			is_diff,
			index_run_id
		) VALUES
		(
			'mcp-fundamentals',
			1,
			NULL,
			10,
			'exercise-instructions',
			'Exercise 1 instructions',
			'exercises/01.ping/README.mdx',
			'Exercise intro context for ping.',
			31,
			0,
			'${escapeSql(runId)}'
		),
		(
			'mcp-fundamentals',
			1,
			1,
			20,
			'problem-instructions',
			'Problem instructions',
			'exercises/01.ping/01.problem.connect/README.mdx',
			'Problem context for ping step one.',
			34,
			0,
			'${escapeSql(runId)}'
		),
		(
			'mcp-fundamentals',
			1,
			1,
			30,
			'solution-instructions',
			'Solution instructions',
			'exercises/01.ping/01.solution.connect/README.mdx',
			'Solution context for ping step one.',
			35,
			0,
			'${escapeSql(runId)}'
		),
		(
			'mcp-fundamentals',
			1,
			1,
			40,
			'diff-summary',
			'Diff summary',
			NULL,
			'- modified src/index.ts',
			23,
			1,
			'${escapeSql(runId)}'
		),
		(
			'mcp-fundamentals',
			1,
			1,
			50,
			'diff-hunk',
			'Diff hunk',
			'src/index.ts',
			'diff --git a/src/index.ts b/src/index.ts',
			39,
			1,
			'${escapeSql(runId)}'
		);
	`

	await runWrangler([
		'd1',
		'execute',
		'APP_DB',
		'--local',
		'--env',
		'test',
		'--persist-to',
		persistDir,
		'--command',
		insertSql,
	])
}

async function seedSecondaryIndexedWorkshopData(persistDir: string) {
	const runId = `run-${crypto.randomUUID()}`
	const insertSql = `
		INSERT INTO workshop_index_runs (
			id,
			status,
			started_at,
			completed_at,
			workshop_count,
			exercise_count,
			step_count,
			section_count
		) VALUES (
			'${escapeSql(runId)}',
			'completed',
			CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP,
			1,
			1,
			1,
			2
		);
		INSERT INTO indexed_workshops (
			workshop_slug,
			title,
			product,
			repo_owner,
			repo_name,
			default_branch,
			source_sha,
			exercise_count,
			has_diffs,
			last_indexed_at,
			index_run_id
		) VALUES (
			'advanced-typescript',
			'Advanced TypeScript',
			'Epic Web',
			'epicweb-dev',
			'advanced-typescript',
			'main',
			'seed-sha-2',
			1,
			0,
			CURRENT_TIMESTAMP,
			'${escapeSql(runId)}'
		);
		INSERT INTO indexed_exercises (
			workshop_slug,
			exercise_number,
			title,
			step_count
		) VALUES (
			'advanced-typescript',
			1,
			'Promises',
			1
		);
		INSERT INTO indexed_steps (
			workshop_slug,
			exercise_number,
			step_number,
			problem_dir,
			solution_dir,
			has_diff
		) VALUES (
			'advanced-typescript',
			1,
			1,
			'exercises/01.promises/01.problem.creation',
			'exercises/01.promises/01.solution.creation',
			0
		);
		INSERT INTO indexed_sections (
			workshop_slug,
			exercise_number,
			step_number,
			section_order,
			section_kind,
			label,
			source_path,
			content,
			char_count,
			is_diff,
			index_run_id
		) VALUES
		(
			'advanced-typescript',
			1,
			NULL,
			10,
			'exercise-instructions',
			'Exercise 1 instructions',
			'exercises/01.promises/README.mdx',
			'Promises exercise context.',
			26,
			0,
			'${escapeSql(runId)}'
		),
		(
			'advanced-typescript',
			1,
			1,
			20,
			'problem-instructions',
			'Problem instructions',
			'exercises/01.promises/01.problem.creation/README.mdx',
			'Promise creation problem context.',
			33,
			0,
			'${escapeSql(runId)}'
		);
	`

	await runWrangler([
		'd1',
		'execute',
		'APP_DB',
		'--local',
		'--env',
		'test',
		'--persist-to',
		persistDir,
		'--command',
		insertSql,
	])
}

async function applyMigrations(persistDir: string) {
	const migrationFiles = await listMigrationFiles()
	if (migrationFiles.length === 0) {
		throw new Error('No migration files found in migrations directory.')
	}

	for (const migrationFile of migrationFiles) {
		await runWrangler([
			'd1',
			'execute',
			'APP_DB',
			'--local',
			'--env',
			'test',
			'--persist-to',
			persistDir,
			'--file',
			join('migrations', migrationFile),
		])
	}
}

async function listMigrationFiles() {
	const entries = await readdir(migrationsDir, { withFileTypes: true })
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
}

function captureOutput(stream: ReadableStream<Uint8Array> | null) {
	let output = ''
	if (!stream) {
		return () => output
	}

	const reader = stream.getReader()
	const decoder = new TextDecoder()

	const read = async () => {
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				if (value) {
					output += decoder.decode(value)
				}
			}
		} catch {
			// Ignore stream errors while capturing output.
		}
	}

	void read()
	return () => output
}

function formatOutput(stdout: string, stderr: string) {
	const snippets: Array<string> = []
	if (stdout.trim()) {
		snippets.push(`stdout: ${stdout.trim().slice(-2000)}`)
	}
	if (stderr.trim()) {
		snippets.push(`stderr: ${stderr.trim().slice(-2000)}`)
	}
	return snippets.length > 0 ? ` Output:\n${snippets.join('\n')}` : ''
}

async function waitForServer(
	origin: string,
	proc: ReturnType<typeof Bun.spawn>,
	getStdout: () => string,
	getStderr: () => string,
) {
	let exited = false
	let exitCode: number | null = null
	void proc.exited
		.then((code) => {
			exited = true
			exitCode = code
		})
		.catch(() => {
			exited = true
		})

	const metadataUrl = new URL('/.well-known/oauth-protected-resource', origin)
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		if (exited) {
			throw new Error(
				`wrangler dev exited (${exitCode ?? 'unknown'}).${formatOutput(
					getStdout(),
					getStderr(),
				)}`,
			)
		}
		try {
			const response = await fetch(metadataUrl)
			if (response.ok) {
				await response.body?.cancel()
				return
			}
		} catch {
			// Retry until the server is ready.
		}
		await delay(250)
	}

	throw new Error(
		`Timed out waiting for dev server at ${origin}.${formatOutput(
			getStdout(),
			getStderr(),
		)}`,
	)
}

async function stopProcess(proc: ReturnType<typeof Bun.spawn>) {
	let exited = false
	void proc.exited.then(() => {
		exited = true
	})
	proc.kill('SIGINT')
	await Promise.race([proc.exited, delay(5_000)])
	if (!exited) {
		proc.kill('SIGKILL')
		await proc.exited
	}
}

async function startDevServer(persistDir: string) {
	const port = await getPort({ host: '127.0.0.1' })
	const origin = `http://127.0.0.1:${port}`
	const wranglerLogLevel = runWorkshopNetworkTests ? 'info' : 'error'
	const devCommand: Array<string> = [
		bunBin,
		'x',
		'wrangler',
		'dev',
		'--local',
		'--env',
		'test',
		'--port',
		String(port),
		'--ip',
		'127.0.0.1',
		'--persist-to',
		persistDir,
		'--show-interactive-dev-session=false',
		'--log-level',
		wranglerLogLevel,
	]
	if (runtimeGitHubToken) {
		devCommand.push('--var', `GITHUB_TOKEN:${runtimeGitHubToken}`)
	}
	const proc = Bun.spawn({
		cmd: devCommand,
		cwd: projectRoot,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})

	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)

	await waitForServer(origin, proc, getStdout, getStderr)

	return {
		origin,
		getCapturedOutput: () => formatOutput(getStdout(), getStderr()),
		[Symbol.asyncDispose]: async () => {
			await stopProcess(proc)
		},
	}
}

function getTextResultContent(result: CallToolResult) {
	return (
		result.content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	)
}

async function authorizeWithPassword(
	authorizationUrl: URL,
	user: { email: string; password: string },
) {
	const response = await fetch(authorizationUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		},
		body: new URLSearchParams({
			decision: 'approve',
			email: user.email,
			password: user.password,
		}),
	})
	const payload = (await response.json().catch(() => null)) as unknown

	if (!response.ok || !payload || typeof payload !== 'object') {
		throw new Error(
			`OAuth approval failed (${response.status}). ${JSON.stringify(payload)}`,
		)
	}

	const approval = payload as { ok?: unknown; redirectTo?: unknown }
	if (approval.ok !== true || typeof approval.redirectTo !== 'string') {
		throw new Error(
			`OAuth approval failed (${response.status}). ${JSON.stringify(payload)}`,
		)
	}

	const redirectUrl = new URL(approval.redirectTo)
	const code = redirectUrl.searchParams.get('code')
	if (!code) {
		throw new Error('Authorization response missing code.')
	}
	return code
}

type TestOAuthProvider = OAuthClientProvider & {
	waitForAuthorizationCode: () => Promise<string>
}

function createOAuthProvider({
	redirectUrl,
	clientMetadata,
	authorize,
}: {
	redirectUrl: URL
	clientMetadata: OAuthClientProvider['clientMetadata']
	authorize: (authorizationUrl: URL) => Promise<string>
}): TestOAuthProvider {
	let clientInformation: OAuthClientInformationMixed | undefined
	let tokens: OAuthTokens | undefined
	let codeVerifier: string | undefined
	let authorizationCode: Promise<string> | undefined

	return {
		redirectUrl,
		clientMetadata,
		clientInformation() {
			return clientInformation
		},
		saveClientInformation(nextClientInfo) {
			clientInformation = nextClientInfo
		},
		tokens() {
			return tokens
		},
		saveTokens(nextTokens) {
			tokens = nextTokens
		},
		redirectToAuthorization(authorizationUrl) {
			authorizationCode = authorize(authorizationUrl)
		},
		saveCodeVerifier(nextCodeVerifier) {
			codeVerifier = nextCodeVerifier
		},
		codeVerifier() {
			if (!codeVerifier) {
				throw new Error('No code verifier saved')
			}
			return codeVerifier
		},
		async waitForAuthorizationCode() {
			if (!authorizationCode) {
				throw new Error('Authorization flow was not started')
			}
			return authorizationCode
		},
	}
}

async function ensureAuthorized(
	serverUrl: URL,
	transport: StreamableHTTPClientTransport,
	provider: TestOAuthProvider,
) {
	const result = await auth(provider, { serverUrl })
	if (result === 'AUTHORIZED') {
		return
	}
	const authorizationCode = await provider.waitForAuthorizationCode()
	await transport.finishAuth(authorizationCode)
}

async function createMcpClient(
	origin: string,
	user: { email: string; password: string },
) {
	const redirectUrl = new URL('/oauth/callback', origin)
	const provider = createOAuthProvider({
		redirectUrl,
		clientMetadata: {
			client_name: 'mcp-e2e-client',
			redirect_uris: [redirectUrl.toString()],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'client_secret_post',
		},
		authorize: (authorizationUrl) =>
			authorizeWithPassword(authorizationUrl, user),
	})
	const serverUrl = new URL('/mcp', origin)
	const transport = new StreamableHTTPClientTransport(serverUrl, {
		authProvider: provider,
	})
	const client = new Client(
		{ name: 'mcp-e2e', version: '1.0.0' },
		{ capabilities: {} },
	)

	await ensureAuthorized(serverUrl, transport, provider)
	await client.connect(transport)

	return {
		client,
		[Symbol.asyncDispose]: async () => {
			await client.close()
		},
	}
}

test(
	'mcp server lists tools after oauth flow',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.listTools()
		const toolNames = result.tools.map((tool) => tool.name)

		expect(toolNames).toContain('do_math')
		expect(toolNames).toContain('list_workshops')
		expect(toolNames).toContain('retrieve_learning_context')
		expect(toolNames).toContain('retrieve_diff_context')
		expect(toolNames).toContain('search_topic_context')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server executes do_math tool',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'do_math',
			arguments: {
				left: 8,
				right: 4,
				operator: '+',
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)

		expect(textOutput).toContain('12')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server executes list_workshops tool with empty index',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				limit: 5,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)

		expect(textOutput).toContain('"workshops"')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp retrieval tools return seeded workshop context',
	async () => {
		await using database = await createTestDatabase()
		await seedIndexedWorkshopData(database.persistDir)
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const listResult = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				limit: 5,
			},
		})
		const listOutput = getTextResultContent(listResult as CallToolResult)
		expect(listOutput).toContain('mcp-fundamentals')
		expect(listOutput).toContain('"exerciseCount": 1')

		const learningResult = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
				maxChars: 35,
			},
		})
		const learningOutput = getTextResultContent(
			learningResult as CallToolResult,
		)
		expect(learningOutput).toContain('"truncated": true')
		expect(learningOutput).toContain('"nextCursor"')
		const parsedLearningOutput = JSON.parse(learningOutput) as {
			nextCursor?: string
		}
		expect(typeof parsedLearningOutput.nextCursor).toBe('string')

		const learningContinuation = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
				maxChars: 35,
				cursor: parsedLearningOutput.nextCursor,
			},
		})
		const continuationOutput = getTextResultContent(
			learningContinuation as CallToolResult,
		)
		const parsedContinuationOutput = JSON.parse(continuationOutput) as {
			sections: Array<{ label: string; content: string }>
			truncated: boolean
		}
		expect(parsedContinuationOutput.truncated).toBe(true)
		expect(parsedContinuationOutput.sections.length).toBeGreaterThan(0)
		expect(parsedContinuationOutput.sections[0]?.label).toBe(
			'Problem instructions',
		)
		expect(
			parsedContinuationOutput.sections[0]?.content.length,
		).toBeGreaterThan(0)

		const diffResult = await mcpClient.client.callTool({
			name: 'retrieve_diff_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
			},
		})
		const diffOutput = getTextResultContent(diffResult as CallToolResult)
		expect(diffOutput).toContain('"diffSections"')
		expect(diffOutput).toContain('diff --git a/src/index.ts b/src/index.ts')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp retrieval tools support pagination filters and random mode',
	async () => {
		await using database = await createTestDatabase()
		await seedIndexedWorkshopData(database.persistDir)
		await seedSecondaryIndexedWorkshopData(database.persistDir)
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const firstPageResult = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				limit: 1,
			},
		})
		const firstPageOutput = getTextResultContent(
			firstPageResult as CallToolResult,
		)
		const parsedFirstPage = JSON.parse(firstPageOutput) as {
			workshops: Array<{ workshop: string }>
			nextCursor?: string
		}
		expect(parsedFirstPage.workshops.length).toBe(1)
		expect(typeof parsedFirstPage.nextCursor).toBe('string')

		const secondPageResult = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				limit: 1,
				cursor: parsedFirstPage.nextCursor,
			},
		})
		const secondPageOutput = getTextResultContent(
			secondPageResult as CallToolResult,
		)
		const parsedSecondPage = JSON.parse(secondPageOutput) as {
			workshops: Array<{ workshop: string }>
		}
		expect(parsedSecondPage.workshops.length).toBe(1)
		expect(parsedSecondPage.workshops[0]?.workshop).not.toBe(
			parsedFirstPage.workshops[0]?.workshop,
		)

		const noDiffResult = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				hasDiffs: false,
			},
		})
		const noDiffOutput = getTextResultContent(noDiffResult as CallToolResult)
		expect(noDiffOutput).toContain('advanced-typescript')
		expect(noDiffOutput).not.toContain('mcp-fundamentals')

		const randomResult = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				random: true,
				maxChars: 300,
			},
		})
		const randomOutput = getTextResultContent(randomResult as CallToolResult)
		const parsedRandomOutput = JSON.parse(randomOutput) as {
			workshop: string
			exerciseNumber: number
			sections: Array<{ label: string }>
		}
		expect(['advanced-typescript', 'mcp-fundamentals']).toContain(
			parsedRandomOutput.workshop,
		)
		expect(parsedRandomOutput.exerciseNumber).toBe(1)
		expect(parsedRandomOutput.sections.length).toBeGreaterThan(0)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'retrieve_diff_context focus filter is case-insensitive and trims no-match errors',
	async () => {
		await using database = await createTestDatabase()
		await seedIndexedWorkshopData(database.persistDir)
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const focusedResult = await mcpClient.client.callTool({
			name: 'retrieve_diff_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
				focus: 'SRC/INDEX.TS',
			},
		})
		const focusedOutput = getTextResultContent(focusedResult as CallToolResult)
		const focusedPayload = JSON.parse(focusedOutput) as {
			diffSections: Array<{ sourcePath?: string; content: string }>
		}
		expect(focusedPayload.diffSections.length).toBeGreaterThan(0)
		expect(
			focusedPayload.diffSections.some((section) =>
				(section.sourcePath ?? '').toLowerCase().includes('src/index.ts'),
			),
		).toBe(true)

		const noMatchResult = await mcpClient.client.callTool({
			name: 'retrieve_diff_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
				focus: '   no-such-file   ',
			},
		})
		const noMatchOutput = getTextResultContent(noMatchResult as CallToolResult)
		expect(noMatchOutput).toContain(
			'No diff context matched focus "no-such-file" for workshop "mcp-fundamentals" exercise 1 step 1.',
		)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'manual reindex endpoint rejects malformed json payloads',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)

		const response = await fetch(
			new URL('/internal/workshop-index/reindex', server.origin),
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${testWorkshopIndexAdminToken}`,
					'Content-Type': 'application/json',
				},
				body: '{"workshops":["mcp-fundamentals"]',
			},
		)

		expect(response.status).toBe(400)
		const payload = (await response.json()) as {
			ok: boolean
			error: string
			details?: Array<string>
		}
		expect(payload).toEqual({
			ok: false,
			error: 'Invalid reindex payload.',
			details: ['Request body must be valid JSON.'],
		})
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'manual reindex endpoint rejects missing bearer tokens',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)

		const response = await fetch(
			new URL('/internal/workshop-index/reindex', server.origin),
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: '{}',
			},
		)

		expect(response.status).toBe(401)
		const payload = (await response.json()) as {
			ok: boolean
			error: string
		}
		expect(payload).toEqual({
			ok: false,
			error: 'Unauthorized',
		})
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'manual reindex endpoint rejects oversized payloads',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)

		const response = await fetch(
			new URL('/internal/workshop-index/reindex', server.origin),
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${testWorkshopIndexAdminToken}`,
					'Content-Type': 'application/json',
				},
				body: 'x'.repeat(workshopIndexRequestBodyMaxChars + 1),
			},
		)

		expect(response.status).toBe(413)
		const payload = (await response.json()) as {
			ok: boolean
			error: string
			details?: Array<string>
		}
		expect(payload).toEqual({
			ok: false,
			error: 'Reindex payload is too large.',
			details: [
				`Request body must be at most ${workshopIndexRequestBodyMaxChars} characters.`,
			],
		})
	},
	{ timeout: defaultTimeoutMs },
)

const networkTest = runWorkshopNetworkReindexTest ? test : test.skip

networkTest(
	'manual reindex endpoint rejects unknown workshop filters',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)

		const response = await fetch(
			new URL('/internal/workshop-index/reindex', server.origin),
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${testWorkshopIndexAdminToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					workshops: ['not-a-real-workshop-slug-for-test'],
				}),
			},
		)

		expect(response.status).toBe(400)
		const payload = (await response.json()) as {
			ok: boolean
			error: string
			details?: Array<string>
		}
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('Invalid reindex payload.')
		expect(payload.details).toEqual([
			'Unknown workshop filter(s): not-a-real-workshop-slug-for-test.',
		])
	},
	{ timeout: indexingTimeoutMs },
)

networkTest(
	'manual reindex endpoint normalizes and sorts unknown workshop filter errors',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)

		const response = await fetch(
			new URL('/internal/workshop-index/reindex', server.origin),
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${testWorkshopIndexAdminToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					workshops: ['Z-WORKSHOP', 'a-workshop'],
				}),
			},
		)

		expect(response.status).toBe(400)
		const payload = (await response.json()) as {
			ok: boolean
			error: string
			details?: Array<string>
		}
		expect(payload.ok).toBe(false)
		expect(payload.error).toBe('Invalid reindex payload.')
		expect(payload.details).toEqual([
			'Unknown workshop filter(s): a-workshop, z-workshop.',
		])
	},
	{ timeout: indexingTimeoutMs },
)

networkTest(
	'manual reindex endpoint indexes real workshop data for retrieval tools',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)

		const reindexResponse = await fetch(
			new URL('/internal/workshop-index/reindex', server.origin),
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${testWorkshopIndexAdminToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					workshops: ' MCP-FUNDAMENTALS,\nmcp-fundamentals ',
				}),
			},
		)
		const reindexPayload = (await reindexResponse.json()) as {
			ok: boolean
			error?: string
			workshopCount: number
			exerciseCount: number
			stepCount: number
			sectionCount: number
			sectionChunkCount: number
		}
		if (reindexResponse.status !== 200) {
			throw new Error(
				`Manual reindex failed with status ${reindexResponse.status}: ${reindexPayload.error ?? 'unknown error'}${server.getCapturedOutput()}`,
			)
		}
		expect(reindexPayload.ok).toBe(true)
		expect(reindexPayload.workshopCount).toBe(1)
		expect(reindexPayload.exerciseCount).toBeGreaterThan(0)
		expect(reindexPayload.stepCount).toBeGreaterThan(0)
		expect(reindexPayload.sectionCount).toBeGreaterThan(0)
		expect(reindexPayload.sectionChunkCount).toBeGreaterThan(0)

		await using mcpClient = await createMcpClient(server.origin, database.user)
		const listResult = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				limit: 20,
			},
		})
		const listPayload = JSON.parse(
			getTextResultContent(listResult as CallToolResult),
		) as {
			workshops: Array<{ workshop: string; exerciseCount: number }>
		}
		expect(
			listPayload.workshops.some(
				(workshop) =>
					workshop.workshop === 'mcp-fundamentals' &&
					workshop.exerciseCount > 0,
			),
		).toBe(true)

		const randomLearningContext = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				random: true,
				maxChars: 2_000,
			},
		})
		const randomPayload = JSON.parse(
			getTextResultContent(randomLearningContext as CallToolResult),
		) as {
			workshop: string
			exerciseNumber: number
			sections: Array<{ kind: string; content: string }>
		}
		expect(randomPayload.workshop).toBe('mcp-fundamentals')
		expect(randomPayload.exerciseNumber).toBeGreaterThan(0)
		expect(randomPayload.sections.length).toBeGreaterThan(0)
	},
	{ timeout: indexingTimeoutMs },
)

test(
	'search_topic_context returns clear error when vector bindings are absent',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context validates step scope requirements',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
				stepNumber: 2,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain(
			'exerciseNumber is required when stepNumber is provided for topic search.',
		)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context rejects too-short queries before vector binding checks',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: ' a ',
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Input validation error')
		expect(textOutput).toContain(
			'query must be at least 3 characters for topic search.',
		)
		expect(textOutput).not.toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context validates workshop scope before vector binding checks',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
				workshop: 'unknown-workshop',
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Unknown workshop "unknown-workshop".')
		expect(textOutput).not.toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context validates global exercise scope before vector binding checks',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
				exerciseNumber: 9,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Unknown exercise 9.')
		expect(textOutput).not.toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context validates workshop exercise scope before vector binding checks',
	async () => {
		await using database = await createTestDatabase()
		await seedIndexedWorkshopData(database.persistDir)
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
				workshop: 'mcp-fundamentals',
				exerciseNumber: 99,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain(
			'Unknown exercise 99 for workshop "mcp-fundamentals".',
		)
		expect(textOutput).not.toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context validates step scope before vector binding checks',
	async () => {
		await using database = await createTestDatabase()
		await seedIndexedWorkshopData(database.persistDir)
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 99,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain(
			'Unknown step 99 for workshop "mcp-fundamentals" exercise 1.',
		)
		expect(textOutput).not.toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context validates global step scope before vector binding checks',
	async () => {
		await using database = await createTestDatabase()
		await seedIndexedWorkshopData(database.persistDir)
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search_topic_context',
			arguments: {
				query: 'model context protocol',
				exerciseNumber: 1,
				stepNumber: 99,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Unknown step 99 for exercise 1.')
		expect(textOutput).not.toContain('Vector search is unavailable')
	},
	{ timeout: defaultTimeoutMs },
)
