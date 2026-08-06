# vendor/

Third-party browser libraries shipped **with the site** instead of pulled from a CDN.

## Why

`src/services/supabase-client.js` is on every page's import chain
(`src/pages/*.js` -> `bootstrap.js` -> `auth-gate.js` -> `auth.js` -> `supabase-client.js`).
When it did a static `import ... from "https://esm.sh/..."` and esm.sh was slow,
blocked or the device was offline, that import rejected and **no page module ran
at all**: no bottom nav, diet stuck on "Loading…", Process button dead. A
cross-origin CDN also cannot be fixed by the service worker in a useful way.

Vendoring makes the library same-origin, so `sw.js` precaches it and the app
works fully offline.

## supabase-js@2.74.0

`vendor/supabase-js/` is the complete esm.sh module graph for
`https://esm.sh/@supabase/supabase-js@2.74.0` (13 files, ~220 KB) with every
absolute `/...` esm.sh specifier rewritten to a relative path. Entry point:

    vendor/supabase-js/@supabase/supabase-js@2.74.0/index.mjs

Nothing in the graph reaches back out to esm.sh at runtime.

## xlsx@0.18.5

`vendor/xlsx/` is SheetJS, loaded lazily by `src/imports/sheet-reader.js` (the
only module allowed to touch it). Entry point:

    vendor/xlsx/xlsx@0.18.5/index.mjs

## ical.js@2.2.1

`vendor/ical.js/` is Mozilla's iCalendar codec, MPL-2.0, the same library
Thunderbird ships (`calendar/base/modules/Ical.sys.mjs` in comm-central). It
powers .ics import and export via `lib/ics.mjs`, loaded lazily by
`src/ui/calendar-import.js`. Entry point:

    vendor/ical.js/ical.js@2.2.1/index.mjs

Two files, **77,984 bytes raw / 23,321 gzip** measured: a 109-byte esm.sh entry
shim re-exporting `es2022/ical.mjs` (77,875 bytes). No bare specifiers, no
runtime fetch, resolves by relative path alone.

**Used as a CODEC ONLY, never as a recurrence expander.** ical.js 2.2.1 parses
`BYMONTHDAY=28,29,30,31;BYSETPOS=-1` faithfully and then ignores the `BYSETPOS`
when expanding it (upstream issue #960, PR #985 unmerged). Measured against this
vendored copy: 38 fires in 2026 where the rule means 12. That dialect is exactly
what `lib/rrule-codec.mjs` emits for a clamped "the 31st" rule, so `lib/ics.mjs`
writes those as an explicit `RDATE` list instead, and `tests/ics.test.mjs` locks
the behaviour in both directions. Occurrence arithmetic stays in
`lib/reminders.mjs`.

Not in `sw.js`'s `VENDOR` precache list yet. It is loaded lazily, only when the
import panel is opened, so no page boot depends on it and nothing is broken
online. Offline it is: dropping an .ics with no network fails with "Could not
load the calendar parser". Adding both files to `VENDOR` in `sw.js` fixes that,
and `tests/vendor-offline.test.mjs` has to learn the new root in the same commit
or it fails on the mismatch.

## rrule@2.8.1

`vendor/rrule/` is rrule.js, BSD-3-Clause, the most widely installed RFC 5545
recurrence implementation in JavaScript. Entry point:

    vendor/rrule/rrule@2.8.1/index.mjs

Two files, **46,210 bytes raw / 13,865 gzip** measured: a 70-byte esm.sh entry
shim re-exporting `es2022/rrule.bundle.mjs` (46,140 bytes / 13,778 gzip). No bare
specifiers, no runtime fetch, resolves by relative path alone.

The `?bundle` flag on the crawl is load-bearing. The plain esm.sh build of rrule
imports `/tslib@^2.4.0?target=es2022`; a bare or query-carrying specifier in a
vendored file is a page that does not load, and `?` cannot be part of a filename
on Windows. `?bundle` inlines that one dependency. luxon is NOT pulled in - it
stopped being an rrule dependency in 2.7.0, and adding it back changes nothing.

**Used for INTEROP and as a test oracle, not as the app's engine.**
`lib/rrule-engine.mjs` wraps it: it generates every RRULE string that leaves the
app (via `lib/rrule-codec.mjs`), and `tests/rrule-engine.test.mjs` runs ~6,500
generated rules through both it and `lib/reminders.mjs` and asserts the
occurrence sequences agree. `lib/reminders.mjs` stays the hot path because it is
mirrored byte-identically into the jarvis edge function, where an import is
impossible.

**Known defect, worked around here.** rrule 2.8.1 silently discards a
`DTSTART;VALUE=DATE` line - it substitutes the current wall clock and throws
nothing, so an imported all-day series re-anchors to the day of import. Measured
against this vendored copy. `VALUE=DATE` is what Google, Apple and our own
exporter write for all-day events, so `normaliseICalendar()` in
`lib/rrule-engine.mjs` rewrites date-valued DTSTART/EXDATE/RDATE to the
UTC-midnight DATE-TIME form rrulestr does read. Upstream has had no merged PR
since 2023-11-10, so this is worked around rather than waited on;
`tests/rrule-engine.test.mjs` re-measures the defect so the workaround cannot
rot silently.

**Timezone convention.** rrule returns `Date` objects whose UTC fields carry the
intended wall clock, so the obvious `.toISOString()` is wrong by the host offset
(5.5 h in IST) and right in a UTC CI box. `lib/rrule-engine.mjs` only ever reads
`getUTC*`, and the test proves it by running the same rules under five zones in
child processes.

Not in `sw.js`'s `VENDOR` precache list, for the same reason as ical.js and with
the same consequence. `src/ui/calendar-import.js` reaches it lazily
(`lib/ics.mjs` -> `lib/rrule-codec.mjs` -> `lib/rrule-engine.mjs` -> here), so no
page boot depends on it and nothing is broken online; offline, opening the import
or export panel fails. Both rrule files and both ical.js files belong in
`VENDOR` together, and `tests/vendor-offline.test.mjs` has to learn the new roots
in the same commit or it fails on the mismatch.

## Regenerating (version bump)

    node vendor/fetch-vendor.mjs vendor/supabase-js /@supabase/supabase-js@<version>

Then update, in lockstep:

1. `VENDORED` in `src/services/supabase-client.js` (the version is in the path),
2. the `VENDOR` precache list **and** `VERSION` in `sw.js` (list every file the
   crawler prints; `cache.addAll` does not follow ES module imports),
3. `tests/vendor-offline.test.mjs`, which fails if these drift apart.

Delete the old version directory; version-pinned paths are served cache-first
and are never revalidated.
