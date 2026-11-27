/**
 * The page the main window shows while this computer's server starts. Before, the window opened
 * only once the server was up, and an app that showed nothing for a second looked like it had not
 * heard the click. It is a data URL: it needs no server, no file and no network.
 */
export interface LoadingPage {
  /** The window's own background, so the switch to the real page does not flash. */
  background: string;
  text: string;
  name: string;
  dark: boolean;
  /** The window has no title bar: the page is the area that drags it. */
  frameless: boolean;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function loadingPageHtml(p: LoadingPage): string {
  const fg = p.dark ? '#e6e6e6' : '#1f1f1f';
  const muted = p.dark ? '#9a9a9a' : '#6b6b6b';
  const track = p.dark ? '#333333' : '#e3e3e3';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(p.name)}</title><style>
html,body{margin:0;height:100%;background:${p.background};color:${fg};font:14px/1.4 system-ui,-apple-system,sans-serif;cursor:default;user-select:none}
body{display:flex;align-items:center;justify-content:center;${p.frameless ? '-webkit-app-region:drag;' : ''}}
main{display:flex;flex-direction:column;align-items:center;gap:14px}
h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:${muted}}
i{display:block;width:120px;height:3px;border-radius:2px;background:${track};overflow:hidden;position:relative}
i::after{content:"";position:absolute;inset:0;width:40%;border-radius:2px;background:${muted};animation:go 1.1s ease-in-out infinite}
@keyframes go{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){i::after{animation:none;width:100%;opacity:.5}}
</style></head><body><main><h1>${escapeHtml(p.name)}</h1><i></i><p>${escapeHtml(p.text)}</p></main></body></html>`;
}

export const loadingPageUrl = (p: LoadingPage) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(loadingPageHtml(p))}`;

/** Whether the window is still on the loading page rather than a server's. */
export const isLoadingPage = (url: string) => url.startsWith('data:text/html');
