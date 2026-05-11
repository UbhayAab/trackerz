export function detectBankFormat({ filename = "", headers = [] }) {
  const probe = `${filename} ${headers.join(" ")}`.toLowerCase();
  if (/hdfc/.test(probe)) return "hdfc";
  if (/icici/.test(probe)) return "icici";
  if (/sbi|state bank/.test(probe)) return "sbi";
  if (/axis/.test(probe)) return "axis";
  return "unknown";
}
