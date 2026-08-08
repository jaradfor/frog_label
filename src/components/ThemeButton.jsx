function ThemeButton({
  theme,
  onClick,
  children,
  className = '',
  type = 'button',
  active = false,
  ...rest
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      {...rest}
      style={{
        backgroundColor: active ? theme.buttonsPressed : theme.buttons,
        color: theme.buttonsText,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = theme.buttonsHover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = theme.buttons;
      }}
      className={className}
    >
      {children}
    </button>
  );
}

export default ThemeButton;
