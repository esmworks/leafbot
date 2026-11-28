import type { T } from '@/i18n';

/** Leaf Bot's own tools, under the server name every engine gives them. */
const OWN = 'leafbot';

/**
 * A permission rule as a person reads it. A connection's tool is named by its service and tool
 * (`mcp__service__create_page` becomes a service name and the tool), and Leaf Bot's own tools lose
 * the server prefix. Null when the pattern reads plainly as it is.
 */
export function ruleLabel(pattern: string, t: T, apps: ReadonlyMap<string, string>): string | null {
  const m = /^mcp__([a-z0-9_]+?)__([^()]+?)(?:\((.*)\))?$/s.exec(pattern.trim());
  if (!m) return null;
  const [, server, tool, args] = m as unknown as [string, string, string, string | undefined];
  const scope = args !== undefined ? ` (${args})` : '';
  if (server === OWN) return `${tool}${scope}`;
  const app = apps.get(server) ?? server;
  if (tool === '*') return `${t('rules.appAllTools', { app })}${scope}`;
  return `${t('rules.appTool', { app, tool })}${scope}`;
}
