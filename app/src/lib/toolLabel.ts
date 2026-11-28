import type { T } from '@/i18n';

/** LeafBot's own tools, under the server name every engine gives them. */
const OWN = 'leafbot';

/**
 * What the bot is doing, in words, from the tool it is running (`Bash`, `Read`,
 * `mcp__notion__search`). Null for a tool the "Working" line has nothing to add for: the browser
 * shows itself, the plan is on screen, and an unknown tool reads as plain thinking.
 */
export function toolLabel(tool: string, t: T, apps: ReadonlyMap<string, string>): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  const server = m?.[1] ?? null;
  const name = m?.[2] ?? tool;
  if (server && server !== OWN) return t('activity.tool.app', { app: apps.get(server) ?? server });
  if (name === 'Bash' || name === 'run_command') return t('activity.tool.shell');
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(name)) return t('activity.tool.files');
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'send_file'].includes(name))
    return t('activity.tool.write');
  if (name === 'WebFetch' || name === 'WebSearch') return t('activity.tool.web');
  if (name === 'api_request') return t('activity.tool.api');
  if (name === 'image_create') return t('activity.tool.image');
  if (name === 'video_create') return t('activity.tool.video');
  if (name === 'slides_create') return t('activity.tool.slides');
  if (name === 'page_to_image') return t('activity.tool.pageImage');
  if (name === 'page_to_video') return t('activity.tool.pageVideo');
  if (name === 'Task' || name === 'Agent') return t('activity.tool.agent');
  if (name === 'Advisor') return t('activity.tool.advisor');
  if (name.startsWith('memory_')) return t('activity.tool.memory');
  return null;
}
