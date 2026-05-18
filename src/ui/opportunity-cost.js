import { computeOpportunityCost } from "../analytics/opportunity-cost.js";
import { fetchLedger } from "../services/supabase-data.js";

const INR = new Intl.NumberFormat("en-IN");
const PANEL_ID = "opportunityCostPanel";

export async function renderOpportunityCost(_state) {
  const host = document.getElementById(PANEL_ID) || createPanel();
  if (!host) return;

  let ledger = [];
  try {
    ledger = await fetchLedger({ limit: 500 });
  } catch (err) {
    host.innerHTML = `<p class="muted small">Could not load ledger: ${err.message || err}</p>`;
    return;
  }

  const result = computeOpportunityCost(ledger);
  if (result.count === 0) {
    host.innerHTML = `
      <div class="panel-title-row">
        <div>
          <p class="eyebrow">Opportunity cost</p>
          <h2>Nifty 50 alternative</h2>
        </div>
        <span class="status-pill muted">no data yet</span>
      </div>
      <p class="muted">Once you log a few discretionary expenses, this card shows what they'd be worth had you bought Nifty 50 instead.</p>
    `;
    return;
  }

  const gainSign = result.gain >= 0 ? "+" : "";
  const gainColor = result.gain >= 0 ? "var(--money)" : "var(--risk)";

  host.innerHTML = `
    <div class="panel-title-row">
      <div>
        <p class="eyebrow">Opportunity cost</p>
        <h2>If you had bought Nifty 50 instead</h2>
      </div>
      <span class="status-pill muted">${result.count} expense(s)</span>
    </div>
    <div class="opp-grid">
      <div>
        <p class="muted small">You spent (discretionary)</p>
        <strong>Rs ${INR.format(result.totalSpent)}</strong>
      </div>
      <div>
        <p class="muted small">Would be worth today</p>
        <strong>Rs ${INR.format(result.hypotheticalNow)}</strong>
      </div>
      <div>
        <p class="muted small">Hypothetical gain</p>
        <strong style="color:${gainColor}">${gainSign}Rs ${INR.format(Math.abs(result.gain))} (${gainSign}${result.pct}%)</strong>
      </div>
    </div>
    <p class="muted small">Uses month-end Nifty 50 closes as a coarse benchmark. Reference month: ${result.referenceMonth}.</p>
  `;
}

function createPanel() {
  const main = document.querySelector("main");
  if (!main) return null;
  const section = document.createElement("section");
  section.id = PANEL_ID;
  section.className = "ai-panel opp-panel";
  const insightsHero = main.querySelector(".insights-hero");
  if (insightsHero?.nextSibling) {
    main.insertBefore(section, insightsHero.nextSibling);
  } else {
    main.appendChild(section);
  }
  return section;
}
