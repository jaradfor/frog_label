// Theming is modeled as two independent axes — "skin" (default vs. frog) and
// "brightness" (dark vs. light) — resolved into one of four flat color objects
// that every component reads from (via the `theme` prop / useTheme()).
// Brand colors that repeat across multiple cells of that 2x2 grid are named
// once here so a rebrand only touches one line instead of four.
const FROG_GREEN = '#82A062'; // primary brand green: headers, annotation boxes, frog panels
const WARM_YELLOW = '#FFDE9E'; // mascot toggle chip; frog-skin hover/press accent
const ACCENT_BLUE = '#3b82f6'; // default-skin accent: audio button, waveform cursor
const ACCENT_BLUE_LIGHT = '#60a5fa';
const FROG_INK = '#1E1E1E'; // frog-skin near-black: header, ink text, dark chips
const FROG_CREAM_BG = '#E6E5C9'; // frog-skin cream: light background / light text-on-dark
const FROG_SAGE = '#C8D9A3'; // frog-skin muted green: group chips, box labels
const FROG_CREAM_SURFACE = '#F3F3E4';
const FROG_PALE_BLUE = '#CAE4EF';
const FROG_PALE_BLUE_HOVER = '#B4D2EF';
const FROG_DARK_PANEL = '#2b3324'; // frog-skin dark surface (panels/buttons in frog-dark)
const FROG_DARK_SAGE = '#3f4a34'; // frog-skin dark muted green (group/hover in frog-dark)
const DEFAULT_INK = '#09090b'; // default-skin near-black: dark background/buttons/text
const DARK_SURFACE = '#18181b'; // default-skin dark surface: panels/cream/inputs
const DEFAULT_DARK_GROUP = '#27272a';
const NEUTRAL_HOVER = '#5b5b5e';
const OFF_WHITE = '#fafafa';
const PURE_WHITE = '#ffffff';
const MUTED_GRAY = '#52525b';
const LIGHT_BG = '#f4f4f5'; // default-skin light background / dark-mode key chip
const LIGHT_MUTED = '#e4e4e7'; // default-skin light group chips
const LIGHT_MUTED_STRONG = '#d4d4d8'; // one step darker than LIGHT_MUTED, so a pressed/active
// button never matches the group chip it sits inside
const LIGHT_WAVEFORM = '#a1a1aa';
const LIGHT_PLACEHOLDER = '#71717a';
const FROG_DARK_HOVER = '#4f5d42'; // lighter than FROG_DARK_SAGE, for the same reason

// The annotation box color is the one value identical in every cell today.
const sharedColors = {
  box: FROG_GREEN,
};

export const defaultColors = {
  ...sharedColors,
  header: FROG_GREEN,
  background: DEFAULT_INK,
  panels: DARK_SURFACE,
  group: DEFAULT_DARK_GROUP,
  buttons: DEFAULT_INK,
  buttonsHover: NEUTRAL_HOVER,
  buttonsText: PURE_WHITE,
  buttonsPressed: NEUTRAL_HOVER,
  themeToggle: WARM_YELLOW,

  audioButton: ACCENT_BLUE,
  audioButtonHover: ACCENT_BLUE_LIGHT,
  audioButtonPressed: ACCENT_BLUE_LIGHT,
  // Kept separate from buttonsText: the audio button's own background
  // doesn't invert with brightness the way `buttons` does, so its text
  // color has to be picked independently to stay legible in every palette.
  audioButtonText: PURE_WHITE,

  keyButtons: LIGHT_BG,
  keyText: DEFAULT_INK,
  text: OFF_WHITE,
  cursor: ACCENT_BLUE,
  progress: PURE_WHITE,
  waveform: MUTED_GRAY,
  cream: DARK_SURFACE,

  boxSelected: PURE_WHITE,
  boxFill: 'rgba(16, 185, 129, 0.05)',
  boxFillSelected: 'rgba(52, 211, 153, 0.15)',
  boxLabel: PURE_WHITE,
  boxLabelBg: FROG_GREEN,

  textInput: DARK_SURFACE,
  textInputText: OFF_WHITE,
  placeholderText: MUTED_GRAY,
};

export const defaultLightColors = {
  ...sharedColors,
  header: FROG_GREEN,
  background: LIGHT_BG,
  panels: PURE_WHITE,
  group: LIGHT_MUTED,
  buttons: PURE_WHITE,
  buttonsHover: LIGHT_MUTED_STRONG,
  buttonsText: DEFAULT_INK,
  buttonsPressed: LIGHT_MUTED_STRONG,
  themeToggle: WARM_YELLOW,

  audioButton: ACCENT_BLUE,
  audioButtonHover: ACCENT_BLUE_LIGHT,
  audioButtonPressed: ACCENT_BLUE_LIGHT,
  audioButtonText: PURE_WHITE,

  keyButtons: DEFAULT_INK,
  keyText: OFF_WHITE,
  text: DEFAULT_INK,
  cursor: ACCENT_BLUE,
  progress: DEFAULT_INK,
  waveform: LIGHT_WAVEFORM,
  cream: PURE_WHITE,

  boxSelected: DEFAULT_INK,
  boxFill: 'rgba(16, 185, 129, 0.05)',
  boxFillSelected: 'rgba(52, 211, 153, 0.15)',
  boxLabel: PURE_WHITE,
  boxLabelBg: FROG_GREEN,

  textInput: PURE_WHITE,
  textInputText: DEFAULT_INK,
  placeholderText: LIGHT_PLACEHOLDER,
};

export const frogThemeColors = {
  ...sharedColors,
  header: FROG_INK,
  background: FROG_CREAM_BG,
  panels: FROG_GREEN,
  group: FROG_SAGE,
  buttons: '#FEECBE',
  buttonsHover: WARM_YELLOW,
  buttonsText: FROG_INK,
  buttonsPressed: WARM_YELLOW,
  themeToggle: WARM_YELLOW,

  audioButton: FROG_PALE_BLUE,
  audioButtonHover: FROG_PALE_BLUE_HOVER,
  audioButtonPressed: FROG_PALE_BLUE_HOVER,
  audioButtonText: FROG_INK,

  keyButtons: FROG_INK,
  keyText: FROG_CREAM_BG,
  text: FROG_INK,
  cursor: FROG_PALE_BLUE,
  progress: FROG_CREAM_SURFACE,
  waveform: FROG_INK,
  cream: FROG_CREAM_SURFACE,

  boxSelected: FROG_INK,
  boxFill: 'rgba(130, 160, 98, 0.10)',
  boxFillSelected: 'rgba(30, 30, 30, 0.10)',
  boxLabel: FROG_INK,
  boxLabelBg: FROG_SAGE,

  textInput: PURE_WHITE,
  textInputText: FROG_INK,
  placeholderText: FROG_INK,
};

export const frogDarkColors = {
  ...sharedColors,
  header: FROG_INK,
  background: FROG_INK,
  panels: FROG_DARK_PANEL,
  group: FROG_DARK_SAGE,
  buttons: FROG_DARK_PANEL,
  buttonsHover: FROG_DARK_HOVER,
  buttonsText: FROG_CREAM_BG,
  buttonsPressed: FROG_DARK_HOVER,
  themeToggle: WARM_YELLOW,

  audioButton: FROG_PALE_BLUE,
  audioButtonHover: FROG_PALE_BLUE_HOVER,
  audioButtonPressed: FROG_PALE_BLUE_HOVER,
  audioButtonText: FROG_INK,

  keyButtons: FROG_CREAM_BG,
  keyText: FROG_INK,
  text: FROG_CREAM_BG,
  cursor: FROG_PALE_BLUE,
  progress: FROG_CREAM_BG,
  waveform: FROG_SAGE,
  cream: FROG_DARK_PANEL,

  boxSelected: FROG_CREAM_BG,
  boxFill: 'rgba(130, 160, 98, 0.10)',
  boxFillSelected: 'rgba(230, 229, 201, 0.15)',
  boxLabel: FROG_INK,
  boxLabelBg: FROG_SAGE,

  textInput: FROG_DARK_PANEL,
  textInputText: FROG_CREAM_BG,
  placeholderText: FROG_SAGE,
};

// Single lookup used by ThemeContext to turn the two boolean toggles into a
// palette — keeps the (skin, brightness) -> colors mapping in one place.
export function resolveTheme(frogTheme, lightMode) {
  if (frogTheme) return lightMode ? frogThemeColors : frogDarkColors;
  return lightMode ? defaultLightColors : defaultColors;
}
