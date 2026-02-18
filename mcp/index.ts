import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { registerTools } from './tools.ts'

export type State = {}
export type Props = {
	baseUrl: string
}
export class MCP extends McpAgent<Env, State, Props> {
	server = new McpServer(
		{
			name: 'MCP',
			version: '1.0.0',
		},
		{
			instructions:
				'Use this server to retrieve indexed Epic Workshop context for quiz authoring. If a learner asks to be quizzed or wants to solidify understanding, call retrieve_quiz_instructions and follow the protocol (one question at a time).',
		},
	)
	async init() {
		await registerTools(this)
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
