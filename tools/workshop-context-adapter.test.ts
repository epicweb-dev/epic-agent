/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { parseEpicshopContextToRepoIndexResult } from './workshop-context-adapter.ts'

test('parseEpicshopContextToRepoIndexResult maps context to RepoIndexResult', () => {
	const result = parseEpicshopContextToRepoIndexResult({
		context: {
			workshop: { title: 'Test Workshop', subtitle: 'A test' },
			instructions: { content: '# Workshop intro\n\nHello world.' },
			finishedInstructions: { content: '# Done!\n\nCongrats.' },
			exercises: [
				{
					exerciseNumber: 1,
					title: 'First Exercise',
					instructions: { content: '# Ex 1 intro' },
					finishedInstructions: { content: '# Ex 1 done' },
					steps: [
						{
							stepNumber: 1,
							title: 'Step One',
							problem: { instructions: '# Problem 1' },
							solution: { instructions: '# Solution 1' },
							diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x',
						},
					],
				},
			],
		},
		packageMetadata: {
			epicshop: {
				title: 'Test Workshop',
				product: { displayNameShort: 'Test Product' },
			},
		},
		repo: {
			owner: 'epicweb-dev',
			name: 'test-workshop',
			defaultBranch: 'main',
			sourceSha: 'abc123',
		},
	})

	expect(result.workshop).toEqual({
		workshopSlug: 'test-workshop',
		title: 'Test Workshop',
		product: 'Test Product',
		repoOwner: 'epicweb-dev',
		repoName: 'test-workshop',
		defaultBranch: 'main',
		sourceSha: 'abc123',
		exerciseCount: 1,
		hasDiffs: true,
	})

	expect(result.exercises).toHaveLength(1)
	expect(result.exercises[0]).toEqual({
		exerciseNumber: 1,
		title: 'First Exercise',
		stepCount: 1,
	})

	expect(result.steps).toHaveLength(1)
	expect(result.steps[0]).toEqual({
		exerciseNumber: 1,
		stepNumber: 1,
		hasDiff: true,
	})

	expect(result.sections.length).toBeGreaterThan(0)
	expect(result.sectionChunks.length).toBeGreaterThan(0)
})
