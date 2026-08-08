import frogIdLogo from '.././assets/frog_id_logo.png';
import frog from '.././assets/frog.png';
import ThemeButton from './ThemeButton';
import LightModeToggle from './LightModeToggle';

function Header({
  theme,
  setFrogTheme,
  lightMode,
  setLightMode,
  onSubmit,
  onLogout,
  showActions = true,
}) {
  return (
    <div
      style={{ backgroundColor: theme.header }}
      className="w-full flex items-center px-3 py-2 gap-4 shrink-0"
    >
      <div className="flex flex-1 items-center gap-3 min-w-0">
        <a href="https://www.frogid.net.au" target="_blank" rel="noreferrer" className="shrink-0">
          <img src={frogIdLogo} alt="frogid logo" className="w-[35px] h-[40px]" />
        </a>
        <button
          type="button"
          onClick={() => setFrogTheme((prev) => !prev)}
          title="Toggle frog theme"
          className="shrink-0 p-1 rounded-4xl cursor-pointer hover:opacity-90 transition-opacity"
          style={{ backgroundColor: theme.themeToggle }}
        >
          <img src={frog} alt="Toggle theme" className="w-8 h-8 block" />
        </button>
      </div>

      <p style={{ color: theme.group }} className="font-display text-3xl shrink-0 text-center">
        FrogLabel
      </p>

      <div className="flex flex-1 items-center justify-end gap-2 min-w-0">
        {showActions && (
          <>
            <LightModeToggle theme={theme} lightMode={lightMode} setLightMode={setLightMode} />
            <ThemeButton
              theme={theme}
              onClick={onSubmit}
              className="px-3 py-1.5 text-sm rounded-md font-display cursor-pointer shrink-0"
            >
              Submit Task
            </ThemeButton>
            {onLogout && (
              <ThemeButton
                theme={theme}
                onClick={onLogout}
                className="px-3 py-1.5 text-sm rounded-md font-display cursor-pointer shrink-0"
              >
                Log Out
              </ThemeButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Header;
