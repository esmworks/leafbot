import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { useBots } from '@/lib/queries';
import { connectRealtime } from '@/lib/realtime';
import { SCREEN_READY } from '@/lib/screen';
import { DesktopStage, useDesktop } from './RemoteDesktop';

/** The bridge a phone app's web view puts on the page. */
interface PhoneBridge {
  ReactNativeWebView?: { postMessage(message: string): void };
}

/** One bot's computer filling the page, for the phone app's web view. */
export function PhoneScreen({ botId }: { botId: string }) {
  const qc = useQueryClient();
  // The live screen and the computer's state come over the realtime connection.
  useEffect(() => connectRealtime(qc, { notices: false }), [qc]);
  useEffect(() => (window as PhoneBridge).ReactNativeWebView?.postMessage(SCREEN_READY), []);
  const { data: bots } = useBots();
  const bot = bots?.find((b) => b.id === botId);
  const state = useDesktop(botId);
  return (
    <div className="screen-edges fixed inset-0 flex items-center justify-center bg-neutral-950 p-3 text-white">
      {bot ? (
        <DesktopStage bot={bot} state={state} />
      ) : (
        <Loader2 className="size-6 animate-spin text-white/70" />
      )}
    </div>
  );
}
