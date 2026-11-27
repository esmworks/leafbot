import type { BrowserManager } from './browser/manager';
import type { Bus } from './bus';
import type { MacBridge } from './computer/bridge';
import type { PersonComputer } from './computer/person';
import type { ComputerService } from './computer/service';
import type { Config } from './config';
import type { Db } from './db';
import type { EgressHub } from './egress/hub';
import type { PhoneBridge } from './phone/bridge';
import type { ChromeBridge } from './chrome/bridge';

export interface Ctx {
  db: Db;
  bus: Bus;
  config: Config;
  /** The bots' browsers; `available` is false when no browser program was found. */
  browser: BrowserManager;
  /** The bots' desktops; null when no computer service is configured. */
  computer: ComputerService | null;
  /**
   * Whether this server's command sandbox is known not to start here; a bot with a desktop then
   * runs its commands there instead.
   */
  shellUnavailable?: () => boolean;
  /**
   * The owner's Mac when the server runs on it, for the bots they allow to use it; null where the
   * server runs elsewhere.
   */
  personComputer?: PersonComputer | null;
  /** The people's Macs offered from afar by their desktop apps. */
  macs?: MacBridge;
  /**
   * The person's own computer as the way out for the bots' browsers; null when the server itself
   * runs on that computer.
   */
  egress?: EgressHub | null;
  /** The people's phones connected now, for the bots to read what each person lets them. */
  phones?: PhoneBridge;
  /** The people's Chrome side panels that share their Chrome now. */
  chromes?: ChromeBridge;
}
