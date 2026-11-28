import type { ComponentProps } from 'react';
import { Play } from 'lucide-react';
import { useServerMedia } from '@/lib/server-files';
import { cn } from '@/lib/utils';

/**
 * A picture, sound or video from the server, by whichever way the page reaches it: its path when
 * the server serves the page, a `blob:` address fetched through the tunnel on the web app.
 */
export function ServerImg({ src, alt = '', ...rest }: ComponentProps<'img'> & { src: string }) {
  const url = useServerMedia(src);
  return url ? (
    <img src={url} alt={alt} {...rest} />
  ) : (
    <span role="img" aria-label={alt} className={rest.className} />
  );
}

export function ServerAudio({ src, ...rest }: ComponentProps<'audio'> & { src: string }) {
  const url = useServerMedia(src);
  return <audio src={url} {...rest} />;
}

export function ServerVideo({ src, ...rest }: ComponentProps<'video'> & { src: string }) {
  const url = useServerMedia(src);
  // Safari paints nothing until playback starts unless the address names a moment to seek to, so a
  // video waiting to be played would be a black box; the fragment is added to the address the page
  // plays, not to the path the tunnel fetches by.
  const shown = url && !url.includes('#') ? `${url}#t=0.001` : url;
  return <video src={shown} {...rest} />;
}

/**
 * A video in a conversation as its first frame with a play mark; it is watched in the preview,
 * where the player has room for its controls and the picture both.
 */
export function VideoTile({
  src,
  label,
  onOpen,
  className,
}: {
  src: string;
  /** Read out and shown on hover: what opening it does. */
  label: string;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      className={cn('group relative block w-full overflow-hidden rounded-xl bg-black', className)}
    >
      <ServerVideo
        src={src}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none block aspect-video w-full object-contain"
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white transition-transform group-hover:scale-110">
          <Play className="size-5 translate-x-px fill-current" />
        </span>
      </span>
    </button>
  );
}
