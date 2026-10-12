export interface UpdateStatus {
  currentVersion: string;
  state: 'idle' | 'current' | 'available' | 'error';
  latestVersion?: string;
}
