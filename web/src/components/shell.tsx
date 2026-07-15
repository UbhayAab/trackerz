"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { clsx } from "clsx";
import {
  Home,
  Wallet,
  Salad,
  Dumbbell,
  BarChart3,
  Moon,
  Sun,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import { useTheme, useSession } from "./providers";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/money", label: "Money", icon: Wallet },
  { href: "/diet", label: "Diet", icon: Salad },
  { href: "/gym", label: "Gym", icon: Dumbbell },
  { href: "/analytics", label: "Stats", icon: BarChart3 },
];

const TITLES: Record<string, string> = {
  "/": "Today",
  "/money": "Money",
  "/diet": "Diet",
  "/gym": "Gym",
  "/analytics": "Analytics",
  "/settings": "Settings",
};

function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const { user } = useSession();
  const title = TITLES[pathname] ?? "Trackerz";
  const initial = (user?.email?.[0] || "U").toUpperCase();

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between px-5 py-4">
      <div className="glass -mx-2 flex w-full items-center justify-between rounded-2xl px-4 py-2.5">
        <h1 className="text-lg font-bold tracking-tight">{title}</h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            className="grid h-9 w-9 place-items-center rounded-xl border border-border bg-surface-2/60 text-muted transition hover:text-text"
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <Link
            href="/settings"
            aria-label="Settings"
            className="grid h-9 w-9 place-items-center rounded-xl bg-primary/20 text-sm font-bold text-primary transition hover:bg-primary/30"
          >
            {initial}
          </Link>
          <button
            onClick={signOut}
            aria-label="Sign out"
            className="grid h-9 w-9 place-items-center rounded-xl border border-border bg-surface-2/60 text-muted transition hover:text-danger"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}

function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <div className="glass mx-auto flex max-w-md items-center justify-around rounded-2xl p-1.5 shadow-card">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className="relative flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5"
            >
              {active && (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-xl bg-primary/15"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <Icon
                size={20}
                className={clsx("relative z-10 transition", active ? "text-primary" : "text-muted")}
              />
              <span
                className={clsx(
                  "relative z-10 text-[10px] font-medium transition",
                  active ? "text-primary" : "text-muted",
                )}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <TopBar />
      <main className="flex-1 px-5 pb-28">
        <AnimatePresence mode="wait">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
      <BottomNav />
    </div>
  );
}
