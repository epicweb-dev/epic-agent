import { type BuildAction } from 'remix/fetch-router'
import { Layout } from '../layout.ts'
import { render } from '../render.ts'
import type routes from '../routes.ts'

export default {
	middleware: [],
	async action() {
		return render(
			Layout({
				title: 'Chat',
			}),
		)
	},
} satisfies BuildAction<typeof routes.chat.method, typeof routes.chat.pattern>
