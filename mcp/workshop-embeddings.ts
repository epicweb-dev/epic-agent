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
	const lastCodeUnit = value.charCodeAt(max - 1)
	const nextCodeUnit = value.charCodeAt(max)

	const isHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
	const isLowSurrogate = nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff

	// If we cut between a surrogate pair, include the matching low surrogate so we
	// keep the emoji intact rather than dropping it. This can exceed the UTF-16
	// code-unit cap by 1, but does not increase Unicode code points and avoids
	// Cloudflare Workers AI rejecting invalid Unicode (AiError 3010).
	const end = isHighSurrogate && isLowSurrogate ? max + 1 : max
	return value.slice(0, end)
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
