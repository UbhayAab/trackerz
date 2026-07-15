import { AppShell } from "@/components/shell";

// Every route in this group is wrapped in the nav shell. /login lives outside it.
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
