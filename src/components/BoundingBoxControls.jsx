import { useState, useEffect, useRef } from 'react';

function BoundingBoxControls({ code, setCode, codesDict, boxes, setBoxes, currSelectedBoxId, setCurrSelectedBoxId, setCurrTool, theme }) {
  const inputRef = useRef(null);
  const [isError, setIsError] = useState(false);
  
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isTabPressed, setIsTabPressed] = useState(false);
  const [, setIsShiftVPressed] = useState(false);
  const [isShiftDPressed, setIsShiftDPressed] = useState(false);
  const [isEscPressed, setIsEscPressed] = useState(false);

  const handleSetCode = () => {
      setCode('');
      inputRef.current?.focus();
      inputRef.current?.select();
  };

  const handleCodeInput = (e) => {
    const value = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
    if (value.length <= 3) {
      setCode(value);
      setIsError(false);
      if (value.length === 3) {
        // Delay blur to allow typing to complete
        setTimeout(() => {
          if (Object.keys(codesDict).includes(value)) {
            setCurrTool(2);
            setIsError(false);
          } else {
            setCode(''); 
            setIsError(true);
            setTimeout(() => setIsError(false), 1000);
          }
          inputRef.current?.blur();
        }, 100); // Short delay to prevent interruption
      }
    }
  };

  const handleSelectBox = () => {
    if (boxes.length === 0) return;
    const currentIndex = boxes.findIndex(b => b.id === currSelectedBoxId);
    const nextIndex = (currentIndex + 1) % boxes.length;
    setCurrSelectedBoxId(boxes[nextIndex].id);
  };

  const handlePlayBoxAudio = () => console.log("Play Box Audio");

  const handleDeleteBox = () => {
    if (currSelectedBoxId !== -1) {
      setBoxes((prev) => prev.filter((box) => box.id !== currSelectedBoxId));
      setCurrSelectedBoxId(-1);
    }
  };

  const handleDeselectBox = () => setCurrSelectedBoxId(-1);

  const actionsRef = useRef({ handleSetCode, handleSelectBox, handlePlayBoxAudio, handleDeleteBox, handleDeselectBox });
  useEffect(() => {
    actionsRef.current = { handleSetCode, handleSelectBox, handlePlayBoxAudio, handleDeleteBox, handleDeselectBox };
  });

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Allow spacebar to trigger even if input is focused
      if (e.key === ' ') { 
        e.preventDefault(); 
        setIsSpacePressed(true); 
        actionsRef.current.handleSetCode(); 
        return; // Early return after handling space
      }
      if (document.activeElement === inputRef.current && e.key !== 'Escape') return;

      if (e.key === 'Tab') { e.preventDefault(); setIsTabPressed(true); actionsRef.current.handleSelectBox(); }
      if (e.shiftKey && e.key.toUpperCase() === 'V') { e.preventDefault(); setIsShiftVPressed(true); actionsRef.current.handlePlayBoxAudio(); }
      if (e.shiftKey && e.key.toUpperCase() === 'D') { e.preventDefault(); setIsShiftDPressed(true); actionsRef.current.handleDeleteBox(); }
      if (e.key === 'Escape') { setIsEscPressed(true); actionsRef.current.handleDeselectBox(); }
    };
    const handleKeyUp = (e) => {
      if (e.key === ' ') setIsSpacePressed(false);
      if (e.key === 'Tab') setIsTabPressed(false);
      if (e.key === 'Shift' || e.key.toUpperCase() === 'V') setIsShiftVPressed(false);
      if (e.key === 'Shift' || e.key.toUpperCase() === 'D') setIsShiftDPressed(false);
      if (e.key === 'Escape') setIsEscPressed(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  return (
    <div className='flex items-center justify-center gap-2 flex-wrap'>
      <div style={{ backgroundColor: theme.group }} className='p-1.5 rounded-xl flex items-center gap-1 font-display'>
        <button onClick={handleSetCode}
          style={{ backgroundColor: isSpacePressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isSpacePressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isSpacePressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Set Code
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>Space</div>
        </button>
        <div style={{ color: theme.text }}>+</div>
        <input
          ref={inputRef}
          value={code}
          onChange={handleCodeInput}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder='Code'
          maxLength={3}
          className={`w-15 px-2 py-1.5 text-xs rounded-md font-display uppercase placeholder:normal-case
            ${isError ? 'border-2 border-[#FFAAAA]' : 'border-none'}`}
          style={{ 
            backgroundColor: theme.textInput, 
            color: theme.textInputText,
            '--placeholder-color': theme.placeholderText 
          }}
        />
        <div style={{ color: theme.text }}>:</div>
        <div style={{ backgroundColor: theme.cream, color: theme.textInputText }} className='px-2 py-1.5 text-xs rounded-md font-display'>
          {codesDict[code] || '—'}
        </div>
      </div>

      <div style={{ backgroundColor: theme.group }} className='p-1.5 rounded-xl flex items-center gap-1'>
        <button onClick={handleSelectBox}
          style={{ backgroundColor: isTabPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isTabPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isTabPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Select Box
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>Tab</div>
        </button>
        <button onClick={handleDeleteBox}
          style={{ backgroundColor: isShiftDPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isShiftDPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isShiftDPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Delete Box
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>Shift</div>
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>D</div>
        </button>
        <button onClick={handleDeselectBox}
          style={{ backgroundColor: isEscPressed ? theme.buttonsPressed : theme.buttons, color: theme.buttonsText }}
          onMouseEnter={(e) => !isEscPressed && (e.currentTarget.style.backgroundColor = theme.buttonsHover)}
          onMouseLeave={(e) => !isEscPressed && (e.currentTarget.style.backgroundColor = theme.buttons)}
          className='px-2 py-1.5 text-xs rounded-md font-display whitespace-nowrap cursor-pointer flex items-center gap-1'>
          Deselect Box
          <div style={{ backgroundColor: theme.keyButtons, color: theme.keyText }} className='text-xs font-display px-2 rounded-md'>Esc</div>
        </button>
      </div>
    </div>
  );
}

export default BoundingBoxControls;