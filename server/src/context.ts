import type { BrowserManager } from './browser/manager';
import type { Bus } from './bus';
import type { PersonComputer } from './computer/person';
import type { ComputerService } from './computer/service';
import type { Config } from './config';
import type { Db } from './db';
import type { EgressHub } from './egress/hub';
import type { PhoneBridge } from './phone/bridge';

export interface Ctx {
  db: Db;
  bus: Bus;
  config: Config;
  /** The bots' browsers; `available` is false when no browser program was found. */
  browser: BrowserManager;
  /** The bots' desktops; null when no computer service is configured. */
  computer: ComputerService | null;
  /** The person's own Mac, for the bots they allow to use it; null where it cannot be used. */
  personComputer?: PersonComputer | null;
  /**
   * The person's own computer as the way out for the bots' browsers; null when the server itself
   * runs on that computer.
   */
  egress?: EgressHub | null;
  /** The people's phones connected now, for the bots to read what each person lets them. */
  phones?: PhoneBridge;
}
