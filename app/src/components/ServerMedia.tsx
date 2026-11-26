import type { ComponentProps } from 'react';
import { useServerMedia } from '@/lib/server-files';

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
  return <video src={url} {...rest} />;
}
