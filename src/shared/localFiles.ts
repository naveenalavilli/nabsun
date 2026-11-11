export type LocalFolderMode = 'read' | 'read-write';
export interface LocalFolder {
  id: string;
  name: string;
  mode: LocalFolderMode;
  /** Displayed only in the trusted application UI, never sent to the model. */
  path?: string;
}
