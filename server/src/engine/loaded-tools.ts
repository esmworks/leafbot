import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_SERVER, type AppTool } from './types';

/**
 * What a session was shown of a tool when it loaded it, as one digest of its words and its
 * top-level fields: a server keeps many sessions, and descriptions run to pages.
 */
type Seen = string;

interface Read {
  file: string;
  /** Up to where the transcript has been read, at a line's end. */
  offset: number;
  tools: Map<string, Seen>;
}

/** How many sessions' reads are kept between turns. */
const SESSIONS_KEPT = 500;
/** The most of a transcript read in one go; a longer one is read on at the next turn. */
const READ_MAX = 64 * 1024 * 1024;

const fieldsOf = (properties: unknown) =>
  properties && typeof properties === 'object' ? Object.keys(properties).sort().join(',') : '';
const digest = (description: string, properties: unknown) =>
  createHash('sha256').update(description).update('\0').update(fieldsOf(properties)).digest('base64url');

/** The folder the CLI keeps a working folder's sessions in: every other sign becomes `-`. */
export const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Which tools a resumed Claude session holds an out-of-date definition of. The CLI loads a tool
 * that waits behind its tool search once in a session and keeps the definition it got then, also
 * after the server comes back with a changed one; the bot then says a field it has is missing.
 * Read from the session's transcript, where each load is kept; anything that cannot be read
 * counts as nothing changed, so a resume never fails for it.
 */
export class LoadedTools {
  private reads = new Map<string, Read>();

  async changed(configDir: string, cwd: string, sessionId: string, tools: AppTool[]): Promise<string[]> {
    try {
      const seen = await this.seen(configDir, cwd, sessionId);
      if (!seen?.size) return [];
      const out: string[] = [];
      for (const tool of tools) {
        const name = `mcp__${tool.server ?? APP_SERVER}__${tool.name}`;
        const was = seen.get(name);
        if (!was) continue;
        const now = digest(tool.description, tool.jsonSchema ? tool.jsonSchema.properties : tool.input);
        if (was !== now) out.push(tool.name);
      }
      return out;
    } catch {
      return [];
    }
  }

  private async seen(configDir: string, cwd: string, sessionId: string): Promise<Map<string, Seen> | null> {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    let read = this.reads.get(sessionId);
    if (!read) {
      const file = await this.find(configDir, cwd, sessionId);
      if (!file) return null;
      read = { file, offset: 0, tools: new Map() };
      this.reads.set(sessionId, read);
      // The sessions looked at longest ago go first; one comes back by reading its transcript again.
      if (this.reads.size > SESSIONS_KEPT) this.reads.delete(this.reads.keys().next().value!);
    }
    const size = (await stat(read.file)).size;
    // A transcript written anew from the start is read again from there.
    if (size < read.offset) {
      read.offset = 0;
      read.tools.clear();
    }
    if (size === read.offset) return read.tools;
    const length = Math.min(size - read.offset, READ_MAX);
    const handle = await open(read.file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, read.offset);
      // Only whole lines: a line still being written is read with the rest next time.
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) return read.tools;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"deferred_tools_record"')) continue;
        let entry: { attachment?: { type?: string; entries?: unknown } };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }
        if (entry.attachment?.type !== 'deferred_tools_record' || !Array.isArray(entry.attachment.entries))
          continue;
        for (const e of entry.attachment.entries as Record<string, unknown>[]) {
          if (typeof e.name !== 'string' || typeof e.description !== 'string') continue;
          const schema = e.input_schema as { properties?: unknown } | undefined;
          read.tools.set(e.name, digest(e.description, schema?.properties));
        }
      }
      read.offset += end + 1;
    } finally {
      await handle.close();
    }
    return read.tools;
  }

  /** The session's transcript: in its working folder's project folder, or found among the others. */
  private async find(configDir: string, cwd: string, sessionId: string): Promise<string | null> {
    const projects = join(configDir, 'projects');
    const named = join(projects, projectFolder(cwd), `${sessionId}.jsonl`);
    if (existsSync(named)) return named;
    // A long working folder's project folder is cut short and marked, so it is looked for.
    for (const folder of await readdir(projects).catch(() => [] as string[])) {
      const file = join(projects, folder, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
    return null;
  }
}
