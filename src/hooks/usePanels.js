import { createContext, useContext } from 'react';

export const PanelContext = createContext(null);

export function usePanels() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error('usePanels must be used inside <PanelProvider>');
  return ctx;
}
