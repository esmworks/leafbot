// A coding agent that speaks the Agent Client Protocol over stdin/stdout, for tests: it answers
// with what it was asked, and with "crash" in the message it exits mid-turn.
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream } from '@agentclientprotocol/sdk';

const app = agent({ name: 'fixture' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  .onRequest('session/new', () => ({ sessionId: 'p1' }))
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (text.includes('crash')) {
      process.stderr.write('fixture: crashed on purpose\n');
      process.exit(3);
    }
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `cwd=${process.cwd()} secret=${process.env.LEAFBOT_ACCESS_KEY ?? 'none'}`,
        },
      },
    });
    return { stopReason: 'end_turn' };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
