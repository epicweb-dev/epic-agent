import {
	type IndexedExerciseWrite,
	type IndexedSectionChunkWrite,
	type IndexedSectionWrite,
	type IndexedStepWrite,
} from '../mcp/workshop-data.ts'
import {
	type RepoIndexResult,
	workshopIndexerTestUtils,
} from '../mcp/workshop-indexer.ts'

const maxStoredSectionChars = 20_000

function toSectionContent(content: string) {
	if (content.length <= maxStoredSectionChars) return content
	return `${content.slice(0, maxStoredSectionChars)}\n\n[truncated for storage]`
}

function cleanTitle(value: string | undefined, fallback: string) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : fallback
}

type EpicshopContextTranscript = {
	embed?: string
	transcript?: string
	status?: string
}

type EpicshopContextStep = {
	stepNumber: number
	title: string
	problem?: {
		instructions?: string
		transcripts?: Array<EpicshopContextTranscript>
	}
	solution?: {
		instructions?: string
		transcripts?: Array<EpicshopContextTranscript>
	}
	diff?: string | null
}

type EpicshopContextExercise = {
	exerciseNumber: number
	title: string
	instructions?: { content?: string }
	finishedInstructions?: { content?: string }
	steps: Array<EpicshopContextStep>
}

type EpicshopContext = {
	workshop?: { title?: string; subtitle?: string }
	instructions?: { content?: string }
	finishedInstructions?: { content?: string }
	exercises?: Array<EpicshopContextExercise>
}

type PackageMetadata = {
	epicshop?: {
		title?: string
		product?: {
			displayNameShort?: string
			host?: string
			slug?: string
		}
	}
}

type RepoMetadata = {
	owner: string
	name: string
	defaultBranch: string
	sourceSha: string
}

function formatTranscriptSection(
	transcript: EpicshopContextTranscript,
): string {
	const embed = transcript.embed?.trim()
	const text = transcript.transcript?.trim()
	const status = transcript.status?.trim()
	if (text && text !== 'Transcripts not available') {
		return text
	}
	const parts: Array<string> = []
	if (embed) parts.push(`Embed: ${embed}`)
	if (status) parts.push(`Status: ${status}`)
	return parts.length > 0 ? parts.join('; ') : '(no transcript)'
}

export function parseEpicshopContextToRepoIndexResult({
	context,
	packageMetadata,
	repo,
}: {
	context: EpicshopContext
	packageMetadata: PackageMetadata
	repo: RepoMetadata
}): RepoIndexResult {
	const workshopSlug = repo.name
	const title = cleanTitle(
		context.workshop?.title ?? packageMetadata?.epicshop?.title,
		repo.name,
	)
	const product = cleanTitle(
		packageMetadata?.epicshop?.product?.displayNameShort ??
			packageMetadata?.epicshop?.product?.host ??
			packageMetadata?.epicshop?.product?.slug,
		'',
	)

	const exercises: Array<IndexedExerciseWrite> = []
	const steps: Array<IndexedStepWrite> = []
	const sections: Array<IndexedSectionWrite> = []
	const sectionChunks: Array<IndexedSectionChunkWrite> = []
	let hasDiffs = false
	let sectionOrder = 10

	if (context.instructions?.content) {
		sections.push({
			sectionOrder: sectionOrder++,
			sectionKind: 'workshop-instructions',
			label: 'Workshop instructions',
			sourcePath: 'exercises/README.mdx',
			content: toSectionContent(context.instructions.content),
		})
	}
	if (context.finishedInstructions?.content) {
		sections.push({
			sectionOrder: sectionOrder++,
			sectionKind: 'workshop-finished',
			label: 'Workshop finished notes',
			sourcePath: 'exercises/FINISHED.mdx',
			content: toSectionContent(context.finishedInstructions.content),
		})
	}

	const exerciseList = context.exercises ?? []
	for (const exercise of exerciseList) {
		exercises.push({
			exerciseNumber: exercise.exerciseNumber,
			title: exercise.title,
			stepCount: exercise.steps.length,
		})

		if (exercise.instructions?.content) {
			sections.push({
				exerciseNumber: exercise.exerciseNumber,
				sectionOrder: sectionOrder++,
				sectionKind: 'exercise-instructions',
				label: `Exercise ${exercise.exerciseNumber} instructions`,
				content: toSectionContent(exercise.instructions.content),
			})
		}
		if (exercise.finishedInstructions?.content) {
			sections.push({
				exerciseNumber: exercise.exerciseNumber,
				sectionOrder: sectionOrder++,
				sectionKind: 'exercise-finished',
				label: `Exercise ${exercise.exerciseNumber} finished notes`,
				content: toSectionContent(exercise.finishedInstructions.content),
			})
		}

		for (const step of exercise.steps) {
			const stepHasDiff = Boolean(step.diff && step.diff.trim().length > 0)
			if (stepHasDiff) hasDiffs = true

			steps.push({
				exerciseNumber: exercise.exerciseNumber,
				stepNumber: step.stepNumber,
				hasDiff: stepHasDiff,
			})

			if (step.problem?.instructions) {
				sections.push({
					exerciseNumber: exercise.exerciseNumber,
					stepNumber: step.stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'problem-readme',
					label: `Problem: ${step.title}`,
					content: toSectionContent(step.problem.instructions),
				})
			}
			const problemTranscripts = step.problem?.transcripts ?? []
			for (const [idx, t] of problemTranscripts.entries()) {
				const content = formatTranscriptSection(t)
				sections.push({
					exerciseNumber: exercise.exerciseNumber,
					stepNumber: step.stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'problem-transcript',
					label: `Problem transcript ${idx + 1}`,
					content: toSectionContent(content),
				})
			}

			if (step.solution?.instructions) {
				sections.push({
					exerciseNumber: exercise.exerciseNumber,
					stepNumber: step.stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'solution-readme',
					label: `Solution: ${step.title}`,
					content: toSectionContent(step.solution.instructions),
				})
			}
			const solutionTranscripts = step.solution?.transcripts ?? []
			for (const [idx, t] of solutionTranscripts.entries()) {
				const content = formatTranscriptSection(t)
				sections.push({
					exerciseNumber: exercise.exerciseNumber,
					stepNumber: step.stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'solution-transcript',
					label: `Solution transcript ${idx + 1}`,
					content: toSectionContent(content),
				})
			}

			if (stepHasDiff && step.diff) {
				sections.push({
					exerciseNumber: exercise.exerciseNumber,
					stepNumber: step.stepNumber,
					sectionOrder: sectionOrder++,
					sectionKind: 'diff-hunk',
					label: `Diff for exercise ${exercise.exerciseNumber} step ${step.stepNumber}`,
					content: toSectionContent(step.diff),
					isDiff: true,
				})
			}
		}
	}

	for (const section of sections) {
		const chunks = workshopIndexerTestUtils.splitIntoChunks({
			content: section.content,
		})
		for (const chunk of chunks) {
			sectionChunks.push({
				exerciseNumber: section.exerciseNumber,
				stepNumber: section.stepNumber,
				sectionOrder: section.sectionOrder,
				chunkIndex: chunk.chunkIndex,
				content: chunk.content,
			})
		}
	}

	return {
		workshop: {
			workshopSlug,
			title,
			product: product.length > 0 ? product : undefined,
			repoOwner: repo.owner,
			repoName: repo.name,
			defaultBranch: repo.defaultBranch,
			sourceSha: repo.sourceSha,
			exerciseCount: exercises.length,
			hasDiffs,
		},
		exercises,
		steps,
		sections,
		sectionChunks,
	}
}
