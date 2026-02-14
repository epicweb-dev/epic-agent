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
	const proc = Bun.spawn({
		cmd: [
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
			'error',
		],
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
		[Symbol.asyncDispose]: async () => {
			await stopProcess(proc)
		},
	}
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

		const textOutput =
			(result as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''

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

		const textOutput =
			(result as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''

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
		const listOutput =
			(listResult as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
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
		const learningOutput =
			(learningResult as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
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
		const continuationOutput =
			(learningContinuation as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
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
		const diffOutput =
			(diffResult as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
		expect(diffOutput).toContain('"diffSections"')
		expect(diffOutput).toContain('diff --git a/src/index.ts b/src/index.ts')
	},
	{ timeout: defaultTimeoutMs },
)
