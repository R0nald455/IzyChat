import { latestFileVersions } from './versions';

describe('latestFileVersions', () => {
  it('keeps only the newest upload of a filename', () => {
    const files = [
      { file_id: 'old', filename: 'requisitos.pdf', createdAt: '2026-10-09T10:00:00Z' },
      { file_id: 'manual', filename: 'manual.pdf', createdAt: '2026-10-09T10:05:00Z' },
      { file_id: 'new', filename: 'requisitos.pdf', createdAt: '2026-10-09T11:00:00Z' },
    ];
    expect(latestFileVersions(files).map((f) => f.file_id)).toEqual(['manual', 'new']);
  });

  it('uses createdAt over list position', () => {
    const files = [
      { file_id: 'new', filename: 'requisitos.pdf', createdAt: new Date('2026-10-09T11:00:00Z') },
      { file_id: 'old', filename: 'requisitos.pdf', createdAt: new Date('2026-10-09T10:00:00Z') },
    ];
    expect(latestFileVersions(files).map((f) => f.file_id)).toEqual(['new']);
  });

  it('falls back to the later position when dates are missing or equal', () => {
    const files = [
      { file_id: 'first', filename: 'requisitos.pdf' },
      { file_id: 'second', filename: 'requisitos.pdf' },
    ];
    expect(latestFileVersions(files).map((f) => f.file_id)).toEqual(['second']);
  });

  it('matches names ignoring case and surrounding spaces', () => {
    const files = [
      { file_id: 'old', filename: 'Requisitos.PDF', createdAt: '2026-10-09T10:00:00Z' },
      { file_id: 'new', filename: ' requisitos.pdf ', createdAt: '2026-10-09T11:00:00Z' },
    ];
    expect(latestFileVersions(files).map((f) => f.file_id)).toEqual(['new']);
  });

  it('keeps files without a filename and different names', () => {
    const files = [
      { file_id: 'a', filename: '' },
      { file_id: 'b', filename: 'a.pdf' },
      { file_id: 'c', filename: 'b.pdf' },
    ];
    expect(latestFileVersions(files)).toEqual(files);
  });
});
