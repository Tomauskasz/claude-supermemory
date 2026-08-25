---
name: search
description: Search Supermemory for past project work, previous sessions, decisions, implementation details, and other saved context.
argument-hint: [memory query]
allowed-tools: mcp__supermemory__search_memory mcp__plugin_supermemory_supermemory__search_memory mcp__claude_ai_supermemory__search_memory
---

# Search Supermemory

Search saved project knowledge for the context the user needs.

1. Use `$ARGUMENTS` as the query. If it is empty, derive a concise query from the user's immediately preceding request.
2. Call the available Supermemory `search_memory` tool.
3. Use the current project's `containerTag` from `<supermemory-context>` so results stay scoped to this repository. If no project container is available, omit `containerTag` and search the active Supermemory space.
4. Present the relevant results clearly. Say when nothing relevant was found instead of inventing an answer.
