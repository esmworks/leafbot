import { create } from 'zustand';
import { previewKind } from '@/lib/preview';

// Which file the preview shows, apart from the preview itself: what opens a file is on every
// screen, while the code that draws one loads the first time a file is opened.

/** A bot's file: one in its library, or one sent in a message. */
export interface PreviewFile {
  botId: string;
  path: string;
  name: string;
  /** -1 when not known, as for a file a message only links to. */
  size: number;
}

export const usePreview = create<{
  file: PreviewFile | null;
  /** The files to step through with the arrows: the other files of the same message. */
  set: PreviewFile[];
  open(file: PreviewFile | null, set?: PreviewFile[]): void;
}>((set) => ({
  file: null,
  set: [],
  open: (file, list) => set({ file, set: file ? (list ?? [file]) : [] }),
}));

/** Whether a file opens in the preview rather than downloading. */
export const canPreview = (name: string) => previewKind(name) !== null;
