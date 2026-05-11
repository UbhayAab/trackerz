export const trendData = {
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

export const insights = [
  "Food photos and EOD voice likely describe the same dinner. One duplicate cluster is waiting.",
  "Weekend spend is 31% above budget pace, driven by food delivery and fuel.",
  "Protein is improving week over week, but breakfast is still the weakest meal window.",
  "Sleep below 6.5 hours is linked with lower next-day habit score in this sample.",
];

export const pipelineSteps = [
  { name: "Intake", detail: "Raw text, voice, images, bank files, notes" },
  { name: "Extract", detail: "Gemini/OCR/file parser creates evidence" },
  { name: "Reason", detail: "DeepSeek plans typed actions only" },
  { name: "Validate", detail: "Schemas, confidence, RLS, dedupe checks" },
  { name: "Write", detail: "Audited database action with undo payload" },
];
