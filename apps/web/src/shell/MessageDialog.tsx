import { ModalDialog } from "./ModalDialog";

export interface MessageDialogProps {
  readonly isOpen: boolean;
  readonly title: string;
  readonly message: string;
  readonly onClose: () => void;
}

/**
 * A message, such as an operation's out-of-memory error, closed with the title bar's close button
 * or Esc. It has no footer, since its only action would be another Close.
 */
export function MessageDialog({ isOpen, title, message, onClose }: MessageDialogProps) {
  return (
    <ModalDialog isOpen={isOpen} onClose={onClose} title={title}>
      <p>{message}</p>
    </ModalDialog>
  );
}
