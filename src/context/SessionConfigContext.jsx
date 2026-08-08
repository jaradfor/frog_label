import { useState, useCallback, useMemo } from 'react';
import {
  setSessionConfig,
  clearSessionConfig,
  isValidConfig,
  getDefaultFormValues,
} from '../utils/sessionConfig';
import { SessionConfigContext } from '../hooks/useSessionConfig';

export function SessionConfigProvider({ children }) {
  const [config, setConfig] = useState(null);

  const login = useCallback((nextConfig) => {
    if (!isValidConfig(nextConfig)) return false;
    const normalized = {
      demoMode: Boolean(nextConfig.demoMode),
      token: nextConfig.token?.trim() || '',
      projectId: String(nextConfig.projectId ?? '').trim(),
      lsUrl: nextConfig.lsUrl?.trim() || getDefaultFormValues().lsUrl,
    };
    setSessionConfig(normalized);
    setConfig(normalized);
    return true;
  }, []);

  const logout = useCallback(() => {
    clearSessionConfig();
    setConfig(null);
  }, []);

  const value = useMemo(
    () => ({
      config,
      isAuthenticated: Boolean(config),
      login,
      logout,
      defaultFormValues: getDefaultFormValues(),
    }),
    [config, login, logout],
  );

  return <SessionConfigContext.Provider value={value}>{children}</SessionConfigContext.Provider>;
}
