import { useState } from 'react';

function CodesPanel({ codesDict, setCodesDict, theme }) {
  const [code, setCode] = useState('');
  const [speciesName, setSpeciesName] = useState('');
  const [search, setSearch] = useState('');
  const [isCodeError, setIsCodeError] = useState(false);
  const [isNameError, setIsNameError] = useState(false);

  const handleCreate = () => {
    if (!code.trim() || !speciesName.trim()) {
      return;
    } else if (code.length < 3) {
      setCode('');
      setIsCodeError(true);
      setTimeout(() => setIsCodeError(false), 1000);
      return;
    } else if (Object.values(codesDict).includes(speciesName.trim())) {
      setSpeciesName('');
      setCode('');
      setIsNameError(true);
      setTimeout(() => setIsNameError(false), 1000);
      return;
    } else if (Object.keys(codesDict).includes(code)) {
      setCode('');
      setIsCodeError(true);
      setTimeout(() => setIsCodeError(false), 1000);
      return;
    }
    setIsCodeError(false);
    setCodesDict((prev) => ({ ...prev, [code.trim()]: speciesName.trim() }));
    setCode('');
    setSpeciesName('');
  };

  const filteredCodes = Object.entries(codesDict).filter(([, name]) =>
    name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleDelete = (codeToDelete) => {
    setCodesDict((prev) => {
      const next = { ...prev };
      delete next[codeToDelete];
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        style={{ backgroundColor: theme.keyButtons, color: theme.keyText }}
        className="text-sm font-display px-2 rounded-md w-5 flex items-center justify-center"
      >
        1
      </div>

      <div
        style={{ backgroundColor: theme.group, color: theme.text }}
        className="flex flex-col flex-1 rounded-lg font-display text-md p-2 gap-1"
      >
        Create Code
        <div className="flex flex-row items-center justify-center gap-1">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Code"
            onKeyDown={(e) => e.stopPropagation()}
            maxLength={3}
            style={{
              backgroundColor: theme.textInput,
              color: theme.textInputText,
              '--placeholder-color': theme.placeholderText,
            }}
            className={`w-15 px-2 py-1.5 text-sm rounded-md font-display uppercase placeholder:normal-case
                        ${isCodeError ? 'border-2 border-[#FFAAAA]' : 'border-none'}`}
          />
          <input
            value={speciesName}
            onChange={(e) => setSpeciesName(e.target.value)}
            placeholder="Species Name"
            onKeyDown={(e) => e.stopPropagation()}
            maxLength={35}
            style={{
              backgroundColor: theme.textInput,
              color: theme.textInputText,
              '--placeholder-color': theme.placeholderText,
            }}
            className={`w-25 px-2 py-1.5 text-sm  rounded-md font-display
                        ${isNameError ? 'border-2 border-[#FFAAAA]' : 'border-none'}`}
          />
        </div>
        <button
          onClick={handleCreate}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = theme.buttons)}
          onMouseDown={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsPressed)}
          onMouseUp={(e) => (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          style={{ backgroundColor: theme.buttons, color: theme.buttonsText }}
          className="w-full px-2 py-1.5 text-sm rounded-md font-display whitespace-nowrap cursor-pointer"
        >
          Create
        </button>
      </div>

      <div
        style={{ backgroundColor: theme.group, color: theme.text }}
        className="flex flex-col flex-1 rounded-lg font-display text-md p-2 gap-1"
      >
        Codes
        <div className="flex flex-row gap-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            onKeyDown={(e) => e.stopPropagation()}
            maxLength={35}
            style={{
              backgroundColor: theme.textInput,
              color: theme.textInputText,
              '--placeholder-color': theme.placeholderText,
            }}
            className="w-40 px-2 py-1.5 text-sm rounded-md font-display"
          />
        </div>
        <div className="rounded-lg flex flex-col gap-1 overflow-y-auto">
          {filteredCodes.length === 0 ? (
            <div style={{ color: theme.keyText }} className="font-display text-sm">
              No codes found
            </div>
          ) : (
            filteredCodes.map(([c, name]) => (
              <div
                key={c}
                style={{ backgroundColor: theme.cream }}
                className="rounded-md px-2 py-1 flex items-center justify-between"
              >
                <div>
                  <div style={{ color: theme.textInputText }} className="font-display text-sm">
                    {c}
                  </div>
                  <div style={{ color: theme.textInputText }} className="font-display text-xs">
                    {name}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(c)}
                  className="text-red-400 hover:text-red-600 font-display text-sm cursor-pointer"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default CodesPanel;
