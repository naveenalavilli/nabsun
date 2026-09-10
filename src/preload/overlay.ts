import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH } from '../shared/ipc';
import type { OmniboxSuggestion } from '../shared/types';

export interface OverlayApi {
  onOpen(
    cb: (payload: {
      kind: 'omnibox' | 'palette';
      payload: unknown;
      /** null means "follow the OS"; see AppWindow.showOverlay. */
      theme: 'light' | 'dark' | null;
    }) => void,
  ): void;
  suggest(query: string): Promise<OmniboxSuggestion[]>;
  run(command: string, arg?: unknown): void;
  close(): void;
}

const api: OverlayApi = {
  onOpen: (cb) => {
    ipcRenderer.on(CH.overlayOpen, (_e: IpcRendererEvent, payload) => cb(payload));
  },
  suggest: (query) => ipcRenderer.invoke(CH.omniboxSuggest, query),
  run: (command, arg) => ipcRenderer.send(CH.overlayCommand, command, arg),
  close: () => ipcRenderer.send(CH.overlayClose),
};

contextBridge.exposeInMainWorld('overlay', api);
