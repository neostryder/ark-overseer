import { api } from '../api.js';
import { STRINGS } from '../strings.js';

export function validInstallFolder(value, installs = [], { allowUnc = false } = {}) {
  if (typeof value !== 'string' || !(/^[A-Za-z]:[\\/]/.test(value) || (allowUnc && /^[\\/]{2}[^\\/?]/.test(value))))
    return false;
  if (/["\r\n]/.test(value) || value.split(/[\\/]/).includes('..') || /[\\/]steamapps[\\/]/i.test(value)) return false;
  const key = (path) =>
    path
      .replaceAll('/', '\\')
      .replace(/[\\]+$/, '')
      .toLowerCase();
  return !installs.some((install) => key(install.path) === key(value));
}

// A path stays editable for a new folder. Browse offers existing local folders from the host.
export function createInstallFolderPicker(input, startPath) {
  const strings = STRINGS.folderPicker;
  const wrap = document.createElement('div');
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'button secondary';
  browse.textContent = strings.browse;
  const panel = document.createElement('div');
  panel.className = 'folder-picker-list';
  panel.hidden = true;
  const show = async (folder) => {
    try {
      const listing = await api.get(`/api/host/folders?path=${encodeURIComponent(folder)}`);
      panel.replaceChildren();
      const add = (label, action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button quiet';
        button.textContent = label;
        button.addEventListener('click', action);
        panel.append(button);
      };
      if (listing.parent !== listing.path) add(strings.up, () => void show(listing.parent));
      add(strings.use, () => {
        input.value = listing.path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        panel.hidden = true;
      });
      for (const entry of listing.folders) add(entry.name, () => void show(entry.path));
      panel.hidden = false;
    } catch (error) {
      panel.textContent = error.message;
      panel.hidden = false;
    }
  };
  browse.addEventListener('click', () => void show(input.value || startPath));
  wrap.append(browse, panel);
  return wrap;
}
