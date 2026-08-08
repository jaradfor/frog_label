import { useState, useRef, useEffect } from 'react';
import { freqToY, yToFreq } from '../utils/spectrogramScale';
import moonCursor from '../assets/moon_cursor.png';

const BoundingBoxLayer = ({
  code,
  boxes,
  setBoxes,
  currSelectedBoxId,
  setCurrSelectedBoxId,
  setDrawingBox,
  canvasWidth,
  visibleTime,
  theme,
  currTool,
  lowCutoff,
  highCutoff,
  yScale,
}) => {
  const [activeBox, setActiveBox] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [localWidth, setLocalWidth] = useState(0);
  const resizeState = useRef(null);
  const containerRef = useRef(null);

  // Track width for responsiveness
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setLocalWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      setLocalWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Clear drawing/resizing state when the visible viewport changes (e.g. scroll/zoom),
  // so a stale in-progress box doesn't carry over into the new view.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveBox(null);
    setIsDrawing(false);
    resizeState.current = null;
  }, [visibleTime]);

  const effectiveWidth = canvasWidth > 0 ? canvasWidth : localWidth > 0 ? localWidth : 1;
  const viewDuration = visibleTime.end - visibleTime.start;

  // Time -> Pixels
  const timeToPx = (time) => {
    if (viewDuration <= 0) return 0;
    const offsetTime = time - visibleTime.start;
    return (offsetTime / viewDuration) * effectiveWidth;
  };

  // Pixels -> Time
  const pxToTime = (px) => {
    const timeOffset = (px / effectiveWidth) * viewDuration;
    return visibleTime.start + timeOffset;
  };

  // Frequency -> Pixels (Y-axis)
  const freqToPx = (freq) => {
    // Clamp frequency to visible range to prevent boxes from going above/below spectrogram
    const clampedFreq = Math.max(lowCutoff, Math.min(highCutoff, freq));
    return freqToY(clampedFreq, lowCutoff, highCutoff, yScale);
  };

  // Pixels -> Frequency (Y-axis)
  const pxToFreq = (px) => {
    return yToFreq(px, lowCutoff, highCutoff, yScale);
  };

  const toPixels = (box) => ({
    ...box,
    left: timeToPx(box.startTime),
    width: timeToPx(box.endTime) - timeToPx(box.startTime),
    top: freqToPx(box.endFreq),
    height: freqToPx(box.startFreq) - freqToPx(box.endFreq),
  });

  const handleMouseDown = (e) => {
    if (currTool !== 2) return; // only draw with crosshair (tool 2)
    if (!code || code.length < 3) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const clickedBox = boxes.findLast((box) => {
      const px = toPixels(box);
      return x >= px.left && x <= px.left + px.width && y >= px.top && y <= px.top + px.height;
    });

    if (clickedBox) {
      setCurrSelectedBoxId(clickedBox.id);
      setDrawingBox?.(null);
      return;
    }

    setActiveBox({ startX: x, startY: y, currentX: x, currentY: y });
    setIsDrawing(true);
  };

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (resizeState.current) {
      const { corner, boxId, startX, startY, originalBox } = resizeState.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let { startTime, endTime, startFreq, endFreq } = originalBox;

      // Calculate new pixel positions based on drag
      const originalPx = toPixels(originalBox);
      let { left, top, width, height } = originalPx;

      if (corner === 'tl') {
        left += dx;
        top += dy;
        width -= dx;
        height -= dy;
      }
      if (corner === 'tr') {
        top += dy;
        width += dx;
        height -= dy;
      }
      if (corner === 'bl') {
        left += dx;
        width -= dx;
        height += dy;
      }
      if (corner === 'br') {
        width += dx;
        height += dy;
      }

      width = Math.max(20, width);
      height = Math.max(20, height);

      // Convert pixel positions back to time/frequency
      const newStartTime = pxToTime(left);
      const newEndTime = pxToTime(left + width);
      const newEndFreq = pxToFreq(top);
      const newStartFreq = pxToFreq(top + height);

      // Update only the affected values based on corner
      if (corner === 'tl' || corner === 'tr' || corner === 'bl' || corner === 'br') {
        if (corner === 'tl' || corner === 'bl') startTime = newStartTime;
        if (corner === 'tr' || corner === 'br') endTime = newEndTime;
        if (corner === 'tl' || corner === 'tr') endFreq = newEndFreq;
        if (corner === 'bl' || corner === 'br') startFreq = newStartFreq;
      }

      setDrawingBox?.({ startTime, endTime, startFreq, endFreq, code: originalBox.code });

      setBoxes((prev) =>
        prev.map((b) =>
          b.id === boxId ? { ...originalBox, startTime, endTime, startFreq, endFreq } : b,
        ),
      );
      return;
    }

    if (!isDrawing || !activeBox) return;

    setActiveBox((prev) => ({ ...prev, currentX: x, currentY: y }));

    const left = Math.min(activeBox.startX, x);
    const width = Math.abs(x - activeBox.startX);
    const top = Math.min(activeBox.startY, y);
    const height = Math.abs(y - activeBox.startY);

    const startTime = pxToTime(left);
    const endTime = pxToTime(left + width);
    const endFreq = pxToFreq(top);
    const startFreq = pxToFreq(top + height);

    setDrawingBox?.({
      startTime,
      endTime,
      startFreq,
      endFreq,
      code,
    });
  };

  const handleMouseUp = (e) => {
    if (resizeState.current) {
      resizeState.current = null;
      setDrawingBox?.(null);
      return;
    }

    if (!isDrawing || !activeBox) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const finalX = e.clientX - rect.left;
    const finalY = e.clientY - rect.top;

    const width = Math.abs(finalX - activeBox.startX);
    const height = Math.abs(finalY - activeBox.startY);

    if (width >= 10 && height >= 10) {
      const left = Math.min(activeBox.startX, finalX);
      const top = Math.min(activeBox.startY, finalY);

      const startTime = pxToTime(left);
      const endTime = pxToTime(left + width);
      const endFreq = pxToFreq(top);
      const startFreq = pxToFreq(top + height);

      setBoxes((prev) => [
        ...prev,
        {
          id: Date.now(),
          startTime,
          endTime,
          startFreq,
          endFreq,
          code,
        },
      ]);
    }

    setActiveBox(null);
    setIsDrawing(false);
    setDrawingBox?.(null);
  };

  const handleCornerMouseDown = (e, corner, boxId) => {
    e.stopPropagation();
    setCurrSelectedBoxId(boxId);

    const masterBox = boxes.find((b) => b.id === boxId);
    if (!masterBox) return;

    resizeState.current = {
      corner,
      boxId,
      startX: e.clientX,
      startY: e.clientY,
      originalPx: toPixels(masterBox),
      originalBox: { ...masterBox },
    };
  };

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-40 select-none }`} // ${code ? 'cursor-crosshair' : 'cursor-default'
      style={{
        cursor: currTool === 2 ? 'crosshair' : currTool === 3 ? `url(${moonCursor}), auto` : 'auto',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {boxes.map((box, index) => {
        const px = toPixels(box);
        const isSelected = box.id === currSelectedBoxId;

        if (px.left + px.width < 0 || px.left > effectiveWidth) return null;

        return (
          <div
            key={box.id}
            className="absolute border-2 z-40"
            style={{
              left: px.left,
              top: px.top,
              width: px.width,
              height: px.height,
              cursor:
                currTool === 2 ? 'crosshair' : currTool === 3 ? `url(${moonCursor}), auto` : 'auto',
              borderColor: isSelected ? theme.boxSelected : theme.box,
              backgroundColor: isSelected ? theme.boxFillSelected : theme.boxFill,
            }}
          >
            {/* Box Metadata Labels */}
            <div className="absolute -top-4 left-0 right-0 flex justify-between pointer-events-none px-0.5">
              {/* Top Left: Box Index */}
              <div
                className="font-display text-[9px] px-1 rounded-t-sm flex items-center justify-center"
                style={{
                  backgroundColor: theme.keyButtons,
                  color: theme.keyText,
                  height: '14px',
                }}
              >
                {index + 1}
              </div>

              {/* Top Right: Label Code */}
              {box.code && (
                <div
                  className="font-display text-[9px] px-1 rounded-t-sm flex items-center justify-center"
                  style={{
                    backgroundColor: theme.boxLabelBg,
                    color: theme.boxLabel,
                    border: `1px solid ${isSelected ? theme.boxSelected : theme.box}`,
                    borderBottom: 'none',
                    height: '14px',
                  }}
                >
                  {box.code}
                </div>
              )}
            </div>

            {/* Selected State & Resize Handles */}
            {isSelected && (
              <div
                className="absolute -inset-[2px] border-2 pointer-events-none"
                style={{ borderColor: theme.boxSelected }}
              >
                {[
                  { pos: '-top-1.5 -left-1.5', corner: 'tl', cursor: 'cursor-nwse-resize' },
                  { pos: '-top-1.5 -right-1.5', corner: 'tr', cursor: 'cursor-nesw-resize' },
                  { pos: '-bottom-1.5 -left-1.5', corner: 'bl', cursor: 'cursor-nesw-resize' },
                  { pos: '-bottom-1.5 -right-1.5', corner: 'br', cursor: 'cursor-nwse-resize' },
                ].map(({ pos, corner, cursor }) => (
                  <div
                    key={corner}
                    className={`absolute ${pos} ${cursor} w-2.5 h-2.5 rounded-full pointer-events-auto shadow-sm`}
                    style={{ backgroundColor: theme.boxSelected }}
                    onMouseDown={(e) => handleCornerMouseDown(e, corner, box.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Ghost Box while drawing */}
      {isDrawing && activeBox && (
        <div
          className="absolute border-2 pointer-events-none z-50"
          style={{
            left: Math.min(activeBox.startX, activeBox.currentX),
            top: Math.min(activeBox.startY, activeBox.currentY),
            width: Math.abs(activeBox.currentX - activeBox.startX),
            height: Math.abs(activeBox.currentY - activeBox.startY),
            borderColor: theme.box,
            backgroundColor: theme.boxFill,
          }}
        >
          <div className="absolute -top-4 right-0 flex pointer-events-none px-0.5">
            <div
              className="font-display text-[9px] px-1 rounded-t-sm flex items-center justify-center"
              style={{
                backgroundColor: theme.boxLabelBg,
                color: theme.boxLabel,
                border: `1px solid ${theme.box}`,
                borderBottom: 'none',
                height: '14px',
              }}
            >
              {code}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BoundingBoxLayer;
