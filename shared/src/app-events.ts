/**
 * Ready-made webhook triggers for apps that call a web address when something happens in them: the
 * person picks an app and an event, and the routine's webhook filter is written for it. Each app
 * also says how it proves a call is its own:
 *
 * - `token`: the app signs with a secret the person types in there; the routine's own webhook
 *   secret is that secret, so there is nothing to paste back.
 * - `secret`: the app makes the secret itself; the person pastes it into the routine, which then
 *   turns away every call that is not signed with it.
 *
 * What the filter reads: the call's JSON body, plus the kind of event the app names in a header
 * (GitHub, GitLab, Shopify, Sentry) as `event`.
 */
export const APP_EVENT_SOURCES = [
  {
    app: 'github',
    name: 'GitHub',
    sign: 'token',
    events: [
      { id: 'issueOpened', filter: 'event=issues\naction=opened' },
      { id: 'issueComment', filter: 'event=issue_comment\naction=created' },
      { id: 'prOpened', filter: 'event=pull_request\naction=opened' },
      { id: 'prMerged', filter: 'event=pull_request\naction=closed\npull_request.merged=true' },
      { id: 'push', filter: 'event=push' },
      { id: 'release', filter: 'event=release\naction=published' },
      {
        id: 'workflowFailed',
        filter: 'event=workflow_run\naction=completed\nworkflow_run.conclusion=failure',
      },
    ],
  },
  {
    app: 'gitlab',
    name: 'GitLab',
    sign: 'token',
    events: [
      { id: 'issueOpened', filter: 'object_kind=issue\nobject_attributes.action=open' },
      { id: 'mrOpened', filter: 'object_kind=merge_request\nobject_attributes.action=open' },
      { id: 'mrMerged', filter: 'object_kind=merge_request\nobject_attributes.action=merge' },
      { id: 'push', filter: 'object_kind=push' },
      { id: 'pipelineFailed', filter: 'object_kind=pipeline\nobject_attributes.status=failed' },
    ],
  },
  {
    app: 'stripe',
    name: 'Stripe',
    sign: 'secret',
    events: [
      { id: 'paymentSucceeded', filter: 'type=payment_intent.succeeded' },
      { id: 'paymentFailed', filter: 'type=payment_intent.payment_failed' },
      { id: 'checkoutCompleted', filter: 'type=checkout.session.completed' },
      { id: 'subscriptionCanceled', filter: 'type=customer.subscription.deleted' },
      { id: 'invoiceFailed', filter: 'type=invoice.payment_failed' },
    ],
  },
  {
    app: 'shopify',
    name: 'Shopify',
    sign: 'secret',
    events: [
      { id: 'orderCreated', filter: 'event=orders/create' },
      { id: 'orderPaid', filter: 'event=orders/paid' },
      { id: 'customerCreated', filter: 'event=customers/create' },
    ],
  },
  {
    app: 'linear',
    name: 'Linear',
    sign: 'secret',
    events: [
      { id: 'issueCreated', filter: 'type=Issue\naction=create' },
      { id: 'commentCreated', filter: 'type=Comment\naction=create' },
    ],
  },
  {
    app: 'sentry',
    name: 'Sentry',
    sign: 'secret',
    events: [
      { id: 'issueCreated', filter: 'event=issue\naction=created' },
      { id: 'alertTriggered', filter: 'event=event_alert\naction=triggered' },
    ],
  },
  {
    app: 'calendly',
    name: 'Calendly',
    sign: 'token',
    events: [
      { id: 'inviteeCreated', filter: 'event=invitee.created' },
      { id: 'inviteeCanceled', filter: 'event=invitee.canceled' },
    ],
  },
  {
    app: 'typeform',
    name: 'Typeform',
    sign: 'token',
    events: [{ id: 'formResponse', filter: 'event_type=form_response' }],
  },
] as const;

export type AppEventSource = (typeof APP_EVENT_SOURCES)[number];
export type AppEventApp = AppEventSource['app'];

/** The first line of a filter written from the catalog, naming its app and event. */
const MARK = /^#\s*app:([a-z]+)\/([A-Za-z]+)\s*$/;

/** The filter for one app's event, its first line naming them so the routine shows which it is. */
export function appEventFilter(app: string, event: string): string | null {
  const source = APP_EVENT_SOURCES.find((s) => s.app === app);
  const e = source?.events.find((x) => x.id === event);
  return source && e ? `# app:${source.app}/${e.id}\n${e.filter}` : null;
}

/**
 * Which app and event a filter was written for, while its conditions are still the catalog's; null
 * once the person changed them (or for a filter of their own).
 */
export function appEventOf(filter: string): { app: AppEventApp; event: string } | null {
  const [first, ...rest] = filter.trim().split('\n');
  const m = MARK.exec(first?.trim() ?? '');
  if (!m) return null;
  const written = appEventFilter(m[1]!, m[2]!);
  if (!written) return null;
  const same = (a: string) =>
    a
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  return same(written.split('\n').slice(1).join('\n')) === same(rest.join('\n'))
    ? { app: m[1] as AppEventApp, event: m[2]! }
    : null;
}

/** Whether calls from this app are signed with a secret the app makes, which the person pastes in. */
export const appMakesSecret = (app: string) =>
  APP_EVENT_SOURCES.find((s) => s.app === app)?.sign === 'secret';
