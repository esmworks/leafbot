import { agent as acpAgent, type AgentApp, type SessionUpdate } from '@agentclientprotocol/sdk';

/** What the fake agent was asked, and what it heard back. */
export interface Seen {
  prompts: string[];
  loads: string[];
  cancelled: boolean;
  answers: unknown[];
  toolResults: unknown[];
}

/**
 * A coding agent speaking the protocol, in this process: what it does with a prompt is `onPrompt`.
 */
export function fakeAgent(opts: {
  loadSession?: boolean;
  http?: boolean;
  onPrompt?: (
    say: (u: SessionUpdate) => Promise<void>,
    ctx: {
      ask: (u: unknown) => Promise<unknown>;
      mcpUrl: string | null;
      seen: Seen;
      cancelled: Promise<void>;
    },
  ) => Promise<string>;
}) {
  const seen: Seen = { prompts: [], loads: [], cancelled: false, answers: [], toolResults: [] };
  let mcpUrl: string | null = null;
  let onCancel = () => {};
  const cancelled = new Promise<void>((r) => (onCancel = r));
  const app: AgentApp = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: !!opts.loadSession, mcpCapabilities: { http: !!opts.http } },
    }))
    .onRequest('session/new', ({ params }) => {
      mcpUrl = params.mcpServers.find((s) => 'url' in s)?.url ?? null;
      return { sessionId: 's1' };
    })
    .onRequest('session/load', async ({ params, client }) => {
      seen.loads.push(params.sessionId);
      if (params.sessionId !== 's1') throw new Error('no such session');
      mcpUrl = params.mcpServers.find((s) => 'url' in s)?.url ?? null;
      // A loaded session replays its past first.
      await client.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD ' } },
      });
      return {};
    })
    .onNotification('session/cancel', () => {
      seen.cancelled = true;
      onCancel();
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      const first = params.prompt[0];
      seen.prompts.push(first?.type === 'text' ? first.text : '');
      const say = (update: SessionUpdate) =>
        client.notify('session/update', { sessionId: params.sessionId, update });
      const ask = async (toolCall: unknown) => {
        const answer = await client.request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: toolCall as never,
          options: [
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Always', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        seen.answers.push(answer.outcome);
        return answer.outcome;
      };
      const stop = await (
        opts.onPrompt ??
        (async (s) => {
          await s({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Merhaba' } });
          return 'end_turn';
        })
      )(say, { ask, mcpUrl, seen, cancelled });
      return { stopReason: stop as 'end_turn' };
    });
  return { app, seen };
}
