const STORAGE_KEY = 'froglabel-session';
export const DEFAULT_LS_URL = import.meta.env.VITE_LS_URL || 'http://localhost:8080';

let activeConfig = null;

export function getDefaultFormValues() {
  return {
    demoMode: import.meta.env.VITE_DEMO_MODE === 'true',
    token: '',
    projectId: String(import.meta.env.VITE_LS_PROJECT_ID || ''),
    lsUrl: DEFAULT_LS_URL,
  };
}

export function isValidConfig(config) {
  if (!config) return false;
  if (config.demoMode) return true;
  return Boolean(config.token?.trim() && config.projectId?.trim());
}

export function getSessionConfig() {
  return activeConfig;
}

export function setSessionConfig(config) {
  activeConfig = config;
}

export function clearSessionConfig() {
  activeConfig = null;
  clearStoredConfig(); // cleans up anything previously saved
}

function clearStoredConfig() {
  localStorage.removeItem(STORAGE_KEY);
}
