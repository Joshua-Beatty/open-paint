/** A key press in a text input, with the modifiers the Text tool reads (TL-TEXT-01). */
export interface TextKey {
  /** The physical key, such as `ArrowLeft` or `Enter`, so the bindings do not depend on the layout. */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** What a text input reports to the Text tool. */
export interface TextInputHandlers {
  /** A key press. Returns true when the tool used it, so the default action is suppressed. */
  key(key: TextKey): boolean;
  keyUp(code: string): void;
  /** Characters typed, or a composition that was committed. */
  text(text: string): void;
  /** The composition in progress (IME, WEB-FONT), or undefined once it has ended. */
  composition(preedit: string | undefined): void;
  /** Plain text pasted with Ctrl+V (WEB-CLIP-02). */
  paste(text: string): void;
}

/** A focusable text input that the Text tool types into. */
export interface TextInputPort {
  focus(): void;
  blur(): void;
  dispose(): void;
}

export type TextInputFactory = (handlers: TextInputHandlers) => TextInputPort;

/**
 * The text input of the Text tool: a hidden textarea that holds the keyboard focus while a text
 * block is edited. Typing, IME composition and paste reach the tool through it, and because it is a
 * text field, the global shortcuts stay off while it has focus (WEB-KEY-05).
 */
export class DomTextInput implements TextInputPort {
  readonly #element: HTMLTextAreaElement;
  readonly #handlers: TextInputHandlers;
  #composing = false;

  constructor(handlers: TextInputHandlers, label: string) {
    this.#handlers = handlers;
    const element = document.createElement("textarea");
    element.setAttribute("aria-label", label);
    element.setAttribute("autocomplete", "off");
    element.setAttribute("autocapitalize", "off");
    element.spellcheck = false;
    element.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;" +
      "outline:none;resize:none;overflow:hidden;pointer-events:none;";
    element.addEventListener("keydown", this.#keyDown);
    element.addEventListener("keyup", this.#keyUp);
    element.addEventListener("input", this.#input);
    element.addEventListener("compositionstart", this.#compositionStart);
    element.addEventListener("compositionupdate", this.#compositionUpdate);
    element.addEventListener("compositionend", this.#compositionEnd);
    element.addEventListener("paste", this.#paste);
    document.body.append(element);
    this.#element = element;
  }

  focus(): void {
    this.#element.focus({ preventScroll: true });
  }

  blur(): void {
    if (document.activeElement === this.#element) this.#element.blur();
  }

  dispose(): void {
    this.#element.removeEventListener("keydown", this.#keyDown);
    this.#element.removeEventListener("keyup", this.#keyUp);
    this.#element.removeEventListener("input", this.#input);
    this.#element.removeEventListener("compositionstart", this.#compositionStart);
    this.#element.removeEventListener("compositionupdate", this.#compositionUpdate);
    this.#element.removeEventListener("compositionend", this.#compositionEnd);
    this.#element.removeEventListener("paste", this.#paste);
    this.#element.remove();
  }

  readonly #keyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;
    const handled = this.#handlers.key({
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
    if (handled) event.preventDefault();
  };

  readonly #keyUp = (event: KeyboardEvent): void => {
    this.#handlers.keyUp(event.code);
  };

  /** Typed characters arrive here. Each one is taken out of the field at once. */
  readonly #input = (event: Event): void => {
    if (this.#composing || (event as InputEvent).isComposing) return;
    const value = this.#element.value;
    this.#element.value = "";
    if (value !== "") this.#handlers.text(value);
  };

  readonly #compositionStart = (): void => {
    this.#composing = true;
  };

  readonly #compositionUpdate = (event: CompositionEvent): void => {
    this.#handlers.composition(event.data);
  };

  readonly #compositionEnd = (event: CompositionEvent): void => {
    this.#composing = false;
    this.#element.value = "";
    this.#handlers.composition(undefined);
    if (event.data !== "") this.#handlers.text(event.data);
  };

  readonly #paste = (event: ClipboardEvent): void => {
    event.preventDefault();
    this.#handlers.paste(event.clipboardData?.getData("text/plain") ?? "");
  };
}

/** The input factory of the app: a hidden textarea labelled with `label`. */
export function domTextInputFactory(label: string): TextInputFactory {
  return (handlers) => new DomTextInput(handlers, label);
}
