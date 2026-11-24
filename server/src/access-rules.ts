import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Principal } from './auth';
import { schema } from './db';
import type { Services } from './services';
import { managesServer } from './services/access';
import { HttpError, notFound } from './util';

/** What a route's `:id` (or `:botId`) names, so the bot or conversation behind it can be found. */
type BotVia = 'bot' | 'botParam' | 'table' | 'routine';
type ThreadVia = 'thread' | 'message' | 'turn' | 'approval' | 'job';

/**
 * Who may call a route:
 * - `signedIn`: anyone signed in;
 * - `admin` / `owner`: those who look after the server, or only its owner;
 * - `self`: anyone signed in, and the handler itself keeps each person to what is theirs;
 * - a bot level: the bot the route names must be shared with them at least that far;
 * - a conversation: it must be theirs (or the bot's own work, for those who may change the bot);
 *   to write in it they must also still be able to talk with its bot. `manage` (rename, archive,
 *   delete, edit lines) is read for one's own; a team conversation is managed only by those who
 *   may change its bot, since everyone in it shares it.
 */
export type Rule =
  | 'signedIn'
  | 'admin'
  | 'owner'
  | 'self'
  | { bot: 'chat' | 'edit'; via: BotVia }
  | { thread: 'read' | 'write' | 'manage'; via: ThreadVia };

const chat = (via: BotVia = 'bot'): Rule => ({ bot: 'chat', via });
const edit = (via: BotVia = 'bot'): Rule => ({ bot: 'edit', via });
const read = (via: ThreadVia = 'thread'): Rule => ({ thread: 'read', via });
const write = (via: ThreadVia = 'thread'): Rule => ({ thread: 'write', via });
const manage = (via: ThreadVia = 'thread'): Rule => ({ thread: 'manage', via });

/**
 * Every signed-in route, as registered, with who may call it. A route missing here is left to the
 * admins; a test checks that none is missing.
 */
export const ROUTE_RULES: Record<string, Rule> = {
  // Signing in and the person's own account and devices.
  'GET /api/sessions': 'signedIn',
  'DELETE /api/sessions/:id': 'signedIn',
  'POST /api/pairing': 'signedIn',
  'GET /api/account': 'signedIn',
  'PUT /api/account': 'signedIn',
  'POST /api/logout': 'signedIn',
  'GET /api/info': 'signedIn',
  // People: everyone sees who is here; those who look after the server change them.
  'GET /api/people': 'signedIn',
  'POST /api/people': 'admin',
  'PATCH /api/people/:id': 'admin',
  'DELETE /api/people/:id': 'admin',
  'POST /api/info/claude-check': 'admin',
  'PUT /api/push/device': 'signedIn',
  'DELETE /api/push/device/:token': 'signedIn',
  'POST /api/push/test': 'signedIn',

  // The server's own settings and the AI services it uses.
  'GET /api/settings': 'signedIn',
  'GET /api/link-preview': 'signedIn',
  'PATCH /api/settings': 'self',
  'GET /api/claude/auth': 'signedIn',
  'PUT /api/claude/auth': 'admin',
  'DELETE /api/claude/auth': 'admin',
  'GET /api/claude/models': 'signedIn',
  'GET /api/push/apns': 'admin',
  'PUT /api/push/apns': 'admin',
  'DELETE /api/push/apns': 'admin',
  'GET /api/providers': 'signedIn',
  'GET /api/providers/:id/models': 'signedIn',
  'GET /api/providers/:id/model-info': 'signedIn',
  'PUT /api/providers/:id/key': 'admin',
  'POST /api/providers/:id/test': 'admin',
  'POST /api/providers/:id/sign-in': 'admin',
  'GET /api/sign-ins/:id': 'admin',
  'POST /api/sign-ins/:id/paste': 'admin',
  'DELETE /api/sign-ins/:id': 'admin',
  'DELETE /api/providers/:id/sign-in': 'admin',
  'DELETE /api/providers/:id/key': 'admin',
  'POST /api/providers/custom': 'admin',
  'GET /api/providers/discover': 'admin',
  'PATCH /api/providers/:id': 'admin',
  'POST /api/providers/:id/refresh': 'admin',
  'DELETE /api/providers/:id': 'admin',
  'GET /api/ai-endpoints': 'signedIn',
  'PUT /api/ai-endpoints/:kind': 'admin',
  'DELETE /api/ai-endpoints/:kind': 'admin',
  'POST /api/ai-endpoints/:kind/test': 'admin',
  'GET /api/transcribe': 'signedIn',
  'POST /api/transcribe': 'signedIn',
  'GET /api/speech': 'signedIn',
  'POST /api/speech': 'signedIn',
  'GET /api/content-encryption': 'signedIn',
  'PUT /api/content-encryption': 'owner',
  'GET /api/usage': 'admin',
  'GET /api/usage/turns.csv': 'admin',
  'GET /api/usage/plan': 'signedIn',
  // Each person's own Mac: the server's for the owner, the one their desktop app offers for anyone.
  'GET /api/person-computer': 'signedIn',
  'POST /api/person-computer/request': 'signedIn',
  'GET /api/storage': 'admin',

  // Everything at once: only the owner holds every person's data.
  'GET /api/setup-import': 'owner',
  'GET /api/setup-import/projects': 'owner',
  'POST /api/setup-import': 'owner',
  'POST /api/backup': 'owner',
  'GET /api/acp-agents': 'owner',
  'GET /api/tailscale': 'owner',
  'POST /api/tailscale': 'owner',
  'GET /api/backup/:id': 'owner',
  'POST /api/backup/restore': 'owner',
  'GET /api/export/bots': 'admin',
  'POST /api/import/bots': 'admin',
  'POST /api/import/grok-link': 'admin',
  'POST /api/mcp': 'owner',
  'GET /api/mcp': 'owner',
  'DELETE /api/mcp': 'owner',

  // Bots.
  'GET /api/bots': 'self',
  'POST /api/bots': 'signedIn',
  'POST /api/bots/engine': 'admin',
  'GET /api/bots/:id': chat(),
  'PATCH /api/bots/:id': edit(),
  'PUT /api/bots/:id/access': edit(),
  'POST /api/bots/:id/instructions/check': edit(),
  'POST /api/bots/:id/instructions/accept': edit(),
  'POST /api/bots/:id/instructions/decline': edit(),
  'POST /api/bots/:id/move': edit(),
  'POST /api/bots/:id/archive': edit(),
  'POST /api/bots/:id/pause': edit(),
  'GET /api/bots/:id/spend': edit(),
  'POST /api/bots/pause-all': 'admin',
  'POST /api/bots/:id/restore': edit(),
  'DELETE /api/bots/:id': edit(),
  'POST /api/bots/:id/browser/window': edit(),
  'DELETE /api/bots/:id/browser/window': edit(),
  'GET /api/bots/:id/audit': edit(),
  'POST /api/bots/:id/ask': chat(),
  'POST /api/bots/:id/teach': edit(),
  'GET /api/bots/:id/teach': edit(),
  'POST /api/bots/:id/teach/stop': edit(),
  'POST /api/bots/:id/skills/:skillId/replay': edit(),
  'GET /api/bots/:id/conversations': edit(),
  'GET /api/bots/:id/actions': edit(),
  'GET /api/bots/:id/suggestions': edit(),
  'POST /api/bots/:id/suggestions/dismiss': edit(),
  'GET /api/bots/:id/actions.csv': edit(),
  'GET /api/bots/:id/telegram': edit(),
  'PUT /api/bots/:id/telegram': edit(),
  'PATCH /api/bots/:id/telegram': edit(),
  'POST /api/bots/:id/telegram/pair': edit(),
  'DELETE /api/bots/:id/telegram': edit(),
  'POST /api/bots/:id/email': edit(),
  'DELETE /api/bots/:id/email': edit(),
  'PUT /api/bots/:id/email/codes': edit(),
  'GET /api/bots/:id/emails': edit(),
  // A bot's folders hold every conversation's files: only those who may change the bot list them;
  // those who talk with it open the files of their own conversations (checked by the route).
  'GET /api/bots/:id/library': edit(),
  'GET /api/bots/:id/library/zip': chat(),
  'GET /api/bots/:id/library/page': chat(),
  'GET /api/bots/:id/library/file': chat(),
  'GET /api/bots/:id/library/share': edit(),
  'POST /api/bots/:id/library/share': edit(),
  'GET /api/page-shares': 'self',
  'DELETE /api/page-shares/:token': 'self',
  'GET /api/summaries': 'self',
  'GET /api/search': 'self',
  'GET /api/today': 'self',
  // A person's own promises; the handler keeps each person to theirs, admins included.
  'GET /api/promises': 'self',
  'POST /api/promises/:id/done': 'self',
  'POST /api/promises/:id/drop': 'self',
  // Routines suggested from a person's own requests; the handler keeps each person to theirs.
  'GET /api/routine-suggestions': 'self',
  'POST /api/routine-suggestions/:id/accept': 'self',
  'POST /api/routine-suggestions/:id/dismiss': 'self',
  'GET /api/skill-suggestions': 'self',
  'POST /api/skill-suggestions/:id/accept': 'self',
  'POST /api/skill-suggestions/:id/dismiss': 'self',
  'GET /api/turns/:id/result': read('turn'),
  'GET /api/turns/:id/changes': read('turn'),
  'POST /api/turns/:id/undo': write('turn'),
  // How much work stopping the whole server would stop: for those who look after it.
  'GET /api/turns/running': 'admin',

  // A bot's tables.
  'GET /api/bots/:id/tables': chat(),
  'GET /api/tables/:id/rows': chat('table'),
  'GET /api/tables/:id/rows.csv': chat('table'),
  'POST /api/tables/:id/rows': edit('table'),
  'PATCH /api/tables/:id/rows/:rowId': edit('table'),
  'DELETE /api/tables/:id/rows/:rowId': edit('table'),
  'DELETE /api/tables/:id': edit('table'),

  // The board.
  'GET /api/tickets': 'self',
  'POST /api/tickets': 'self',
  'PATCH /api/tickets/:id': 'self',
  'DELETE /api/tickets/:id': 'self',
  'POST /api/tickets/:id/comments': 'self',

  // Skills, plugins, groups.
  'POST /api/plugins/preview': 'admin',
  'POST /api/plugins/install': 'admin',
  'GET /api/skills': 'signedIn',
  'POST /api/skills': 'signedIn',
  'POST /api/skills/fetch': 'signedIn',
  'PATCH /api/skills/:id': 'self',
  'DELETE /api/skills/:id': 'self',
  'GET /api/skill-changes': 'self',
  'POST /api/skill-changes/:id/accept': 'self',
  'POST /api/skill-changes/:id/reject': 'self',
  'PUT /api/skills/:id/bots/:botId': edit('botParam'),
  'GET /api/groups': 'signedIn',
  'POST /api/groups': 'admin',
  'PATCH /api/groups/:id': 'admin',
  'POST /api/groups/:id/move': 'admin',
  'POST /api/groups/:id/pause': 'admin',
  'DELETE /api/groups/:id': 'admin',

  // Conversations.
  'GET /api/bots/:id/threads': chat(),
  'GET /api/bots/:id/main-thread': chat(),
  'POST /api/bots/:id/threads': chat(),
  'DELETE /api/bots/:id/threads': chat(),
  'GET /api/threads/:id': read(),
  'PATCH /api/threads/:id': manage(),
  'DELETE /api/threads/:id': manage(),
  'GET /api/threads/:id/messages': read(),
  'GET /api/threads/:id/live': read(),
  'PUT /api/threads/:id/activity': read(),
  'GET /api/threads/:id/turn-changes': read(),
  'GET /api/threads/:id/action-log': read(),
  'POST /api/threads/:id/messages': write(),
  'PATCH /api/messages/:id': manage('message'),
  'POST /api/messages/:id/steer': write('message'),
  'POST /api/messages/:id/retry': write('message'),
  'POST /api/messages/:id/offer': write('message'),
  'POST /api/messages/:id/card': write('message'),
  'DELETE /api/messages/:id': manage('message'),
  'PUT /api/threads/:id/pin': manage(),
  'POST /api/messages/:id/fork': write('message'),
  'PUT /api/messages/:id/reaction': write('message'),
  'POST /api/threads/:id/files': write(),
  'DELETE /api/threads/:id/files/:name': manage(),
  'DELETE /api/threads/:id/uploads/:uploadId': write(),
  'POST /api/threads/:id/reset': manage(),
  'POST /api/threads/:id/stop': read(),
  'GET /api/apps/:id/frame': read('message'),
  'POST /api/apps/:id/call': write('message'),
  'GET /api/rooms': 'self',
  'POST /api/rooms': 'self',
  'GET /api/rooms/:id': read(),
  'PATCH /api/rooms/:id': read(),
  'DELETE /api/rooms/:id': read(),
  'POST /api/rooms/:id/messages': write(),
  'POST /api/rooms/:id/stop': read(),
  // A room's meetings and minutes are the room's: its person reads, starts, ends and approves them.
  'GET /api/rooms/:id/meetings': read(),
  'POST /api/rooms/:id/meetings': write(),
  'POST /api/rooms/:id/meetings/:meetingId/answer': write(),
  'POST /api/rooms/:id/meetings/:meetingId/end': write(),
  'POST /api/rooms/:id/meetings/:meetingId/resume': write(),
  'POST /api/rooms/:id/meetings/:meetingId/retry': write(),
  'POST /api/rooms/:id/meetings/:meetingId/save': write(),
  'DELETE /api/rooms/:id/meetings/:meetingId': write(),
  'GET /api/jobs/:id': read('job'),
  'GET /api/approvals': 'self',
  'GET /api/approvals/:id': read('approval'),
  'POST /api/approvals/:id': read('approval'),
  // The service keeps each person to the steps waiting for their second yes.
  'GET /api/approvals-second': 'self',
  'POST /api/approvals-second/:id': 'self',
  'GET /api/approvers': 'self',
  'GET /api/rules': 'self',
  'POST /api/rules': 'self',
  'DELETE /api/rules/:id': 'self',

  // Routines.
  'GET /api/routines': 'self',
  'POST /api/routines': 'self',
  // Each routine's health is read only for bots the person may change, inside the service.
  'GET /api/routines/health': 'self',
  'POST /api/routines/:id/health/dismiss': edit('routine'),
  'PATCH /api/routines/:id': edit('routine'),
  'DELETE /api/routines/:id': edit('routine'),
  'POST /api/routines/:id/failure-seen': edit('routine'),
  'POST /api/routines/:id/run': edit('routine'),
  'POST /api/routines/:id/webhook': edit('routine'),
  'DELETE /api/routines/:id/webhook': edit('routine'),
  'PUT /api/routines/:id/webhook-secret': edit('routine'),
  'GET /api/routines/:id/runs': edit('routine'),
  'POST /api/routines/:id/runs/:runId/retry': edit('routine'),
  'POST /api/routines/:id/runs/:runId/end-wait': edit('routine'),
  'GET /api/routines/:id/revisions': edit('routine'),
  // The service keeps each person to the rehearsals they asked for.
  'POST /api/routines/:id/rehearse': edit('routine'),
  'GET /api/routines/:id/rehearsals': edit('routine'),
  'GET /api/routines/:id/rehearsals/:rehearsalId': edit('routine'),
  'GET /api/routines/:id/replayable': edit('routine'),

  // Memory: each person's own notes, and those of the bots they may change (checked by the routes).
  'GET /api/memory': 'self',
  'GET /api/memory/graph': 'self',
  'POST /api/memory': 'self',
  'PATCH /api/memory/:id': 'self',
  'DELETE /api/bots/:id/memory': edit(),
  'DELETE /api/memory/:id': 'self',
  'GET /api/memory-history': 'self',
  'GET /api/memory-changes': 'self',
  'POST /api/memory-changes/:id/accept': 'self',
  'DELETE /api/memory-changes/:id': 'self',
  'GET /api/memory/flags': 'self',
  'POST /api/memory/flags/:id/answer': 'self',
  'POST /api/memory/flags/:id/dismiss': 'self',
  'GET /api/memory-stale': 'self',
  'POST /api/memory-stale/delete': 'self',

  // Connected apps, keys, documents, the vault and the chat apps.
  'GET /api/connections': 'self',
  'GET /api/connections/redirect-url': 'self',
  'POST /api/connections': 'self',
  'GET /api/connections/:id': 'self',
  'PATCH /api/connections/:id': 'self',
  'DELETE /api/connections/:id': 'self',
  'GET /api/connections/:id/sender': 'self',
  'POST /api/connections/:id/refresh': 'self',
  'POST /api/connections/:id/signin': 'self',
  'POST /api/connections/:id/signout': 'self',
  'PATCH /api/connections/:id/tools/:name': 'self',
  'PUT /api/connections/:id/bots': 'self',
  'GET /api/api-sources': 'signedIn',
  'POST /api/api-sources': 'admin',
  'POST /api/api-sources/:id/refresh': 'admin',
  'DELETE /api/api-sources/:id': 'admin',
  'GET /api/api-keys': 'self',
  'POST /api/api-keys': 'self',
  'POST /api/api-keys/import': 'self',
  'POST /api/api-keys/trap': 'self',
  'POST /api/canary-alarms/:id/seen': 'self',
  'PATCH /api/api-keys/:id': 'self',
  'DELETE /api/api-keys/:id': 'self',
  'GET /api/vault': 'self',
  'POST /api/vault': 'self',
  'POST /api/vault/import': 'self',
  'PATCH /api/vault/:id': 'self',
  'DELETE /api/vault/:id': 'self',
  'GET /api/password-managers': 'self',
  'POST /api/password-managers': 'self',
  'PATCH /api/password-managers/:id': 'self',
  'POST /api/password-managers/:id/refresh': 'self',
  'DELETE /api/password-managers/:id': 'self',
  'GET /api/cards': 'self',
  'POST /api/cards': 'self',
  'PATCH /api/cards/:id': 'self',
  'DELETE /api/cards/:id': 'self',
  'GET /api/whatsapp': 'admin',
  'PUT /api/whatsapp': 'admin',
  'POST /api/whatsapp/link': 'admin',
  // The groups of the linked account; the route itself answers only the person who linked it.
  'GET /api/whatsapp/groups': 'admin',
  'DELETE /api/whatsapp': 'admin',
  'GET /api/slack': 'admin',
  'PUT /api/slack': 'admin',
  'PATCH /api/slack': 'admin',
  'DELETE /api/slack': 'admin',
  'GET /api/slack/me': 'self',
  'POST /api/slack/me/code': 'self',
  'DELETE /api/slack/me': 'self',
  'GET /api/teams': 'admin',
  'PUT /api/teams': 'admin',
  'PATCH /api/teams': 'admin',
  'DELETE /api/teams': 'admin',
  'GET /api/teams/me': 'self',
  'POST /api/teams/me/code': 'self',
  'DELETE /api/teams/me': 'self',
  'GET /api/discord': 'admin',
  'PUT /api/discord': 'admin',
  'PATCH /api/discord': 'admin',
  'DELETE /api/discord': 'admin',
  'GET /api/doctor': 'admin',
  'POST /api/doctor/repair': 'admin',
  'GET /api/email': 'admin',
  'POST /api/email/secret': 'admin',
};

/** The rule for a request, by its method and the route it matched. */
export function ruleFor(method: string, route: string): Rule {
  return ROUTE_RULES[`${method === 'HEAD' ? 'GET' : method} ${route}`] ?? 'admin';
}

const param = (req: FastifyRequest, name: string): string => {
  const v = (req.params as Record<string, unknown>)[name];
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'error.notFound');
  return v;
};

async function botOf(s: Services, req: FastifyRequest, via: BotVia): Promise<string> {
  const db = s.ctx.db;
  switch (via) {
    case 'bot':
      return param(req, 'id');
    case 'botParam':
      return param(req, 'botId');
    case 'table': {
      const [row] = await db
        .select({ botId: schema.botTables.botId })
        .from(schema.botTables)
        .where(eq(schema.botTables.id, param(req, 'id')))
        .limit(1);
      if (!row) throw notFound('table');
      return row.botId;
    }
    case 'routine': {
      const [row] = await db
        .select({ botId: schema.routines.botId })
        .from(schema.routines)
        .where(eq(schema.routines.id, param(req, 'id')))
        .limit(1);
      if (!row) throw notFound('routine');
      return row.botId;
    }
  }
}

/** The conversations a route's id leads to; a person must see one of them. */
async function threadsOf(s: Services, req: FastifyRequest, via: ThreadVia): Promise<string[]> {
  const db = s.ctx.db;
  const id = param(req, 'id');
  switch (via) {
    case 'thread':
      return [id];
    case 'message': {
      const [row] = await db
        .select({ threadId: schema.messages.threadId })
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!row) throw notFound('message');
      return [row.threadId];
    }
    case 'turn': {
      const [row] = await db
        .select({ threadId: schema.turns.threadId })
        .from(schema.turns)
        .where(eq(schema.turns.id, id))
        .limit(1);
      if (!row) throw new HttpError(404, 'error.notFound');
      return [row.threadId];
    }
    case 'approval': {
      const [row] = await db
        .select({ threadId: schema.approvals.threadId })
        .from(schema.approvals)
        .where(eq(schema.approvals.id, id))
        .limit(1);
      if (!row) throw notFound('approval');
      return [row.threadId];
    }
    case 'job': {
      const [row] = await db
        .select({ from: schema.jobs.fromThreadId, to: schema.jobs.toThreadId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id))
        .limit(1);
      if (!row) throw notFound('job');
      return [row.from, row.to];
    }
  }
}

/** Refuses a request its person may not make; lets it through otherwise. */
export async function enforceRule(s: Services, req: FastifyRequest, rule: Rule): Promise<void> {
  const p: Principal | null = req.principal;
  if (!p) throw new HttpError(401, 'error.accessKeyRequired');
  if (rule === 'signedIn' || rule === 'self') return;
  if (rule === 'admin') {
    if (!managesServer(p.role)) throw new HttpError(403, 'error.adminOnly');
    return;
  }
  if (rule === 'owner') {
    if (p.role !== 'owner') throw new HttpError(403, 'error.ownerOnly');
    return;
  }
  if ('bot' in rule) {
    await s.access.requireBot(p, await botOf(s, req, rule.via), rule.bot);
    return;
  }
  const ids = await threadsOf(s, req, rule.via);
  let lastErr: unknown = notFound('thread');
  for (const id of ids) {
    try {
      await s.access.requireThread(p, id, rule.thread === 'write', rule.thread === 'manage');
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
