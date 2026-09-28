import { STRINGS } from '../strings.js';
export class AoDialog extends HTMLElement {
  connectedCallback() {
    if (this.querySelector('dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    const title = document.createElement('h2');
    title.id = 'ao-dialog-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const message = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'button-row';
    const cancel = document.createElement('button');
    cancel.className = 'button secondary';
    cancel.textContent = STRINGS.dialog.cancel;
    const confirm = document.createElement('button');
    confirm.className = 'button primary';
    confirm.textContent = STRINGS.dialog.confirm;
    actions.append(cancel, confirm);
    dialog.append(title, message, actions);
    this.append(dialog);
    cancel.addEventListener('click', () => this.finish(false));
    confirm.addEventListener('click', () => this.finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.finish(false);
    });
    this.dialog = dialog;
    this.titleNode = title;
    this.messageNode = message;
  }
  // The answer comes from the button or key that closed the dialog, not from its returnValue, which
  // carries over from the previous question.
  finish(answer) {
    const resolve = this.pending;
    this.pending = null;
    if (this.dialog.open) this.dialog.close();
    this.opener?.focus?.();
    resolve?.(answer);
  }
  async ask(title, message, confirmText = STRINGS.dialog.confirm) {
    if (this.pending) this.finish(false);
    this.opener = document.activeElement;
    this.titleNode.textContent = title;
    this.messageNode.textContent = message;
    this.dialog.querySelector('.button.primary').textContent = confirmText;
    this.dialog.showModal();
    this.dialog.querySelector('button').focus();
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
}
customElements.define('ao-dialog', AoDialog);
