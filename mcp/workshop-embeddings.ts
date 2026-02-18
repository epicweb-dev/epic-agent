const embeddingControlCharsRegex =
	// eslint-disable-next-line no-control-regex -- strip control chars before sending to Workers AI
	/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

// bge-base-en-v1.5 max is 512 tokens; use 1:1 char cap for safety with dense code.
export const workshopEmbeddingMaxChars = 512

function roundTripUtf8(value: string) {
	// Normalizes any invalid UTF-16 (e.g. lone surrogates) into valid Unicode by
	// replacing them with U+FFFD during UTF-8 encoding.
	return new TextDecoder().decode(new TextEncoder().encode(value))
}

function truncateUtf16Safely(value: string, maxChars: number) {
	const max = Math.max(1, Math.floor(maxChars))
	if (value.length <= max) return value
	let truncated = value.slice(0, max)
	const lastCodeUnit = truncated.charCodeAt(truncated.length - 1)
	// If we cut off after a high surrogate, drop it so we don't send a dangling
	// surrogate to Workers AI (Cloudflare returns AiError 3010 invalid input).
	if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
		truncated = truncated.slice(0, -1)
	}
	return truncated
}

export function prepareEmbeddingText({
	content,
	maxChars = workshopEmbeddingMaxChars,
}: {
	content: string
	maxChars?: number
}) {
	const raw = (content ?? '').replaceAll(embeddingControlCharsRegex, ' ').trim()
	if (raw.length === 0) return '.'

	const normalized = roundTripUtf8(raw)
	const truncated = truncateUtf16Safely(normalized, maxChars)
	const normalizedTruncated = roundTripUtf8(truncated).trim()
	return normalizedTruncated.length === 0 ? '.' : normalizedTruncated
}
