import { classifyCaptureInput, estimateMonthlyAiCost, routeModelForCapture } from "./lib/agent-core.mjs";
import { getFlowsByDomain, getFlowStats } from "./lib/flow-catalog.mjs";

const trendData = {
  dod: [
    { label: "Mon", value: 42 },
    { label: "Tue", value: 58 },
    { label: "Wed", value: 37 },
    { label: "Thu", value: 64 },
    { label: "Fri", value: 88 },
    { label: "Sat", value: 76 },
    { label: "Sun", value: 51 },
  ],
  wow: [
    { label: "W1", value: 61 },
    { label: "W2", value: 68 },
    { label: "W3", value: 56 },
    { label: "W4", value: 73 },
  ],
  mom: [
    { label: "Aug", value: 72 },
    { label: "Sep", value: 63 },
    { label: "Oct", value: 79 },
    { label: "Nov", value: 83 },
    { label: "Dec", value: 69 },
  ],
  trajectory: [
    { label: "Spend", value: 48 },
    { label: "Protein", value: 66 },
    { label: "Sleep", value: 52 },
    { label: "Steps", value: 74 },
    { label: "Mood", value: 59 },
  ],
};

const insights = [
  "Food photos and EOD voice are likely describing the same dinner. One duplicate is waiting for review.",
  "Weekend spend is running 31% above budget pace, mostly food delivery and fuel.",
  "Protein is improving week over week, but breakfast is still the weakest meal window.",
  "Sleep below 6.5 hours predicts lower habit score the next day in this sample.",
];

function money(value) {
  return `$${value.toFixed(2)}`;
}

function renderChart(view) {
  const chart = document.querySelector("#chart");
  const activeViewLabel = document.querySelector("#activeViewLabel");
  const data = trendData[view];
  const max = Math.max(...data.map((point) => point.value));

  activeViewLabel.textContent = view.toUpperCase();
  chart.innerHTML = data
    .map((point) => {
      const height = Math.max(8, Math.round((point.value / max) * 142));
      return `
        <div class="bar">
          <div class="bar-fill" style="height:${height}px"></div>
          <span>${point.label}</span>
        </div>
      `;
    })
    .join("");
}

function renderInsights() {
  const list = document.querySelector("#insightList");
  list.innerHTML = insights.map((item) => `<li>${item}</li>`).join("");
}

function calculateCost() {
  const images = Number(document.querySelector("#imagesPerDay").value);
  const voiceMinutes = Number(document.querySelector("#voicePerDay").value);
  const events = Number(document.querySelector("#eventsPerDay").value);

  const cost = estimateMonthlyAiCost({
    imagesPerDay: images,
    voiceMinutesPerDay: voiceMinutes,
    agentEventsPerDay: events,
  });

  document.querySelector("#monthlyCost").textContent = money(cost.monthlyTotal);
  document.querySelector("#costBreakdown").textContent =
    `${images} images/day, ${voiceMinutes} voice min/day, ${events} agent events/day. ` +
    `Estimated Gemini ${money(cost.monthlyGemini)}/mo, DeepSeek ${money(cost.monthlyDeepseek)}/mo.`;
}

function updateRoutePreview() {
  const fileInput = document.querySelector("#fileInput");
  const files = Array.from(fileInput.files).map((file) => ({
    name: file.name,
    type: file.type,
    kind: file.type.startsWith("image/") ? "image" : file.name,
  }));
  const captureType = classifyCaptureInput({
    text: document.querySelector("#captureText").value,
    files,
  });
  const route = routeModelForCapture({
    captureType: captureType === "media_review" && files.length > 8 ? "media_review" : captureType,
    risk: files.length > 12 ? "high" : "normal",
  });
  const media = route.mediaModel ? `${route.mediaModel} -> ` : "";
  document.querySelector("#routePreview").textContent =
    `Auto route: ${captureType}. ${media}${route.brainModel}. ${route.reason}`;
}

function renderFlows(domain = "all") {
  const flowList = document.querySelector("#flowList");
  const flowCount = document.querySelector("#flowCount");
  const flows = getFlowsByDomain(domain);
  flowCount.textContent = String(domain === "all" ? getFlowStats().total : flows.length);
  flowList.innerHTML = flows
    .slice(0, 14)
    .map(
      (flow) => `
        <article class="flow-card">
          <header>
            <h3>${flow.title}</h3>
            <span class="flow-domain">${flow.domain}</span>
          </header>
          <p>${flow.trigger}</p>
          <p><strong>AI:</strong> ${flow.aiSteps.join(" -> ")}</p>
          <p><strong>Example:</strong> ${flow.examples[0]}</p>
        </article>
      `,
    )
    .join("");
}

function attachEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      renderChart(tab.dataset.view);
    });
  });

  document.querySelectorAll(".mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".mode-card").forEach((item) => item.classList.remove("active"));
      card.classList.add("active");
    });
  });

  ["#imagesPerDay", "#voicePerDay", "#eventsPerDay"].forEach((selector) => {
    document.querySelector(selector).addEventListener("input", calculateCost);
  });

  document.querySelector("#submitCapture").addEventListener("click", () => {
    const text = document.querySelector("#captureText").value.trim();
    const files = document.querySelector("#fileInput").files.length;
    const review = document.querySelector("#reviewCount");
    const current = Number(review.textContent);
    if (text || files) {
      review.textContent = String(current + 1);
      document.querySelector("#captureText").value = "";
      updateRoutePreview();
    }
  });

  document.querySelector("#captureText").addEventListener("input", updateRoutePreview);
  document.querySelector("#fileInput").addEventListener("change", updateRoutePreview);

  document.querySelector("#refreshInsights").addEventListener("click", renderInsights);

  document.querySelectorAll(".quick-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelector("#captureText").value = chip.dataset.template;
      document.querySelector("#captureText").focus();
      updateRoutePreview();
    });
  });

  document.querySelectorAll(".flow-filter").forEach((filter) => {
    filter.addEventListener("click", () => {
      document.querySelectorAll(".flow-filter").forEach((item) => item.classList.remove("active"));
      filter.classList.add("active");
      renderFlows(filter.dataset.domain);
    });
  });
}

renderChart("dod");
renderInsights();
calculateCost();
renderFlows("all");
updateRoutePreview();
attachEvents();
