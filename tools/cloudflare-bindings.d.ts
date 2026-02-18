declare global {
	type D1Meta = Record<string, unknown> & {
		duration: number
		changes: number
	}

	type D1Result<T = unknown> = {
		success: true
		results: Array<T>
		meta: D1Meta
	}

	type D1ExecResult = {
		count: number
		duration: number
	}

	interface D1PreparedStatement {
		bind(...values: Array<unknown>): D1PreparedStatement
		first<T = Record<string, unknown>>(colName: string): Promise<T | null>
		first<T = Record<string, unknown>>(): Promise<T | null>
		run<T = Record<string, unknown>>(): Promise<D1Result<T>>
		all<T = Record<string, unknown>>(): Promise<D1Result<T>>
		raw<T = Array<unknown>>(options: {
			columnNames: true
		}): Promise<[string[], ...Array<T>]>
		raw<T = Array<unknown>>(options?: {
			columnNames?: false
		}): Promise<Array<T>>
	}

	interface D1Database {
		prepare(query: string): D1PreparedStatement
		batch<T = unknown>(
			statements: Array<D1PreparedStatement>,
		): Promise<Array<D1Result<T>>>
		exec(query: string): Promise<D1ExecResult>
	}

	type VectorizeVectorMetadataValue = string | number | boolean | string[]
	type VectorizeVectorMetadata =
		| VectorizeVectorMetadataValue
		| Record<string, VectorizeVectorMetadataValue>

	type VectorizeVector = {
		id: string
		values: Array<number>
		metadata?: Record<string, VectorizeVectorMetadata>
	}

	type VectorizeAsyncMutation = Record<string, unknown>

	interface Vectorize {
		upsert(vectors: Array<VectorizeVector>): Promise<VectorizeAsyncMutation>
		deleteByIds(ids: Array<string>): Promise<VectorizeAsyncMutation>
	}

	interface Ai {
		run(modelName: string, input: unknown): Promise<unknown>
	}

	interface Env {
		APP_DB: D1Database
		GITHUB_TOKEN?: string
		WORKSHOP_VECTOR_INDEX?: Vectorize
		AI?: Ai
		WORKSHOP_CONTEXT_DEFAULT_MAX_CHARS?: number
		WORKSHOP_CONTEXT_HARD_MAX_CHARS?: number
		WORKSHOP_INDEX_ADMIN_TOKEN?: string
		WORKSHOP_INDEX_ALLOW_REMOTE_REINDEX?: string
	}
}

export {}
