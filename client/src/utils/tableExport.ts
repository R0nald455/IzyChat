export type TableMatrix = string[][];

export type TableStructure = {
  headerRow: boolean;
  matrix: TableMatrix;
};

/** Reads visible cell text from a rendered GFM table. */
export function readTableStructure(table: HTMLTableElement): TableStructure {
  const matrix: TableMatrix = [];
  let headerRow = false;

  table.querySelectorAll('tr').forEach((row, rowIndex) => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    if (cells.length === 0) {
      return;
    }
    if (rowIndex === 0 && cells.every((cell) => cell.tagName === 'TH')) {
      headerRow = true;
    }
    matrix.push(cells.map((cell) => cell.textContent ?? ''));
  });

  return { headerRow, matrix: normalizeMatrix(matrix) };
}

export function normalizeMatrix(matrix: TableMatrix): TableMatrix {
  if (matrix.length === 0) {
    return matrix;
  }
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  return matrix.map((row) => {
    if (row.length >= width) {
      return row;
    }
    return [...row, ...Array(width - row.length).fill('')];
  });
}

/** Prefix cells that Excel could treat as formulas (CA12). */
export function sanitizeSpreadsheetCell(value: string): string {
  if (/^[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

export function escapeCsvField(value: string): string {
  const sanitized = sanitizeSpreadsheetCell(value);
  if (/[",\r\n]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

export function matrixToCsv(matrix: TableMatrix): string {
  const body = matrix.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  return `\uFEFF${body}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function matrixToHtmlDocument(structure: TableStructure, title: string): string {
  const { matrix, headerRow } = structure;
  if (matrix.length === 0) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body></body></html>`;
  }

  const bodyRows = headerRow ? matrix.slice(1) : matrix;
  const headerCells = headerRow ? matrix[0] : null;

  const thead = headerCells
    ? `<thead><tr>${headerCells.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
    : '';
  const tbody = `<tbody>${bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #212121; }
  table { border-collapse: collapse; width: 100%; max-width: 100%; }
  th, td { border: 1px solid #cdcdcd; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
  th { background: #f7f7f8; font-weight: 600; }
</style>
</head>
<body>
<table>${thead}${tbody}</table>
</body>
</html>`;
}

export function buildTableFilename(tableIndex: number, extension: string): string {
  const suffix = tableIndex > 1 ? `_table_${tableIndex}` : '_table';
  return `IzyBot${suffix}.${extension}`;
}

export async function matrixToXlsxBlob(matrix: TableMatrix): Promise<Blob> {
  const XLSX = await import('xlsx');
  const sanitized = matrix.map((row) => row.map(sanitizeSpreadsheetCell));
  const sheet = XLSX.utils.aoa_to_sheet(sanitized);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Table');
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
