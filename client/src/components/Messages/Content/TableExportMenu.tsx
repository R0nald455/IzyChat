import React, { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { FileCode2, FileSpreadsheet, ImageDown, LoaderCircle } from 'lucide-react';
import download from 'downloadjs';
import { DropdownPopup, TooltipAnchor } from '@librechat/client';
import type { MenuItemProps } from '~/common';
import type { TranslationKeys } from '~/hooks/useLocalize';
import {
  buildTableFilename,
  matrixToCsv,
  matrixToHtmlDocument,
  matrixToXlsxBlob,
  readTableStructure,
} from '~/utils/tableExport';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

type ExportFormat = 'csv' | 'xlsx' | 'html';

const FORMATS: ReadonlyArray<{
  format: ExportFormat;
  labelKey: TranslationKeys;
  mime: string;
  extension: string;
}> = [
  {
    format: 'csv',
    labelKey: 'com_ui_export_table_csv',
    mime: 'text/csv;charset=utf-8',
    extension: 'csv',
  },
  {
    format: 'xlsx',
    labelKey: 'com_ui_export_table_xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
  {
    format: 'html',
    labelKey: 'com_ui_export_table_html',
    mime: 'text/html;charset=utf-8',
    extension: 'html',
  },
];

type TableExportMenuProps = {
  tableRef: React.RefObject<HTMLTableElement | null>;
  tableIndex: number;
};

const TableExportMenu = memo(function TableExportMenu({
  tableRef,
  tableIndex,
}: TableExportMenuProps) {
  const localize = useLocalize();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const runExport = useCallback(
    async (format: ExportFormat) => {
      const table = tableRef.current;
      if (!table) {
        return;
      }
      const structure = readTableStructure(table);
      if (structure.matrix.length === 0) {
        return;
      }

      const meta = FORMATS.find((entry) => entry.format === format);
      if (!meta) {
        return;
      }

      setExporting(format);
      try {
        const filename = buildTableFilename(tableIndex, meta.extension);
        if (format === 'csv') {
          download(matrixToCsv(structure.matrix), filename, meta.mime);
        } else if (format === 'html') {
          download(matrixToHtmlDocument(structure, filename), filename, meta.mime);
        } else {
          const blob = await matrixToXlsxBlob(structure.matrix);
          download(blob, filename, meta.mime);
        }
      } finally {
        setExporting(null);
        setIsOpen(false);
      }
    },
    [tableIndex, tableRef],
  );

  const isBusy = exporting !== null;

  const items: MenuItemProps[] = useMemo(
    () =>
      FORMATS.map(({ format, labelKey }) => ({
        label: localize(labelKey),
        icon:
          exporting === format ? (
            <LoaderCircle className="text-text-secondary size-4 animate-spin motion-reduce:animate-none" />
          ) : format === 'html' ? (
            <FileCode2 className="text-text-secondary size-4" />
          ) : (
            <FileSpreadsheet className="text-text-secondary size-4" />
          ),
        disabled: isBusy,
        onClick: () => {
          void runExport(format);
        },
      })),
    [exporting, isBusy, localize, runExport],
  );

  return (
    <DropdownPopup
      portal
      focusLoop
      unmountOnHide
      menuId={`table-export-${menuId}`}
      finalFocus={triggerRef}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      items={items}
      minWidth="12rem"
      className="absolute top-1 right-1 z-10 motion-reduce:!transition-none"
      trigger={
        <TooltipAnchor
          description={localize('com_ui_export_table')}
          render={
            <Ariakit.MenuButton
              ref={triggerRef}
              aria-label={localize('com_ui_export_table')}
              aria-busy={isBusy || undefined}
              className={cn(
                'text-text-secondary flex items-center justify-center rounded-lg p-1.5 transition-opacity motion-reduce:transition-none',
                'bg-surface-primary/90 shadow-sm backdrop-blur-sm',
                'hover:bg-surface-hover hover:text-text-primary',
                'focus-visible:outline-focus-subtle focus-visible:outline focus-visible:outline-2',
                'opacity-0 group-hover/table:opacity-100 group-focus-within/table:opacity-100',
              )}
            >
              {isBusy ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <ImageDown className="size-4" aria-hidden="true" />
              )}
            </Ariakit.MenuButton>
          }
        />
      }
    />
  );
});

TableExportMenu.displayName = 'TableExportMenu';

export default TableExportMenu;
