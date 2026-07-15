"use client";

import { useCallback, useEffect, useState } from "react";
import { CaptureBar } from "@/components/capture-bar";
import { GlanceMetrics, AdditionsFeed, HomeSkeleton } from "@/components/home";
import { SectionTitle } from "@/components/ui";
import { loadHome, type HomeData } from "@/lib/services";

const EMPTY: HomeData = { spendToday: 0, proteinToday: 0, caloriesToday: 0, workoutsToday: 0, feed: [] };

export default function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);

  const refresh = useCallback(() => {
    loadHome()
      .then(setData)
      .catch(() => setData(EMPTY));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-6 pt-1">
      <CaptureBar onCaptured={refresh} />
      {!data ? (
        <HomeSkeleton />
      ) : (
        <>
          <GlanceMetrics data={data} />
          <section>
            <SectionTitle>Recent activity</SectionTitle>
            <AdditionsFeed feed={data.feed} />
          </section>
        </>
      )}
    </div>
  );
}
