export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	return String(error)
}

function hasNumericCode(messageLower: string, code: number) {
	return new RegExp(`\\b${code}\\b`).test(messageLower)
}

export function isWorkersAiInvalidInputError(error: unknown) {
	const messageLower = getErrorMessage(error).toLowerCase()
	return (
		messageLower.includes('invalid input') ||
		messageLower.includes('workers ai rejected') ||
		hasNumericCode(messageLower, 3010)
	)
}

export function isWorkersAiCapacityError(error: unknown) {
	const messageLower = getErrorMessage(error).toLowerCase()
	return (
		messageLower.includes('capacity temporarily exceeded') ||
		hasNumericCode(messageLower, 3040) ||
		(messageLower.includes('/ai/run/') && hasNumericCode(messageLower, 429))
	)
}
