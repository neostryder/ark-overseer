import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
export class AoDialog extends HTMLElement {
  connectedCallback() {
    if (this.querySelector('dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    const title = document.createElement('h2');
    title.id = 'ao-dialog-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const heading = document.createElement('div');
    heading.className = 'dialog-heading';
    const close = document.createElement('button');
    close.className = 'button quiet dialog-close';
    close.type = 'button';
    close.setAttribute('aria-label', STRINGS.dialog.cancel);
    close.title = STRINGS.dialog.cancel;
    close.append(icon('close'));
    heading.append(title, close);
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
    dialog.append(heading, message, actions);
    this.append(dialog);
    cancel.addEventListener('click', () => this.finish(false));
    close.addEventListener('click', () => this.finish(false));
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
    if (this.choiceButtons) {
      this.dialog.querySelector('.button-row').replaceChildren(...this.defaultButtons);
      this.choiceButtons = false;
    }
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
  async choose(title, message, choices) {
    if (this.pending) this.finish(null);
    this.opener = document.activeElement;
    this.titleNode.textContent = title;
    this.messageNode.textContent = message;
    const actions = this.dialog.querySelector('.button-row');
    this.defaultButtons ??= [...actions.children];
    const buttons = choices.map(({ value, label }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.textContent = label;
      button.addEventListener('click', () => this.finish(value));
      return button;
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button quiet';
    cancel.textContent = STRINGS.dialog.cancel;
    cancel.addEventListener('click', () => this.finish(null));
    actions.replaceChildren(...buttons, cancel);
    this.choiceButtons = true;
    this.dialog.showModal();
    buttons[0]?.focus();
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
}
customElements.define('ao-dialog', AoDialog);
