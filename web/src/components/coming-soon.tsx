"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

export function ComingSoon({ title, points }: { title: string; points: string[] }) {
  return (
    <div className="space-y-5 pt-2">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="card flex flex-col items-center gap-3 p-8 text-center"
      >
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/15 text-primary">
          <Sparkles size={26} />
        </div>
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="text-sm text-muted">Porting from the current app — parity in progress.</p>
      </motion.div>
      <div className="space-y-2">
        {points.map((p, i) => (
          <motion.div
            key={p}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.05 + i * 0.05 }}
            className="card flex items-center gap-3 p-3 text-sm text-muted"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {p}
          </motion.div>
        ))}
      </div>
    </div>
  );
}
