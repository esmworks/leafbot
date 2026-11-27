---
name: move-to-leafbot
description: Packs the user's Grok Bot agents (instructions, picture, timed tasks, remembered facts, skills, team chats) into a single leafbot-bots.json file for the Leaf Bot app. Use when the user wants their agents in Leaf Bot.
---

# Move agents to Leaf Bot

The result of this task is one JSON document in the shape below. The user loads it in Leaf Bot
(**Settings → Import**), where it is previewed before anything is created. Leaf Bot checks it
strictly; a document that does not match the shape below is rejected as a whole.

Hand it over in the first of these ways that works:

1. **The Leaf Bot connector.** When you have its tools (`move_status`, `send_export`), call
   `move_status`, then send the document with `send_export`, one agent per call when they are
   large. Write no file.
2. **A file.** Save it as `leafbot-bots.json`, in the user's Downloads folder if you can write to
   their computer, otherwise in your workspace, and attach it to your reply.
3. **Your reply.** Put the whole document in a single ```json code block, with nothing else
   inside the block.

When it is too long for one message, file or call, split it: send several documents, each
complete and valid in this same shape (`format`, `version`, `bots`). An agent can be split over
several of them under the same `ref`; Leaf Bot joins the parts and imports each thing once.

## What the file looks like

```json
{
  "format": "leafbot-bot-import",
  "version": 1,
  "source": "grok-bot",
  "exportedAt": "2026-11-13T09:00:00Z",
  "bots": [
    {
      "ref": "trip-planner",
      "name": "Trip Planner",
      "description": "Plans trips and keeps bookings in order",
      "instructions": "You plan the user's trips. Prefer trains over flights under 600 km. …",
      "avatar": null,
      "routines": [
        {
          "name": "Sunday travel check",
          "prompt": "List the bookings for the coming week and flag missing tickets.",
          "schedule": { "type": "weekly", "days": [0], "time": "18:00" },
          "timezone": "Europe/Berlin",
          "enabled": true
        }
      ],
      "memories": ["The user has a rail pass valid until March 2027."],
      "skills": [
        {
          "name": "rail-booking",
          "description": "Books train tickets. Use when the user asks for a train between two cities.",
          "body": "# Rail booking\n\n1. Ask for the date and the two cities. …"
        }
      ]
    },
    {
      "ref": "bookkeeper",
      "name": "Bookkeeper",
      "description": "Tracks invoices and expenses",
      "instructions": "You keep the user's books. …",
      "avatar": null,
      "routines": [],
      "memories": [],
      "skills": []
    }
  ],
  "groups": [{ "name": "Household", "members": ["trip-planner", "bookkeeper"] }],
  "notImported": [
    { "bot": "bookkeeper", "what": "Task: file receipts from email", "reason": "starts on an email" },
    { "bot": "trip-planner", "what": "Integration: Google Calendar", "reason": "connected account" }
  ]
}
```

### `bots` (1 to 50)

- `ref`: your own id for the agent, used only inside this file. Lowercase letters and digits,
  words joined by single hyphens, up to 64 characters. No two agents share one.
- `name`: up to 60 characters.
- `description`: what the agent is for, in one line of up to 500 characters.
- `instructions`: its system prompt, up to 20,000 characters. When it is longer, condense it,
  keeping every rule, and list what you cut under `notImported`.
- `avatar`: `null`, the agent's picture as a base64 data URL of type `image/png`,
  `image/jpeg` or `image/webp` no larger than 290 KB (SVG is not accepted), or, for an agent
  drawn as a coloured shape rather than a picture, the nearest Leaf Bot shape: `object:drop`
  for a teardrop or drop, `object:circle`, `object:square`, `object:pill`, `object:hexagon` or
  `object:cloud`. The colour is not carried.
- `routines`: up to 32 timed tasks (see below).
- `memories`: the facts the agent has saved in its memory, at most 50 (see below).
- `skills`: the agent's skills, at most 32 (see below).

### `routines`

Each has a `name` (up to 80 characters), the `prompt` it runs (up to 20,000 characters), a
`schedule`, an IANA `timezone` (such as `Asia/Tokyo`) and `enabled`, which says whether the task
is currently switched on in Grok Bot. Leaf Bot imports every routine switched off so nothing runs
twice; the user turns them on.

`schedule` must be exactly one of the following. `HH:MM` is a 24-hour clock time in the routine's
own time zone; weekdays are numbered with Sunday as 0 and Saturday as 6.

```json
{ "type": "hourly", "minute": 0 }
{ "type": "daily", "time": "HH:MM" }
{ "type": "weekdays", "time": "HH:MM" }
{ "type": "weekly", "days": [1, 4], "time": "HH:MM" }
{ "type": "monthly", "day": 15, "time": "HH:MM" }
{ "type": "interval", "minutes": 90 }
```

`hourly` runs once an hour at the given minute; `weekdays` means Monday to Friday; `interval`
takes 5 to 10,080 minutes. Cron expressions are not accepted.

Some tasks will not fit: a schedule none of these shapes expresses exactly, or a task that is
triggered by something other than the clock (a webhook, an incoming email, a message). Never
approximate such a task with a nearby schedule. Leave it out of `routines` and describe it in
`notImported`, naming what triggers it. A task with two or more separate schedules becomes one
routine per schedule, each with the same prompt and a distinguishing name.

### `memories`

Only what the agent already keeps as memory in Grok Bot (its saved facts about the user), one
plain sentence each, up to 2,000 characters. Copy them; do not add new ones. Never derive facts
from the agent's conversations or summarise its chats, and never paste conversation text. An
agent with no saved memory gets `[]`; that is the expected case for most agents, not a gap to
fill. Leaf Bot saves these as the agent's memory as soon as the user confirms the import.

### `skills`

Every skill the agent has, copied whole, so it works the same in Leaf Bot:

- `name`: the skill's name as lowercase words joined by single hyphens, up to 64 characters
  (`Routine healthcheck` becomes `routine-healthcheck`).
- `description`: when to use the skill, up to 1,024 characters.
- `body`: the skill's full text, exactly as it is in Grok Bot, up to 50,000 characters. Do not
  summarise or rewrite it. When it is longer, keep the first 50,000 characters and say so under
  `notImported`. Files that come with a skill (scripts, templates) are not carried: name each one
  under `notImported`.

Two agents that share a skill list it with the same `name`; Leaf Bot creates it once.

When you cannot read a skill's full text, leave the skill out and name it under `notImported`
with the reason. Never write a body from its description or from memory: a rebuilt skill would
behave differently from the original.

### Integrations

Connected services, plugins and tool servers (an MCP server, a plugin such as a package of
commands, a connected account) are not carried, since they need the user to sign in again in
Leaf Bot. List each one under `notImported` as `Integration: <its name>`, with what it does as
the `reason`, so the user can set it up there. When a plugin or tool server comes from a public
address (such as a GitHub repository), put that address in the `reason` too: Leaf Bot installs
plugins from such an address.

### `groups` (up to 50)

Team chats in which several agents work together: a `name` (up to 60 characters) and the `ref` of
each member. In Leaf Bot an agent belongs to at most one group.

### `notImported` (up to 200)

Everything the user had that the file cannot carry, such as files, integrations, connected
accounts or event-triggered tasks: `bot` (the agent's `ref`, or `null`), `what` (up to 200 characters) and
`reason`.

## How to do it

1. If the user named the agents to move (for example one added from a shared link), take exactly
   those and do not ask. Otherwise gather the user's agents and team chats and show them as a
   list. Ask which to include (all, or a selection) and wait for the reply. Skip any agent whose
   only job is to run this export.
2. For each chosen agent, collect the fields above: its instructions, its saved memories and its
   skills copied as they are, its timed tasks, and its integrations for `notImported`.
3. Keep credentials out of the file. API keys, passwords, tokens, cookies and signed URLs never
   go in, not even inside instructions or prompts; put a note such as `[needs the user's API key]`
   in their place.
4. Write the document, then check it:
   - it parses as JSON, with `format` `leafbot-bot-import` and `version` `1`;
   - every `ref` is unique, and every group member is one of them;
   - every schedule is one of the six shapes, none of them guessed;
   - every skill's `body` is its full text, not a summary;
   - no credentials appear anywhere;
   - everything left behind is listed in `notImported`.
5. Hand it over as described at the top. Then tell the user how many agents and groups it
   contains and what is in `notImported`, and, unless you sent it over the connector, that they
   can now load it (or paste your reply) under **Settings → Import** in Leaf Bot.
