import { z } from 'zod';
import { Id } from './schemas.js';

/**
 * Connections: remote MCP servers (Streamable HTTP) whose tools bots may use. The server is the
 * MCP client. A connection is open to every bot unless the person narrows it to chosen bots.
 */

export const ConnectionAuth = z.enum(['oauth', 'token', 'none']);
export type ConnectionAuth = z.infer<typeof ConnectionAuth>;

export const ConnectionStatus = z.enum(['connected', 'signed-out', 'error']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * At most this many tools of one server are kept. Big catalogs stay usable past what a model takes
 * in one list: Claude bots load tools through tool search, API-key bots through find_tool.
 */
export const MAX_CONNECTION_TOOLS = 1000;
/** At most this many connections. */
export const MAX_CONNECTIONS = 50;

export const ConnectionTool = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  /** What the server marked: read-only (`readOnlyHint`), or anything else. */
  hinted: z.enum(['read', 'write']),
  /** What counts: the person's choice, else the hint. A read tool runs without a card. */
  kind: z.enum(['read', 'write']),
  /** Turned off tools are never given to a bot. */
  enabled: z.boolean(),
  /** It has a view of its own (an MCP app) that shows in the conversation. */
  app: z.boolean().optional(),
});
export type ConnectionTool = z.infer<typeof ConnectionTool>;

export const Connection = z.object({
  id: Id,
  /** The name bots see the tools under (`mcp__<slug>__<tool>`); stable once made. */
  slug: z.string(),
  name: z.string(),
  catalogId: z.string().nullable(),
  url: z.string(),
  auth: ConnectionAuth,
  status: ConnectionStatus,
  /** Why the last check failed, as the server said it. */
  error: z.string().nullable(),
  /** A token is saved (for `token`). */
  hasToken: z.boolean(),
  /** The names of the request headers saved for this server; their values never come back. */
  headerNames: z.array(z.string()).optional(),
  /** The OAuth app's client ID, when one was entered (its secret never comes back). */
  clientId: z.string().nullable(),
  /** The name given to that app, when one was. */
  clientName: z.string().nullable(),
  tools: z.array(ConnectionTool),
  /** Every bot may use the tools, including bots made later; `botIds` is then not used. */
  allBots: z.boolean(),
  /**
   * Whose it is: a person's own, used only when a bot works for them; null for the team's.
   * Missing on older servers.
   */
  userId: z.string().nullable().optional(),
  /** The bots that may use the tools when `allBots` is off. */
  botIds: z.array(Id),
  /** Its tools' views (MCP apps) show in the conversation. */
  showApps: z.boolean().optional(),
  /** A call was refused for lack of scope: signing in again asks for it. */
  needsScope: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'error.connectionUrl');

/** Names that carry the transport's or the sign-in's own business: never set by the person. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'accept',
  'accept-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'cookie',
  'set-cookie',
  'origin',
  'referer',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

/** Whether a header may be set by the person; `auth` is how the connection signs in. */
export function headerNameAllowed(name: string, auth: ConnectionAuth): boolean {
  const n = name.toLowerCase();
  if (RESERVED_HEADERS.has(n) || n.startsWith('proxy-') || n.startsWith('sec-')) return false;
  // With a token or OAuth, `Authorization` is the sign-in's own.
  return n !== 'authorization' || auth === 'none';
}

/**
 * The headers a new connection's form sends: those added, and a name and value typed but not yet
 * added, so a header filled in is not lost by connecting straight away. A later name replaces an
 * earlier one, as names are not told apart by case.
 */
export function formHeaders(
  added: { name: string; value: string }[],
  typed: { name: string; value: string },
): { name: string; value: string }[] {
  const all = [...added, { name: typed.name.trim(), value: typed.value }].filter((h) => h.name && h.value);
  const byName = new Map(all.map((h) => [h.name.toLowerCase(), h]));
  return [...byName.values()];
}

/**
 * A request header for a server. An empty value in an update keeps the one saved under that name,
 * since values never come back to be shown again.
 */
export const ConnectionHeader = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'error.connectionHeaderName'),
  // Visible characters only: a line break would start a header of its own.
  value: z
    .string()
    .max(4000)
    .regex(/^[\x20-\x7e]*$/, 'error.connectionHeaderValue')
    .default(''),
});
export type ConnectionHeader = z.infer<typeof ConnectionHeader>;
const ConnectionHeaders = z
  .array(ConnectionHeader)
  .max(20)
  .refine((list) => new Set(list.map((h) => h.name.toLowerCase())).size === list.length, {
    message: 'error.connectionHeaderName',
  });

export const ConnectionCreate = z.object({
  name: z.string().trim().min(1).max(80),
  url: ConnectionUrl,
  auth: ConnectionAuth,
  catalogId: z.string().max(80).nullable().default(null),
  token: z.string().trim().max(10_000).optional(),
  /** Request headers sent with every call to the server; set by the person only, never by a bot. */
  headers: ConnectionHeaders.optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().trim().max(2000).optional(),
  /** A name for the app `clientId` names, so further accounts can pick it. */
  clientName: z.string().trim().max(80).optional(),
  /**
   * Another account of a service already connected, or another service of the same provider
   * (`client.family`): signs in through that connection's registered app, secret included, so it
   * is not asked for again.
   */
  sameAppAs: Id.optional(),
  /** Open to every bot; off limits it to `botIds`. */
  allBots: z.boolean().default(true),
  /** The bots that may use it when `allBots` is off. */
  botIds: z.array(Id).max(500).default([]),
  /** For the whole team rather than the person setting it up; only those who look after the server. */
  team: z.boolean().optional(),
});
export type ConnectionCreate = z.input<typeof ConnectionCreate>;

export const ConnectionUpdate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: ConnectionUrl.optional(),
  auth: ConnectionAuth.optional(),
  /** A new token; an empty string removes it. */
  token: z.string().trim().max(10_000).optional(),
  /** The whole list: a name left out is removed, a name with an empty value keeps its saved value. */
  headers: ConnectionHeaders.optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().trim().max(2000).optional(),
  showApps: z.boolean().optional(),
  /** Moves it to the team, or back to the person changing it; only those who look after the server. */
  team: z.boolean().optional(),
});
export type ConnectionUpdate = z.input<typeof ConnectionUpdate>;

export const ConnectionToolPatch = z.object({
  enabled: z.boolean().optional(),
  /** null goes back to what the server marked. */
  kind: z.enum(['read', 'write']).nullable().optional(),
});
export type ConnectionToolPatch = z.input<typeof ConnectionToolPatch>;

export const ConnectionBots = z.object({
  allBots: z.boolean(),
  /** Kept only when `allBots` is off. */
  botIds: z.array(Id).max(500).default([]),
});
export type ConnectionBots = z.input<typeof ConnectionBots>;

/** Answer to starting a sign-in: where to send the person, or nothing when already signed in. */
export type ConnectionAuthStart = { url: string | null; connection: Connection };

// ------------------------------------------------------------------------------------ catalog

export const CATALOG_CATEGORIES = [
  'projects',
  'docs',
  'messaging',
  'meetings',
  'design',
  'dev',
  'monitoring',
  'analytics',
  'sales',
  'support',
  'marketing',
  'finance',
  'hr',
  'automation',
  'web',
  'media',
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export interface CatalogEntry {
  /** Stable key, from the name; also the logo's file name (`/connections/<id>.png`). */
  id: string;
  name: string;
  /** The MCP endpoint. */
  url: string;
  auth: ConnectionAuth;
  category: CatalogCategory;
  /** Where to make the token, for token entries. */
  tokenHelp?: string;
  /**
   * The service signs in only apps registered with it beforehand: where to register one (with
   * this server's redirect address), and whether such an app may have no secret.
   */
  client?: {
    help: string;
    secretOptional?: boolean;
    /**
     * Entries of one provider that sign in the same registered app: one already connected lends
     * it to the others, so it is entered once.
     */
    family?: string;
  };
  /** The scopes a sign-in asks for, when not all the service lists. */
  scope?: string;
  /** Shown first, in "Suggested". */
  featured?: boolean;
  /**
   * Write tools whose calls the service hands to a form in their view for the person to send, and
   * the argument that marks a call as sent: a bot's call carries it, so it runs at once. Whether the
   * bot may make the call at all was already decided by its permission settings and cards.
   */
  botSubmits?: { arg: string; tools: readonly string[] };
}

type Row = [
  name: string,
  url: string,
  auth: ConnectionAuth,
  extra?: Pick<CatalogEntry, 'tokenHelp' | 'client' | 'scope' | 'featured' | 'botSubmits'>,
];

const FEATURED = { featured: true } as const;

/**
 * Google's MCP servers sign in an app registered in a Google Cloud project, one for all of them.
 * Each asks only for the scopes its tools use.
 */
function google(...scopes: string[]): NonNullable<Row[3]> {
  return {
    client: {
      help: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
      family: 'google',
    },
    scope: scopes.map((s) => `https://www.googleapis.com/auth/${s}`).join(' '),
  };
}
const DRIVE_SCOPES = ['drive.readonly', 'drive.file'];

/**
 * Services whose remote MCP server can be reached as they are: an OAuth one publishes metadata and
 * takes registrations (or is marked `client`), a token one takes the service's key as a bearer
 * token, an open one answers without a sign-in.
 */
const ROWS: Record<CatalogCategory, Row[]> = {
  projects: [
    [
      'Asana',
      'https://mcp.asana.com/v2/mcp',
      'oauth',
      { client: { help: 'https://app.asana.com/0/my-apps' } },
    ],
    ['Atlassian (Jira, Confluence)', 'https://mcp.atlassian.com/v2/mcp', 'oauth', FEATURED],
    ['Basecamp', 'https://mcp.basecamp.com/mcp', 'oauth'],
    ['ClickUp', 'https://mcp.clickup.com/mcp', 'oauth'],
    ['Linear', 'https://mcp.linear.app/mcp', 'oauth', FEATURED],
    ['monday.com', 'https://mcp.monday.com/mcp', 'oauth'],
    ['Productboard', 'https://mcp.productboard.com/mcp', 'oauth'],
    ['Shortcut', 'https://mcp.shortcut.com/mcp', 'oauth'],
    ['Todoist', 'https://ai.todoist.net/mcp', 'oauth'],
  ],
  docs: [
    ['Airtable', 'https://mcp.airtable.com/mcp', 'oauth'],
    ['AWS Knowledge', 'https://knowledge-mcp.global.api.aws/', 'none'],
    ['Coda', 'https://coda.io/apis/mcp', 'oauth'],
    ['Box', 'https://mcp.box.com/', 'oauth', { client: { help: 'https://app.box.com/developers/console' } }],
    ['Context7', 'https://mcp.context7.com/mcp', 'none'],
    ['DeepWiki', 'https://mcp.deepwiki.com/mcp', 'none'],
    ['Dropbox', 'https://mcp.dropbox.com/mcp', 'oauth'],
    ['Egnyte', 'https://mcp-server.egnyte.com/mcp', 'oauth'],
    ['Evernote', 'https://mcp.evernote.com/mcp', 'oauth'],
    ['GitBook', 'https://mcp.gitbook.com/mcp', 'oauth'],
    ['Google Docs', 'https://docsmcp.googleapis.com/mcp/v1', 'oauth', google(...DRIVE_SCOPES, 'documents')],
    [
      'Google Drive',
      'https://drivemcp.googleapis.com/mcp/v1',
      'oauth',
      { ...google(...DRIVE_SCOPES), ...FEATURED },
    ],
    [
      'Google Sheets',
      'https://sheetsmcp.googleapis.com/mcp/v1',
      'oauth',
      { ...google(...DRIVE_SCOPES, 'spreadsheets'), ...FEATURED },
    ],
    [
      'Google Slides',
      'https://slidesmcp.googleapis.com/mcp/v1',
      'oauth',
      google(...DRIVE_SCOPES, 'presentations'),
    ],
    ['Guru', 'https://mcp.api.getguru.com/mcp', 'oauth'],
    ['Microsoft Learn', 'https://learn.microsoft.com/api/mcp', 'none'],
    ['Mintlify', 'https://mcp.mintlify.com/mcp', 'oauth'],
    ['Notion', 'https://mcp.notion.com/mcp', 'oauth', FEATURED],
    ['Raindrop.io', 'https://api.raindrop.io/rest/v2/ai/mcp', 'oauth'],
    ['Readwise', 'https://mcp2.readwise.io/mcp', 'oauth'],
  ],
  messaging: [
    [
      'Discord',
      'https://mcp.discord.com/mcp',
      'oauth',
      { client: { help: 'https://discord.com/developers/applications', secretOptional: true } },
    ],
    [
      'Gmail',
      'https://gmailmcp.googleapis.com/mcp/v1',
      'oauth',
      // The server's setup guide asks for these three scopes. Compose also lets the Gmail API send
      // mail, which this server does itself while the MCP server lists no tool that sends.
      { ...google('gmail.readonly', 'gmail.compose', 'gmail.modify'), ...FEATURED },
    ],
    [
      'Google Chat',
      'https://chatmcp.googleapis.com/mcp/v1',
      'oauth',
      google(
        'chat.spaces.readonly',
        'chat.memberships.readonly',
        'chat.messages.readonly',
        'chat.messages.create',
        'chat.users.readstate',
      ),
    ],
    [
      'Slack',
      'https://mcp.slack.com/mcp',
      'oauth',
      { client: { help: 'https://api.slack.com/apps' }, ...FEATURED },
    ],
  ],
  meetings: [
    ['Cal.com', 'https://mcp.cal.com/mcp', 'oauth'],
    ['Calendly', 'https://mcp.calendly.com/', 'oauth'],
    ['Dialpad', 'https://mcp.dialpad.com/mcp', 'oauth'],
    ['Fathom', 'https://api.fathom.ai/mcp', 'oauth'],
    ['Fireflies', 'https://api.fireflies.ai/mcp', 'oauth'],
    [
      'Google Calendar',
      'https://calendarmcp.googleapis.com/mcp/v1',
      'oauth',
      {
        ...google('calendar.calendarlist.readonly', 'calendar.events', 'calendar.events.freebusy'),
        ...FEATURED,
      },
    ],
    ['Granola', 'https://mcp.granola.ai/mcp', 'oauth', FEATURED],
    ['Krisp', 'https://mcp.krisp.ai/mcp', 'oauth'],
    ['Otter.ai', 'https://mcp.otter.ai/mcp', 'oauth'],
    ['tl;dv', 'https://mcp.tldv.io/mcp', 'oauth'],
  ],
  design: [
    ['Canva', 'https://mcp.canva.com/mcp', 'oauth', FEATURED],
    ['Contentful', 'https://mcp.contentful.com/mcp', 'oauth'],
    ['Excalidraw', 'https://mcp.excalidraw.com/mcp', 'none'],
    ['Framer', 'https://mcp.framer.com/mcp', 'oauth'],
    ['Gamma', 'https://mcp.gamma.app/mcp', 'oauth'],
    ['Lucid', 'https://mcp.lucid.app/mcp', 'oauth'],
    ['Miro', 'https://mcp.miro.com/', 'oauth'],
    ['Mural', 'https://mcp-canvas.mural.co/mcp', 'oauth'],
    ['Sanity', 'https://mcp.sanity.io/', 'oauth'],
    ['Webflow', 'https://mcp.webflow.com/mcp', 'oauth'],
    ['Whimsical', 'https://mcp.whimsical.com/mcp', 'oauth'],
    ['Wix', 'https://mcp.wix.com/mcp', 'oauth'],
    ['WordPress.com', 'https://public-api.wordpress.com/wpcom/v2/mcp/v1', 'oauth'],
  ],
  dev: [
    ['Algolia', 'https://mcp.algolia.com/mcp', 'oauth'],
    ['Buildkite', 'https://mcp.buildkite.com/mcp', 'oauth'],
    ['CircleCI', 'https://mcp.circleci.com/v1/mcp', 'oauth'],
    ['Clerk', 'https://mcp.clerk.com/mcp', 'oauth'],
    ['ClickHouse', 'https://mcp.clickhouse.cloud/mcp', 'oauth'],
    ['Cloudflare', 'https://mcp.cloudflare.com/mcp', 'oauth'],
    ['Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', 'none'],
    ['DevCycle', 'https://mcp.devcycle.com/mcp', 'oauth'],
    ['DigitalOcean', 'https://mcp.digitalocean.com/mcp', 'oauth'],
    // GitHub takes no registrations: sign-in goes through an OAuth app made for this server.
    [
      'GitHub',
      'https://api.githubcopilot.com/mcp/',
      'oauth',
      {
        client: { help: 'https://github.com/settings/applications/new' },
        scope: 'repo read:org read:user user:email notifications',
        // Opening or changing a pull request or an issue would otherwise wait on a form in GitHub's
        // view until the person presses Submit, though they already let the bot do it.
        botSubmits: {
          arg: '_ui_submitted',
          tools: ['create_pull_request', 'update_pull_request', 'issue_write'],
        },
        ...FEATURED,
      },
    ],
    ['GitLab', 'https://gitlab.com/api/v4/mcp', 'oauth'],
    ['Heroku', 'https://mcp.heroku.com/mcp', 'oauth'],
    ['InstantDB', 'https://mcp.instantdb.com/mcp', 'oauth'],
    ['Jam', 'https://mcp.jam.dev/mcp', 'oauth'],
    ['Neon', 'https://mcp.neon.tech/mcp', 'oauth'],
    ['Netlify', 'https://mcp.netlify.com/mcp', 'oauth'],
    ['Postman', 'https://mcp.postman.com/mcp', 'oauth'],
    ['Prisma Postgres', 'https://mcp.prisma.io/mcp', 'oauth'],
    ['Railway', 'https://mcp.railway.com/', 'oauth'],
    [
      'Render',
      'https://mcp.render.com/mcp',
      'token',
      { tokenHelp: 'https://dashboard.render.com/u/settings?add-api-key' },
    ],
    ['Retool', 'https://mcp.retool.com/mcp', 'oauth'],
    ['Semgrep', 'https://mcp.semgrep.ai/mcp', 'oauth'],
    ['Statsig', 'https://api.statsig.com/v1/mcp', 'oauth'],
    ['Supabase', 'https://mcp.supabase.com/mcp', 'oauth'],
    ['Upstash', 'https://mcp.upstash.com/mcp', 'oauth'],
    ['Vercel', 'https://mcp.vercel.com/', 'oauth'],
    ['WorkOS', 'https://mcp.workos.com/mcp', 'oauth'],
  ],
  monitoring: [
    ['Axiom', 'https://mcp.axiom.co/mcp', 'oauth'],
    ['Cloudflare Observability', 'https://observability.mcp.cloudflare.com/mcp', 'oauth'],
    ['Cloudflare Radar', 'https://radar.mcp.cloudflare.com/mcp', 'oauth'],
    ['Datadog', 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', 'oauth'],
    ['Grafana', 'https://mcp.grafana.com/mcp', 'oauth'],
    ['Honeycomb', 'https://mcp.honeycomb.io/mcp', 'oauth'],
    ['incident.io', 'https://mcp.incident.io/mcp', 'oauth'],
    ['New Relic', 'https://mcp.newrelic.com/mcp/', 'oauth'],
    [
      'PagerDuty',
      'https://mcp.pagerduty.com/mcp',
      'oauth',
      { client: { help: 'https://docs.pagerduty.com/developer/private-apps' } },
    ],
    ['Rootly', 'https://mcp.rootly.com/mcp', 'oauth'],
    ['Sentry', 'https://mcp.sentry.dev/mcp', 'oauth'],
    ['Vanta', 'https://mcp.vanta.com/mcp', 'oauth'],
  ],
  analytics: [
    ['Amplitude', 'https://mcp.amplitude.com/mcp', 'oauth'],
    ['Hex', 'https://app.hex.tech/mcp', 'oauth'],
    ['Mixpanel', 'https://mcp.mixpanel.com/mcp', 'oauth'],
    ['Pendo', 'https://app.pendo.io/mcp/v0/shttp', 'oauth'],
    ['PostHog', 'https://mcp.posthog.com/mcp', 'oauth'],
    ['ThoughtSpot', 'https://agent.thoughtspot.app/mcp', 'oauth'],
  ],
  sales: [
    ['Apollo.io', 'https://mcp.apollo.io/mcp', 'oauth'],
    ['Attio', 'https://mcp.attio.com/mcp', 'oauth'],
    ['Close', 'https://mcp.close.com/mcp', 'oauth'],
    ['Gong', 'https://mcp.gong.io/mcp', 'oauth'],
    [
      'Google Contacts',
      'https://people.googleapis.com/mcp/v1',
      'oauth',
      google('contacts.readonly', 'directory.readonly', 'userinfo.profile'),
    ],
    [
      'HubSpot',
      'https://mcp.hubspot.com/',
      'oauth',
      {
        client: {
          help: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
        },
        ...FEATURED,
      },
    ],
    ['Hunter', 'https://mcp.hunter.io/mcp', 'oauth'],
    ['Instantly', 'https://mcp.instantly.ai/mcp', 'oauth'],
    ['PandaDoc', 'https://mcp.pandadoc.com/v1/mcp', 'oauth'],
    ['ZoomInfo', 'https://mcp.zoominfo.com/mcp', 'oauth'],
  ],
  support: [
    [
      'Front',
      'https://mcp.frontapp.com/mcp',
      'oauth',
      { client: { help: 'https://dev.frontapp.com/docs/create-and-manage-apps' } },
    ],
    ['Help Scout', 'https://mcp.helpscout.net/mcp', 'oauth'],
    ['Intercom', 'https://mcp.intercom.com/mcp', 'oauth'],
  ],
  marketing: [
    ['beehiiv', 'https://mcp.beehiiv.com/mcp', 'oauth'],
    ['Buffer', 'https://mcp.buffer.com/mcp', 'oauth'],
    ['Customer.io', 'https://mcp.customer.io/mcp', 'oauth'],
    ['Jotform', 'https://mcp.jotform.com/', 'oauth'],
    ['Klaviyo', 'https://mcp.klaviyo.com/mcp', 'oauth'],
    ['Resend', 'https://mcp.resend.com/mcp', 'oauth'],
    ['Semrush', 'https://mcp.semrush.com/v1/mcp', 'oauth'],
    ['Similarweb', 'https://mcp.similarweb.com/mcp', 'token'],
    ['Tally', 'https://api.tally.so/mcp', 'oauth'],
    ['Typeform', 'https://api.typeform.com/mcp', 'oauth'],
    // X takes no registrations but signs in a public app without a secret. Without a scope it
    // would ask for every permission it lists, ads and billing among them.
    [
      'X',
      'https://api.x.com/mcp',
      'oauth',
      {
        client: { help: 'https://developer.x.com/en/portal/dashboard', secretOptional: true },
        scope:
          'tweet.read tweet.write users.read follows.read like.read list.read bookmark.read bookmark.write media.write offline.access',
      },
    ],
  ],
  finance: [
    ['Airwallex', 'https://mcp.airwallex.com/mcp', 'oauth'],
    ['Daloopa', 'https://mcp.daloopa.com/server/mcp', 'oauth'],
    ['FactSet', 'https://mcp.factset.com/mcp', 'oauth'],
    ['Mercury', 'https://mcp.mercury.com/mcp', 'oauth'],
    ['Morningstar', 'https://mcp.morningstar.com/mcp', 'oauth'],
    ['Paddle', 'https://mcp.paddle.com/mcp', 'oauth'],
    ['PayPal', 'https://mcp.paypal.com/mcp', 'oauth'],
    ['PitchBook', 'https://mcp.pitchbook.com/mcp', 'oauth'],
    ['Plaid', 'https://mcp.plaid.com/mcp', 'oauth'],
    ['Ramp', 'https://mcp.ramp.com/mcp', 'oauth'],
    ['Square', 'https://mcp.squareup.com/mcp', 'oauth'],
    ['Stripe', 'https://mcp.stripe.com/', 'oauth'],
    [
      'Xero',
      'https://mcp.xero.com/mcp',
      'oauth',
      { client: { help: 'https://developer.xero.com/app/manage' } },
    ],
  ],
  hr: [
    ['15Five', 'https://mcp.15five.com/mcp', 'oauth'],
    ['Greenhouse', 'https://mcp.greenhouse.io/mcp', 'oauth'],
    ['Remote', 'https://mcp.remote.com/mcp', 'oauth'],
    ['Workable', 'https://mcp.workable.com/mcp', 'oauth'],
  ],
  automation: [
    ['IFTTT', 'https://ifttt.com/mcp', 'oauth'],
    ['Make', 'https://mcp.make.com/', 'oauth'],
    ['Zapier', 'https://mcp.zapier.com/api/v1/connect', 'oauth', FEATURED],
  ],
  web: [
    ['Apify', 'https://mcp.apify.com/', 'oauth'],
    ['Bright Data', 'https://mcp.brightdata.com/mcp', 'oauth'],
    ['Exa', 'https://mcp.exa.ai/mcp', 'none'],
    ['Kiwi.com', 'https://mcp.kiwi.com/', 'none'],
    ['Mapbox', 'https://mcp.mapbox.com/mcp', 'oauth'],
    ['Tavily', 'https://mcp.tavily.com/mcp', 'oauth'],
  ],
  media: [
    ['ElevenLabs', 'https://api.us.elevenlabs.io/v1/mcp', 'oauth'],
    ['Hugging Face', 'https://huggingface.co/mcp', 'none'],
    ['invideo', 'https://mcp.invideo.io/mcp', 'oauth'],
    ['Mux', 'https://mcp.mux.com/', 'oauth'],
    ['Replicate', 'https://mcp.replicate.com/mcp', 'oauth'],
    ['Vimeo', 'https://mcp.vimeo.com/mcp', 'oauth'],
  ],
};

const idOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const CONNECTION_CATALOG: readonly CatalogEntry[] = CATALOG_CATEGORIES.flatMap((category) =>
  ROWS[category].map(([name, url, auth, extra]) => ({ id: idOf(name), name, url, auth, category, ...extra })),
);

const byId = new Map(CONNECTION_CATALOG.map((e) => [e.id, e]));

export function catalogEntry(id: string | null | undefined): CatalogEntry | undefined {
  return id ? byId.get(id) : undefined;
}

/**
 * The arguments of a bot's call to a connection's tool: marked as a sent form where the service
 * would otherwise wait for the person to send one (see `botSubmits`).
 */
export function botToolArgs(
  conn: { url: string },
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // By the address, not the entry a connection names: the mark means something only to that service.
  const submits = CONNECTION_CATALOG.find((e) => e.botSubmits && e.url === conn.url)?.botSubmits;
  return submits?.tools.includes(tool) ? { ...args, [submits.arg]: true } : args;
}

/**
 * Whether one connection's registered app may serve another: the same address, or catalog entries
 * of one provider each at its own catalog address (a stored secret never goes to an address the
 * catalog does not name).
 */
export function sharesApp(
  a: { url: string; catalogId: string | null | undefined },
  b: { url: string; catalogId: string | null | undefined },
): boolean {
  if (addressKey(a.url) === addressKey(b.url)) return true;
  const ea = catalogEntry(a.catalogId);
  const eb = catalogEntry(b.catalogId);
  return (
    !!ea?.client?.family &&
    ea.client.family === eb?.client?.family &&
    addressKey(a.url) === addressKey(ea.url) &&
    addressKey(b.url) === addressKey(eb.url)
  );
}

/** An address without its trailing slash, query or host case: how addresses are compared. */
export function addressKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/** Entries whose name, address or (translated) category matches every word of the query. */
export function searchCatalog(query: string, categoryLabel: (c: CatalogCategory) => string): CatalogEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...CONNECTION_CATALOG];
  return CONNECTION_CATALOG.filter((e) => {
    const text = `${e.name} ${new URL(e.url).host} ${categoryLabel(e.category)}`.toLocaleLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Where an entry's logo is served from (the app's public folder). */
export const catalogLogo = (id: string) => `/connections/${id}.png`;

/**
 * The name a connection's tools go under, from its name: lower-case letters, digits and `_`,
 * short enough that `mcp__<slug>__<tool>` stays within the 64 characters models accept.
 */
export function connectionSlug(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\(.*\)/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20)
      .replace(/_+$/, '') || 'mcp';
  const used = new Set(taken);
  // Reserved: the app's own tools.
  used.add('leafbot');
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const s = `${base.slice(0, 17)}_${i}`;
    if (!used.has(s)) return s;
  }
}
