import { classifyCaptureInput, routeModelForCapture } from "../../lib/agent-core.mjs";

export function buildFileDescriptors(fileList) {
  return Array.from(fileList || []).map((file) => ({
    name: file.name,
    type: file.type,
    kind: file.type?.startsWith("image/") ? "image" : file.name,
  }));
}

export function previewCaptureRoute({ text, files }) {
  const descriptors = buildFileDescriptors(files);
  const captureType = classifyCaptureInput({ text, files: descriptors });
  const route = routeModelForCapture({
    captureType,
    risk: descriptors.length > 12 ? "high" : "normal",
  });

  return {
    captureType,
    route,
    descriptors,
  };
}
