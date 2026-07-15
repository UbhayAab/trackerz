"use client";

import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Salad, Dumbbell } from "lucide-react";
import type { FeedItem, HomeData } from "@/lib/services";
import { inr, num, relativeTime } from "@/lib/format";
import { StatTile, Card, SectionTitle, EmptyState, Skeleton } from "./ui";

export function GlanceMetrics({ data }: { data: HomeData }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <StatTile label="Spent today" value={inr(data.spendToday)} tone="primary" delay={0.02} />
      <StatTile label="Protein" value={`${num(Math.round(data.proteinToday))} g`} tone="success" delay={0.06} />
      <StatTile label="Calories" value={num(Math.round(data.caloriesToday))} delay={0.1} />
      <StatTile
        label="Workouts"
        value={data.workoutsToday ? `${data.workoutsToday} logged` : "—"}
        tone={data.workoutsToday ? "success" : "default"}
        delay={0.14}
      />
    </div>
  );
}

const KIND_META: Record<FeedItem["kind"], { icon: typeof Salad; className: string }> = {
  expense: { icon: ArrowUpRight, className: "text-danger bg-danger/15" },
  income: { icon: ArrowDownRight, className: "text-success bg-success/15" },
  food: { icon: Salad, className: "text-accent bg-accent/15" },
  workout: { icon: Dumbbell, className: "text-primary bg-primary/15" },
};

export function AdditionsFeed({ feed }: { feed: FeedItem[] }) {
  if (!feed.length) {
    return (
      <EmptyState
        title="Nothing logged yet"
        hint="Drop a note, photo, or voice memo above — it fans out to money, diet, and gym automatically."
      />
    );
  }
  return (
    <div className="space-y-2">
      {feed.map((item, i) => {
        const meta = KIND_META[item.kind];
        const Icon = meta.icon;
        return (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.3), ease: [0.22, 1, 0.36, 1] }}
            className="card flex items-center gap-3 p-3"
          >
            <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${meta.className}`}>
              <Icon size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{item.title}</div>
              {item.subtitle ? <div className="truncate text-xs text-muted">{item.subtitle}</div> : null}
            </div>
            <div className="text-right">
              {item.amount != null ? (
                <div
                  className={`text-sm font-semibold tabular-nums ${
                    item.kind === "income" ? "text-success" : "text-text"
                  }`}
                >
                  {item.kind === "income" ? "+" : ""}
                  {inr(item.amount)}
                </div>
              ) : null}
              <div className="text-[11px] text-muted">{relativeTime(item.at)}</div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 w-full" />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}

export { Card, SectionTitle };
