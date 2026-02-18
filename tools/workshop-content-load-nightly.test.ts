/// <reference types="bun" />
import { expect, test } from 'bun:test'
import {
	changedFilesIncludeWorkshopContent,
	diffIncludesWorkshopContent,
	isWorkshopContentPath,
} from './workshop-content-load-nightly.ts'

test('isWorkshopContentPath matches only exercises/ and extra/', () => {
	expect(isWorkshopContentPath('exercises/01.intro/README.md')).toBe(true)
	expect(isWorkshopContentPath('extra/notes.md')).toBe(true)
	expect(isWorkshopContentPath('README.md')).toBe(false)
	expect(isWorkshopContentPath('src/index.ts')).toBe(false)
	expect(isWorkshopContentPath('exercises-old/01/README.md')).toBe(false)
})

test('changedFilesIncludeWorkshopContent matches on changed filenames', () => {
	expect(changedFilesIncludeWorkshopContent(['README.md'])).toBe(false)
	expect(
		changedFilesIncludeWorkshopContent([
			'README.md',
			'exercises/02.tools/01.problem/README.mdx',
		]),
	).toBe(true)
	expect(changedFilesIncludeWorkshopContent(['extra/guide.md'])).toBe(true)
})

test('diffIncludesWorkshopContent matches compare diff headers', () => {
	const diff = [
		'diff --git a/README.md b/README.md',
		'index 111..222 100644',
		'--- a/README.md',
		'+++ b/README.md',
		'@@ -1 +1 @@',
		'-old',
		'+new',
		'',
		'diff --git a/exercises/01.ping/README.md b/exercises/01.ping/README.md',
		'index 111..222 100644',
	].join('\n')
	expect(diffIncludesWorkshopContent(diff)).toBe(true)
	expect(
		diffIncludesWorkshopContent(
			'diff --git a/src/index.ts b/src/index.ts\nindex 1..2 100644\n',
		),
	).toBe(false)
})
