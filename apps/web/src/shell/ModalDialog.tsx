import { DialogTitleBar } from "@openpaint/ui";
import type { ReactNode } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";

export interface ModalDialogProps {
  isOpen: boolean;
  /** Called on Esc, the close button or any other cancel, so the caller can close the dialog (WEB-UI-02). */
  onClose: () => void;
  title: string;
  /** Use the wider size for dialogs with tables. */
  wide?: boolean;
  /**
   * Whether the title bar has a close button that calls `onClose`. Off only for dialogs that have
   * no Cancel or Close, such as progress the user cannot stop or a question that must be answered.
   */
  closable?: boolean;
  /** Disables the close button, for example while a cancel is already under way. */
  closeDisabled?: boolean;
  children: ReactNode;
}

/**
 * An in-page modal (WEB-UI-02). React Aria traps focus inside it and keeps the page inert behind
 * it. Esc and the title bar's close button call `onClose`. The dialog system (M2.13) builds its
 * buttons and content on this.
 */
export function ModalDialog({
  isOpen,
  onClose,
  title,
  wide = false,
  closable = true,
  closeDisabled = false,
  children,
}: ModalDialogProps) {
  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal className={wide ? "modal modal-wide" : "modal"}>
        <Dialog className="modal-dialog">
          <DialogTitleBar
            title={title}
            onClose={closable ? onClose : undefined}
            closeDisabled={closeDisabled}
          />
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
