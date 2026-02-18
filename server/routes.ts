import { post, route } from 'remix/fetch-router'

const routes = route({
	home: '/',
	health: '/health',
	login: '/login',
	signup: '/signup',
	account: '/account',
	chat: '/chat',
	auth: post('/auth'),
	session: '/session',
	logout: post('/logout'),
	passwordResetRequest: post('/password-reset'),
	passwordResetConfirm: post('/password-reset/confirm'),
})

export default routes
