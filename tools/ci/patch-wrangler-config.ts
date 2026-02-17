import { readFile, writeFile } from 'node:fs/promises'
import { stripJsonc } from '../strip-jsonc.ts'

type CliOptions = {
	input?: string
	output?: string
	env?: string
	d1Binding?: string
	d1DatabaseName?: string
	d1DatabaseId?: string
	kvBinding?: string
	kvNamespaceId?: string
	kvPreviewId?: string
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function parseArgs(argv: Array<string>): CliOptions {
	const options: CliOptions = {}
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue

		switch (arg) {
			case '--input': {
				options.input = argv[index + 1]
				index += 1
				break
			}
			case '--output': {
				options.output = argv[index + 1]
				index += 1
				break
			}
			case '--env': {
				options.env = argv[index + 1]
				index += 1
				break
			}
			case '--d1-binding': {
				options.d1Binding = argv[index + 1]
				index += 1
				break
			}
			case '--d1-database-name': {
				options.d1DatabaseName = argv[index + 1]
				index += 1
				break
			}
			case '--d1-database-id': {
				options.d1DatabaseId = argv[index + 1]
				index += 1
				break
			}
			case '--kv-binding': {
				options.kvBinding = argv[index + 1]
				index += 1
				break
			}
			case '--kv-namespace-id': {
				options.kvNamespaceId = argv[index + 1]
				index += 1
				break
			}
			case '--kv-preview-id': {
				options.kvPreviewId = argv[index + 1]
				index += 1
				break
			}
			default: {
				if (arg.startsWith('-')) {
					fail(`Unknown flag: ${arg}`)
				}
			}
		}
	}
	return options
}

function assertString(value: unknown, label: string) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(`Missing ${label}.`)
	}
	return value
}

function patchD1Database(
	config: Record<string, unknown>,
	options: {
		envName: string
		binding: string
		databaseName: string
		databaseId: string
	},
) {
	const env = config.env
	if (!env || typeof env !== 'object') {
		fail('Invalid Wrangler config: missing env object.')
	}
	const envConfig = (env as Record<string, unknown>)[options.envName]
	if (!envConfig || typeof envConfig !== 'object') {
		fail(`Invalid Wrangler config: missing env.${options.envName} object.`)
	}
	const d1Databases = (envConfig as Record<string, unknown>).d1_databases
	if (!Array.isArray(d1Databases)) {
		fail(
			`Invalid Wrangler config: env.${options.envName}.d1_databases is missing.`,
		)
	}
	const entry = d1Databases.find(
		(value) =>
			value &&
			typeof value === 'object' &&
			(value as Record<string, unknown>).binding === options.binding,
	) as Record<string, unknown> | undefined
	if (!entry) {
		fail(
			`Invalid Wrangler config: no D1 binding "${options.binding}" in env.${options.envName}.d1_databases.`,
		)
	}
	entry.database_name = options.databaseName
	entry.database_id = options.databaseId
}

function patchKvNamespace(
	config: Record<string, unknown>,
	options: {
		envName: string
		binding: string
		namespaceId: string
		previewId: string
	},
) {
	const env = config.env
	if (!env || typeof env !== 'object') {
		fail('Invalid Wrangler config: missing env object.')
	}
	const envConfig = (env as Record<string, unknown>)[options.envName]
	if (!envConfig || typeof envConfig !== 'object') {
		fail(`Invalid Wrangler config: missing env.${options.envName} object.`)
	}
	const kvNamespaces = (envConfig as Record<string, unknown>).kv_namespaces
	if (!Array.isArray(kvNamespaces)) {
		fail(
			`Invalid Wrangler config: env.${options.envName}.kv_namespaces is missing.`,
		)
	}
	const entry = kvNamespaces.find(
		(value) =>
			value &&
			typeof value === 'object' &&
			(value as Record<string, unknown>).binding === options.binding,
	) as Record<string, unknown> | undefined
	if (!entry) {
		fail(
			`Invalid Wrangler config: no KV binding "${options.binding}" in env.${options.envName}.kv_namespaces.`,
		)
	}
	entry.id = options.namespaceId
	entry.preview_id = options.previewId
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const inputPath = assertString(options.input, '--input <path>')
	const outputPath = assertString(options.output, '--output <path>')
	const envName = assertString(options.env, '--env <name>')

	const content = await readFile(inputPath, 'utf8')
	const parsed = JSON.parse(stripJsonc(content)) as Record<string, unknown>

	const d1Binding = options.d1Binding?.trim() ?? ''
	const d1DatabaseName = options.d1DatabaseName?.trim() ?? ''
	const d1DatabaseId = options.d1DatabaseId?.trim() ?? ''
	if (d1Binding && (d1DatabaseName || d1DatabaseId)) {
		patchD1Database(parsed, {
			envName,
			binding: d1Binding,
			databaseName: assertString(d1DatabaseName, '--d1-database-name <name>'),
			databaseId: assertString(d1DatabaseId, '--d1-database-id <uuid>'),
		})
	}

	const kvBinding = options.kvBinding?.trim() ?? ''
	const kvNamespaceId = options.kvNamespaceId?.trim() ?? ''
	const kvPreviewId = (options.kvPreviewId?.trim() || kvNamespaceId).trim()
	if (kvBinding && kvNamespaceId) {
		patchKvNamespace(parsed, {
			envName,
			binding: kvBinding,
			namespaceId: kvNamespaceId,
			previewId: kvPreviewId,
		})
	} else if (kvBinding || kvNamespaceId) {
		fail('KV patch requires --kv-binding and --kv-namespace-id.')
	}

	await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
	console.log(outputPath)
}

await main()
