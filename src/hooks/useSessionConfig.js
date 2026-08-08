import { createContext, useContext } from 'react';

export const SessionConfigContext = createContext(null);

export function useSessionConfig() {
  const ctx = useContext(SessionConfigContext);
  if (!ctx) {
    throw new Error('useSessionConfig must be used within SessionConfigProvider');
  }
  return ctx;
}
