import { desktop } from './desktop';

/**
 * Tells the desktop app when this page drew its first screen, its sidebar and its chat, so a start
 * is timed to what the person sees rather than to when the server answered. Main-thread work of
 * 50 ms or more until the chat is drawn is counted too: such work is what holds the first screen
 * back. Outside the desktop app (a browser, the phone) nothing is sent.
 */
export type PageMark = 'first-paint' | 'sidebar' | 'chat';

const sent = new Set<PageMark>();
const longTasks = { count: 0, totalMs: 0 };
let observer: PerformanceObserver | null = null;

if (desktop?.launchMark && typeof PerformanceObserver !== 'undefined') {
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.count++;
        longTasks.totalMs += e.duration;
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // A browser without long-task entries: the marks go without the count.
    observer = null;
  }
}

/** Sends a stage once per page load; the chat's also ends the long-task count. */
export function pageMark(name: PageMark): void {
  if (sent.has(name) || !desktop?.launchMark) return;
  sent.add(name);
  if (name === 'chat') {
    observer?.disconnect();
    observer = null;
    void desktop.launchMark(name, { ...longTasks }).catch(() => {});
  } else {
    void desktop.launchMark(name).catch(() => {});
  }
}
