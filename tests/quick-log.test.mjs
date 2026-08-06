// THE ONE-TAP WATER SURFACES.
//
// The owner asked for "a widget kind of a thing, which whenever I tap on, it logs
// water". That shipped on three surfaces which all promise the same thing and all
// fail differently:
//   1. the PWA manifest shortcut (long-press the icon), which needs no APK;
//   2. quick-log.html, the page every surface lands on;
//   3. the Android home-screen widget + Quick Settings tile.
//
// The invariant across all three is the one that matters: A TAP IS NEVER SILENTLY
// LOST. Offline, signed out, expired token and server error each have to end in a
// queued item or a visible, specific reason. This file is what stops that decaying
// into a button that looks like it worked.
//
// It also pins the constants that exist in BOTH JavaScript and Kotlin. Two copies
// of one number is how a widget ends up showing a different total from the app it
// belongs to.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  WATER_TAP_ML, WATER_GOAL_SCAFFOLD_ML,
  createWaterState, tapWater, takeFlushBatch, flushOk, flushFailed,
  applyServerTotal, undoWater, waterView, pctOf, fmtMl,
} from "../lib/water.mjs";
import { parseQuickLogRequest, isReplayableFailure, QUICK_LOG_ACTIONS, QUICK_LOG_MAX_ML } from "../src/pages/quick-log.js";

const page = readFileSync("src/pages/quick-log.js", "utf8");
const html = readFileSync("quick-log.html", "utf8");
const css = readFileSync("styles/quick-log.css", "utf8");
const stylesEntry = readFileSync("styles.css", "utf8");
const sw = readFileSync("sw.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
const config = readFileSync("src/config.js", "utf8");

const ANDROID = "android/app/src/main";
const nativeManifest = readFileSync(`${ANDROID}/AndroidManifest.xml`, "utf8");
const mainActivity = readFileSync(`${ANDROID}/java/com/ubhayaab/trackerz/MainActivity.kt`, "utf8");
const store = readFileSync(`${ANDROID}/java/com/ubhayaab/trackerz/water/WaterStore.kt`, "utf8");
const sync = readFileSync(`${ANDROID}/java/com/ubhayaab/trackerz/water/WaterSync.kt`, "utf8");
const provider = readFileSync(`${ANDROID}/java/com/ubhayaab/trackerz/water/WaterWidgetProvider.kt`, "utf8");
const tile = readFileSync(`${ANDROID}/java/com/ubhayaab/trackerz/water/WaterTileService.kt`, "utf8");
const plugin = readFileSync(`${ANDROID}/java/com/ubhayaab/trackerz/water/WaterWidgetPlugin.kt`, "utf8");
const layout = readFileSync(`${ANDROID}/res/layout/widget_water.xml`, "utf8");
const widgetInfo = readFileSync(`${ANDROID}/res/xml/water_widget_info.xml`, "utf8");
const values = readFileSync(`${ANDROID}/res/values/water_widget.xml`, "utf8");

// ===========================================================================
// 1. THE URL IS THE ACTION
// ===========================================================================
// The shortcut, the widget and the tile all express themselves as a query
// string, so this parser is the only thing standing between a malformed link and
// either a phantom glass or a tap that quietly does nothing.

assert.deepEqual(parseQuickLogRequest("?do=water&ml=250"), { action: "water", ml: 250, error: null });
assert.deepEqual(parseQuickLogRequest("?do=sync"), { action: "sync", ml: 0, error: null });

// A full href, because a widget deep link arrives as one.
assert.equal(parseQuickLogRequest("https://localhost/quick-log.html?do=water&ml=500").ml, 500);
// A URLSearchParams, because that is what a caller already holding one will pass.
assert.equal(parseQuickLogRequest(new URLSearchParams("do=water&ml=750")).ml, 750);

// Opening the page bare is a glass, not an error page: water is the only reason
// this page exists and the shortcut is allowed to be sloppy.
assert.deepEqual(parseQuickLogRequest(""), { action: "water", ml: WATER_TAP_ML, error: null });
assert.equal(parseQuickLogRequest("?do=water").ml, WATER_TAP_ML);

// Refusals must be REFUSALS - action null, ml 0, and a sentence. A 0 ml
// "success" is a tap the user believes was recorded.
for (const bad of ["?do=water&ml=abc", "?do=water&ml=0", "?do=water&ml=-250", "?do=teleport"]) {
  const req = parseQuickLogRequest(bad);
  assert.equal(req.action, null, `${bad} should be refused`);
  assert.equal(req.ml, 0, `${bad} must not carry an amount`);
  assert.ok(req.error && req.error.length > 10, `${bad} must explain itself`);
}
// A crafted or fat-fingered URL cannot poison the day's total.
const huge = parseQuickLogRequest(`?do=water&ml=${QUICK_LOG_MAX_ML + 1}`);
assert.equal(huge.action, null);
assert.ok(/typo/.test(huge.error), "an absurd amount should be named as a typo, not written");
assert.equal(parseQuickLogRequest(`?do=water&ml=${QUICK_LOG_MAX_ML}`).ml, QUICK_LOG_MAX_ML, "the cap itself is allowed");

// `sync` exists so the widget has somewhere to send the user that flushes its
// queue WITHOUT logging another glass. If it ever starts carrying millilitres,
// every "open Deno to sync" tap becomes water nobody drank.
assert.ok(QUICK_LOG_ACTIONS.includes("sync"));
assert.equal(parseQuickLogRequest("?do=sync&ml=1000").ml, 0, "sync must never log water");

// ===========================================================================
// 2. A FAILED WRITE IS EITHER REPLAYABLE OR IT IS NOT
// ===========================================================================
// Queueing a write that may already have landed is how one glass becomes two.
// Refusing to queue one that never left the phone is how a glass disappears.

assert.equal(isReplayableFailure(new TypeError("Failed to fetch")), true, "offline is safe to replay");
assert.equal(isReplayableFailure(new Error("NetworkError when attempting to fetch resource.")), true);
assert.equal(isReplayableFailure(new Error("not_authenticated")), true, "signed out is safe to replay");
// A PostgrestError always carries a `code`: the server ANSWERED, so replaying it
// risks a duplicate row and the page must show the reason instead.
assert.equal(
  isReplayableFailure(Object.assign(new Error("new row violates row-level security policy"), { code: "42501" })),
  false,
);
assert.equal(isReplayableFailure(Object.assign(new Error("duplicate key"), { code: "23505" })), false);
assert.equal(isReplayableFailure(null), false);

// The page has to act on that distinction, not merely compute it.
assert.ok(/isReplayableFailure\(err\)/.test(page), "the failure handler must consult the classifier");
assert.ok(/enqueueCapture/.test(page), "a replayable failure must reach the offline queue");
assert.ok(
  /offline-queue\.js/.test(page),
  "quick-log must reuse src/services/offline-queue.js rather than opening its own IndexedDB",
);

// ===========================================================================
// 3. THE TAP PATH IS THE ONE FROM lib/water.mjs, NOT A NEW ONE
// ===========================================================================
// The incident this protects: the old water row awaited the server inside a
// `if (state.busy) return` guard, so six taps in three seconds logged ONE glass.

assert.ok(/from "\.\.\/\.\.\/lib\/water\.mjs"/.test(page), "quick-log must import the shared water reducer");
assert.ok(!/hydration_logs/.test(page), "quick-log must not hand-roll its own insert");
assert.ok(/logHydrationBatch/.test(page), "quick-log must write through the existing batched insert");
assert.ok(/undoLastHydration/.test(page), "quick-log must undo through the existing server undo");
assert.ok(/fetchWaterGoalMl/.test(page), "quick-log must read the user's real goal, not assume one");

// Six taps in a burst are six glasses and they are ONE insert.
let s = createWaterState({ serverMl: 500, serverRows: 2 });
for (let i = 0; i < 6; i++) s = tapWater(s, WATER_TAP_ML);
assert.equal(waterView(s).totalMl, 500 + 6 * WATER_TAP_ML, "every tap in a burst counts immediately");
const flush = takeFlushBatch(s);
assert.equal(flush.batch.length, 6, "a burst is one batch, not six round trips");
s = flushOk(flush.next, flush.batch);
assert.equal(waterView(s).totalMl, 2000);

// A failed flush puts the number visibly BACK DOWN, and hands back how much for
// the page to say out loud. An optimistic total that stays up after a failure is
// a lie the user walks away believing.
let f = createWaterState({ serverMl: 0 });
f = tapWater(f, 250);
const taken = takeFlushBatch(f);
const failed = flushFailed(taken.next, taken.batch);
assert.equal(failed.lostMl, 250);
assert.equal(waterView(failed.next).totalMl, 0, "a failed write must not leave the total inflated");

// A server read taken while a batch is inflight is stale BY CONSTRUCTION and
// must not be allowed to erase the rows it could not have seen.
const inflight = takeFlushBatch(tapWater(createWaterState({ serverMl: 1000 }), 250)).next;
assert.equal(applyServerTotal(inflight, { ml: 1000, rows: 4 }), inflight, "an inflight read is ignored");

// Undo pops the un-sent tap locally, so it can never delete the older row that
// came before it.
const undone = undoWater(tapWater(createWaterState({ serverMl: 750, serverRows: 3 }), 250));
assert.equal(undone.undone.scope, "pending");
assert.equal(waterView(undone.next).totalMl, 750);

// ===========================================================================
// 4. NO Infinity AND NO NaN CAN REACH THE DOM
// ===========================================================================
// A goal of 0 made the in-app meter Math.round(x / 0 * 100) = Infinity, which
// renders as width:Infinity%. Both the page and the widget draw a meter.

for (const goal of [0, -1, NaN, Infinity, null, undefined, "banana"]) {
  const pct = pctOf(1000, goal);
  assert.ok(Number.isFinite(pct), `pctOf(1000, ${String(goal)}) must be finite`);
  assert.ok(pct >= 0 && pct <= 100, `pctOf(1000, ${String(goal)}) must be 0..100`);
}
for (const total of [NaN, Infinity, null, undefined, "x"]) {
  assert.ok(Number.isFinite(pctOf(total, 3450)), `pctOf(${String(total)}, 3450) must be finite`);
}
assert.ok(!/undefined|NaN/.test(fmtMl(undefined) + fmtMl(NaN) + fmtMl(null) + fmtMl("x")));

// KNOWN GAP IN lib/water.mjs, pinned here so it cannot be "fixed" by accident in
// one place and forgotten in the other: fmtMl coerces NaN to 0 but leaves
// Infinity alone, so fmtMl(Infinity) is the string "InfinityL". Nothing can feed
// it one today, but the guard therefore lives at the last point before the DOM
// on the page that renders this number for three separate entry points.
assert.equal(fmtMl(Infinity), "InfinityL", "if fmtMl grew an Infinity guard, drop the local one in quick-log.js");
assert.ok(/Number\.isFinite\(v\.totalMl \+ queuedMl\)/.test(page), "quick-log must refuse a non-finite total before painting it");

// The page must go through pctOf rather than doing the division itself.
assert.ok(/pctOf\(/.test(page), "quick-log must use pctOf for the meter");
assert.ok(!/\/\s*goal\w*\s*\*\s*100/.test(page), "quick-log must not compute its own percentage");

// The widget's Kotlin twin has to carry the same guard, because it draws the
// same meter from a value the app can push into it.
assert.ok(/fun pctOf\(/.test(store), "WaterStore needs its own pctOf");
assert.ok(/if \(goalMl <= 0\) return 0/.test(store), "WaterStore.pctOf must refuse a zero goal");
assert.ok(/coerceIn\(0, 100\)/.test(store), "WaterStore.pctOf must clamp to 0..100");

// ===========================================================================
// 5. THE PAGE ITSELF
// ===========================================================================

assert.ok(html.includes("./src/pages/quick-log.js"), "quick-log.html must load its module");
assert.ok(html.includes("./styles.css"), "quick-log.html must load the app stylesheet");
assert.ok(stylesEntry.includes('@import "./styles/quick-log.css"'), "styles.css must import the page layer");

// Every id the module reaches for has to exist in the markup. A typo here is a
// silent no-op on a page whose entire job is to be unmistakable.
const ids = [...page.matchAll(/\bel\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
assert.ok(ids.length >= 6, `expected the page module to address several elements, found ${ids.length}`);
for (const id of new Set(ids)) {
  assert.ok(html.includes(`id="${id}"`), `quick-log.html is missing #${id}, which the module writes to`);
}

// It must log on load, with nothing to confirm - choosing the shortcut WAS the
// confirmation. Same rule the share target already follows.
assert.ok(/tapWater\(state, req\.ml\)/.test(page), "the page must log on load, not on a confirm tap");
// Inside start() specifically: the tap has to be recorded before the first thing
// that can fail or hang. Auth, supabase-js and the network all come after it.
const startBody = page.slice(page.indexOf("async function start()"));
assert.ok(startBody.length > 200, "start() not found in quick-log.js");
assert.ok(
  startBody.indexOf("tapWater(state, req.ml)") < startBody.indexOf("await ensureSession()"),
  "the tap must be recorded BEFORE auth is resolved - nothing async may be the reason a tap did not count",
);
assert.ok(
  startBody.indexOf("paint()") < startBody.indexOf("await ensureSession()"),
  "the number must move before the first await, not after the round trip",
);

// A reload (or Android restoring the tab) must not pour a second glass.
assert.ok(/replaceState/.test(page), "the page must neutralise its own URL after acting on it");
assert.ok(/do=sync/.test(page), "the neutralised URL must be the no-op sync action");

// Repeat taps and undo are both on screen, and the way out is a real link.
assert.ok(/id="qlAgain"/.test(html) && /id="qlUndo"/.test(html), "repeat and undo must both exist");
assert.ok(/href="\.\/index\.html"/.test(html), "the page must offer a way into the full app");
// Undo stays reachable when the only water is queued: it cannot cancel a queued
// glass, but a disabled button hides the explanation of where that glass went.
assert.ok(
  /undo\.disabled = !\(v\.canUndo \|\| queuedMl > 0\)/.test(page),
  "undo must stay enabled while water is queued, so its explanation is reachable",
);

// The three honest failure states have to be spelled out, not implied.
for (const phrase of ["not signed in", "local test mode", "queued"]) {
  assert.ok(page.toLowerCase().includes(phrase), `the page must name the "${phrase}" case out loud`);
}
assert.ok(/isLocalSession/.test(page), "local test mode never syncs and must be detected, not written through");

// Thumb-sized controls. The audit that produced the 44px rule flagged 30px
// buttons; this page is tapped in a hurry, repeatedly, one-handed.
const minHeights = [...css.matchAll(/min-height:\s*(\d+)px/g)].map((m) => Number(m[1]));
assert.ok(minHeights.length >= 2, "the page CSS should size its controls explicitly");
assert.ok(Math.min(...minHeights) >= 44, `every control must be >= 44px tall, smallest is ${Math.min(...minHeights)}px`);
// Without touch-action:manipulation the browser eats the second tap of any pair
// inside 300ms as a zoom gesture, which on a repeat-tap button loses every other
// glass.
assert.ok(/touch-action:\s*manipulation/.test(css), "the repeat button must not lose fast double taps to zoom");

// ===========================================================================
// 6. THE MANIFEST SHORTCUT
// ===========================================================================

const shortcuts = manifest.shortcuts || [];
const water = shortcuts.find((s) => /water/i.test(s.name || ""));
assert.ok(water, "manifest declares no water shortcut - the no-APK surface is missing");
assert.ok(/quick-log\.html/.test(water.url), "the water shortcut must point at the quick-log page");
// The shortcut URL has to parse into the action it advertises. This is the only
// place the two halves are checked against each other.
const fromShortcut = parseQuickLogRequest(water.url);
assert.equal(fromShortcut.action, "water", `the shortcut URL ${water.url} does not parse as a water log`);
assert.equal(fromShortcut.ml, 250, "the shortcut must log one 250 ml glass");
assert.ok(/250/.test(water.name), "the shortcut name must say how much it logs");
// Android shows a handful of shortcuts at most; beyond that they are simply
// dropped, silently, starting with the last.
assert.ok(shortcuts.length <= 4, `Android shows about 4 shortcuts, manifest declares ${shortcuts.length}`);
assert.equal(shortcuts[0], water, "the water shortcut must be first - it is the one that is used daily");
for (const s of shortcuts) {
  assert.ok(s.name && s.url, "every shortcut needs a name and a url");
}

// ===========================================================================
// 7. THE SERVICE WORKER
// ===========================================================================
// A shortcut that opens a blank offline page is worse than no shortcut.

const shell = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
assert.ok(shell, "sw.js has no APP_SHELL");
assert.ok(shell[1].includes('"./quick-log.html"'), "quick-log.html is not precached, so it is blank offline");
assert.ok(shell[1].includes('"./src/pages/quick-log.js"'), "the quick-log module is not precached");
// The cache is keyed by VERSION and only purged when it changes, so shipping a
// new shell without bumping it serves the old precache list indefinitely - which
// is exactly how sw.js sat on v21 for twelve days while the app moved underneath.
const version = sw.match(/const VERSION = "([^"]+)"/)?.[1];
assert.ok(version, "sw.js has no VERSION");
assert.notEqual(version, "deno-v22-20260806", "VERSION was not bumped, so the old precache list survives the deploy");

// ===========================================================================
// 8. THE NATIVE SURFACES
// ===========================================================================

// Registered, or none of the Kotlin exists as far as Android is concerned.
assert.ok(/\.water\.WaterWidgetProvider/.test(nativeManifest), "the widget receiver is not in AndroidManifest");
assert.ok(/android\.appwidget\.action\.APPWIDGET_UPDATE/.test(nativeManifest), "the widget has no update intent filter");
assert.ok(/android\.appwidget\.provider/.test(nativeManifest), "the widget has no provider metadata");
assert.ok(/\.water\.WaterTileService/.test(nativeManifest), "the Quick Settings tile is not in AndroidManifest");
assert.ok(/android\.service\.quicksettings\.action\.QS_TILE/.test(nativeManifest), "the tile has no QS_TILE filter");
assert.ok(
  /BIND_QUICK_SETTINGS_TILE/.test(nativeManifest),
  "a tile service without BIND_QUICK_SETTINGS_TILE can be bound by any app",
);
assert.ok(
  /registerPlugin\(WaterWidgetPlugin::class\.java\)/.test(mainActivity),
  "WaterWidgetPlugin is not registered, so the widget can never get a token",
);

// The CI step "Verify the native manifest survived sync" hard-fails if any of
// these disappear. Adding the widget must not have cost one of them.
for (const needle of [
  "android.permission.READ_SMS",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.health.READ_SLEEP",
  "android.speech.RecognitionService",
  "HealthPrivacyPolicyActivity",
  "PaymentNotificationListenerService",
]) {
  assert.ok(nativeManifest.includes(needle), `AndroidManifest lost "${needle}" - CI would reject this build`);
}
for (const kept of ["HealthConnectPlugin", "SmsReaderPlugin", "NotifyReaderPlugin"]) {
  assert.ok(mainActivity.includes(kept), `MainActivity lost registerPlugin(${kept})`);
}

// --- the tap is durable BEFORE it is sent ---------------------------------
// This is the whole reason the native side is not just a deep link into the app.
assert.ok(/fun addTap\(/.test(store), "WaterStore must be able to record a tap locally");
assert.ok(/\.commit\(\)/.test(store), "a tap must be committed synchronously - apply() can be reaped with the process");
// Scoped to the tap handlers themselves, not the file - the header comments
// name both objects long before either is called.
const onReceive = provider.slice(provider.indexOf("override fun onReceive("));
const onClick = tile.slice(tile.indexOf("override fun onClick()"));
assert.ok(
  onReceive.indexOf("WaterStore.addTap") < onReceive.indexOf("WaterSync"),
  "the widget must record the tap before it tries to send it",
);
assert.ok(
  onClick.indexOf("WaterStore.addTap") < onClick.indexOf("WaterSync"),
  "the tile must record the tap before it tries to send it",
);
// goAsync keeps the receiver alive past onReceive; without it the send is killed
// halfway and only the queued tap survives, every time.
assert.ok(/goAsync\(\)/.test(onReceive), "the widget's send must survive the end of onReceive");
// Neither may do network work on the main thread: a widget tap that blocks the
// UI thread on a mobile connection is an ANR waiting to be reported as "the
// launcher froze".
assert.ok(/Thread \{/.test(provider) && /Thread \{/.test(tile), "the send must be off the main thread");
// Removing only the taps that actually landed. Clearing the whole queue would
// drop a tap made while the POST was in the air - the same class of bug as the
// busy-guard that ate five glasses.
assert.ok(/fun confirmSent\(ctx: Context, sentIds: Set<Int>/.test(store), "sent taps must be removed by id, not wholesale");
// Each queued tap keeps its own timestamp, or a glass drunk before midnight is
// filed as tomorrow's the first time the phone syncs in the morning.
assert.ok(/put\("occurred_at", WaterStore\.iso\(tap\.optLong\("at"/.test(sync), "a queued tap must keep its own time");

// --- a widget tap that cannot sync says so ---------------------------------
for (const phrase of ["open Deno to sync", "sign-in expired", "still queued"]) {
  assert.ok(sync.includes(phrase), `WaterSync must be able to say "${phrase}"`);
}
assert.ok(/waiting - tap here to sync/.test(store), "the widget must show queued water, not a silent success");

// --- the refresh token is deliberately NOT taken ---------------------------
// GoTrue rotates refresh tokens and revokes the family on reuse; a native
// refresh would sign the user out of the app itself. If someone reverses this,
// they have to delete the reasoning first.
assert.ok(!/refresh_token/.test(sync), "WaterSync must not use the refresh token - it would revoke the app's session");
assert.ok(!/refresh_token/.test(plugin), "the plugin must not cache the refresh token");
assert.ok(/access_token/.test(plugin), "the plugin must cache the access token");
assert.ok(/expires_at[\s\S]{0,200}1000L/.test(plugin), "expires_at is in seconds and must be converted to ms");
assert.ok(/local:/.test(plugin), "a local test-mode session must be rejected, not cached as a real one");

// --- the resource XML actually parses --------------------------------------
// An XML comment may not contain a double hyphen. This file's comments quote CSS
// custom property names, and writing one with its leading hyphens made aapt
// reject the entire values file - taking every widget string and colour with it
// and failing the APK build with an error that points at a comment.
for (const [name, src] of [
  ["widget_water.xml", layout],
  ["water_widget_info.xml", widgetInfo],
  ["water_widget.xml", values],
  ["widget_water_bg.xml", readFileSync(`${ANDROID}/res/drawable/widget_water_bg.xml`, "utf8")],
  ["ic_water_drop.xml", readFileSync(`${ANDROID}/res/drawable/ic_water_drop.xml`, "utf8")],
  ["AndroidManifest.xml", nativeManifest],
]) {
  for (const [comment] of src.matchAll(/<!--[\s\S]*?-->/g)) {
    const body = comment.slice(4, -3);
    assert.ok(!body.includes("--"), `${name} has an XML comment containing "--", which aapt cannot parse`);
  }
  // Balanced comment delimiters, so a stray "-->" cannot silently comment out a
  // resource that everything else assumes exists.
  assert.equal(
    (src.match(/<!--/g) || []).length,
    (src.match(/-->/g) || []).length,
    `${name} has unbalanced XML comment delimiters`,
  );
}

// --- resources resolve --------------------------------------------------
for (const file of [
  `${ANDROID}/res/layout/widget_water.xml`,
  `${ANDROID}/res/xml/water_widget_info.xml`,
  `${ANDROID}/res/values/water_widget.xml`,
  `${ANDROID}/res/drawable/widget_water_bg.xml`,
  `${ANDROID}/res/drawable/ic_water_drop.xml`,
]) {
  assert.ok(existsSync(file), `missing widget resource ${file}`);
}

// Every R.id / R.layout / R.drawable the Kotlin names must exist, or the widget
// inflates to a blank grey box on the launcher with the reason only in logcat.
const kotlin = [provider, tile, plugin].join("\n");
for (const [, id] of kotlin.matchAll(/R\.id\.(\w+)/g)) {
  assert.ok(layout.includes(`@+id/${id}`), `Kotlin uses R.id.${id}, which widget_water.xml does not define`);
}
for (const [, name] of kotlin.matchAll(/R\.layout\.(\w+)/g)) {
  assert.ok(existsSync(`${ANDROID}/res/layout/${name}.xml`), `missing layout ${name}.xml`);
}
for (const [, name] of kotlin.matchAll(/R\.drawable\.(\w+)/g)) {
  assert.ok(existsSync(`${ANDROID}/res/drawable/${name}.xml`), `missing drawable ${name}.xml`);
}
// Every @string/@color the widget XML references must be declared. These live in
// their own values file rather than strings.xml because `cap sync` regenerates
// the Capacitor-owned resources.
const widgetXml = [layout, widgetInfo, readFileSync(`${ANDROID}/res/drawable/widget_water_bg.xml`, "utf8")].join("\n");
for (const [, kind, name] of widgetXml.matchAll(/@(string|color)\/(\w+)/g)) {
  assert.ok(values.includes(`<${kind} name="${name}"`), `@${kind}/${name} is used but never declared`);
}
for (const name of ["water_widget_label", "water_tile_label"]) {
  assert.ok(nativeManifest.includes(`@string/${name}`), `AndroidManifest should label the component with @string/${name}`);
  assert.ok(values.includes(`name="${name}"`), `@string/${name} is used in AndroidManifest but never declared`);
}
// RemoteViews can only inflate a fixed set of classes. A ConstraintLayout or any
// androidx view here is a blank grey widget on the launcher, with the failure
// visible only in logcat. Comments are stripped first - the file explains this
// rule in prose and would otherwise trip its own guard.
const layoutCode = layout.replace(/<!--[\s\S]*?-->/g, "");
assert.ok(!/ConstraintLayout|androidx\./.test(layoutCode), "widget_water.xml uses a view RemoteViews cannot inflate");
const ALLOWED_WIDGET_VIEWS = new Set(["LinearLayout", "RelativeLayout", "FrameLayout", "GridLayout", "TextView", "ImageView", "Button", "ImageButton", "ProgressBar", "ViewFlipper", "ListView", "GridView", "StackView", "AdapterViewFlipper", "AnalogClock", "Chronometer", "Space"]);
for (const [, tag] of layoutCode.matchAll(/<([A-Za-z][\w.]*)/g)) {
  assert.ok(ALLOWED_WIDGET_VIEWS.has(tag), `<${tag}> is not a view RemoteViews can inflate`);
}
// FLAG_IMMUTABLE is mandatory from Android 12: without it the PendingIntent is
// refused and the widget silently does nothing when tapped.
assert.ok(/FLAG_IMMUTABLE/.test(provider), "widget PendingIntents must be immutable or Android 12+ refuses them");
// The status line opens the SYNC action. Opening ?do=water there would pour a
// glass every time the user tapped "open Deno to sync".
assert.ok(/quick-log\.html\?do=sync/.test(provider), "the widget's open-app tap must sync, never log");
assert.ok(!/quick-log\.html\?do=water/.test(provider), "the widget must not deep-link an action that logs water");

// ===========================================================================
// 9. THE SAME NUMBER IN TWO LANGUAGES
// ===========================================================================
// Kotlin cannot import lib/water.mjs, so these constants are duplicated. This is
// the only thing stopping the widget and the app disagreeing about a glass.

const kTap = Number(store.match(/const val TAP_ML = (\d+)/)?.[1]);
assert.equal(kTap, WATER_TAP_ML, `WaterStore.TAP_ML (${kTap}) != WATER_TAP_ML (${WATER_TAP_ML})`);

const kGoal = Number(store.match(/const val DEFAULT_GOAL_ML = (\d+)/)?.[1]);
assert.equal(kGoal, WATER_GOAL_SCAFFOLD_ML, `WaterStore.DEFAULT_GOAL_ML (${kGoal}) != the scaffold sum (${WATER_GOAL_SCAFFOLD_ML})`);

const kUrl = sync.match(/const val DEFAULT_SUPABASE_URL = "([^"]+)"/)?.[1];
const jsUrl = config.match(/const PROD_URL = "([^"]+)"/)?.[1];
assert.equal(kUrl, jsUrl, "WaterSync points at a different Supabase project than src/config.js");

const kKey = sync.match(/const val DEFAULT_SUPABASE_ANON_KEY = "([^"]+)"/)?.[1];
const jsKey = config.match(/const PROD_ANON_KEY = "([^"]+)"/)?.[1];
assert.equal(kKey, jsKey, "WaterSync carries a stale anon key");

// The widget's fmtMl has to agree with the app's on the values it will actually
// show, or the same day reads "1.5L" in one place and "1500ml" in the other.
const kotlinFmt = (ml) => (Math.abs(ml) < 1000 ? `${ml}ml` : `${(ml / 1000).toFixed(1).replace(/\.0$/, "")}L`);
assert.ok(/fun fmtMl\(ml: Int\)/.test(provider), "the widget needs its own fmtMl");
assert.ok(/endsWith\("\.0"\)/.test(provider), "the widget's fmtMl must strip a trailing .0, so 10000 reads 10L");
for (const ml of [0, 250, 999, 1000, 1250, 3450, 10000]) {
  assert.equal(kotlinFmt(ml), fmtMl(ml), `fmtMl disagrees at ${ml} ml`);
}

// Both sides window the day the same way, or a glass belongs to today in the app
// and to yesterday in the widget.
assert.ok(/Calendar\.HOUR_OF_DAY, 0/.test(store), "the widget's day must start at LOCAL midnight, like fetchHydrationTotal");
assert.ok(/occurred_at=gte\./.test(sync) && /occurred_at=lt\./.test(sync), "the widget must read the same half-open day window");
assert.ok(/URLEncoder\.encode/.test(sync), "an ISO offset like +05:30 must be encoded or the + becomes a space");

// ===========================================================================
// 10. HOUSE RULE
// ===========================================================================
// No em dashes and no en dashes anywhere in this project. Nothing else in the
// suite enforces it, and it is easiest to break in exactly this kind of
// comment-heavy change.
const owned = [
  "quick-log.html", "src/pages/quick-log.js", "styles/quick-log.css", "manifest.webmanifest", "sw.js",
  `${ANDROID}/AndroidManifest.xml`,
  `${ANDROID}/java/com/ubhayaab/trackerz/MainActivity.kt`,
  `${ANDROID}/java/com/ubhayaab/trackerz/water/WaterStore.kt`,
  `${ANDROID}/java/com/ubhayaab/trackerz/water/WaterSync.kt`,
  `${ANDROID}/java/com/ubhayaab/trackerz/water/WaterTileService.kt`,
  `${ANDROID}/java/com/ubhayaab/trackerz/water/WaterWidgetPlugin.kt`,
  `${ANDROID}/java/com/ubhayaab/trackerz/water/WaterWidgetProvider.kt`,
  `${ANDROID}/res/layout/widget_water.xml`,
  `${ANDROID}/res/xml/water_widget_info.xml`,
  `${ANDROID}/res/values/water_widget.xml`,
  "tests/quick-log.test.mjs",
];
// Written as escapes, not literals, so this file passes its own check.
const DASHES = new RegExp("[\\u2013\\u2014]");
for (const file of owned) {
  const src = readFileSync(file, "utf8");
  const line = src.split(/\r?\n/).findIndex((l) => DASHES.test(l));
  assert.equal(line, -1, `${file}:${line + 1} contains an em or en dash`);
}

console.log(`quick-log tests passed: ${QUICK_LOG_ACTIONS.length} actions, ${shortcuts.length} manifest shortcuts, widget + tile registered`);
