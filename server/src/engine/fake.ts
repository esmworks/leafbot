import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  resultImages,
  resultText,
  runCost,
  SILENT_REPLY,
  toolPermName,
  type CompactOutcome,
  type CompactRequest,
  type CompleteRequest,
  type Completion,
  type Engine,
  type ModelTest,
  type GateRequest,
  type GateVerdict,
  type TurnOutcome,
  type TurnRequest,
} from './types';

/**
 * Deterministic engine for tests and offline development.
 * Directives in the prompt drive it:
 *   [izin:Tool {json}]   ask permission for Tool with the given input
 *   [araç:name {json}]   call an app tool and include its result
 *   [dosya:Write {json}] a file tool as an engine runs it: looked at, asked, then done (`Write` with
 *                        `file_path` and `content`, or `Edit` with `file_path`, `old_string`, `new_string`)
 *   [bekle:ms]           wait (stops early on interrupt)
 *   [uzun-araç:ms]       a shell command that runs this long (stops early on interrupt)
 *   [hata]               fail with an engine error
 *   [meşgul-sonra]       after the directives before it, fail as an overloaded server
 *   [kesik]              after the directives before it, cut the reply off on the turn's first run
 *   [kesik-hep]          after the directives before it, cut the reply off on every run
 *   [özet]               report that the conversation was condensed into a summary
 *   [çöktü]              after the directives before it, the Claude Code process dies on the turn's first run
 *   [çöktü-hep]          after the directives before it, it dies on every run of a Claude model
 *   [bakiye]             fail as if the provider's balance were spent (a backup is not under it)
 *   [giriş-yok]          fail as if logged out
 *   [sınır]              fail as if the usage limit were spent until 2026-11-16 09:00 UTC
 *   [sınır-sonra]        after the directives before it, fail as [sınır] does
 *   [adım-sınırı]        run out of steps mid-task
 *   [boş]                finish without any text
 *   [plan]               write a two-step plan, then move it on
 *   [sessiz]             answer with the silent reply
 *   [maliyet:0.42]       spend this much in US dollars on the turn
 *   [bağlam:150000]      leave the session this many tokens full
 * Like Claude, it reports cost as the session's running total, which a resumed session goes on from.
 * Without directives it echoes the prompt. Each session counts its turns, so resume can be checked.
 * A session passed to `forget` is gone, as when its transcript was deleted.
 */
export class FakeEngine implements Engine {
  readonly kind = 'fake';
  private sessions = new Map<string, number>();
  private lost = new Set<string>();
  private fresh = new Map<string, number>();
  private totals = new Map<string, number>();
  /** Turns whose reply `[kesik]` has cut off once already. */
  private cutTurns = new Set<string>();
  private crashedTurns = new Set<string>();
  public requests: TurnRequest[] = [];
  public gates: GateRequest[] = [];
  /** The requests of `complete`, and what answers them (the memory review); a test sets `completer`. */
  public completions: CompleteRequest[] = [];
  public completer: (req: CompleteRequest) => string | Promise<string> = () => '{"operations":[]}';

  async complete(req: CompleteRequest): Promise<Completion> {
    this.completions.push(req);
    return { text: await this.completer(req), costUsd: 0.001 };
  }

  /**
   * The routine pre-check, by words in the input: "önemsiz" says the run has nothing to work on,
   * "kapı-hatası" fails the check; anything else lets the run go ahead.
   */
  async gate(req: GateRequest): Promise<GateVerdict> {
    this.gates.push(req);
    if (req.input.includes('kapı-hatası')) throw new Error('Sahte ön kontrol hatası');
    if (req.input.includes('önemsiz'))
      return { decision: 'skip', reason: 'Sahte ön kontrol: yeni bir şey yok.', costUsd: 0.001 };
    return { decision: 'run', reason: 'Sahte ön kontrol: bakmaya değer.', costUsd: 0.001 };
  }

  forget(sessionId: string) {
    this.lost.add(sessionId);
    this.sessions.delete(sessionId);
  }

  /** A new session's id: the thread's own the first time, numbered after that. */
  private newSession(threadId: string): string {
    const n = this.fresh.get(threadId) ?? 0;
    this.fresh.set(threadId, n + 1);
    return n ? `fake-${threadId}-${n}` : `fake-${threadId}`;
  }

  async run(req: TurnRequest): Promise<TurnOutcome> {
    const outcome = await this.turn(req);
    if (outcome.costUsd == null || !outcome.sessionId) return outcome;
    const total = (this.totals.get(outcome.sessionId) ?? 0) + outcome.costUsd;
    this.totals.set(outcome.sessionId, total);
    return {
      ...outcome,
      costUsd: runCost(total, req.sessionId ? req.sessionCostUsd : null),
      sessionCostUsd: total,
    };
  }

  /** The run, with `costUsd` what it spent itself. */
  private async turn(req: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(req);
    if (req.sessionId && this.lost.has(req.sessionId)) {
      return { ok: false, kind: 'lostSession', message: 'No conversation found', text: '', sessionId: null };
    }
    const sessionId = req.sessionId ?? this.newSession(req.threadId);
    const n = (this.sessions.get(sessionId) ?? 0) + 1;
    this.sessions.set(sessionId, n);
    req.onSession(sessionId);

    if (req.prompt.includes('[sınır-yakın]')) {
      req.onLimitNear?.({ used: 0.92, resetsAt: new Date('2026-11-16T09:00:00.000Z') });
    }
    // Overloaded, the way a busy model server answers; a backup (`provider/model`) is not.
    if (req.prompt.includes('[meşgul]') && !req.model.includes('/')) {
      return { ok: false, kind: 'engine', message: 'overloaded_error', text: '', sessionId, transient: true };
    }
    // A resumed conversation that no longer fits; a new session starts with room.
    if (req.prompt.includes('[bağlam-dolu]') && req.sessionId) {
      return {
        ok: false,
        kind: 'engine',
        message: 'prompt is too long: 210000 tokens > 200000 maximum',
        text: '',
        sessionId,
        costUsd: 0,
      };
    }
    // The same, in a wording only the engine itself recognises as an overflow.
    if (req.prompt.includes('[bağlam-bayrak]') && req.sessionId) {
      return {
        ok: false,
        kind: 'engine',
        message: 'Range of input length should be [1, 30720]',
        text: '',
        sessionId,
        costUsd: 0,
        contextFull: true,
        summary: 'ÖZET: devredilen konuşma',
      };
    }
    // The limit, only the first time this text is sent; it reset a moment ago.
    if (
      req.prompt.includes('[sınır-bir-kez]') &&
      this.requests.filter((r) => r.prompt === req.prompt).length === 1
    ) {
      return {
        ok: false,
        kind: 'limit',
        message: 'rate limited',
        text: '',
        sessionId,
        resetsAt: new Date(Date.now() - 29_800),
      };
    }
    // A helper the bot starts for part of the work: it takes two steps and finishes.
    if (req.prompt.includes('[alt-ajan]')) {
      const sub = { id: 'fake-sub', description: 'Kaynakları tara', state: 'running' as const, steps: 0 };
      req.onSubagent?.(sub);
      req.onSubagent?.({ ...sub, steps: 1, tool: 'Grep' });
      req.onSubagent?.({ ...sub, steps: 2, tool: 'WebSearch' });
      req.onSubagent?.({ ...sub, steps: 2, tool: 'WebSearch', state: 'done', result: 'Üç kaynak bulundu.' });
    }
    // A call that keeps failing the same way, past the warning: the turn is stopped.
    if (req.prompt.includes('[döngü]')) {
      req.onRepeatedFailure?.('mcp__notion__search', 5);
      if (req.signal.aborted)
        return { ok: false, kind: 'interrupted', message: 'Durduruldu', text: '', sessionId };
    }
    if (req.prompt.includes('[adım-sınırı]')) {
      return { ok: false, kind: 'engine', message: 'Adım sınırı', text: '', sessionId, stepLimit: true };
    }
    if (req.prompt.includes('[bakiye]') && !req.model.includes('/')) {
      return {
        ok: false,
        kind: 'engine',
        message: 'Credit balance is too low',
        text: '',
        sessionId,
        billing: true,
      };
    }
    // A model the provider retired; a backup (`provider/model`) is still offered.
    if (req.prompt.includes('[model-yok]') && !req.model.includes('/')) {
      return {
        ok: false,
        kind: 'engine',
        message: 'not_found_error: model',
        text: '',
        sessionId,
        modelGone: true,
      };
    }
    if (req.prompt.includes('[giriş-yok]') && !req.model.includes('/')) {
      return { ok: false, kind: 'auth', message: 'Not logged in', text: '', sessionId };
    }
    // The usage limit is the Claude account's; a `provider/model` (a backup) is not under it.
    if (req.prompt.includes('[sınır]') && !req.model.includes('/')) {
      return {
        ok: false,
        kind: 'limit',
        message: 'rate limited',
        text: '',
        sessionId,
        resetsAt: new Date('2026-11-16T09:00:00.000Z'),
      };
    }
    if (req.prompt.includes('[plan]')) {
      req.onPlan?.([
        { text: 'Oku', status: 'in_progress' },
        { text: 'Yaz', status: 'pending' },
      ]);
      await Promise.resolve();
      req.onPlan?.([
        { text: 'Oku', status: 'completed' },
        { text: 'Yaz', status: 'in_progress' },
      ]);
    }
    if (req.prompt.includes('[boş]')) return { ok: true, text: '', sessionId, costUsd: 0 };
    if (req.prompt.includes('[sessiz]')) {
      req.onText(SILENT_REPLY.slice(0, 3));
      req.onText(SILENT_REPLY.slice(3));
      return { ok: true, text: SILENT_REPLY, sessionId, costUsd: 0 };
    }
    // Says why there is nothing to report, then gives the silent reply on its own line.
    if (req.prompt.includes('[sessiz-son]')) {
      const text = `Değişiklik yok.\n\n${SILENT_REPLY}`;
      req.onText(text);
      return { ok: true, text, sessionId, costUsd: 0 };
    }
    const cost = /\[maliyet:(\d+(?:\.\d+)?)\]/.exec(req.prompt);
    const spent = cost ? Number(cost[1]) : 0;
    const parts: string[] = [];
    const directive =
      /\[(izin|araç|dosya|uzun-araç|bekle|hata|özet|meşgul-sonra|sınır-sonra|kesik|kesik-hep|çöktü|çöktü-hep)(?::([^\s\]]+))?(?:\s+(\{.*?\}))?\](?=\s|$)/g;
    for (const m of req.prompt.matchAll(directive)) {
      const [, kind, name, json] = m;
      if (req.signal.aborted) break;
      if (kind === 'hata') {
        return {
          ok: false,
          kind: 'engine',
          message: 'Sahte motor hatası',
          text: parts.join('\n'),
          sessionId,
          costUsd: spent,
        };
      }
      if (kind === 'sınır-sonra' && !req.model.includes('/')) {
        return {
          ok: false,
          kind: 'limit',
          message: 'rate limited',
          text: '',
          sessionId,
          resetsAt: new Date('2026-11-16T09:00:00.000Z'),
        };
      }
      if (kind === 'kesik-hep' || (kind === 'kesik' && !this.cutTurns.has(req.turnId))) {
        this.cutTurns.add(req.turnId);
        return {
          ok: false,
          kind: 'engine',
          message: 'Stream ended without finish_reason',
          text: parts.join('\n'),
          sessionId,
          costUsd: spent,
          transient: true,
          cut: true,
        };
      }
      // The CLI's process exits; a backup model is not under it.
      if (
        !req.model.includes('/') &&
        (kind === 'çöktü-hep' || (kind === 'çöktü' && !this.crashedTurns.has(req.turnId)))
      ) {
        this.crashedTurns.add(req.turnId);
        return {
          ok: false,
          kind: 'engine',
          message: 'Claude Code process exited with code 1',
          text: parts.join('\n'),
          sessionId,
          costUsd: spent,
          transient: true,
          crashed: true,
        };
      }
      if (kind === 'meşgul-sonra' && !req.model.includes('/')) {
        return {
          ok: false,
          kind: 'engine',
          message: 'overloaded_error',
          text: '',
          sessionId,
          transient: true,
        };
      }
      if (kind === 'bekle') {
        await sleep(Number(name ?? 0), req.signal);
        continue;
      }
      if (kind === 'uzun-araç') {
        const id = `fake-tool-${parts.length}`;
        req.onActivity?.({ id, name: 'Bash', running: true });
        await sleep(Number(name ?? 0), req.signal);
        req.onActivity?.({ id, name: 'Bash', running: false });
        parts.push('Bash: bitti');
        continue;
      }
      if (kind === 'özet') {
        req.onCompacted?.();
        continue;
      }
      const input = json ? (JSON.parse(json) as Record<string, unknown>) : {};
      if (kind === 'izin') {
        const answer = await req.canUseTool({ toolName: name ?? 'Tool', input });
        parts.push(
          answer.behavior === 'allow' ? `${name}: izin verildi` : `${name}: reddedildi (${answer.message})`,
        );
      } else if (kind === 'dosya') {
        const refused = await req.screen?.({ toolName: name ?? 'Write', input });
        const answer = refused
          ? ({ behavior: 'deny', message: refused } as const)
          : await req.canUseTool({ toolName: name ?? 'Write', input });
        if (answer.behavior === 'deny') {
          parts.push(`${name}: reddedildi (${answer.message})`);
          continue;
        }
        const path = String(input.file_path);
        if (name === 'Edit') {
          const text = await readFile(path, 'utf8');
          await writeFile(path, text.replace(String(input.old_string), String(input.new_string)));
        } else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, String(input.content));
        }
        parts.push(`${name}: yazıldı`);
      } else if (kind === 'araç') {
        const tool = req.tools.find((t) => t.name === name);
        if (!tool) {
          parts.push(`${name}: araç yok`);
          continue;
        }
        // As the real engines do, every call is looked at before any card.
        const refused = await req.screen?.({ toolName: toolPermName(tool), input });
        const answer = refused
          ? ({ behavior: 'deny', message: refused } as const)
          : await req.canUseTool({ toolName: toolPermName(tool), input });
        if (answer.behavior === 'deny') {
          parts.push(`${name}: reddedildi (${answer.message})`);
          continue;
        }
        req.onActivity?.({ id: `fake-${name}`, name: toolPermName(tool), running: true });
        try {
          const r = await tool.handler(input);
          for (const added of req.steering?.() ?? []) parts.push(`Ek: ${added}`);
          const images = resultImages(r).length;
          parts.push(`${name}: ${resultText(r)}${images ? ` [${images} görüntü]` : ''}`);
        } catch (e) {
          parts.push(`${name}: hata: ${(e as Error).message}`);
        } finally {
          req.onActivity?.({ id: `fake-${name}`, name: toolPermName(tool), running: false });
        }
      }
    }
    if (req.signal.aborted) {
      return { ok: false, kind: 'interrupted', message: 'Durduruldu', text: parts.join('\n'), sessionId };
    }
    if (!parts.length) parts.push(`Yankı: ${req.prompt}`);
    parts.push(`(oturum ${n}. tur)`);
    const text = parts.join('\n');
    let late = this.textAfterAbort;
    for (const chunk of text.match(/.{1,12}/gs) ?? []) {
      if (req.signal.aborted && late-- <= 0) {
        return { ok: false, kind: 'interrupted', message: 'Durduruldu', text: '', sessionId };
      }
      req.onText(chunk);
      await Promise.resolve();
    }
    const full = /\[bağlam:(\d+)\]/.exec(req.prompt);
    return { ok: true, text, sessionId, costUsd: spent, ...(full && { contextTokens: Number(full[1]) }) };
  }

  /** Sessions folded by `compact`; a test may hold a fold open with `compactGate`. */
  public compactions: CompactRequest[] = [];
  public compactGate: Promise<void> | null = null;
  /** A fold that fails after it was paid for. */
  public compactFails = false;
  /** Pieces of the answer still sent after a stop, as a real engine may while the stop takes hold. */
  public textAfterAbort = 0;

  async compact(req: CompactRequest): Promise<CompactOutcome> {
    this.compactions.push(req);
    if (this.compactGate) await this.compactGate;
    if (req.signal.aborted) return { ok: false, message: 'Durduruldu', costUsd: 0, sessionCostUsd: null };
    if (this.compactFails) return { ok: false, message: 'Özetlenemedi', costUsd: 0.02, sessionCostUsd: null };
    return { ok: true, sessionId: req.sessionId, contextTokens: 20_000, costUsd: 0.05, sessionCostUsd: null };
  }

  async account() {
    return { status: 'ok' as const, detail: 'sahte motor' };
  }

  /** Any model works offline; one whose name holds "hata" fails, for tests of the error path. */
  async testModel(model: string): Promise<ModelTest> {
    return model.includes('hata') ? { ok: false, detail: 'Sahte motor hatası' } : { ok: true };
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
