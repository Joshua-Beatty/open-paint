import { acceptsDrag } from "./dropped-sources";

/**
 * Accepts files and images dropped anywhere on the window (UI-DOC-02, WEB-FILE-06). The drop goes
 * to `onDrop` during the event, because a `DataTransfer` can only be read then. A drop the Colors
 * panel takes (a palette file) stops before the window and never reaches here.
 */
export function installDropTarget(
  target: Window,
  onDrop: (data: DataTransfer) => void,
): () => void {
  const onDragOver = (event: DragEvent) => {
    const data = event.dataTransfer;
    if (data === null || !acceptsDrag(data.types)) return;
    event.preventDefault();
    data.dropEffect = "copy";
  };
  const onDropEvent = (event: DragEvent) => {
    const data = event.dataTransfer;
    if (data === null || !acceptsDrag(data.types)) return;
    event.preventDefault();
    onDrop(data);
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDropEvent);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDropEvent);
  };
}
