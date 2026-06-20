// src/editor/modal.ts
// Promise-based wrappers around the shared .sf-modal overlay. The
// browser's built-in window.alert / window.confirm / window.prompt
// are blocked in some sandboxes, look out of place against the editor
// theme, and can't show multi-line error messages cleanly. These
// helpers render an in-page dialog that uses the project's accent
// color and matches the existing animation-naming modal.
//
// All three are async — call sites that need to know the user's
// choice `await` the result, which makes them drop-in compatible
// with existing `if (confirm(...))` blocks.

export interface AlertOptions {
  title?: string;
  message: string;
  okLabel?: string;
  /** Render message as a <pre> so newlines / indentation are preserved.
   *  Use for error stacks and file paths. */
  pre?: boolean;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Render message as a <pre> so newlines / indentation are preserved. */
  pre?: boolean;
}

/** Build the shared overlay + box scaffold (title, message, actions
 *  container) used by every modal helper. The caller fills `actions`
 *  with the buttons it wants and calls `mount(onDismiss)` to attach
 *  the overlay to the document and wire up backdrop-click dismiss. */
function buildModalScaffold(opts: { title?: string; message: string; pre?: boolean }) {
  const overlay = document.createElement("div");
  overlay.className = "sf-modal-overlay";
  const box = document.createElement("div");
  box.className = "sf-modal";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  if (opts.title) {
    const title = document.createElement("div");
    title.className = "sf-modal-title";
    title.textContent = opts.title;
    box.appendChild(title);
  }
  const msg = document.createElement(opts.pre ? "pre" : "div");
  msg.className = "sf-modal-msg" + (opts.pre ? " sf-modal-pre" : "");
  msg.textContent = opts.message;
  box.appendChild(msg);
  const actions = document.createElement("div");
  actions.className = "sf-modal-actions";
  box.appendChild(actions);
  overlay.appendChild(box);
  return {
    overlay,
    box,
    actions,
    /** Append the overlay to <body> and wire up backdrop-click dismiss. */
    mount(onDismiss: () => void) {
      document.body.appendChild(overlay);
      // Click outside the modal box (on the overlay) dismisses.
      overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) onDismiss();
      });
    },
  };
}

/** Tear down the overlay and resolve the dialog's promise. */
function close(overlay: HTMLDivElement, done: () => void): void {
  if (!overlay.isConnected) return;  // already dismissed
  overlay.remove();
  done();
}

/** Add a button to the actions row and return it. */
function addButton(
  actions: HTMLElement,
  label: string,
  variant: "primary" | "destructive" | "default",
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className =
    "sf-modal-btn" + (variant === "primary" ? " primary" : variant === "destructive" ? " destructive" : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  actions.appendChild(btn);
  return btn;
}

/** Show an alert dialog. Resolves when the user dismisses it. */
export function alertDialog(opts: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    const { overlay, actions, mount } = buildModalScaffold(opts);
    const dismiss = () => close(overlay as HTMLDivElement, resolve);
    const ok = addButton(actions, opts.okLabel ?? "OK", "primary", dismiss);
    mount(dismiss);
    setTimeout(() => ok.focus(), 0);
  });
}

/** Show a confirm dialog. Resolves with `true` if the user confirms,
 *  `false` if they cancel or dismiss. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, actions, mount } = buildModalScaffold(opts);
    const finish = (value: boolean) => close(overlay as HTMLDivElement, () => resolve(value));
    addButton(actions, opts.cancelLabel ?? "Cancel", "default", () => finish(false));
    const ok = addButton(
      actions,
      opts.okLabel ?? "OK",
      opts.destructive ? "destructive" : "primary",
      () => finish(true),
    );
    mount(() => finish(false));
    // Enter confirms, Escape cancels.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter")  { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("remove", () => window.removeEventListener("keydown", onKey, true), { once: true });
    setTimeout(() => ok.focus(), 0);
  });
}
