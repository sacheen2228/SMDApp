// Resizable Panel — drag to resize with min/max constraints

"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface ResizablePanelProps {
  children: React.ReactNode;
  defaultSize?: number; // percentage
  minSize?: number;
  maxSize?: number;
  direction?: "horizontal" | "vertical";
  className?: string;
}

export function ResizablePanel({
  children,
  defaultSize = 50,
  minSize = 20,
  maxSize = 80,
  direction = "horizontal",
  className = "",
}: ResizablePanelProps) {
  const [size, setSize] = useState(defaultSize);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
    startSize.current = size;
  }, [direction, size]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;

    const container = containerRef.current.parentElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const delta = direction === "horizontal"
      ? e.clientX - startPos.current
      : e.clientY - startPos.current;
    const containerSize = direction === "horizontal"
      ? containerRect.width
      : containerRect.height;
    const deltaPercent = (delta / containerSize) * 100;
    const newSize = Math.max(minSize, Math.min(maxSize, startSize.current + deltaPercent));

    setSize(newSize);
  }, [isDragging, direction, minSize, maxSize]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp, direction]);

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={{
        [direction === "horizontal" ? "width" : "height"]: `${size}%`,
        [direction === "horizontal" ? "minWidth" : "minHeight"]: `${minSize}%`,
        [direction === "horizontal" ? "maxWidth" : "maxHeight"]: `${maxSize}%`,
        flexShrink: 0,
      }}
    >
      {children}
      {/* Drag handle */}
      <div
        className={`absolute ${
          direction === "horizontal"
            ? "right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30"
            : "bottom-0 left-0 right-0 h-1 cursor-row-resize hover:bg-primary/30"
        } ${isDragging ? "bg-primary/40" : "bg-transparent"} transition-colors z-50`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
