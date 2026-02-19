import { expect, test } from '@playwright/test'

test('home page renders the shell', async ({ page }) => {
	await page.goto('/')
	await expect(page).toHaveTitle('epic-agent')
	await expect(page.getByRole('heading', { name: 'epic-agent' })).toBeVisible()
})
