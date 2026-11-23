import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import type { T } from '../i18n';
import { SUBAGENT_RESULT_MAX, type SubagentState } from './types';

/**
 * A Pi bot's helper tool goes by the name Claude bots' does, so its approval wording, rules and the bot's
 * tool selection treat both alike.
 */
export const SUBAGENT_TOOL = 'Agent';

/**
 * Helpers one turn runs at the same time; the rest wait for a free place. Every helper's requests go to
 * the same key, and providers limit a key's requests per minute.
 */
export const SUBAGENTS_AT_ONCE = 4;

/** What a helper's run came to: its answer, or why it has none. */
export interface HelperOutcome {
  text: string;
  /** Why it ended without an answer: a model error, its step limit, calls that kept failing. */
  failed?: string;
  /** The turn was stopped while it worked. */
  stopped?: boolean;
}

/**
 * Runs one task in a conversation of its own and gives back the last answer; `onStep` hears each tool it
 * calls, by the name cards use.
 */
export type HelperRun = (
  task: string,
  signal: AbortSignal,
  onStep: (tool: string) => void,
) => Promise<HelperOutcome>;

/** Lets `size` pieces of work run at once; the others wait in the order they asked. */
export function limiter(size: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running--;
  };
  return {
    /** A place to run in, and the call that frees it; null when `signal` is aborted first. */
    acquire(signal: AbortSignal): Promise<(() => void) | null> {
      if (signal.aborted) return Promise.resolve(null);
      if (running < size) {
        running++;
        return Promise.resolve(once(release));
      }
      return new Promise((resolve) => {
        const start = () => {
          signal.removeEventListener('abort', give);
          resolve(once(release));
        };
        const give = () => {
          const at = queue.indexOf(start);
          if (at >= 0) queue.splice(at, 1);
          resolve(null);
        };
        queue.push(start);
        signal.addEventListener('abort', give, { once: true });
      });
    },
  };
}

function once(fn: () => void) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export type Limiter = ReturnType<typeof limiter>;

const input = (t: T) =>
  z.object({
    description: z.string().min(1).max(200).describe(t('engine.subagentDescription')),
    prompt: z.string().min(1).max(100_000).describe(t('engine.subagentPrompt')),
  });

/**
 * The tool a Pi bot hands a self-contained part of its work to a helper with. Several calls in one message
 * run together, up to the limiter's places; each reports its card as it waits, works and ends.
 */
export function subagentTool(o: {
  t: T;
  run: HelperRun;
  slots: Limiter;
  /** Cuts the answer to what the conversation's room allows. */
  cap: (text: string) => string;
  onSubagent?: (s: SubagentState) => void;
}): AgentTool {
  const { t } = o;
  const schema = input(t);
  const { $schema: _drop, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  const result = (text: string, isError?: boolean): AgentToolResult<undefined> => ({
    content: [{ type: 'text', text }],
    details: undefined,
    ...(isError && { isError: true }),
  });
  return {
    name: SUBAGENT_TOOL,
    label: SUBAGENT_TOOL,
    description: t('engine.subagentTool'),
    parameters: parameters as AgentTool['parameters'],
    // Helpers started in one message work side by side; any other call in that message makes them take turns.
    executionMode: 'parallel',
    execute: async (id, params, signal) => {
      const parsed = schema.safeParse(params ?? {});
      if (!parsed.success) return result(t('tool.invalidInput', { issues: parsed.error.message }), true);
      const stop = signal ?? new AbortController().signal;
      const sub: SubagentState = { id, description: parsed.data.description, state: 'waiting', steps: 0 };
      const show = () => o.onSubagent?.({ ...sub });
      show();
      const free = await o.slots.acquire(stop);
      // A place can come free in the same moment the turn is stopped.
      if (free && stop.aborted) free();
      if (!free || stop.aborted) {
        sub.state = 'stopped';
        show();
        return result(t('engine.stopped'), true);
      }
      sub.state = 'running';
      show();
      let outcome: HelperOutcome;
      try {
        outcome = await o.run(parsed.data.prompt, stop, (tool) => {
          sub.steps += 1;
          sub.tool = tool;
          show();
        });
      } catch (err) {
        outcome = { text: '', failed: (err as Error).message };
      } finally {
        free();
      }
      if (outcome.stopped || stop.aborted) {
        sub.state = 'stopped';
        show();
        return result(t('engine.stopped'), true);
      }
      if (outcome.failed) {
        sub.state = 'failed';
        sub.result = outcome.failed.slice(0, SUBAGENT_RESULT_MAX);
        show();
        return result(t('engine.subagentFailed', { reason: outcome.failed }), true);
      }
      const answer = outcome.text.trim() || t('engine.subagentNoAnswer');
      sub.state = 'done';
      sub.result = answer.slice(0, SUBAGENT_RESULT_MAX);
      show();
      return result(o.cap(answer));
    },
  };
}
