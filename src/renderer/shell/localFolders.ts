/** Access is granted by the native picker, never by renderer-supplied paths. */
export class LocalFoldersView {
  private button = document.querySelector<HTMLButtonElement>('#choose-local-folder')!;
  private root = document.querySelector<HTMLElement>('#local-folder-access')!;
  private status = document.querySelector<HTMLElement>('#local-folder-status')!;
  private generation = 0;
  constructor(private session: () => string | null) {
    this.button.addEventListener('click', () => void this.choose());
    window.nabsun.localFolders.onChanged(event => {
      if (event.sessionId === this.session()) void this.refresh();
    });
  }
  private async choose() {
    const scope = this.session();
    if (!scope) return;
    this.button.disabled = true;
    this.status.textContent = '';
    try {
      const folder = await window.nabsun.localFolders.choose(scope);
      if (scope === this.session()) this.status.textContent = folder
        ? 'Folder connected for this chat.' : 'No new folder access was added.';
      await this.refresh(false);
    } catch (error) {
      if (scope === this.session()) this.status.textContent = error instanceof Error ? error.message : 'Could not connect the folder. Try again.';
    } finally { this.button.disabled = false; }
  }
  async refresh(clearStatus = true) {
    const generation = ++this.generation, scope = this.session();
    const expanded = this.root.querySelector('details')?.open ?? true;
    this.root.replaceChildren();
    this.root.hidden = true;
    if (clearStatus) this.status.textContent = '';
    if (!scope) return;
    try {
      const folders = await window.nabsun.localFolders.list(scope);
      if (scope !== this.session() || generation !== this.generation) return;
      if (!folders.length) return;
      const details = document.createElement('details');
      details.open = expanded;
      const summary = document.createElement('summary');
      summary.textContent = `Folders shared with this chat (${folders.length})`;
      details.append(summary);
      for (const folder of folders) {
        const row = document.createElement('div');
        row.className = 'local-folder-row';
        const description = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = folder.name;
        const mode = document.createElement('span');
        mode.className = 'local-folder-mode';
        mode.textContent = folder.mode === 'read' ? 'Read only' : 'Can read and change files';
        const location = document.createElement('span');
        location.className = 'local-folder-path';
        location.textContent = folder.path ?? folder.name;
        description.append(name, mode, location);
        const disconnect = document.createElement('button');
        disconnect.className = 'ghost';
        disconnect.textContent = 'Disconnect';
        disconnect.title = 'Disconnect this folder and stop the current task';
        disconnect.addEventListener('click', async () => {
          disconnect.disabled = true;
          try {
            await window.nabsun.localFolders.revoke(scope, folder.id);
            await this.refresh(false);
            if (scope === this.session()) this.status.textContent = 'Folder disconnected. Current work was stopped.';
          } catch {
            disconnect.disabled = false;
            if (scope === this.session()) this.status.textContent = 'Could not disconnect this folder. Try again.';
          }
        });
        row.append(description, disconnect);
        details.append(row);
      }
      this.root.append(details);
      this.root.hidden = false;
    } catch {
      if (scope === this.session() && generation === this.generation) this.status.textContent = 'Could not load folder permissions. Reopen this chat to try again.';
    }
  }
}
