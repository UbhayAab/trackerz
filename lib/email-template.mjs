// Email rendering for the Jarvis notification service.
//
// Email is the primary channel (Web Push needs a per-device opt-in that most
// days never happens; an inbox is always there), so these have to be real
// emails, not a paragraph in a <div>. Table-based layout because Outlook and
// Gmail still do not do flexbox, inline styles because <style> blocks get
// stripped, and a text/plain alternative for every message.
//
// THE RULE THAT MATTERS: a metric whose value is null was never measured. It
// gets NO ROW. It is never rendered as 0, "—0", "missed", or "none". Reporting
// "you slept 0h" every morning off an absent sleep source is the exact bug this
// project keeps making.
//
// Pure (no DOM, no Deno, no Supabase) so it is unit-tested; the jarvis edge
// function keeps a byte-identical mirror between the marker comments.

// ==== EMAIL-TEMPLATE MIRROR START (byte-identical in supabase/functions/jarvis/index.ts) ====
var ET_APP_URL = "https://ubhayaab.github.io/trackerz/";
var ET_INK = "#17211c";
var ET_MUTED = "#7c8a82";
var ET_ACCENT = "#138a5b";
var ET_LINE = "#e3e9e5";
var ET_BG = "#f6f8f7";

function etEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function etRupees(n) {
  return "Rs " + (Math.round(Number(n) || 0)).toLocaleString("en-IN");
}

// A stat is worth showing only when it is a real number. null/undefined/NaN mean
// "not measured" and must vanish entirely rather than becoming a zero.
function etHasValue(v) {
  return v !== null && v !== undefined && !(typeof v === "number" && !isFinite(v));
}

// Build the stat rows for a brief from its facts JSON. Order is fixed so the
// email reads the same every day.
function etStatsFromFacts(facts) {
  var out = [];
  if (!facts) return out;
  var y = facts.yesterday;
  if (y) {
    if (etHasValue(y.calories) && y.calories > 0) out.push({ label: "Calories yesterday", value: String(Math.round(y.calories)) + " kcal" });
    if (etHasValue(y.protein) && y.protein > 0) out.push({ label: "Protein yesterday", value: String(Math.round(y.protein)) + " g" });
    if (etHasValue(y.spend)) out.push({ label: "Spent yesterday", value: etRupees(y.spend) });
    // sleep_h is null whenever no sleep was recorded — omit, never render 0.
    if (etHasValue(y.sleep_h) && y.sleep_h > 0) out.push({ label: "Slept", value: String(y.sleep_h) + " h" });
    if (etHasValue(y.weight_kg)) out.push({ label: "Weight", value: String(y.weight_kg) + " kg" });
    out.push({ label: "Workout yesterday", value: y.workout_done ? "done" : (y.workout_ok ? "rest day" : "not logged") });
  }
  if (facts.workout && facts.workout.name) out.push({ label: "Today's workout", value: facts.workout.name });
  if (facts.diet_label) out.push({ label: "Today's diet", value: facts.diet_label });
  var t = facts.targets || {};
  if (etHasValue(t.protein_g)) out.push({ label: "Protein target", value: String(Math.round(t.protein_g)) + " g" });
  if (etHasValue(t.calories)) out.push({ label: "Calorie target", value: String(Math.round(t.calories)) + " kcal" });
  if (facts.money && facts.money.hasBudget) {
    out.push({ label: "Safe to spend today", value: etRupees(facts.money.perDay) });
  }
  var st = facts.streaks || {};
  var streaks = [];
  if (st.workout > 1) streaks.push("gym " + st.workout + "d");
  if (st.protein > 1) streaks.push("protein " + st.protein + "d");
  if (st.budget > 1) streaks.push("budget " + st.budget + "d");
  if (st.logging > 1) streaks.push("logging " + st.logging + "d");
  if (streaks.length) out.push({ label: "Streaks", value: streaks.join(" · ") });
  return out;
}

function etStatRows(stats) {
  var rows = "";
  for (var i = 0; i < (stats || []).length; i++) {
    var s = stats[i];
    var border = i === 0 ? "none" : "1px solid " + ET_LINE;
    rows += '<tr>'
      + '<td style="padding:9px 0;border-top:' + border + ';font-size:14px;color:' + ET_MUTED + '">' + etEscape(s.label) + '</td>'
      + '<td style="padding:9px 0;border-top:' + border + ';font-size:14px;color:' + ET_INK + ';font-weight:600;text-align:right;white-space:nowrap">' + etEscape(s.value) + '</td>'
      + '</tr>';
  }
  return rows;
}

function etBulletList(items) {
  if (!items || !items.length) return "";
  var lis = "";
  for (var i = 0; i < items.length; i++) {
    lis += '<li style="margin:0 0 6px;font-size:15px;line-height:1.5;color:' + ET_INK + '">' + etEscape(items[i]) + "</li>";
  }
  return '<ul style="margin:14px 0 0;padding-left:20px">' + lis + "</ul>";
}

// The one email shell. `kind` only changes the eyebrow and the accent word.
function etRenderEmail(o) {
  var opts = o || {};
  var title = opts.title || "Trackerz";
  var eyebrow = opts.eyebrow || "Trackerz · Jarvis";
  var body = opts.body || "";
  var stats = opts.stats || [];
  var bullets = opts.bullets || [];
  var ctaLabel = opts.ctaLabel || "Open Trackerz";
  var footerNote = opts.footerNote || "";

  var statsBlock = stats.length
    ? '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;border-collapse:collapse">' + etStatRows(stats) + "</table>"
    : "";

  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light">'
    + "<title>" + etEscape(title) + "</title></head>"
    + '<body style="margin:0;padding:0;background:' + ET_BG + '">'
    // Preheader: the grey preview line in the inbox list. Without it, clients
    // show the eyebrow text, which is identical every day and tells you nothing.
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + etEscape(String(body).slice(0, 140)) + "</div>"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:' + ET_BG + ';padding:24px 12px">'
    + "<tr><td align=\"center\">"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ' + ET_LINE + ';border-radius:14px;overflow:hidden">'
    + '<tr><td style="padding:22px 24px 0">'
    + '<p style="margin:0 0 10px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:' + ET_ACCENT + ';font-weight:700">' + etEscape(eyebrow) + "</p>"
    + '<p style="margin:0;font-size:16px;line-height:1.6;color:' + ET_INK + '">' + etEscape(body) + "</p>"
    + etBulletList(bullets)
    + statsBlock
    + "</td></tr>"
    + '<tr><td style="padding:20px 24px 24px">'
    + '<a href="' + ET_APP_URL + '" style="display:inline-block;background:' + ET_ACCENT + ';color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:999px">' + etEscape(ctaLabel) + "</a>"
    + "</td></tr>"
    + '<tr><td style="padding:14px 24px 20px;border-top:1px solid ' + ET_LINE + ';background:#fbfcfb">'
    + (footerNote ? '<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:' + ET_MUTED + '">' + etEscape(footerNote) + "</p>" : "")
    + '<p style="margin:0;font-size:12px;line-height:1.5;color:' + ET_MUTED + '">'
    + 'Every number here comes from what you logged. Turn these off any time in '
    + '<a href="' + ET_APP_URL + 'pages/settings.html" style="color:' + ET_ACCENT + '">Settings &rarr; Jarvis</a>.'
    + "</p></td></tr>"
    + "</table></td></tr></table></body></html>";
}

// text/plain alternative. Spam filters penalise HTML-only mail, and it is what
// a watch or a screen reader actually reads out.
function etRenderText(o) {
  var opts = o || {};
  var lines = [String(opts.body || "").trim()];
  var bullets = opts.bullets || [];
  for (var i = 0; i < bullets.length; i++) lines.push("- " + bullets[i]);
  var stats = opts.stats || [];
  if (stats.length) {
    lines.push("");
    for (var j = 0; j < stats.length; j++) lines.push(stats[j].label + ": " + stats[j].value);
  }
  lines.push("");
  lines.push(ET_APP_URL);
  lines.push("Manage these emails: " + ET_APP_URL + "pages/settings.html");
  return lines.join("\n");
}

// Subject lines carry the headline number so the inbox list is useful without
// opening anything. Never invent one — fall back to a plain subject.
function etSubjectFor(kind, facts, dateLabel) {
  var y = facts && facts.yesterday;
  if (kind === "morning") {
    if (y && y.logged_anything && etHasValue(y.calories) && y.calories > 0) {
      return "Morning brief — " + Math.round(y.calories) + " kcal yesterday";
    }
    return "Morning brief" + (dateLabel ? " — " + dateLabel : "");
  }
  if (kind === "evening") return "Evening check-in — still time";
  if (kind === "closeout") return "Day closed" + (dateLabel ? " — " + dateLabel : "");
  if (kind === "weekly") return "Your week in review";
  return "Trackerz";
}

var ET_EYEBROWS = {
  morning: "Trackerz · Morning brief",
  evening: "Trackerz · Evening check-in",
  closeout: "Trackerz · Day closed",
  weekly: "Trackerz · Weekly review",
  alert: "Trackerz · Alert",
  test: "Trackerz · Test",
};

// One call site for the whole service: kind + body + facts -> {subject, html, text}.
function etBuildMessage(o) {
  var opts = o || {};
  var kind = opts.kind || "morning";
  var facts = opts.facts || null;
  var stats = opts.stats || (facts ? etStatsFromFacts(facts) : []);
  var payload = {
    title: opts.subject || etSubjectFor(kind, facts, opts.dateLabel),
    eyebrow: ET_EYEBROWS[kind] || ET_EYEBROWS.morning,
    body: opts.body || "",
    stats: stats,
    bullets: opts.bullets || [],
    ctaLabel: opts.ctaLabel || (kind === "evening" ? "Log the rest of today" : "Open Trackerz"),
    footerNote: opts.footerNote || "",
  };
  return {
    subject: payload.title,
    html: etRenderEmail(payload),
    text: etRenderText(payload),
  };
}
// ==== EMAIL-TEMPLATE MIRROR END ====

export {
  etEscape, etRupees, etHasValue, etStatsFromFacts, etStatRows, etBulletList,
  etRenderEmail, etRenderText, etSubjectFor, etBuildMessage, ET_EYEBROWS, ET_APP_URL,
};
