import stripJsonComments from 'strip-json-comments'

export function stripJsonc(value: string) {
	// Keep parsing lightweight (CI-safe), but handle the JSONC patterns we use:
	// - stripJsonComments safely removes `//` and `/* */` comments without
	//   clobbering `https://` inside string literals.
	// - trailing commas are removed with a simple regex (acceptable for our
	//   controlled config files; not intended as a general-purpose JSONC parser).
	return stripJsonComments(value).replace(/,\s*([}\]])/g, '$1')
}
