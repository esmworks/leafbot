/**
 * The decisions about offering this computer to an account server's bots, apart from Electron so
 * they can be tested: what the page asking to turn it on gets, and what the menu bar shows.
 */

/**
 * Whether this computer can be offered: `unsupported` on a system with no helper (Linux),
 * `missing` where the helper should be but is not (a broken install, a run from source without it).
 */
export type HelperState = 'ok' | 'unsupported' | 'missing';

export function helperState(system: boolean, present: boolean): HelperState {
  if (!system) return 'unsupported';
  return present ? 'ok' : 'missing';
}

/**
 * What a page's request to offer this computer to `serverId` does:
 * - `refuse`: no helper, or a server the signed-in account does not list;
 * - `restart`: already on for that server, so the connection is made again without a new question,
 *   since nothing more is allowed than before;
 * - `ask`: the person is asked on this computer first; a yes turns it on for that server, and takes
 *   it from the one chosen before (`moveFrom`), if any.
 */
export type OfferStep = { do: 'refuse' } | { do: 'restart' } | { do: 'ask'; moveFrom: string | null };

export function offerStep(o: {
  helper: HelperState;
  listed: readonly string[];
  chosen: string | null;
  on: boolean;
  serverId: string;
}): OfferStep {
  if (o.helper !== 'ok' || !o.listed.includes(o.serverId)) return { do: 'refuse' };
  if (o.on && o.chosen === o.serverId) return { do: 'restart' };
  return { do: 'ask', moveFrom: o.chosen && o.chosen !== o.serverId ? o.chosen : null };
}

/**
 * What the menu bar shows for this computer: nothing without a helper, or for a person with no
 * account servers (their own server's bots use this computer without the switch); the switch off,
 * with the missing step, while the account lists servers but none was chosen; else the switch.
 */
export type MacMenuShape = 'none' | 'chooseServer' | 'switch';

export function macMenuShape(o: {
  helper: HelperState;
  linked: boolean;
  accountServers: number;
}): MacMenuShape {
  if (o.helper !== 'ok') return 'none';
  if (o.linked) return 'switch';
  return o.accountServers > 0 ? 'chooseServer' : 'none';
}
