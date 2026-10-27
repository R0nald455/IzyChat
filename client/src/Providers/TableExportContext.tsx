import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';

type TableExportContextValue = {
  getNextTableIndex: () => number;
};

export const TableExportContext = createContext<TableExportContextValue>({
  getNextTableIndex: () => 1,
});

export const useTableExportContext = () => useContext(TableExportContext);

export function TableExportProvider({ children }: { children: ReactNode }) {
  const counterRef = useRef(0);

  const getNextTableIndex = useCallback(() => {
    counterRef.current += 1;
    return counterRef.current;
  }, []);

  return (
    <TableExportContext.Provider value={{ getNextTableIndex }}>
      {children}
    </TableExportContext.Provider>
  );
}
