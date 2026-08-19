const AGENT_ENTITY_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Preserve durable context that helps a coding agent continue the work
- Condense assistant responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture: "uses monorepo with turborepo", "API in /apps/api"
- Conventions: "components in PascalCase", "hooks prefixed with use"
- Patterns: "all API routes use withAuth wrapper", "errors thrown as ApiError"
- Setup: "requires .env with DATABASE_URL", "run pnpm db:migrate first"
- Decisions: "chose Drizzle over Prisma for performance", "using RSC for data fetching"

SKIP:
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter
- Granular details that do not help future work`;

async function post(baseUrl, apiKey, path, body, timeoutMs = 15000) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-sm-source': 'claude-code',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`Supermemory API ${response.status}: ${text.slice(0, 200)}`),
      { status: response.status },
    );
  }
  return response.json();
}

// Canonical-container reads filter on searchable agent_scope metadata; legacy
// containers stay unfiltered. Requires the backend sm_scope→agent_scope
// backfill (mono#2895) to be deployed, or filtered reads return nothing.
function scopeFilters(scope) {
  return { AND: [{ key: 'agent_scope', value: scope, filterType: 'metadata' }] };
}

function getProfile(baseUrl, apiKey, containerTag, query, options = {}) {
  const body = { containerTag, q: query };
  if (options.filters) body.filters = options.filters;
  return post(baseUrl, apiKey, '/v4/profile', body, options.timeoutMs);
}

function addMemory(baseUrl, apiKey, content, containerTag, metadata, options = {}) {
  const body = {
    content,
    containerTag,
    metadata: { sm_source: 'claude-code', ...metadata },
  };
  if (options.customId) body.customId = options.customId;
  if (options.entityContext) body.entityContext = options.entityContext;
  return post(baseUrl, apiKey, '/v3/documents', body, options.timeoutMs);
}

module.exports = { AGENT_ENTITY_CONTEXT, getProfile, addMemory, scopeFilters };
