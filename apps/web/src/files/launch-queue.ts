/** The part of the File Handling API the app uses: the files the OS launched it with (WEB-FILE-05). */
interface LaunchQueue {
  setConsumer(
    consumer: (params: { readonly files: readonly FileSystemFileHandle[] }) => void,
  ): void;
}

/**
 * Hands each OS launch of the app, with its file handles, to `open`. Browsers without the API, and
 * launches with no files, do nothing.
 */
export function consumeLaunchQueue(
  host: object,
  open: (handles: readonly FileSystemFileHandle[]) => void,
): void {
  const queue = (host as { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer((params) => {
    if (params.files.length > 0) open(params.files);
  });
}
