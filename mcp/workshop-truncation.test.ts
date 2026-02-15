/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { clampMaxChars, truncateSections } from './workshop-truncation.ts'

test('clampMaxChars returns default when request missing', () => {
	const result = clampMaxChars({
		requested: undefined,
		defaultMaxChars: 50_000,
		hardMaxChars: 80_000,
	})
	expect(result).toBe(50_000)
})

test('clampMaxChars respects hard max', () => {
	const result = clampMaxChars({
		requested: 100_000,
		defaultMaxChars: 50_000,
		hardMaxChars: 80_000,
	})
	expect(result).toBe(80_000)
})

test('truncateSections creates continuation cursor', () => {
	const firstPass = truncateSections({
		maxChars: 5,
		sections: [
			{
				label: 'A',
				kind: 'one',
				content: 'abcdef',
			},
		],
	})

	expect(firstPass.sections).toEqual([
		{
			label: 'A',
			kind: 'one',
			content: 'abcde',
		},
	])
	expect(firstPass.truncated).toBe(true)
	expect(firstPass.nextCursor).toBeTruthy()

	const secondPass = truncateSections({
		maxChars: 5,
		sections: [
			{
				label: 'A',
				kind: 'one',
				content: 'abcdef',
			},
		],
		cursor: firstPass.nextCursor,
	})

	expect(secondPass.sections).toEqual([
		{
			label: 'A',
			kind: 'one',
			content: 'f',
		},
	])
	expect(secondPass.truncated).toBe(false)
	expect(secondPass.nextCursor).toBeUndefined()
})
