import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { registerPrompts } from './prompts.ts'
import { registerResources } from './resources.ts'
import { registerTools } from './tools.ts'
import { serverMetadata } from './metadata.ts'

export type State = {}
export type Props = {
	baseUrl: string
}
export class MCP extends McpAgent<Env, State, Props> {
	server = new McpServer(
		{
			name: serverMetadata.name,
			version: serverMetadata.version,
		},
		{
			instructions: serverMetadata.instructions,
		},
	)
	async init() {
		await registerTools(this)
		registerResources(this)
		registerPrompts(this)
	}
	requireDomain() {
		const baseUrl = this.props?.baseUrl
		invariant(
			baseUrl,
			'This should never happen, but somehow we did not get the baseUrl from the request handler',
		)
		return baseUrl
	}
	requireEnv() {
		return this.env
	}
}
