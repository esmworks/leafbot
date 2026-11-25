/**
 * Where a conversation last started afresh: the index of its last line marking a reset, or -1.
 * What comes before it is no longer read by the bots, and a room no longer shows it unasked.
 */
export function lastResetIndex(messages: readonly { props?: Record<string, unknown> | null }[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.props?.kind === 'contextReset') return i;
  }
  return -1;
}
