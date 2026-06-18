import { classifyCaptureInput, routeModelForCapture } from "../../lib/agent-core.mjs";
import { looksLikeBankSms, parseBankSms } from "../imports/sms-parser.js";

export function buildFileDescriptors(fileList) {
  return Array.from(fileList || []).map((file) => ({
    name: file.name,
    type: file.type,
    kind: inferKind(file),
  }));
}

export function previewCaptureRoute({ text, files }) {
  const descriptors = buildFileDescriptors(files);
  const captureType = classifyCaptureInput({ text, files: descriptors });
  const route = routeModelForCapture({
    captureType,
    risk: descriptors.length > 12 ? "high" : "normal",
  });

  // Deterministic fast-lane hint: recognize a pasted bank/UPI SMS.
  let sms = null;
  if (text && !descriptors.length && looksLikeBankSms(text)) {
    const parsed = parseBankSms(text);
    if (parsed.ok) sms = parsed;
  }

  return {
    captureType,
    route,
    descriptors,
    sms,
  };
}

function inferKind(file) {
  if (file.kind) return file.kind;
  if (file.type?.startsWith("image/")) return "image";
  if (file.type?.startsWith("audio/")) return "audio";
  if (/\.(png|jpg|jpeg|webp|heic|gif)$/i.test(file.name || "")) return "image";
  if (/\.(webm|mp3|m4a|wav|ogg|aac)$/i.test(file.name || "")) return "audio";
  return "file";
}
