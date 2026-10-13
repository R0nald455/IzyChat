import type { TFile } from 'librechat-data-provider';

type TVersionedFile = Pick<TFile, 'file_id' | 'filename'> & Partial<Pick<TFile, 'createdAt'>>;

const toTime = (value?: string | Date): number => {
  if (value == null) {
    return Number.NEGATIVE_INFINITY;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

const versionKey = (filename?: string): string => (filename ?? '').trim().toLowerCase();

/**
 * Keeps only the most recent upload of each filename (case-insensitive), so re-uploading an
 * edited document replaces the previous version for search without deleting it. The newest is
 * picked by `createdAt`; on ties or missing dates, the later position in the list wins.
 * Files without a filename are always kept. The original order is preserved.
 */
export function latestFileVersions<T extends TVersionedFile>(files: T[]): T[] {
  const latest = new Map<string, number>();
  for (let i = 0; i < files.length; i++) {
    const key = versionKey(files[i]?.filename);
    if (!key) {
      continue;
    }
    const current = latest.get(key);
    if (current == null || toTime(files[i].createdAt) >= toTime(files[current].createdAt)) {
      latest.set(key, i);
    }
  }
  return files.filter((file, i) => {
    const key = versionKey(file?.filename);
    return !key || latest.get(key) === i;
  });
}
