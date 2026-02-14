/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { workshopIndexerTestUtils } from './workshop-indexer.ts'

test('parseExerciseFromPath supports workshop exercise paths', () => {
	const parsed = workshopIndexerTestUtils.parseExerciseFromPath(
		'exercises/01.ping/01.problem.connect/src/index.ts',
	)
	expect(parsed).toEqual({
		exerciseDir: '01.ping',
		exerciseNumber: 1,
	})
})

test('parseStepFromPath supports both dotted and plain step directories', () => {
	const dotted = workshopIndexerTestUtils.parseStepFromPath(
		'exercises/02.tools/01.problem.simple/src/index.ts',
	)
	expect(dotted).toEqual({
		exerciseNumber: 2,
		stepNumber: 1,
		stepType: 'problem',
		stepDir: 'exercises/02.tools/01.problem.simple',
	})

	const plain = workshopIndexerTestUtils.parseStepFromPath(
		'exercises/02.elicitation/01.solution/src/index.ts',
	)
	expect(plain).toEqual({
		exerciseNumber: 2,
		stepNumber: 1,
		stepType: 'solution',
		stepDir: 'exercises/02.elicitation/01.solution',
	})
})

test('splitIntoChunks is deterministic with overlap', () => {
	const longContent = Array.from(
		{ length: 220 },
		(_, index) => `line-${index.toString().padStart(3, '0')}`,
	).join('\n')
	const chunks = workshopIndexerTestUtils.splitIntoChunks({
		content: longContent,
		chunkSize: 320,
		chunkOverlap: 60,
	})
	expect(chunks.length).toBeGreaterThan(2)
	expect(chunks[0]?.chunkIndex).toBe(0)
	expect(chunks[1]?.chunkIndex).toBe(1)
	expect(chunks[0]?.content.length).toBeLessThanOrEqual(320)
	expect(chunks[1]?.content.length).toBeLessThanOrEqual(320)
	expect(chunks[0]?.content).not.toBe(chunks[1]?.content)
})

test('createSimpleUnifiedDiff includes changed lines', () => {
	const diff = workshopIndexerTestUtils.createSimpleUnifiedDiff({
		path: 'src/index.ts',
		problemContent: 'const value = 1\nconsole.log(value)\n',
		solutionContent: 'const value = 2\nconsole.log(value)\n',
	})
	expect(diff).toContain('diff --git a/src/index.ts b/src/index.ts')
	expect(diff).toContain('-const value = 1')
	expect(diff).toContain('+const value = 2')
})

test('shouldIgnoreDiffPath respects wildcard patterns', () => {
	const ignored = workshopIndexerTestUtils.shouldIgnoreDiffPath('README.mdx', [
		'README.*',
	])
	const notIgnored = workshopIndexerTestUtils.shouldIgnoreDiffPath(
		'src/index.ts',
		['README.*'],
	)
	expect(ignored).toBe(true)
	expect(notIgnored).toBe(false)
})
