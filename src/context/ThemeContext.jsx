import { useState, useMemo, useEffect } from 'react';
import { resolveTheme } from '../utils/theme';
import { ThemeContext } from '../hooks/useTheme';

const LIGHT_MODE_STORAGE_KEY = 'froglabel-light-mode';

// localStorage can throw in some private-browsing contexts (e.g. Safari) —
// fall back silently rather than crashing the whole app over a preference.
function readStoredLightMode() {
    try {
        const stored = localStorage.getItem(LIGHT_MODE_STORAGE_KEY);
        if (stored !== null) return stored === 'true';
    } catch {
        // ignore — storage unavailable
    }
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

function writeStoredLightMode(value) {
    try {
        localStorage.setItem(LIGHT_MODE_STORAGE_KEY, String(value));
    } catch {
        // ignore — storage unavailable
    }
}

export function ThemeProvider({ children }) {
    const [frogTheme, setFrogTheme] = useState(false);
    const [lightMode, setLightMode] = useState(readStoredLightMode);

    useEffect(() => {
        writeStoredLightMode(lightMode);
    }, [lightMode]);

    const theme = resolveTheme(frogTheme, lightMode);

    useEffect(() => {
        document.body.style.backgroundColor = theme.background;
    }, [theme]);

    const value = useMemo(
        () => ({ theme, frogTheme, setFrogTheme, lightMode, setLightMode }),
        [theme, frogTheme, lightMode],
    );

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}
