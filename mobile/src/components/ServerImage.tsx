import { Image, type ImageProps } from 'expo-image';
import { useEffect } from 'react';
import { useServerFile } from '@/lib/serverFiles';

/**
 * A picture the server has, by its path. It is read through the tunnel first; until it comes the
 * box is empty, and `onFailed` is called if it cannot be read.
 */
export function ServerImage({
  path,
  onFailed,
  ...props
}: Omit<ImageProps, 'source'> & { path: string | null; onFailed?: () => void }) {
  const { uri, failed } = useServerFile(path);
  useEffect(() => {
    if (failed) onFailed?.();
  }, [failed, onFailed]);
  return <Image {...props} {...(uri ? { source: { uri } } : {})} />;
}
