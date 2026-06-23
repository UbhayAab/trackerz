import { bootWithAuth } from "./bootstrap.js";
import { renderNav } from "../ui/navigation.js";

// Gym page is a stub in P1 (per-exercise logging + body-composition land in P3).
bootWithAuth(() => {
  renderNav("gym");
});
