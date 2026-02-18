import { randomBytes } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type CliOptions = {
	env?: string
	name?: string
	config?: string
	dotenvPaths: Array<string>
	setPairs: Array<string>
	setFromEnv: Array<string>
	setFromEnvOptional: Array<string>
	generateCookieSecret: boolean
	includeEmpty: boolean
	emptyAsSpace: boolean
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function readFlagValue(
	argv: Array<string>,
	index: number,
	flag: string,
	label: string,
	options: { allowEmpty?: boolean } = {},
) {
	const value = argv[index + 1]
	if (value === undefined) {
		fail(`Missing value for ${flag} ${label}`)
	}
	if (!options.allowEmpty && value.trim().length === 0) {
		fail(`Missing value for ${flag} ${label}`)
	}
	// When users forget the value, the next flag often gets consumed.
	if (value.startsWith('-') && value !== '-') {
		fail(`Missing value for ${flag} ${label}`)
	}
	return value
}

function parseArgs(argv: Array<string>): CliOptions {
	const options: CliOptions = {
		env: undefined,
		dotenvPaths: [],
		setPairs: [],
		setFromEnv: [],
		setFromEnvOptional: [],
		generateCookieSecret: false,
		includeEmpty: false,
		emptyAsSpace: false,
	}

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		switch (arg) {
			case '--env': {
				options.env = readFlagValue(argv, index, '--env', '<environment>', {
					allowEmpty: true,
				})
				index += 1
				break
			}
			case '--name': {
				options.name = readFlagValue(argv, index, '--name', '<worker-name>')
				index += 1
				break
			}
			case '--config': {
				options.config = readFlagValue(argv, index, '--config', '<path>')
				index += 1
				break
			}
			case '--from-dotenv': {
				const path = readFlagValue(argv, index, '--from-dotenv', '<path>')
				options.dotenvPaths.push(path)
				index += 1
				break
			}
			case '--set': {
				const pair = readFlagValue(argv, index, '--set', '<KEY=VALUE>')
				options.setPairs.push(pair)
				index += 1
				break
			}
			case '--set-from-env': {
				const key = readFlagValue(argv, index, '--set-from-env', '<KEY>')
				options.setFromEnv.push(key)
				index += 1
				break
			}
			case '--set-from-env-optional': {
				const key = readFlagValue(
					argv,
					index,
					'--set-from-env-optional',
					'<KEY>',
				)
				options.setFromEnvOptional.push(key)
				index += 1
				break
			}
			case '--generate-cookie-secret': {
				options.generateCookieSecret = true
				break
			}
			case '--include-empty': {
				options.includeEmpty = true
				break
			}
			case '--empty-as-space': {
				options.emptyAsSpace = true
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

function stripQuotes(value: string) {
	const trimmed = value.trim()
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

function parseDotenv(content: string) {
	const result = new Map<string, string>()
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line) continue
		if (line.startsWith('#')) continue
		const withoutExport = line.startsWith('export ') ? line.slice(7) : line
		const equalsIndex = withoutExport.indexOf('=')
		if (equalsIndex <= 0) continue
		const key = withoutExport.slice(0, equalsIndex).trim()
		const rawRhs = withoutExport.slice(equalsIndex + 1).trim()
		let value = rawRhs
		const firstChar = rawRhs[0]
		if (firstChar === '"' || firstChar === "'") {
			// Support `KEY="value" # comment` by scanning for the closing quote.
			const quote = firstChar
			let endIndex = -1
			let escaped = false
			for (let i = 1; i < rawRhs.length; i += 1) {
				const char = rawRhs[i]
				if (quote === '"' && !escaped && char === '\\') {
					escaped = true
					continue
				}
				if (!escaped && char === quote) {
					endIndex = i
					break
				}
				escaped = false
			}
			value =
				endIndex >= 0
					? stripQuotes(rawRhs.slice(0, endIndex + 1))
					: stripQuotes(rawRhs)
		} else {
			// Strip inline comments like `KEY=value # comment` (but keep `foo#bar`).
			const inlineCommentIndex = rawRhs.search(/\s#/)
			value = stripQuotes(
				inlineCommentIndex >= 0
					? rawRhs.slice(0, inlineCommentIndex).trimEnd()
					: rawRhs,
			)
		}
		if (!key) continue
		result.set(key, value)
	}
	return result
}

function parseSetPair(pair: string) {
	const equalsIndex = pair.indexOf('=')
	if (equalsIndex <= 0) {
		fail(`Invalid --set value (expected KEY=VALUE): ${pair}`)
	}
	const key = pair.slice(0, equalsIndex).trim()
	const value = pair.slice(equalsIndex + 1)
	if (!key) {
		fail(`Invalid --set value (empty key): ${pair}`)
	}
	return { key, value }
}

function generateHexSecret(bytes: number) {
	return randomBytes(bytes).toString('hex')
}

async function buildSecrets(options: CliOptions) {
	const secrets = new Map<string, string>()

	for (const path of options.dotenvPaths) {
		const content = await readFile(path, 'utf8')
		for (const [key, value] of parseDotenv(content)) {
			secrets.set(key, value)
		}
	}

	for (const key of options.setFromEnv) {
		const value = process.env[key]
		if (typeof value !== 'string' || value.length === 0) {
			fail(`Missing required environment variable: ${key}`)
		}
		secrets.set(key, value)
	}

	for (const key of options.setFromEnvOptional) {
		const value = process.env[key]
		if (typeof value === 'string' && value.length > 0) {
			secrets.set(key, value)
		}
	}

	for (const pair of options.setPairs) {
		const { key, value } = parseSetPair(pair)
		secrets.set(key, value)
	}

	if (options.generateCookieSecret) {
		const cookieSecret = generateHexSecret(32)
		// GitHub Actions log masking (no-op elsewhere).
		console.log(`::add-mask::${cookieSecret}`)
		secrets.set('COOKIE_SECRET', cookieSecret)
	}

	if (!options.includeEmpty) {
		for (const [key, value] of secrets) {
			if (value.length === 0) {
				secrets.delete(key)
			}
		}
	} else if (options.emptyAsSpace) {
		for (const [key, value] of secrets) {
			if (value.length === 0) {
				secrets.set(key, ' ')
			}
		}
	}

	return secrets
}

function toDotenv(secrets: ReadonlyMap<string, string>) {
	const lines = Array.from(secrets.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`)
	return `${lines.join('\n')}\n`
}

async function runWranglerSecretBulk(options: CliOptions, dotenvText: string) {
	const bunBin = process.execPath
	const args = [bunBin, 'x', 'wrangler', 'secret', 'bulk']
	const secretsFilePath = join(
		tmpdir(),
		`wrangler-secrets-${Date.now()}-${randomBytes(6).toString('hex')}.env`,
	)
	await writeFile(secretsFilePath, dotenvText, {
		encoding: 'utf8',
		mode: 0o600,
	})
	args.push(secretsFilePath)
	if (options.env !== undefined) {
		args.push('--env', options.env)
	}
	if (options.name) {
		args.push('--name', options.name)
	}
	if (options.config) {
		args.push('--config', options.config)
	}

	try {
		const proc = Bun.spawn({
			cmd: args,
			stdio: ['ignore', 'inherit', 'inherit'],
			env: process.env,
		})
		const exitCode = await proc.exited
		if (exitCode !== 0) {
			process.exit(exitCode)
		}
	} finally {
		await unlink(secretsFilePath).catch(() => {})
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const secrets = await buildSecrets(options)
	if (secrets.size === 0) {
		fail('No secrets to sync (empty input).')
	}
	const dotenvText = toDotenv(secrets)
	await runWranglerSecretBulk(options, dotenvText)
	const envLabel =
		options.env && options.env.length > 0 ? options.env : 'default'
	console.log(
		`Synced ${secrets.size} secret(s) via bulk upload (${envLabel}${options.name ? `, ${options.name}` : ''}).`,
	)
}

await main()
