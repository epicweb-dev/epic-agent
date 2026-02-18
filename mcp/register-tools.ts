import { type MCP } from './index.ts'
import { registerListWorkshopsTool } from './tools/list-workshops.ts'
import { registerRetrieveDiffContextTool } from './tools/retrieve-diff-context.ts'
import { registerRetrieveLearningContextTool } from './tools/retrieve-learning-context.ts'
import { registerRetrieveQuizInstructionsTool } from './tools/retrieve-quiz-instructions.ts'
import { registerSearchTopicContextTool } from './tools/search-topic-context.ts'

export async function registerTools(agent: MCP) {
	registerListWorkshopsTool(agent)
	registerRetrieveLearningContextTool(agent)
	registerRetrieveDiffContextTool(agent)
	registerSearchTopicContextTool(agent)
	registerRetrieveQuizInstructionsTool(agent)
}
