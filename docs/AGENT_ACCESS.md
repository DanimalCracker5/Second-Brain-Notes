# Connect Hermes to Second Brain

Hermes already reaches TickTick through a remote MCP server and a bearer token. Second Brain works the same way. You create a token in the app, point Hermes at this account’s MCP URL, and Hermes can search, read, create, and update your notes and todos.

The token is scoped to the signed-in account that created it. Another person’s Hermes cannot see your notes unless you give them a token. Revoke the token and that access stops.

## In Second Brain

1. Sign in.
2. Open **Settings → Connect an agent**.
3. Name the token (for example `Hermes`) and create it.
4. Copy the `SECOND_BRAIN_TOKEN=sb_…` line. The full token is shown only once.

A token can read, create, edit, and delete notes until you revoke it. It is not your Google password and it is not a Firebase key.

## In Hermes

This matches the TickTick bearer-token setup. Put the secret in `~/.hermes/.env`:

```bash
SECOND_BRAIN_TOKEN=sb_paste_the_token_here
```

Add the server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  second_brain:
    url: https://us-central1-second-brain-4077e.cloudfunctions.net/agent/mcp
    headers:
      Authorization: Bearer ${SECOND_BRAIN_TOKEN}
    timeout: 120
    connect_timeout: 60
```

In a Hermes chat, run `/reload-mcp`. Ask Hermes what tools it has. You should see `search_notes`, `read_note`, `create_note`, `update_note`, `list_todos`, `update_todo`, and `delete_note`.

Then try: “Search my Second Brain for the trip note and add a line about the passport.”

Hermes can also learn the shape of the notes from `docs/hermes/second-brain/SKILL.md`. Copy that folder to `~/.hermes/skills/second-brain/` if you want the extra guidance. The MCP tools are enough on their own.

## What Hermes can do

- List and search notes without pulling every full document.
- Read one note when it needs the body.
- Create notes and todos, including due dates (`YYYY-MM-DD`, `today`, `tomorrow`).
- Append text, or rewrite a note when you ask it to replace the body.
- Mark todos done.
- Delete a note only when you explicitly ask and the tool is called with confirmation.

Hidden notes and the in-app assistant stay out of search unless Hermes passes `include_hidden`. Edits show up on devices that are signed in to the same account.

## Other agents

Any MCP client that can call a remote HTTP server with a bearer token can use the same URL. A minimal client config looks like:

```json
{
  "mcpServers": {
    "second-brain": {
      "url": "https://us-central1-second-brain-4077e.cloudfunctions.net/agent/mcp",
      "headers": {
        "Authorization": "Bearer sb_paste_the_token_here"
      }
    }
  }
}
```

There is also a small HTTP API on the same function (`GET /v1/notes`, `POST /v1/notes`, `PATCH /v1/notes/:id`, `GET /v1/todos`, and matching todo routes) using the same `Authorization: Bearer sb_…` header.

## Deploying the endpoint

The page in Settings calls a Cloud Function named `agent`. Deploy it with the rules that keep token hashes unreadable by the browser:

```bash
firebase deploy --project second-brain-4077e --only functions:agent,firestore:rules
```

The function does not use the OpenAI, Gemini, ElevenLabs, or Stripe secrets. Token documents live in `agentTokens` and are denied to clients in `firestore.rules`. Only the Admin SDK inside the function can read them.
