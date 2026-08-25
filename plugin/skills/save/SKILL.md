---
name: save
description: Save important project knowledge to Supermemory. Use when the user wants to preserve an architectural decision, significant bug fix, design pattern, or implementation detail for future sessions.
argument-hint: [what to remember]
allowed-tools: mcp__supermemory__add_memory mcp__plugin_supermemory_supermemory__add_memory mcp__claude_ai_supermemory__add_memory
---

# Save to Supermemory

Save the project knowledge the user wants to preserve.

1. Use `$ARGUMENTS` when it contains the information to save. Otherwise, infer the requested memory from the immediately preceding conversation.
2. Keep the memory focused and self-contained. Include relevant decisions, reasoning, and file paths, but never include secrets.
3. Call the available Supermemory `add_memory` tool with `action: "save"`.
4. Use the current project's `containerTag` from `<supermemory-context>` so the memory remains attached to this repository. If no project container is available, omit `containerTag` and use the active Supermemory space.
5. Report the tool result. Never claim the memory was saved unless the tool confirms success.
