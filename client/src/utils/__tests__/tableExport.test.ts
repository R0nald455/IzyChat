import {
  buildTableFilename,
  escapeCsvField,
  matrixToCsv,
  matrixToHtmlDocument,
  normalizeMatrix,
  sanitizeSpreadsheetCell,
} from '../tableExport';

describe('tableExport', () => {
  it('normalizes ragged rows to a rectangular matrix', () => {
    expect(normalizeMatrix([['a', 'b'], ['c']])).toEqual([
      ['a', 'b'],
      ['c', ''],
    ]);
  });

  it('prefixes spreadsheet formula injection characters', () => {
    expect(sanitizeSpreadsheetCell('=1+1')).toBe("'=1+1");
    expect(sanitizeSpreadsheetCell('+123')).toBe("'+123");
    expect(sanitizeSpreadsheetCell('hello')).toBe('hello');
  });

  it('escapes CSV fields with commas and quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('writes UTF-8 CSV with BOM', () => {
    const csv = matrixToCsv([['Col', 'Val'], ['a', 'b']]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Col,Val');
  });

  it('builds self-contained HTML with a header row', () => {
    const html = matrixToHtmlDocument(
      { headerRow: true, matrix: [['H1', 'H2'], ['1', '2']] },
      'IzyBot_table.html',
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>H1</th>');
    expect(html).toContain('<td>2</td>');
  });

  it('names downloads with a stable IzyBot prefix', () => {
    expect(buildTableFilename(1, 'csv')).toBe('IzyBot_table.csv');
    expect(buildTableFilename(2, 'xlsx')).toBe('IzyBot_table_2.xlsx');
  });
});
