import { z } from 'zod'

export const maxQuizQuestionCount = 20
export const defaultQuizQuestionCount = 8

export const retrieveQuizInstructionsInputSchema = z.object({
	topic: z.string().trim().min(1).optional(),
	learnerGoal: z.string().trim().min(1).optional(),
	questionCount: z.coerce
		.number()
		.int()
		.positive()
		.max(maxQuizQuestionCount)
		.optional(),
})

export type RetrieveQuizInstructionsInput = z.infer<
	typeof retrieveQuizInstructionsInputSchema
>

export type QuizInstructionsResult = {
	tool: 'retrieve_quiz_instructions'
	version: '1'
	topic: string | null
	learnerGoal: string | null
	targetQuestionCount: number
	instructionsMarkdown: string
	checklist: Array<string>
	questionTypes: Array<{
		id: string
		label: string
		promptTemplate: string
		whatToListenFor: Array<string>
		followUps: Array<string>
	}>
	closingSteps: Array<string>
}

function normalizeOptionalString(value: string | undefined) {
	const normalized = value?.trim()
	return normalized ? normalized : null
}

function clampQuestionCount(value: number | undefined) {
	const raw = value ?? defaultQuizQuestionCount
	return Math.min(maxQuizQuestionCount, Math.max(1, raw))
}

function buildInstructionsMarkdown({
	topic,
	learnerGoal,
	targetQuestionCount,
}: {
	topic: string | null
	learnerGoal: string | null
	targetQuestionCount: number
}) {
	const topicLabel = topic ? `Topic: ${topic}` : 'Topic: (ask the learner)'
	const goalLabel = learnerGoal
		? `Goal: ${learnerGoal}`
		: 'Goal: validate + reinforce understanding'
	const questionCountLabel = `Target: ${targetQuestionCount} questions`

	return [
		'Quiz facilitation protocol (evidence-based)',
		'',
		`${topicLabel}`,
		`${goalLabel}`,
		`${questionCountLabel}`,
		'',
		'How to run the quiz',
		'1) Confirm the scope (what is in/out) and what "good" looks like.',
		"2) Ask exactly one question at a time. Wait for the learner's full answer before continuing.",
		'3) Prefer short-answer / free-recall questions first (retrieval practice). Use multiple-choice only as a fallback.',
		'4) Require an explanation: ask "why?" or "how do you know?" to validate understanding, not just recall.',
		'5) Give feedback immediately after the attempt:',
		'   - Correct: confirm + add one nuance/edge-case.',
		"   - Partially correct: point out what's missing + ask a focused follow-up.",
		'   - Incorrect: give a small hint, then let them try again before revealing the answer.',
		'6) Adapt difficulty: easier if stuck; harder if fluent (apply, compare, debug, transfer).',
		'7) Add spaced retrieval: revisit 1-2 earlier questions near the end, especially ones they missed.',
		'8) Close by summarizing gaps and having the learner restate the corrected concepts in their own words.',
		'',
		'Helpful micro-script for each question',
		'- Q: <ask the question>',
		'- A: <wait>',
		'- Check: "What makes you say that?" / "Can you walk me through it?"',
		'- Feedback: <confirm/correct>',
		'- Follow-up: <one targeted follow-up, or move on>',
	].join('\n')
}

export function buildQuizInstructionsResult(
	input: RetrieveQuizInstructionsInput,
): QuizInstructionsResult {
	const topic = normalizeOptionalString(input.topic)
	const learnerGoal = normalizeOptionalString(input.learnerGoal)
	const targetQuestionCount = clampQuestionCount(input.questionCount)

	const questionTypes: QuizInstructionsResult['questionTypes'] = [
		{
			id: 'free-recall',
			label: 'Free recall',
			promptTemplate:
				'In your own words, what is <concept> and why does it matter?',
			whatToListenFor: [
				'accurate definition (not a synonym)',
				'key constraints/assumptions',
				'a concrete example',
			],
			followUps: [
				'What is a common misconception about it?',
				'What changes if <constraint> is different?',
			],
		},
		{
			id: 'apply-to-scenario',
			label: 'Apply to a scenario',
			promptTemplate:
				'Given <scenario>, what would you do and why? What could go wrong?',
			whatToListenFor: [
				'selects an appropriate approach',
				'explains tradeoffs',
				'identifies failure modes/edge cases',
			],
			followUps: [
				'How would you test that it works?',
				"What's the simplest alternative and when would you choose it?",
			],
		},
		{
			id: 'compare-contrast',
			label: 'Compare/contrast',
			promptTemplate:
				'Compare <A> vs <B>. When is each preferable, and what are the tradeoffs?',
			whatToListenFor: [
				'correct differences (not superficial)',
				'situational guidance ("use A when...")',
				'mentions tradeoffs and constraints',
			],
			followUps: [
				'Give a counterexample where your choice would be wrong.',
				'What happens if requirements change (scale, latency, security, etc.)?',
			],
		},
		{
			id: 'debug-explain',
			label: 'Debug/explain',
			promptTemplate:
				'Here is an outcome/bug: <symptom>. What are 2-3 plausible causes and how would you narrow it down?',
			whatToListenFor: [
				'multiple hypotheses (not just one guess)',
				'concrete checks/observations to disambiguate',
				'uses evidence to converge',
			],
			followUps: [
				'What would you log or inspect first?',
				"What's the smallest reproduction you'd try?",
			],
		},
		{
			id: 'teach-back',
			label: 'Teach-back',
			promptTemplate:
				'Teach this concept to a peer in 60 seconds. Use an analogy and one example.',
			whatToListenFor: [
				'clear mental model',
				'no missing critical steps',
				'accurate analogy (not misleading)',
			],
			followUps: [
				'What part would you expect them to misunderstand first?',
				'How would you correct that misunderstanding?',
			],
		},
	]

	const checklist: QuizInstructionsResult['checklist'] = [
		'Ask exactly one question at a time.',
		'Wait for an attempt before giving the answer (generation effect).',
		'Prefer short-answer/free-recall first; MCQ only if needed.',
		'Validate with "why/how" follow-ups; don\'t accept vibes.',
		'Give immediate, specific feedback.',
		'Re-ask missed concepts later (spaced retrieval).',
	]

	const closingSteps: QuizInstructionsResult['closingSteps'] = [
		'Ask the learner to summarize the 3 most important takeaways.',
		'List the top 1-3 misconceptions/gaps that showed up during the quiz.',
		'Create a short "next practice" set (2-3 prompts) to revisit tomorrow.',
	]

	const instructionsMarkdown = buildInstructionsMarkdown({
		topic,
		learnerGoal,
		targetQuestionCount,
	})

	return {
		tool: 'retrieve_quiz_instructions',
		version: '1',
		topic,
		learnerGoal,
		targetQuestionCount,
		instructionsMarkdown,
		checklist,
		questionTypes,
		closingSteps,
	}
}
