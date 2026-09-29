---
name: second-brain
description: Read and update the owner's Second Brain notes and todos with the connected MCP tools.
version: 1.0.0
platforms: [linux, macos, windows]
---

# Second Brain

Use this when the owner wants something saved, found, or changed in Second Brain. The MCP server `second_brain` is the source of truth. Do not invent note ids.

## When to use

- They mention Second Brain, their notes, their second brain, or a note you should remember.
- They ask what they wrote, what is due, or to capture a task.
- They want a note created or updated instead of only answering in chat.

## Tools

- `search_notes` before `read_note`. Search returns snippets, not full text.
- `list_notes` when they did not give you words to search.
- `read_note` for one id when the snippet is not enough.
- `create_note` or `create_todo` when they ask you to write something new.
- `update_note` with `mode: append` to add wording. Use `replace` only when they asked for a rewrite.
- `list_todos` and `update_todo` for open, done, and overdue tasks.
- `delete_note` only after they explicitly ask to delete, and only with `confirm: true`.

## Dates

Prefer `YYYY-MM-DD`. `today`, `tomorrow`, and `in 3 days` are accepted and use UTC calendar days.

## Pitfalls

- A todo is a note with a checkbox, not a separate database.
- Hidden notes are omitted unless you pass `include_hidden`.
- The in-app assistant’s memory is not a note you can edit from here.
- Do not claim a note changed until the tool result says it was created, updated, or deleted.
