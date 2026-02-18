import { type BuildAction } from 'remix/fetch-router'
import { readAuthSession } from '../auth-session.ts'
import { redirectToLogin } from '../auth-redirect.ts'
import { Layout } from '../layout.ts'
import { render } from '../render.ts'
import type routes from '../routes.ts'

export default {
	middleware: [],
	async action({ request }) {
		const session = await readAuthSession(request)

		if (!session) {
			return redirectToLogin(request)
		}

		return render(
			Layout({
				title: 'Chat',
			}),
		)
	},
} satisfies BuildAction<typeof routes.chat.method, typeof routes.chat.pattern>
