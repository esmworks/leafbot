import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from './services';
import type { AskResult } from './services/bot-api';
import { errorText } from './util';
import { OWNER_ID } from './users';

/** The path an MCP client connects to; under /api/, so the access key guards it like the rest. */
export const MCP_PATH = '/api/mcp';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const answer = (r: AskResult) =>
  text({ status: r.status, reply: r.reply, error: r.error, turnId: r.turnId, threadId: r.threadId });

/** The tools an outside agent gets: the bots, and a way to ask one and read its reply. */
function server(s: Services): McpServer {
  const mcp = new McpServer({ name: 'leafbot', version: '0.10.3' });
  mcp.registerTool(
    'list_bots',
    { description: 'List the bots in Leaf Bot: their ids, names and what each is for.', inputSchema: {} },
    async () =>
      text(
        (await s.bots.list()).map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          engine: b.engine,
        })),
      ),
  );
  mcp.registerTool(
    'ask_bot',
    {
      description:
        'Send a message to a bot in Leaf Bot (by id or name) and wait for its reply. The bot answers in a conversation of its own for API messages. When the wait runs out the status is "running"; read the reply later with get_reply.',
      inputSchema: {
        bot: z.string().min(1).max(100),
        message: z.string().min(1).max(100_000),
        wait_seconds: z.number().int().min(0).max(600).default(120),
      },
    },
    async ({ bot, message, wait_seconds }) => {
      try {
        const target = await s.bots.resolve(bot);
        return answer(
          await s.botApi.ask(target.id, message, { waitMs: wait_seconds * 1000, userId: OWNER_ID }),
        );
      } catch (err) {
        return { ...text({ error: errorText(err, await s.settings.translator()) }), isError: true };
      }
    },
  );
  mcp.registerTool(
    'get_reply',
    {
      description:
        'Read the reply to an earlier ask_bot call by its turnId, waiting up to wait_seconds for it.',
      inputSchema: {
        turn_id: z.string().min(1).max(64),
        wait_seconds: z.number().int().min(0).max(600).default(60),
      },
    },
    async ({ turn_id, wait_seconds }) => {
      try {
        return answer(await s.botApi.result(turn_id, wait_seconds * 1000));
      } catch (err) {
        return { ...text({ error: errorText(err, await s.settings.translator()) }), isError: true };
      }
    },
  );
  return mcp;
}

/**
 * Leaf Bot as an MCP server over streamable HTTP, without sessions: each request gets a fresh
 * server and transport, so nothing has to be kept between calls.
 */
export function registerMcpServer(app: FastifyInstance, s: Services) {
  app.post(MCP_PATH, async (req, reply) => {
    const mcp = server(s);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  // No server-sent stream without sessions.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: MCP_PATH,
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header('allow', 'POST')
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }),
    });
  }
}
