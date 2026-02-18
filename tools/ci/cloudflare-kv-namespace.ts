type CloudflareApiError = {
	code?: number
	message?: string
}

type CloudflareApiEnvelope<T> = {
	success: boolean
	result?: T
	errors?: Array<CloudflareApiError>
	messages?: Array<unknown>
	result_info?: {
		page?: number
		per_page?: number
		count?: number
		total_count?: number
	}
}

type KvNamespace = {
	id: string
	title: string
}

type Action = 'lookup' | 'ensure' | 'delete'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function requireEnv(name: string) {
	const value = process.env[name]
	if (typeof value !== 'string' || value.length === 0) {
		fail(`Missing required environment variable: ${name}`)
	}
	return value
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

function parseArgs(argv: Array<string>) {
	const action = (argv[0] ?? '').trim() as Action
	if (!action || !['lookup', 'ensure', 'delete'].includes(action)) {
		fail(
			'Usage: cloudflare-kv-namespace.ts <lookup|ensure|delete> --title <name>',
		)
	}

	let title = ''
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		if (arg === '--title') {
			const value = argv[index + 1]
			if (value === undefined || value.startsWith('-')) {
				fail('Missing value for --title <namespace-title>')
			}
			title = value.trim()
			index += 1
			continue
		}
		if (arg.startsWith('-')) {
			fail(`Unknown flag: ${arg}`)
		}
	}

	if (!title) {
		fail('Missing --title <namespace-title>')
	}

	return { action, title }
}

async function cloudflareFetchEnvelope<T>({
	apiToken,
	path,
	method = 'GET',
	body,
}: {
	apiToken: string
	path: string
	method?: string
	body?: unknown
}): Promise<CloudflareApiEnvelope<T>> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	})

	const json = (await response
		.json()
		.catch(() => null)) as CloudflareApiEnvelope<T> | null

	if (!response.ok || !json) {
		const message = json?.errors?.length
			? formatCloudflareErrors(json.errors)
			: `HTTP ${response.status}`
		fail(`Cloudflare API request failed: ${message}`)
	}

	if (!json.success) {
		fail(
			`Cloudflare API request failed: ${formatCloudflareErrors(json.errors)}`,
		)
	}

	return json
}

async function listNamespacesByPage({
	apiToken,
	accountId,
	perPage,
	page,
}: {
	apiToken: string
	accountId: string
	perPage: number
	page: number
}) {
	const params = new URLSearchParams({
		per_page: String(perPage),
		page: String(page),
	})
	const envelope = await cloudflareFetchEnvelope<Array<KvNamespace>>({
		apiToken,
		path: `/accounts/${accountId}/storage/kv/namespaces?${params.toString()}`,
	})
	const list = Array.isArray(envelope.result) ? envelope.result : []
	return list.map((entry) => ({
		id: String(entry.id),
		title: String(entry.title),
	}))
}

async function resolveNamespaceIdByTitle({
	apiToken,
	accountId,
	title,
}: {
	apiToken: string
	accountId: string
	title: string
}) {
	const perPage = 1000
	for (let page = 1; page <= 1_000; page += 1) {
		const list = await listNamespacesByPage({
			apiToken,
			accountId,
			perPage,
			page,
		})
		const match = list.find((entry) => entry.title === title)
		if (match) return match.id
		if (list.length < perPage) return null
	}
	fail('Exceeded maximum KV namespace pages while searching for a match.')
}

async function createNamespace({
	apiToken,
	accountId,
	title,
}: {
	apiToken: string
	accountId: string
	title: string
}) {
	const envelope = await cloudflareFetchEnvelope<KvNamespace>({
		apiToken,
		path: `/accounts/${accountId}/storage/kv/namespaces`,
		method: 'POST',
		body: { title },
	})
	const result = envelope.result
	const id = result?.id?.trim()
	if (!id) {
		fail(
			`Cloudflare KV create succeeded but no id was returned for "${title}".`,
		)
	}
	return id
}

async function deleteNamespace({
	apiToken,
	accountId,
	id,
}: {
	apiToken: string
	accountId: string
	id: string
}) {
	await cloudflareFetchEnvelope<Record<string, unknown>>({
		apiToken,
		path: `/accounts/${accountId}/storage/kv/namespaces/${id}`,
		method: 'DELETE',
	})
}

async function main() {
	const { action, title } = parseArgs(process.argv.slice(2))
	const apiToken = requireEnv('CLOUDFLARE_API_TOKEN')
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID')

	if (action === 'lookup') {
		const id = await resolveNamespaceIdByTitle({ apiToken, accountId, title })
		if (id) {
			console.log(id)
		}
		return
	}

	if (action === 'ensure') {
		const existing = await resolveNamespaceIdByTitle({
			apiToken,
			accountId,
			title,
		})
		if (existing) {
			console.log(existing)
			return
		}
		const created = await createNamespace({ apiToken, accountId, title })
		console.log(created)
		return
	}

	const existing = await resolveNamespaceIdByTitle({
		apiToken,
		accountId,
		title,
	})
	if (!existing) {
		console.log(`KV namespace "${title}" already deleted.`)
		return
	}
	await deleteNamespace({ apiToken, accountId, id: existing })
	console.log(`Deleted KV namespace "${title}".`)
}

await main()
