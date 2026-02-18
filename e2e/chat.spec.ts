import {
	expect,
	test,
	type APIRequestContext,
	type Page,
} from '@playwright/test'

const testUser = { email: 'user@example.com', password: 'password123' }

async function ensureUserExists(request: APIRequestContext) {
	const response = await request.post('/auth', {
		data: { ...testUser, mode: 'signup' },
		headers: { 'Content-Type': 'application/json' },
	})
	if (response.ok() || response.status() === 409) {
		return
	}
	throw new Error(`Failed to seed user (${response.status()}).`)
}

async function login(page: Page) {
	await page.context().clearCookies()
	await page.goto('/login')

	await page.getByLabel('Email').fill(testUser.email)
	await page.getByLabel('Password').fill(testUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
}

test('chat calls MCP tools', async ({ page }) => {
	await ensureUserExists(page.request)
	await login(page)

	await page.goto('/chat')

	await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()

	await page.locator('textarea[name="message"]').fill('list workshops')
	await page.getByRole('button', { name: 'Send' }).click()

	await expect(page.getByText('"workshops"')).toBeVisible({
		timeout: 15_000,
	})

	// Second turn ensures the Worker keeps MCP session state server-side.
	await page.locator('textarea[name="message"]').fill('/tools')
	await page.getByRole('button', { name: 'Send' }).click()

	await expect(page.getByText('Available MCP tools:')).toBeVisible({
		timeout: 15_000,
	})
	await expect(page.getByText('list_workshops')).toBeVisible({
		timeout: 15_000,
	})
})
