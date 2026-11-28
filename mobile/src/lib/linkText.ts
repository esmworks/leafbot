import type { MessageKey } from '@/i18n';

/** The words for why the tunnel is waiting or was refused (`reason` of the server state). */
export function reasonKey(reason: string | null): MessageKey {
  switch (reason) {
    case 'offline':
      return 'link.reason.offline';
    case 'outdated':
      return 'link.reason.outdated';
    case 'host-proof':
      return 'link.reason.hostProof';
    case 'access':
    case 'revoked':
      return 'link.reason.access';
    case 'account':
    case 'account-error':
      return 'link.reason.account';
    default:
      return 'link.reason.failed';
  }
}
