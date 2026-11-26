/**
 * The saved theme, applied before the app draws. The server's own page does this in an inline
 * script; here every script must be a file from /bots, so this module is imported first.
 */
try {
  const t = localStorage.getItem('leafbot.theme') || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
} catch {
  document.documentElement.classList.add('dark');
}
try {
  const tone = localStorage.getItem('leafbot.tone');
  if (tone === 'slate' || tone === 'leaf') document.documentElement.dataset.tone = tone;
} catch {
  // The default tone.
}
