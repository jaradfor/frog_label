import { useState } from 'react';
import frogIdLogo from '../assets/frog_id_logo.png';
import { useTheme } from '../hooks/useTheme';
import LightModeToggle from './LightModeToggle';

function LoginScreen({ defaultFormValues, onLogin }) {
    const { theme, lightMode, setLightMode } = useTheme();
    const [demoMode, setDemoMode] = useState(defaultFormValues.demoMode);
    const [token, setToken] = useState(defaultFormValues.token);
    const [projectId, setProjectId] = useState(defaultFormValues.projectId);
    const [error, setError] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        setError('');

        if (!demoMode && (!token.trim() || !projectId.trim())) {
            setError('Token and project ID are required for Label Studio mode.');
            return;
        }

        const ok = onLogin({ demoMode, token, projectId, lsUrl: defaultFormValues.lsUrl });
        if (!ok) setError('Could not connect. Check your settings and try again.');
    };

    return (
        <div
            className="min-h-screen flex items-center justify-center p-4"
            style={{ backgroundColor: theme.background }}
        >
            <div
                className="w-full max-w-md rounded-xl p-8 shadow-lg border"
                style={{ backgroundColor: theme.group, borderColor: theme.group }}
            >
                <div className="flex flex-col items-center mb-8">
                    <img src={frogIdLogo} alt="FrogID logo" className="w-12 h-14 mb-3" />
                    <h1 style={{ color: theme.text }} className="font-display text-3xl">
                        FrogLabel
                    </h1>
                    <p style={{ color: theme.placeholderText }} className="font-display text-sm mt-1">
                        Connect to Label Studio or try demo mode
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                    <label
                        className="flex items-center justify-between gap-3 cursor-pointer"
                        style={{ color: theme.text }}
                    >
                        <span className="font-display text-sm">Demo Mode?</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={demoMode}
                            onClick={() => setDemoMode((prev) => !prev)}
                            className="relative w-11 h-6 rounded-full transition-colors shrink-0"
                            style={{ backgroundColor: demoMode ? theme.buttons : theme.buttons }}
                        >
                            <span
                                className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform"
                                style={{
                                    backgroundColor: theme.text,
                                    transform: demoMode ? 'translateX(20px)' : 'translateX(0)',
                                }}
                            />
                        </button>
                    </label>

                    {!demoMode && (
                        <>
                            <div>
                                <label
                                    htmlFor="token"
                                    style={{ color: theme.text }}
                                    className="font-display text-sm block mb-1"
                                >
                                    Access Token
                                </label>
                                <input
                                    id="token"
                                    type="password"
                                    value={token}
                                    onChange={(e) => setToken(e.target.value)}
                                    placeholder="Label Studio API token"
                                    autoComplete="off"
                                    onKeyDown={(e) => e.stopPropagation()}
                                    className='w-full px-2 py-1.5 text-sm rounded-md font-display'
                                    style={{ backgroundColor: theme.textInput, color: theme.textInputText }}
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="projectId"
                                    style={{ color: theme.text }}
                                    className="font-display text-sm block mb-1"
                                >
                                    Project ID
                                </label>
                                <input
                                    id="projectId"
                                    type="text"
                                    inputMode="numeric"
                                    value={projectId}
                                    onChange={(e) => setProjectId(e.target.value)}
                                    placeholder="ID via Label Studio project URL"
                                    onKeyDown={(e) => e.stopPropagation()}
                                    className='w-full px-2 py-1.5 text-sm rounded-md font-display'
                                    style={{ backgroundColor: theme.textInput, color: theme.textInputText }}
                                />
                            </div>
                        </>
                    )}

                    {demoMode && (
                        <p style={{ color: theme.placeholderText }} className="font-display text-sm">
                            Demo mode cycles through local sample audio files. No Label Studio connection
                            required.
                        </p>
                    )}

                    {error && (
                        <p className="font-display text-sm text-red-400">{error}</p>
                    )}

                    <button
                        type="submit"
                        style={{ backgroundColor: theme.buttons, color: theme.text }}
                        className="w-full py-2.5 rounded-md font-display text-sm cursor-pointer hover:opacity-90 transition-opacity"
                    >
                        {demoMode ? 'Start Demo' : 'Connect'}
                    </button>
                </form>

                <div className="flex justify-center mt-4">
                    <LightModeToggle theme={theme} lightMode={lightMode} setLightMode={setLightMode} />
                </div>
            </div>
        </div>
    );
}

export default LoginScreen;