import manifest from './localModel.json';

/** One pin shared by source setup, runtime download, verification, and tests. */
export const LOCAL_MODEL = Object.freeze({
  ...manifest,
  url: `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${manifest.file}`,
});

export type LocalModelSource = 'custom' | 'bundled' | 'managed';

export interface LocalModelStatus {
  state: 'available' | 'downloading' | 'verifying' | 'ready' | 'failed';
  source?: LocalModelSource;
  downloadedBytes: number;
  totalBytes: number;
  displayName: string;
  error?: string;
}
