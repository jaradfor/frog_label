function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

// Segmented slider (same sliding-thumb idea as the "Demo Mode?" switch in
// LoginScreen.jsx): both icons stay visible, and a highlight thumb animates
// between them on toggle instead of the active color snapping instantly.
// Thumb geometry (w-7 + gap-1) must stay in sync with translate-x-8 below —
// that's what makes the thumb land exactly on the second icon.
function LightModeToggle({ theme, lightMode, setLightMode }) {
  return (
    <div
      style={{ backgroundColor: theme.group }}
      className="relative p-1 rounded-xl flex items-center gap-1 shrink-0"
    >
      <div
        aria-hidden="true"
        style={{ backgroundColor: theme.buttonsPressed }}
        className={`absolute top-1 left-1 w-7 h-7 rounded-md transition-transform duration-200 ease-out ${lightMode ? 'translate-x-0' : 'translate-x-8'}`}
      />
      <button
        type="button"
        onClick={() => setLightMode(true)}
        title="Light mode"
        aria-label="Light mode"
        aria-pressed={lightMode}
        style={{ color: theme.buttonsText }}
        className="relative z-10 w-7 h-7 rounded-md cursor-pointer flex items-center justify-center hover:opacity-80 transition-opacity"
      >
        <SunIcon />
      </button>
      <button
        type="button"
        onClick={() => setLightMode(false)}
        title="Dark mode"
        aria-label="Dark mode"
        aria-pressed={!lightMode}
        style={{ color: theme.buttonsText }}
        className="relative z-10 w-7 h-7 rounded-md cursor-pointer flex items-center justify-center hover:opacity-80 transition-opacity"
      >
        <MoonIcon />
      </button>
    </div>
  );
}

export default LightModeToggle;
