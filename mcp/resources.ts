import type { MCP } from './index.ts'
import { mcpServerBestPracticesMarkdown } from './mcp-server-best-practices.ts'
import { resourcesMetadata, serverMetadata, toolsMetadata } from './metadata.ts'

function buildServerInfoMarkdown() {
	const toolLines = Object.entries(toolsMetadata)
		.map(([name, tool]) => `- \`${name}\` — ${tool.title}`)
		.join('\n')

	return [
		`# ${resourcesMetadata.server.title}`,
		'',
		`Version: \`${serverMetadata.version}\``,
		'',
		'## Tools',
		toolLines,
		'',
		'## Docs',
		`- \`${resourcesMetadata.mcp_server_best_practices.uri}\` — ${resourcesMetadata.mcp_server_best_practices.title}`,
		'',
		'## Quick start',
		'- Call `list_workshops` first, then pick a `workshop` slug.',
		'- Use `retrieve_learning_context` / `retrieve_diff_context` for scoped context.',
		'- Use `search_topic_context` to locate where something is taught.',
	].join('\n')
}

export function registerResources(agent: MCP) {
	agent.server.registerResource(
		resourcesMetadata.server.name,
		resourcesMetadata.server.uri,
		{
			title: resourcesMetadata.server.title,
			description: resourcesMetadata.server.description,
			mimeType: resourcesMetadata.server.mimeType,
		},
		async (uri) => {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: resourcesMetadata.server.mimeType,
						text: buildServerInfoMarkdown(),
					},
				],
			}
		},
	)

	agent.server.registerResource(
		resourcesMetadata.mcp_server_best_practices.name,
		resourcesMetadata.mcp_server_best_practices.uri,
		{
			title: resourcesMetadata.mcp_server_best_practices.title,
			description: resourcesMetadata.mcp_server_best_practices.description,
			mimeType: resourcesMetadata.mcp_server_best_practices.mimeType,
		},
		async (uri) => {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: resourcesMetadata.mcp_server_best_practices.mimeType,
						text: mcpServerBestPracticesMarkdown,
					},
				],
			}
		},
	)
}
