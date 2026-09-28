export class AoToast extends HTMLElement {
  connectedCallback() {
    this.className = 'toast-region';
    this.setAttribute('aria-live', 'polite');
    this.setAttribute('role', 'status');
  }
  show(message) {
    this.textContent = message;
    this.classList.add('visible');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.textContent = '';
      this.classList.remove('visible');
    }, 3500);
  }
}
customElements.define('ao-toast', AoToast);
