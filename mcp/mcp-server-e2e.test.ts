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

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationsDir = join(projectRoot, 'migrations')
const bunBin = process.execPath
const defaultTimeoutMs = 60_000

const passwordHashPrefix = 'pbkdf2_sha256'
const passwordSaltBytes = 16
const passwordHashBytes = 32
const passwordHashIterations = 100_000

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
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
		'--inspector-port',
		'0',
		'--ip',
		'127.0.0.1',
		'--persist-to',
		persistDir,
		'--show-interactive-dev-session=false',
		'--log-level',
		'error',
	]
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

function requireStructuredContent<T>(result: CallToolResult) {
	if (
		!('structuredContent' in result) ||
		result.structuredContent === undefined
	) {
		throw new Error('Expected tool result to include structuredContent')
	}
	return result.structuredContent as T
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

		expect(toolNames).toContain('list_workshops')
		expect(toolNames).toContain('retrieve_learning_context')
		expect(toolNames).toContain('retrieve_diff_context')
		expect(toolNames).toContain('search_topic_context')
		expect(toolNames).toContain('retrieve_quiz_instructions')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server returns quiz facilitation instructions',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'retrieve_quiz_instructions',
			arguments: {
				topic: 'JavaScript closures',
				questionCount: 5,
			},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Quiz facilitation protocol')
		expect(textOutput).toContain('Topic: JavaScript closures')
		expect(textOutput).toContain('Target: 5 questions')
		expect(textOutput).toContain('Ask exactly one question at a time')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp quiz instructions tool supports empty arguments',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'retrieve_quiz_instructions',
			arguments: {},
		})

		const textOutput = getTextResultContent(result as CallToolResult)
		expect(textOutput).toContain('Quiz facilitation protocol')
		expect(textOutput).toContain('Target: 8 questions')
		expect(textOutput).toContain('Ask exactly one question at a time')
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

		const payload = requireStructuredContent<{
			workshops: Array<unknown>
		}>(result as CallToolResult)
		expect(Array.isArray(payload.workshops)).toBe(true)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server exposes best practices documentation as a resource',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const resources = await mcpClient.client.listResources()
		const resourceUris = resources.resources.map((resource) => resource.uri)
		expect(resourceUris).toContain('epic://docs/mcp-server-best-practices')

		const readResult = await mcpClient.client.readResource({
			uri: 'epic://docs/mcp-server-best-practices',
		})
		const text = readResult.contents
			.map((content) => ('text' in content ? content.text : ''))
			.join('\n')
		expect(text).toContain('# MCP Server Best Practices')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server exposes workflow prompts',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const prompts = await mcpClient.client.listPrompts()
		const promptNames = prompts.prompts.map((prompt) => prompt.name)
		expect(promptNames).toContain('quiz_me')
		expect(promptNames).toContain('find_where_topic_is_taught')
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
		const listPayload = requireStructuredContent<{
			workshops: Array<{ workshop: string; exerciseCount: number }>
		}>(listResult as CallToolResult)
		expect(
			listPayload.workshops.some(
				(workshop) => workshop.workshop === 'mcp-fundamentals',
			),
		).toBe(true)
		expect(
			listPayload.workshops.some(
				(workshop) =>
					workshop.workshop === 'mcp-fundamentals' &&
					workshop.exerciseCount === 1,
			),
		).toBe(true)

		const learningResult = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
				maxChars: 35,
			},
		})
		const learningPayload = requireStructuredContent<{
			truncated: boolean
			nextCursor?: string
		}>(learningResult as CallToolResult)
		expect(learningPayload.truncated).toBe(true)
		expect(typeof learningPayload.nextCursor).toBe('string')

		const learningContinuation = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
				maxChars: 35,
				cursor: learningPayload.nextCursor,
			},
		})
		const continuationPayload = requireStructuredContent<{
			sections: Array<{ label: string; content: string }>
			truncated: boolean
		}>(learningContinuation as CallToolResult)
		expect(continuationPayload.truncated).toBe(true)
		expect(continuationPayload.sections.length).toBeGreaterThan(0)
		expect(continuationPayload.sections[0]?.label).toBe('Problem instructions')
		expect(continuationPayload.sections[0]?.content.length).toBeGreaterThan(0)

		const diffResult = await mcpClient.client.callTool({
			name: 'retrieve_diff_context',
			arguments: {
				workshop: 'mcp-fundamentals',
				exerciseNumber: 1,
				stepNumber: 1,
			},
		})
		const diffPayload = requireStructuredContent<{
			diffSections: Array<{ content: string }>
		}>(diffResult as CallToolResult)
		expect(diffPayload.diffSections.length).toBeGreaterThan(0)
		expect(
			diffPayload.diffSections.some((section) =>
				section.content.includes('diff --git a/src/index.ts b/src/index.ts'),
			),
		).toBe(true)
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
				all: false,
				limit: 1,
			},
		})
		const parsedFirstPage = requireStructuredContent<{
			workshops: Array<{ workshop: string }>
			nextCursor?: string
		}>(firstPageResult as CallToolResult)
		expect(parsedFirstPage.workshops.length).toBe(1)
		expect(typeof parsedFirstPage.nextCursor).toBe('string')

		const secondPageResult = await mcpClient.client.callTool({
			name: 'list_workshops',
			arguments: {
				all: false,
				limit: 1,
				cursor: parsedFirstPage.nextCursor,
			},
		})
		const parsedSecondPage = requireStructuredContent<{
			workshops: Array<{ workshop: string }>
		}>(secondPageResult as CallToolResult)
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
		const noDiffPayload = requireStructuredContent<{
			workshops: Array<{ workshop: string }>
		}>(noDiffResult as CallToolResult)
		expect(
			noDiffPayload.workshops.some(
				(workshop) => workshop.workshop === 'advanced-typescript',
			),
		).toBe(true)
		expect(
			noDiffPayload.workshops.some(
				(workshop) => workshop.workshop === 'mcp-fundamentals',
			),
		).toBe(false)

		const randomResult = await mcpClient.client.callTool({
			name: 'retrieve_learning_context',
			arguments: {
				random: true,
				maxChars: 300,
			},
		})
		const parsedRandomOutput = requireStructuredContent<{
			workshop: string
			exerciseNumber: number
			sections: Array<{ label: string }>
		}>(randomResult as CallToolResult)
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
		const focusedPayload = requireStructuredContent<{
			diffSections: Array<{ sourcePath?: string; content: string }>
		}>(focusedResult as CallToolResult)
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
	'manual reindex endpoint is not available',
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

		expect(response.status).toBe(404)
		const payload = (await response.json()) as {
			ok: boolean
			error: string
		}
		expect(payload).toEqual({
			ok: false,
			error: 'Not Found',
		})
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'search_topic_context falls back when vector bindings are absent',
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

		const payload = requireStructuredContent<{
			mode?: string
			vectorSearchAvailable?: boolean
			warnings?: Array<string>
			matches?: Array<unknown>
		}>(result as CallToolResult)
		expect(payload.mode).toBe('keyword')
		expect(payload.vectorSearchAvailable).toBe(false)
		expect(Array.isArray(payload.warnings)).toBe(true)
		expect(Array.isArray(payload.matches)).toBe(true)
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
