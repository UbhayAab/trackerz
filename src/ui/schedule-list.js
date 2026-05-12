const scheduleItems = [
  { name: "00:00 data lock", detail: "Collect today spend, food logs, protein, sleep, steps, duplicates." },
  { name: "00:01 DeepSeek summary", detail: "Generate day summary, budget burn, calorie/protein gap, and next-day plan." },
  { name: "00:02 review queue", detail: "Move uncertain rows, duplicates, and hallucination-risk items into review." },
  { name: "Morning card", detail: "Show yesterday recap and today budget/calorie/protein targets on first open." },
];

export function renderScheduleList() {
  const element = document.querySelector("#scheduleList");
  if (!element) return;
  element.innerHTML = scheduleItems
    .map((item) => `
      <article class="pipeline-step">
        <strong>${item.name}</strong>
        <span>${item.detail}</span>
      </article>
    `)
    .join("");
}
