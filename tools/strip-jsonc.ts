export function stripJsonc(value: string) {
	// Keep parsing lightweight (CI-safe), but handle the JSONC patterns we use:
	// comments + trailing commas.
	return value
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/,\s*([}\]])/g, '$1')
}
