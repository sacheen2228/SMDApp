"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface PanelProps extends React.ComponentProps<"div"> {
  title?: string;
  subtitle?: string;
  className?: string;
}

export function Panel({
  title,
  subtitle,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <div
      data-slot="panel"
      className={cn("ty-panel ty-panel-raised overflow-hidden", className)}
      {...props}
    >
      {title || subtitle ? (
        <div className="px-5 pt-5 pb-1 border-b border-ty-hairline flex items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            {title && (
              <h3 className="ty-text-title font-semibold text-foreground">{title}</h3>
            )}
            {subtitle && (
              <p className="ty-text-xs text-ty-subtle-fg">{subtitle}</p>
            )}
          </div>
        </div>
      ) : null}
      <div className="px-5 pb-5">{children}</div>
    </div>
  );
}

interface StatCellProps {
  label: string;
  value: React.ReactNode;
  change?: { value: string; up: boolean };
  tone?: "up" | "down" | "neutral" | "brand";
}

export function StatCell({
  label,
  value,
  change,
  tone,
  className,
}: StatCellProps) {
  const toneClass =
    tone === "up"
      ? "text-ty-up"
      : tone === "down"
        ? "text-ty-down"
        : tone === "brand"
          ? "text-ty-brand"
          : "text-ty-muted-fg";
  return (
    <div
      data-slot="stat-cell"
      className={cn("flex flex-col gap-0.5", className)}
    >
      <span className="ty-stat-label">{label}</span>
      <div className="flex items-baseline gap-1 ty-stat-value">
        {value}
      </div>
      {change && (
        <span
          className={cn("ty-text-xs font-medium whitespace-nowrap", toneClass)}
        >
          {change.up ? "+" : ""}{change.value}
        </span>
      )}
    </div>
  );
}

interface ChipProps extends React.ComponentProps<"span"> {
  active?: boolean;
  tone?: "up" | "down" | "neutral" | "brand";
}

export function Chip({
  children,
  active,
  tone = "neutral",
  className,
  ...props
}: ChipProps) {
  const base =
    tone === "up"
      ? "border-ty-up/40 bg-ty-up/10 text-ty-up"
      : tone === "down"
        ? "border-ty-down/40 bg-ty-down/10 text-ty-down"
        : tone === "brand"
          ? "border-ty-brand/40 bg-ty-brand/10 text-ty-brand"
          : "border-transparent bg-ty-fill text-ty-muted-fg";
  return (
    <span
      data-slot="chip"
      className={cn(
        "ty-chip shrink-0",
        active ? "border-ty-hairline bg-transparent text-foreground" : base,
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

interface PillsProps {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  className?: string;
}

export function TimeframePills({
  value,
  onChange,
  options,
  className,
}: PillsProps) {
  return (
    <div
      data-slot="timeframe-pills"
      className={cn("inline-flex gap-1", className)}
    >
      {options.map((opt) => (
        <Chip
          key={opt.value}
          active={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Chip>
      ))}
    </div>
  );
}
