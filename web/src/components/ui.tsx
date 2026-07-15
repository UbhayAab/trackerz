"use client";

import { clsx } from "clsx";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

export function Card({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      className={clsx("card p-5", className)}
    >
      {children}
    </motion.div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  delay = 0,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "primary" | "success" | "warn" | "danger";
  delay?: number;
}) {
  const toneClass = {
    default: "text-text",
    primary: "text-gradient",
    success: "text-success",
    warn: "text-warn",
    danger: "text-danger",
  }[tone];
  return (
    <Card delay={delay} className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={clsx("mt-1 text-2xl font-bold tabular-nums", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("chip", className)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} />;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-8 text-center">
      {icon ? <div className="text-muted">{icon}</div> : null}
      <div className="text-sm font-medium text-text">{title}</div>
      {hint ? <div className="max-w-xs text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
