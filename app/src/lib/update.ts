import { useEffect } from 'react';
import { toast } from 'sonner';
import { getT } from '@/i18n';
import { viaTunnel } from './transport';

/** Time to read the notice before the page reloads. */
const RELOAD_DELAY_MS = 2500;
const TOAST_ID = 'leafbot-update';

/**
 * The server's build when this page first heard from it. Kept for the life of the page (not per
 * connection), so signing out and back in after a deploy still counts as an update.
 */
let loadedBuild: string | null = null;
let updated = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Work on the page a reload would throw away, such as a draft or files being attached. */
const holds = new Set<object>();

/** Called with each build the server reports; a different one than before means a new deploy. */
export function serverBuild(buildId: string | null | undefined) {
  // The web app on the website is one build for every server: another server build is no reason
  // to reload it.
  if (!buildId || updated || viaTunnel()) return;
  if (loadedBuild === null) {
    loadedBuild = buildId;
    return;
  }
  if (buildId === loadedBuild) return;
  updated = true;
  schedule();
}

/** While `active`, an update waits to reload until the work is done or the user asks for it. */
export function useHoldReload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const token = {};
    holds.add(token);
    schedule();
    return () => {
      holds.delete(token);
      schedule();
    };
  }, [active]);
}

function schedule() {
  if (!updated) return;
  if (timer) clearTimeout(timer);
  timer = null;
  const t = getT();
  // At the top: the other toasts sit at the bottom, over the message box the draft is in. The top
  // edge moves the desktop window, so the toast opts out to keep its button clickable.
  const base = {
    id: TOAST_ID,
    duration: Infinity,
    position: 'top-center',
    className: '[-webkit-app-region:no-drag]',
    action: { label: t('update.reloadNow'), onClick: reload },
  } as const;
  if (holds.size > 0) {
    toast(t('update.title'), { ...base, description: t('update.waiting') });
    return;
  }
  toast(t('update.title'), { ...base, description: t('update.reloading') });
  timer = setTimeout(reload, RELOAD_DELAY_MS);
}

function reload() {
  window.location.reload();
}
