import { ApiAuth, ApiCredentialName, ApiOrigin, type ApiSource, type Bot } from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { managesServer } from '../services/access';
import { ApiCallError, GITHUB_ORIGIN } from '../services/api-credentials';
import type { TurnRow } from '../runtime/turns';
import { askPerson, type Define } from './index';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Tools for calling a service with an API key the person saved. The bot asks for a key on a
 * protected card that shows where the key will go; afterwards it names the key in a request and
 * the server adds the key itself. The value never reaches the bot, its prompt or a message.
 */
export function apiTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  /** OpenAPI documents the bot may call; with any, it gets the tools for their operations. */
  sources?: ApiSource[];
  thread: { id: string };
  turn: TurnRow;
  /** Whom the turn works for; null in a team conversation, which uses only the team's keys. */
  own: string | null;
  signal: AbortSignal;
  /** How long a card waits when nobody may be watching (a routine's turn); undefined waits on. */
  unattended?: number;
  t: T;
}): AppTool[] {
  const { def, services: s, bot, thread, turn, own, signal, unattended, t } = opts;
  const sources = opts.sources ?? [];
  const describe = (auth: ApiAuth) =>
    auth.type === 'header'
      ? t('tool.apiAuth.header', { header: auth.header })
      : auth.type === 'query'
        ? t('tool.apiAuth.query', { param: auth.param })
        : t(`tool.apiAuth.${auth.type}`);
  return [
    def(
      'api_keys_list',
      {},
      async () => {
        const keys = await s.apiCredentials.forBot(bot.id, own);
        if (!keys.length) return t('tool.apiKeysNone');
        return keys
          .map((k) => `- ${k.name}: ${k.origin} (${describe(k.auth)})${k.label ? ` — ${k.label}` : ''}`)
          .join('\n');
      },
      'read',
    ),
    def(
      'credential_request',
      {
        key: z.string().max(64),
        origin: z.string().max(500),
        auth: ApiAuth.optional(),
        label: z.string().trim().min(1).max(200),
        why: z.string().max(500).optional(),
      },
      async ({ key, origin, auth, label, why }) => {
        const name = ApiCredentialName.safeParse(key);
        if (!name.success) return t('tool.credentialBadName');
        const where = ApiOrigin.safeParse(origin);
        if (!where.success) return t('tool.credentialBadOrigin');
        // The key typed on the card is the person's own; a team conversation has no one to own it.
        if (!own) return t('tool.credentialTeam');
        const existing = await s.apiCredentials.owned(name.data, own);
        // Their own key under that name, kept for other bots: the person may open it to this bot
        // as it is, or type a new one, which this bot may then use as well.
        const closed = existing?.botIds && !existing.botIds.includes(bot.id) ? existing : null;
        if (closed) {
          const useSaved = t('tool.credentialUseSaved');
          const typeNew = t('tool.credentialTypeNew');
          const c = await askPerson(s, {
            bot,
            thread,
            turn,
            signal,
            timeoutMs: unattended,
            title: t('tool.credentialTitle', { bot: bot.name, label }),
            items: [
              {
                question: t('tool.credentialSavedQuestion', { key: name.data, origin: closed.origin }),
                options: [useSaved, typeNew],
              },
            ],
          });
          if (c.timedOut) return t('tool.questionTimedOut');
          if (c.status === 'expired') return t('tool.questionExpired');
          const pick = c.status === 'allowed' ? c.answers[0] : undefined;
          if (pick === useSaved) {
            await s.apiCredentials.update(closed.id, { botIds: [...closed.botIds!, bot.id] });
            return t('tool.credentialOpened', { key: name.data, origin: closed.origin });
          }
          if (pick !== typeNew) return t('tool.credentialSkipped');
        }
        const how = auth ?? { type: 'bearer' as const };
        // Git on the bot's desktop uses only the team's GitHub key (see `gitToken`), so one who may
        // keep the team's keys is asked on the same card whether this one is the team's.
        const github = where.data === GITHUB_ORIGIN;
        const mayTeam = github && managesServer((await s.access.viewerOf(own)).role);
        const forTeam = t('tool.credentialForTeam');
        const r = await askPerson(s, {
          bot,
          thread,
          turn,
          signal,
          timeoutMs: unattended,
          title: t('tool.credentialTitle', { bot: bot.name, label }),
          items: [
            {
              question: t('tool.credentialQuestion', { label }),
              context: [t('tool.credentialWhere', { origin: where.data, how: describe(how) }), why]
                .filter(Boolean)
                .join(' '),
              options: [],
              secret: true,
            },
            ...(mayTeam
              ? [
                  {
                    question: t('tool.credentialOwnerQuestion'),
                    context: t('tool.credentialOwnerContext'),
                    options: [forTeam, t('tool.credentialForMe')],
                  },
                ]
              : []),
          ],
        });
        if (r.timedOut) return t('tool.questionTimedOut');
        if (r.status === 'expired') return t('tool.questionExpired');
        const value = r.answers[0]?.trim();
        if (r.status !== 'allowed' || !value) return t('tool.credentialSkipped');
        const team = mayTeam && r.answers[1] === forTeam;
        const prior = team ? await s.apiCredentials.owned(name.data, null) : existing;
        const saved = await s.apiCredentials.put(
          {
            name: name.data,
            origin: where.data,
            auth: how,
            label,
            value,
            // A new key is this bot's alone until the person opens it to others in the vault.
            ...(prior ? {} : { botIds: [bot.id] }),
          },
          team ? null : own,
        );
        // A key kept for other bots is opened to this one as well, since it was typed for it.
        const kept = team ? prior : closed;
        if (kept?.botIds && !kept.botIds.includes(bot.id)) {
          await s.apiCredentials.update(saved.id, { botIds: [...kept.botIds, bot.id] });
        }
        const done = { key: name.data, origin: where.data };
        if (team) return t('tool.credentialSavedForGit', done);
        return github ? t('tool.credentialSavedNotGit', done) : t('tool.credentialSaved', done);
      },
      'internal',
    ),
    def(
      'api_request',
      {
        key: z.string().max(64),
        method: z
          .string()
          .transform((m) => m.toUpperCase())
          .pipe(z.enum(METHODS))
          .default('GET'),
        url: z.string().min(1).max(4000),
        headers: z.record(z.string(), z.string().max(4000)).optional(),
        body: z.unknown().optional(),
      },
      async ({ key, method, url, headers, body }) => {
        try {
          const res = await s.apiCredentials.call(bot.id, own, key, { method, url, headers, body }, signal);
          const head = [
            `HTTP ${res.status}${res.type ? ` · ${res.type}` : ''}`,
            res.location && t('tool.apiRedirect', { location: res.location }),
          ]
            .filter(Boolean)
            .join('\n');
          return [head, res.body, res.cut && t('tool.apiCut')].filter(Boolean).join('\n\n');
        } catch (err) {
          if (!(err instanceof ApiCallError)) throw err;
          return t(`tool.apiRefused.${err.reason}`, { detail: err.detail });
        }
      },
      'read',
      // Reading is free like any other read of a service the person gave a key for; anything that
      // changes something there goes by the bot's approval level.
      async ({ method }) => method !== 'GET' && method !== 'HEAD',
    ),
    ...(sources.length
      ? [
          def(
            'api_operations',
            { api: z.string().max(64).optional(), query: z.string().max(200).optional() },
            async ({ api, query }) => {
              if (!api) {
                return sources
                  .map(
                    (x) =>
                      `- ${x.name}: ${x.title || x.baseUrl} (${t('tool.apiOperationCount', { count: x.operations })})`,
                  )
                  .join('\n');
              }
              const ops = await s.apiSources.operations(bot.id, api, query);
              if (!ops)
                return t('tool.apiSourceMissing', { api, names: sources.map((x) => x.name).join(', ') });
              if (!ops.length) return t('tool.apiOperationsNone');
              const shown = ops.slice(0, 60).map((o) => {
                const params = o.params
                  .map((p) => `${p.name}${p.required ? '*' : ''} (${p.in}, ${p.type})`)
                  .join(', ');
                return [
                  `- ${o.id}: ${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ''}`,
                  params && `  ${t('tool.apiParams')}: ${params}`,
                  o.body && `  body: ${o.body}`,
                ]
                  .filter(Boolean)
                  .join('\n');
              });
              return [...shown, ops.length > 60 && t('tool.apiOperationsMore', { count: ops.length - 60 })]
                .filter(Boolean)
                .join('\n');
            },
            'read',
          ),
          def(
            'api_call',
            {
              api: z.string().max(64),
              operation: z.string().max(120),
              params: z.record(z.string(), z.unknown()).optional(),
              body: z.unknown().optional(),
            },
            async ({ api, operation, params, body }) => {
              try {
                const res = await s.apiSources.call(bot.id, own, api, operation, { params, body }, signal);
                const head = [
                  `HTTP ${res.status}${res.type ? ` · ${res.type}` : ''}`,
                  res.location && t('tool.apiRedirect', { location: res.location }),
                ]
                  .filter(Boolean)
                  .join('\n');
                return [head, res.body, res.cut && t('tool.apiCut')].filter(Boolean).join('\n\n');
              } catch (err) {
                if (!(err instanceof ApiCallError)) throw err;
                return t(`tool.apiRefused.${err.reason}`, { detail: err.detail });
              }
            },
            'read',
            // Reading is free; an operation that changes something goes by the bot's approval level.
            async ({ api, operation }) => {
              const ops = await s.apiSources.operations(bot.id, api);
              const op = ops?.find((o) => o.id === operation);
              return !op || (op.method !== 'GET' && op.method !== 'HEAD');
            },
          ),
        ]
      : []),
  ];
}
