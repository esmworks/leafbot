import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ComputerClient, ComputerError } from '../src/computer/client';

describe('computer service client', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  /** A service that answers a command only after `ms`, as the real one answers when it ends. */
  const slowService = async (ms: number) => {
    server = createServer((_req, res) => {
      const timer = setTimeout(() => res.end(JSON.stringify({ exitCode: 0, output: 'ok' })), ms);
      res.on('close', () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return new ComputerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'token');
  };

  it('a command that outlasts its wait is reported as not answering, not as an unreachable service', async () => {
    const client = await slowService(5_000);
    const err = await client['call']('POST', '/desktops/b/exec', z.unknown(), {}, 1_000).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComputerError);
    expect(err).toMatchObject({ code: 'noAnswer', seconds: 1 });
  });

  it('a service that is not there is unreachable', async () => {
    await slowService(0);
    const port = (server!.address() as AddressInfo).port;
    server!.close();
    server = undefined;
    const gone = new ComputerClient(`http://127.0.0.1:${port}`, 'token');
    await expect(gone.status('b')).rejects.toMatchObject({ code: 'unreachable' });
  });
});
