# MCP Server Best Practices

_Learnings from analyzing high-quality MCP server implementations_

This document summarizes best practices learned from analyzing the following MCP
server implementations:

- [Linear MCP Server](https://github.com/iceener/linear-streamable-mcp-server)
- [Google Calendar MCP Server](https://github.com/iceener/google-calendar-streamable-mcp-server)
- [Google Maps MCP Server](https://github.com/iceener/maps-streamable-mcp-server)
- [Tesla MCP Server](https://github.com/iceener/tesla-streamable-mcp-server)

---

## 1. Server Instructions

### What Great Servers Do

Provide comprehensive server-level instructions that act as an "onboarding
guide" for the AI. This is the first thing the AI reads when connecting.

**Best Practice Format:**

```
Quick start
- What to call first
- Most common workflows
- How to chain tools

Default behavior
- What happens when optional params are omitted
- Timezone handling
- Date format expectations

How to chain tools safely
- Which IDs come from which tools
- Dependency order
- Verification patterns

Common patterns & examples
- "To do X, first call Y, then Z"
```

**Example from Linear:**

```
Quick start
- Call 'workspace_metadata' first to fetch canonical identifiers you will reuse across tools.
- Then use 'list_issues' with teamId/projectId and filters to locate targets.
- To modify, use 'update_issues', then verify with 'list_issues'.
```

**Example in this repo:** The MCP server provides a structured onboarding guide
in server-level instructions (quick start, defaults, chaining patterns, and
examples).

---

## 2. Tool Descriptions

### What Great Servers Do

Tools have _detailed, structured descriptions_ that include:

1. **What the tool does** (1-2 sentences)
2. **Behavioral input notes** (defaults, cross-field constraints, and any
   non-obvious rules)
3. **Returns** - what the response structure looks like
4. **Next steps** - what to do after calling this tool
5. **Examples** - concrete usage examples

### Avoid schema duplication

When a server already provides a rich input schema (for example, Zod/JSON Schema
with per-field `.describe()` metadata), treat the schema as the source of truth
for parameter types, requiredness, ranges, and per-field descriptions.

Similarly, when a server provides an output schema (via MCP tool `outputSchema`)
for `structuredContent`, treat that as the source of truth for the shape of the
structured response.

In that case, tool descriptions should:

- Focus on **semantics** (what the tool _means_, not just what it accepts)
- Focus on **use cases** (when to call the tool)
- Call out **cross-field constraints** the schema may not capture well (for
  example: "if you pass `stepNumber`, you must also pass `exerciseNumber`")
- Call out **defaults** and **server-side behavior** (pagination, truncation,
  fallbacks) that are easy to miss
- Include **examples** when they clarify intent

Tool descriptions should generally _not_:

- Repeat every input parameter with its type/requiredness if the schema already
  documents it
- Copy/paste the schema text into the tool description
- Repeat full `structuredContent` shapes if the tool provides `outputSchema`
- Over-index on "what to call next"; navigation belongs in tool outputs (for
  example, `nextCursor` fields and explicit next-step hints in the returned
  markdown)

**Best Practice Format:**

```
Brief description of what the tool does.

Inputs:
- See the input schema for parameter-level details.
- Call out only non-obvious constraints and defaults here.

Examples:
- "Do X" → { param: "value" }
- "Do Y" → { param: "other" }

Navigation:
- Prefer returning next steps in tool outputs (for example: cursors and explicit next-step hints in markdown).
```

**Example from Google Calendar:**

```
Search events across ALL calendars by default. Returns merged results sorted by start time.

Inputs: calendarId? (default: 'all'), timeMin?, timeMax? (ISO 8601), query?, maxResults?...

FILTERING BY TIME (important!):
- Today's events: timeMin=start of day, timeMax=end of day
- This week: timeMin=Monday 00:00, timeMax=Sunday 23:59:59

Returns: { items: Array<{ id, summary, start, end, calendarId, calendarName... }> }

Next: Use eventId AND calendarId with 'update_event' or 'delete_event'.
```

**Example in this repo:** Tool descriptions focus on use cases and semantics,
while input/output schemas describe parameter and structured output shapes.
Navigation guidance (cursors, next steps) lives in the tool outputs.

---

## 3. Tool Annotations

### What Great Servers Do

Every tool includes annotations that help the AI understand the tool's behavior:

```typescript
annotations: {
  readOnlyHint: true,      // Does not modify state
  destructiveHint: false,  // Does not delete data
  idempotentHint: true,    // Safe to call multiple times
  openWorldHint: true,     // May access external resources
}
```

**Guidelines:**

| Annotation        | When to use `true`                      |
| ----------------- | --------------------------------------- |
| `readOnlyHint`    | GET/LIST operations                     |
| `destructiveHint` | DELETE operations, irreversible changes |
| `idempotentHint`  | Same input always produces same result  |
| `openWorldHint`   | Accesses external APIs/resources        |

**Example in this repo:** Tools provide annotations via the
`server.registerTool()` config.

---

## 4. Input Schema Best Practices

### What Great Servers Do

Rich, descriptive input schemas with:

- **Clear descriptions** for each parameter
- **Default values** explained in description
- **Valid values** listed (especially for enums)
- **Format expectations** (dates, IDs, etc.)

**Example:**

```typescript
z.object({
	calendarId: z
		.union([z.literal('all'), z.string(), z.array(z.string())])
		.optional()
		.default('all')
		.describe(
			'Calendar ID(s). Use "all" (default) to search all calendars, a single ID, or array of IDs',
		),

	timeMin: z
		.string()
		.optional()
		.describe(
			'Start of time range (RFC3339 with timezone, e.g., 2025-12-06T19:00:00Z)',
		),

	maxResults: z
		.number()
		.int()
		.min(1)
		.max(250)
		.optional()
		.default(50)
		.describe('Max events to return (1-250, default: 50)'),
})
```

**Example in this repo:** Tool input schemas describe defaults, valid values,
and format expectations where it is useful.

---

## 5. Output Schema Best Practices

### What Great Servers Do

Provide `outputSchema` for tools so clients (and the server) can understand and
validate the `structuredContent` return shape.

Benefits:

- Lets clients rely on schema instead of parsing markdown
- Prevents drift between documented returns and actual payloads
- Allows tool descriptions to focus on _behavior_ rather than re-describing data

Example:

```typescript
server.registerTool(
	'list_workshops',
	{
		inputSchema: listWorkshopsInputSchema,
		outputSchema: z.object({
			workshops: z.array(
				z.object({
					workshop: z.string(),
					title: z.string(),
					exerciseCount: z.number().int(),
					hasDiffs: z.boolean(),
				}),
			),
			nextCursor: z.string().optional(),
		}),
	},
	async (args) => {
		// ...
		return { content: [...], structuredContent }
	},
)
```

---

## 6. Response Formatting

### What Great Servers Do

Return **both** human-readable text AND structured content:

```typescript
return {
	content: [
		{
			type: 'text',
			text: `✓ Event created: [${title}](${htmlLink})\n  when: ${start}\n  meet: ${meetLink}`,
		},
	],
	structuredContent: {
		id: event.id,
		summary: event.summary,
		// ... full structured data
	},
}
```

**Human-readable text best practices:**

- Use **markdown** formatting (links, bold, lists)
- Use **emojis** for status (✓, ⚠️, 🟢, 🔴)
- Include **context** (what calendar, which feed)
- Provide **next steps** in the text

**Example from Tesla:**

```
## Model 3

**Status**: asleep
**Locked**: Yes ✓
**Sentry Mode**: On

### Battery
- Level: 78%
- Range: 312 km
- Charging: Not charging

### ⚠️ Open
- Trunk
```

**Example in this repo:** Tools return human-readable markdown in `content` and
machine-friendly data in `structuredContent`.

---

## 7. Tool Modules (Colocated Configuration)

### What Great Servers Do

Keep each tool's configuration (title, description, annotations, schemas) next
to its handler implementation. This reduces drift between schemas, descriptions,
and behavior.

```typescript
// mcp/tools/list-workshops.ts
const outputSchema = z.object({
	workshops: z.array(z.object({ workshop: z.string() /* ... */ })),
	nextCursor: z.string().optional(),
})

export function registerListWorkshopsTool(agent: MCP) {
	agent.server.registerTool(
		'list_workshops',
		{
			title: 'List Workshops',
			description: 'List indexed workshops and coverage.',
			inputSchema: listWorkshopsInputSchema,
			outputSchema,
			annotations: readOnlyToolAnnotations,
		},
		async (args) => {
			// ... implementation ...
			return { content: [...], structuredContent: { workshops: [] } }
		},
	)
}
```

**Benefits:**

- Schema + implementation drift is less likely
- Easier to reason about one tool at a time
- Encourages concise, use-case focused descriptions

**Centralization is still useful** for server-level instructions and shared
annotations; tool-level config is often easiest to maintain when colocated.

**Example in this repo:** Tools are registered in `mcp/register-tools.ts` and
implemented in `mcp/tools/*.ts`.

---

## 8. Tool Naming Conventions

### What Great Servers Do

| Pattern    | Example                    | Use Case              |
| ---------- | -------------------------- | --------------------- |
| `list_*`   | `list_feeds`, `list_users` | Get multiple items    |
| `get_*`    | `get_feed`, `get_issue`    | Get single item by ID |
| `create_*` | `create_feed`              | Create new item       |
| `update_*` | `update_feed`              | Modify existing item  |
| `delete_*` | `delete_feed`              | Remove item           |
| `browse_*` | `browse_media`             | Navigate/explore      |
| `search_*` | `search_events`            | Query with filters    |

**Consistency rules:**

- Use `snake_case` for tool names
- Group related tools with common prefix
- Use singular nouns for get/create, plural for list

**Example in this repo:** Tool names use `snake_case` and follow `list_*`/verb
conventions.

---

## 9. Error Handling

### What Great Servers Do

Provide helpful, actionable error messages:

```typescript
if (!feed) {
	return {
		content: [
			{
				type: 'text',
				text: `Feed "${feedId}" not found.\n\nNext: Use list_feeds to see available feeds.`,
			},
		],
		isError: true,
	}
}
```

**Best practices:**

- Explain **what went wrong**
- Suggest **how to fix it**
- Reference **related tools** that can help
- Include **valid values** when applicable

**Example in this repo:** Tool error responses include actionable next steps
(including which tool to call next).

---

## 10. Pagination & Limiting

### What Great Servers Do

Consistent pagination patterns:

```typescript
return {
  content: [...],
  structuredContent: {
    items: [...],
    pagination: {
      hasMore: boolean,
      nextCursor: string | undefined,
      itemsReturned: number,
      limit: number,
    },
  },
}
```

**In descriptions:**

```
Returns: { items[], pagination: { hasMore, nextCursor } }

Pass nextCursor to fetch the next page.
```

**Example in this repo:** List-style tools return `nextCursor` when there are
more results, and callers can pass that cursor back into the same tool to fetch
the next page.

---

## 11. Resources Best Practices

### What Great Servers Do

Resources provide **read-only data access** with:

- Clear URI schemes (`media://feeds`, `media://feeds/{id}`)
- Proper MIME types
- Descriptions that explain the data structure

**Good resource examples:**

- `media://server` — Server info and statistics
- `media://feeds` — All feeds list
- `media://feeds/{id}` — Individual feed details
- `media://directories` — Available media directories

**Note for this repo:** Resources are not currently registered, but these
patterns are recommended if/when resources are added.

---

## 12. Prompts Best Practices

### What Great Servers Do

Prompts are **task-oriented conversation starters**:

- Guide the user through **multi-step workflows**
- Provide **context** about available tools
- Include **concrete next steps**
- Support **optional parameters** to customize the task

**Example prompt:**

```
I want to create a new feed. Please help me decide:

1. Should this be a directory feed (automatically includes all media from a folder)?
2. Or a curated feed (manually select specific content)?

Available media roots:
- audio: /media/audio
- video: /media/video

Please ask me some questions to understand what I'm trying to create, then help me set it up.
```

**Note for this repo:** Prompts are not currently registered, but these patterns
are recommended if/when prompts are added.
