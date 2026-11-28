/**
 * A menu's choices with the saved value among them, in order: a number saved some other way (the
 * API, another app, an older version's menu) would otherwise leave the menu showing nothing.
 */
export function withSaved(choices: number[], saved: number): number[] {
  return choices.includes(saved) ? choices : [...choices, saved].sort((a, b) => a - b);
}
