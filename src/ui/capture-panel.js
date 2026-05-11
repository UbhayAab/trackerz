import { $, $all } from "../utils/dom.js";
import { previewCaptureRoute } from "../services/capture-router.js";

export function renderRoutePreview() {
  const { captureType, route } = previewCaptureRoute({
    text: $("#captureText").value,
    files: $("#fileInput").files,
  });
  const media = route.mediaModel ? `${route.mediaModel} -> ` : "";
  $("#routePreview").textContent = `Auto route: ${captureType}. ${media}${route.brainModel}. ${route.reason}`;
}

export function bindCapturePanel() {
  $("#captureText").addEventListener("input", renderRoutePreview);
  $("#fileInput").addEventListener("change", renderRoutePreview);

  $("#submitCapture").addEventListener("click", () => {
    const hasText = $("#captureText").value.trim().length > 0;
    const hasFiles = $("#fileInput").files.length > 0;
    if (!hasText && !hasFiles) return;
    $("#reviewCount").textContent = String(Number($("#reviewCount").textContent) + 1);
    $("#captureText").value = "";
    renderRoutePreview();
  });

  $all(".mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      $all(".mode-card").forEach((item) => item.classList.remove("active"));
      card.classList.add("active");
    });
  });

  $all(".quick-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("#captureText").value = chip.dataset.template;
      $("#captureText").focus();
      renderRoutePreview();
    });
  });
}
