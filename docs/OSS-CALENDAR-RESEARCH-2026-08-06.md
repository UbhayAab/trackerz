# OSS calendar tooling: what to adopt, what to reject

Research date 2026-08-06. Every byte count and every PASS/FAIL in this document
was measured locally against the real package, not read off bundlephobia or a
README. The harness lived in a scratchpad directory; nothing here changed the
repo except this file.

## The one-paragraph answer

We were right to hand-roll the *expansion engine* and wrong to hand-roll the
*iCalendar codec*. No JavaScript recurrence library passes all the RFC 5545 cases
this app actually depends on: `rrule` gets the expansion semantics right and then
silently discards `DTSTART;VALUE=DATE`, re-anchoring every imported all-day
series to the date of import, while `ical.js` gets dates and timezones right and
then silently ignores `BYSETPOS` when it is combined with `BYMONTHDAY` - which is
precisely the dialect `lib/rrule-codec.mjs` was written to emit. Meanwhile our
own exporter produces iCalendar that violates the spec in two ways a library
would have prevented for free, and its default mode is misread by the most widely
deployed parser. So: keep `lib/reminders.mjs`, adopt `ical.js` for parse and
serialize, stop hand-writing `.ics` text, and change the default export mode.

The frustration behind this brief is half right. Hand-rolling the engine was
correct and the measurements defend it. Hand-rolling the file format was not.

---

## How the numbers were produced

- **Vendored cost** is the repo's own process: run the `vendor/fetch-vendor.mjs`
  crawl over the esm.sh module graph and sum every byte of every file, because
  that is literally what would land in `vendor/` and ship to Pages and get baked
  into the APK. Gzip is reported too, since Pages serves gzip and that is the
  number the user's phone pays on first load.
- **Bare specifiers** were checked against the package's *own* npm dist file
  (via jsDelivr), not esm.sh's rebuild. esm.sh rewrites bare specifiers into
  absolute `/...` paths and the crawler rewrites those to relative paths, so a
  library with bare specifiers is still *adoptable*; it just costs the whole
  transitive runtime in bytes rather than failing outright. The distinction that
  matters is "one self-contained file we can copy" versus "a 57-file graph".
- **Correctness** was measured by running each library on seven rules and
  counting occurrences. Source of truth is RFC 5545 section 3.3.10.

Reference points for judging size: `vendor/` today is 634,895 bytes
(`xlsx` 432,846 + `supabase-js` 202,049). Our hand-rolled calendar code is
**69,180 bytes raw / 24,468 gzip** across `lib/reminders.mjs` (30,623),
`lib/rrule-codec.mjs` (24,611) and `lib/schedule-args.mjs` (13,946). Those three
files were being edited by other agents while this research ran, so the counts
drifted upward mid-session (they read 65,351 total an hour earlier); every
correctness finding below was re-run against the files as they stand now and
still reproduces.

---

## 1. RFC 5545 recurrence

### The conformance run

Seven rules, expanded by each library, occurrence counts compared to what the RFC
requires. `rrule@2.8.1` and `ical.js@2.2.1` were driven directly;
`rrule-temporal@2.0.2` was run on the subset it accepts.

| Case | RFC says | rrule 2.8.1 | ical.js 2.2.1 | rrule-temporal 2.0.2 |
|---|---|---|---|---|
| `FREQ=MONTHLY;BYMONTHDAY=31` skips short months | 7 in 2026 | **7 PASS** | **7 PASS** | **7 PASS** |
| `BYMONTHDAY=28,29,30,31;BYSETPOS=-1` (our clamp dialect) | 12 | **12 PASS** | **38 FAIL** | **12 PASS** |
| `BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1` (last weekday) | 12 | **12 PASS** | **12 PASS** | **12 PASS** |
| `COUNT=5` with one `EXDATE` | 4 | **4 PASS** | **4 PASS** | **4 PASS** |
| `RDATE` adds a date outside the rule | 4 | **4 PASS** | **4 PASS** | not run |
| `UNTIL` is inclusive | 3 | **3 PASS** | **3 PASS** | not run |
| `FREQ=YEARLY` from Feb 29 fires only in leap years | 4 | **4 PASS** | **13 FAIL** | **13 FAIL** |
| `DTSTART;VALUE=DATE:` honoured | start date | **FAIL, silent** | **PASS** | **PASS** |
| `TZID` instant correct *after the documented reinterpretation* | exact | PASS | **PASS** | **PASS** |
| `TZID` instant correct from a naive `.toISOString()` | exact | **FAIL, off by host offset** | **PASS** | **PASS** |

Nothing passes everything. The two failures on each side are disqualifying in
opposite directions, which is why the recommendation is a split.

### The bugs, precisely

**rrule 2.8.1: `DTSTART;VALUE=DATE` is silently discarded.** Given
`DTSTART;VALUE=DATE:20260131` plus `FREQ=MONTHLY;COUNT=3`, it returns
`2026-08-06, 2026-09-06, 2026-10-06` - today's date, three times, monthly.
Inspecting the parsed rule confirms it is not a formatting artefact:
`options.dtstart` reads `2026-08-06T05:28:09.000Z`, which is literally the
timestamp at which the test ran. The same rule written `DTSTART:20260131` (no
`VALUE` parameter) returns the correct `2026-01-31, 2026-03-31, 2026-05-31`. No
exception is thrown. `VALUE=DATE` is the form Google Calendar, Apple Calendar and
our own exporter emit for all-day events, so every imported birthday and holiday
would be re-anchored to the day of import. This is the single most dangerous
behaviour found in this research, because an import that is wrong *and quiet* is
the failure mode this codebase has been burned by before.

**rrule 2.8.1 and TZID: a documented footgun, not a miscomputation. I initially
got this wrong and the correction matters.** The first measurement looked like a
flat error: on this machine (`Asia/Calcutta`, UTC+5:30) every TZID'd occurrence
came back shifted by exactly +330 minutes, constant across four zones, and
correct under `TZ=UTC`. That reads as "rrule adds the host offset". It does not.
rrule returns `Date` objects under a convention its README states explicitly:
*returned "UTC" dates are always meant to be interpreted as dates in your local
timezone*. Reinterpreting the returned UTC calendar fields as local fields
recovers the exact instant in all four zones:

| Rule | True instant | naive `.toISOString()` | Reinterpreted |
|---|---|---|---|
| `TZID=Europe/London:20260306T090000` | `09:00:00Z` | `14:30:00Z` WRONG | `09:00:00Z` **OK** |
| `TZID=America/New_York:20260306T090000` | `14:00:00Z` | `19:30:00Z` WRONG | `14:00:00Z` **OK** |
| `TZID=Asia/Tokyo:20260306T090000` | `00:00:00Z` | `05:30:00Z` WRONG | `00:00:00Z` **OK** |
| `TZID=Asia/Kolkata:20260306T090000` | `03:30:00Z` | `09:00:00Z` WRONG | `03:30:00Z` **OK** |

So the arithmetic is right and the return type lies. That is still a serious
liability for us, for three reasons: the obvious code (`.all()` then
`.toISOString()`) is wrong by 5.5 hours in this app's timezone; it is invisible in
any CI running UTC; and the browser (IST) and the edge function (UTC) would
disagree on the same rule, which is exactly the divergence class
`tests/mirror-parity.test.mjs` exists to prevent. It is
[#336 "UTC-but-not-UTC confusion"](https://github.com/jkbrzt/rrule/issues/336),
open since 2019-04-05 with 19 comments, and it is open precisely because everyone
writes the obvious code. Installing `luxon@3.7.2` alongside, which the README
implies is the fix for timezone support, changed nothing - and it would not, since
luxon stopped being a dependency in rrule 2.7.0.

**Correction to the issue numbers commonly cited for this.** #233, #300, #550,
#453 and #391 are all **closed** (2018-2022). The live timezone issues are
[#336](https://github.com/jkbrzt/rrule/issues/336),
[#452](https://github.com/jkbrzt/rrule/issues/452),
[#501](https://github.com/jkbrzt/rrule/issues/501) (walks the RFC's own
`DTSTART;TZID=America/New_York:19970905T090000` example),
[#355](https://github.com/jkbrzt/rrule/issues/355),
[#571](https://github.com/jkbrzt/rrule/issues/571) and, directly relevant to us,
[#658](https://github.com/jkbrzt/rrule/issues/658) (2025-11-25, `Asia/Kolkata`,
off by exactly one day). Root cause is architectural: `src/dateutil.ts`'s
`dateInTimeZone` derives a **single scalar offset** per call by diffing two
`Intl.DateTimeFormat` strings, so one offset covers a whole series and it cannot
be right across a DST boundary by construction.

**rrule 2.8.1 is abandoned, on the record.** Last commit to master
**2023-11-10**, last release the same day, **zero merged PRs in 2 years 9
months**, **183 open issues and 29 open PRs**. In
[#450](https://github.com/jkbrzt/rrule/issues/450) (open since 2021-01-18) the
primary maintainer wrote on 2022-03-01: "I haven't had any time to put into this
in the past couple of years at all... In my view, this project is in need of a
ground-up rewrite." Two BYSETPOS correctness fixes are sitting unmerged:
[PR #669](https://github.com/jkbrzt/rrule/pull/669) (2026-07-23, `buildPoslist`
dedupes `Date` objects with `indexOf`, i.e. reference equality, so it never
dedupes) and [PR #668](https://github.com/jkbrzt/rrule/pull/668) (2026-06-22,
`tmp.slice(daypos)[0]` clamps an out-of-range negative position to 0 and returns
the *first* candidate instead of nothing). Also open:
[#351](https://github.com/jkbrzt/rrule/issues/351) (since 2019, EXDATE silently
ignored when combined with RRULE in a set) and
[#665](https://github.com/jkbrzt/rrule/issues/665) (2026-03-18, `after`/`before`/
`between` ignore EXDATE when the cache is warm), plus a cluster of infinite-loop
reports (#468, #481, #568, #602, #226).

**ical.js 2.2.1: `BYSETPOS` is parsed and then ignored when combined with
`BYMONTHDAY`.** `ICAL.Recur.fromString` round-trips the rule perfectly - the
parsed `parts` show `{"BYMONTHDAY":[28,29,30,31],"BYSETPOS":[-1]}` and
`toString()` returns the input unchanged - but `ICAL.Recur.iterator` expands
`FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1` to 38 dates in 2026 instead of
12. `BYSETPOS` *does* work when combined with `BYDAY` (the last-weekday case
passes), so this is specific to the `BYMONTHDAY` pairing. The round-trip fidelity
is what makes it nasty: a naive "serialize then parse, compare strings" test
passes while the expansion is wrong.

This is not academic for us. `lib/rrule-codec.mjs` exists specifically to emit
`BYMONTHDAY=28,29,30,31;BYSETPOS=-1` as the faithful export of a clamped "the
31st" rule. Feeding our own `toICS(rule, {mode:"rrule"})` output to ical.js
produces `2026-03-28, 2026-03-29, 2026-03-30, 2026-03-31, ...` - the GST filing
reminder fires roughly 38 times a year in Thunderbird instead of 12. The header
comment in `rrule-codec.mjs` predicted the opposite failure (a naive export
dropping February) and successfully prevented it; this is a different one it did
not anticipate.

The measurement above was made independently and then matched to the tracker:
this is ical.js [#960](https://github.com/kewisch/ical.js/issues/960) (**open**,
filed 2026-02-08), reporting `FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1`
returning all three days.
[PR #985](https://github.com/kewisch/ical.js/pull/985), which fixes it, has been
open since 2026-05-28. The cause is visible in `lib/ical/recur_iterator.js`:
`next_month()` applies BYSETPOS **only inside the `has_by_data("BYDAY")`
branch**, so the BYMONTHDAY-only path never reaches `check_set_position`, and
`expand_year_days()` applies it only when the rule is exactly BYDAY + BYMONTH.
The practical scope of the hole is wider than our case:

- MONTHLY + BYMONTHDAY: BYSETPOS ignored (#960).
- YEARLY + BYDAY without BYMONTH: BYSETPOS ignored
  ([#578](https://github.com/kewisch/ical.js/issues/578), open since 2023-03-06).
- **WEEKLY and DAILY: no BYSETPOS handling anywhere in the file.**

Two more open ical.js issues worth recording before adopting it:
[#1001](https://github.com/kewisch/ical.js/issues/1001) (2026-06-18) is silent
data loss - `ICAL.Recur` parses and stores RFC 7529 `RSCALE`/`SKIP` but
`toString()` drops them, so a non-Gregorian rule round-trips as bare
`FREQ=YEARLY`. And [#70](https://github.com/kewisch/ical.js/issues/70) has been
open since **2013-02-16**: a hang on a rule with both BYDAY and BYMONTHDAY,
inherited from libical. Neither touches our codec use, but both argue against
using ical.js as an expander.

**ical.js 2.2.1: `FREQ=YEARLY` from Feb 29 rolls forward to Mar 1.** Returns 13
occurrences 2024-2036 (`2024-02-29, 2025-03-01, 2026-03-01, ...`) where the RFC
requires 4. RFC 5545 section 3.3.10 says recurrence instances with an invalid date
"MUST be ignored". `rrule-temporal` gets the same case wrong in the other
direction, clamping back to Feb 28 (also 13). Only `rrule` is correct here.

**The EXDATE type-mismatch trap splits them too.** Given
`EXDATE;VALUE=DATE:20260107` against a date-time `DTSTART`, ical.js honours the
exclusion (4 occurrences) and rrule silently ignores it (5). Real calendars do
emit this mismatch.

**Speed is a non-issue for both.** Expanding 5 years of a daily rule (1,826
occurrences), 200 times: `rrule` 1,260 ms, `ical.js` 2,225 ms. That is 6.9 and
12.2 microseconds per occurrence. Our windows are months, not decades.

### Verdicts

| Candidate | Version / last release | License | Vendored bytes (raw / gzip) | Bare specifiers | Verdict |
|---|---|---|---|---|---|
| **`ical.js`** | 2.2.1, 2025-08-08 | MPL-2.0 | **77,698 / 22,993** (single file `dist/ical.min.js`) | **none** | **ADOPT (codec only, not expansion)** |
| `rrule` | 2.8.1, **2023-11-10** | BSD-3-Clause | 57,192 / 17,463 (4 files via esm.sh) | `tslib` | **REJECT** |
| `rrule-temporal` | 2.0.2, 2026-07-25 | MIT | 758 KB unpacked (polyfill bundled in) | `temporal-spec` | **REJECT for now** |
| `@rschedule/core` | 1.5.0, **2023-02-03** | Unlicense | 15,446 / 4,531 (core alone, unusable) | none | **REJECT** |
| `dayspan` | 1.1.0, **2019-06-04** | MIT | not measured | - | **REJECT** |
| `luxon` + `rrule` | luxon 3.7.2, 2025-09-05 | MIT | +71,190 / +22,184 on top of rrule | none | **REJECT** |
| `@rrulenet/rrule` | **0.1.8, 2026-07-23, 5 dl/week** | MIT | 78 KB unpacked | `temporal-polyfill` | **REJECT** |
| `@ephys/rrule` | 3.0.0, **2021-09-30**, 4 dl/week | BSD-3-Clause | not measured | - | **REJECT** |
| `elastic/rrule-es` | Apache-2.0, opened 2025-02-28 | Apache-2.0 | not on npm under that name | - | **REJECT (not distributed)** |

Decisive reasons, one line each:

- **`ical.js` ADOPT** - it is the only candidate that ships a single
  self-contained ES module with zero imports (verified: 0 `import` statements, 0
  `require()` calls, ends in `export{Yt as default}`), so it needs no crawler, no
  bundler and no vendored dependency graph, and it is correct on exactly the
  things a codec must be correct about (`VALUE=DATE`, `TZID`, folding, escaping).
  Its expansion bugs do not matter if we do not use it to expand.
- **`rrule` REJECT** - silently re-anchors all-day recurring events to the date of
  import, and the maintainer has said in writing the project needs a ground-up
  rewrite, with zero merged PRs since 2023-11-10.
- **`rrule-temporal` REJECT for now** - the closest thing to a right answer, and
  the reject is genuinely marginal. It passed the clamp-dialect case ical.js
  failed, `node-ical` switched to it on 2026-01-10, it is the only JS library
  running *external* conformance corpora (both the python-dateutil suite and
  Elastic's RFC-example corpus), and its maintainer closes bugs in days. But it
  is 758 KB unpacked because `temporal-polyfill` is bundled inside, which is 12x
  `ical.js` for a job `lib/reminders.mjs` already does in integer date keys; and
  its README's "first and only fully compliant" claim is false by its own
  tracker ([#128](https://github.com/ggaabe/rrule-temporal/issues/128) accepts
  `COUNT` and `UNTIL` together, which RFC 5545 forbids, even under `strict:true`;
  [#129](https://github.com/ggaabe/rrule-temporal/issues/129) applies COUNT to
  the final set instead of the RRULE). **Revisit when Safari ships Temporal**, at
  which point the polyfill cost disappears and this becomes the recommendation.
- **`@rschedule/core` REJECT** - not merely abandoned: **BYSETPOS is not
  implemented at all**. The shipped 1.5.0 exposes `ByDayOfMonth`, `ByDayOfWeek`,
  `ByHourOfDay`, `ByMonthOfYear` and friends, and there is no `BySetPosition`,
  `ByWeekOfYear` or `ByDayOfYear` module. Issues #4, #3 and #2 have requested
  them since **2018-08-14**. Missing BYSETPOS alone rules out "last Friday of the
  month", never mind our clamp dialect.
- **`dayspan` REJECT** - it cannot parse or emit RRULE strings at all. The
  published tarball has zero occurrences of `RRULE`, `5545`, `BYSETPOS`, `EXDATE`
  or `icalendar`; it has its own vocabulary (`weekspanOfYear`,
  `lastWeekspanOfMonth`) with no mapping to the RFC.
- **`luxon` + `rrule` REJECT** - measured: adding luxon changes nothing, and it
  could not, since luxon stopped being an rrule dependency in 2.7.0. 22 KB gzip
  for zero effect. We do not need a date library anyway: the engine works in date
  keys and `Asia/Kolkata` has no DST.
- **`@rrulenet/rrule` REJECT** - **5 downloads per week**, version 0.1.8, GitHub
  org created 2026-01-06, 1 star, one committer whose every public commit is a
  release chore (development happens privately and lands as squashed drops). It
  is a compat shim over a new closed-history engine, and its `COMPARISONS.md` is a
  marketing matrix of red X's against rrule.js and rrule-temporal citing no issue
  numbers, no reproductions and no conformance results. Not a technical judgement
  against the code, which may be fine; a judgement that nothing about it is
  verifiable.

### Which is the de-facto interop standard?

Two different answers, and the distinction decides our recommendation.

**By usage, it is still `rrule`, and the standard is abandoned.** Weekly npm
downloads for the week of 2026-07-29: `rrule` **2,641,875**, `ical.js` 441,489,
`node-ical` 262,307, `rrule-temporal` 256,787, `@rschedule/core` 20,131,
`dayspan` 3,648, `@rrulenet/rrule` **5**. So the most-installed recurrence
library in the ecosystem has not had a commit in two years and nine months and
carries 183 open issues. Worth noting the movement, though: `rrule-temporal` went
from zero to 257k/week in 15 months, and `node-ical` - the largest consumer of
rrule-like functionality in the registry - dropped `rrule` for it entirely. Some
of that 257k is `node-ical` pulling it transitively and the npm API will not let
me decompose direct from transitive, so treat the organic share as unknown.

**By what will actually read the file we export, it is `ical.js`.** That is the
number that matters for us. rrule's 2.6M downloads are Node services computing
their own schedules; they will never see our `.ics`. Thunderbird will, and
Thunderbird ships ical.js - confirmed at the source, not from the README:
maintainer `kewisch` is Philipp Kewisch, Director of Web Services at
MZLA/Thunderbird, and comm-central contains
`calendar/base/modules/Ical.sys.mjs`, MPL-2.0, as the vendored bundle. If our
export is misread by ical.js it is misread by Thunderbird, and being right about
the RFC does not get the user their reminder.

**These two facts point the same way: change what we export, keep our own
expander.** There is no shared cross-implementation RFC 5545 conformance suite
for JavaScript - I looked, and the honest answer is that none exists. What exists
is per-implementation corpora that get ported around (python-dateutil's
`test_rrule.py` is the common ancestor; Elastic open-sourced its production
implementation in 2025 and rrule-temporal absorbed its RFC-example corpus,
Apache-2.0 header intact). So "passes the standard suite" is not a claim anyone
can make, and library choice cannot be outsourced to a conformance badge.

---

## 2. iCalendar parse and serialize

### Our own exporter is the thing that is actually broken

Running `toICS()` from `lib/rrule-codec.mjs` on a real rule
(`{freq:"monthly", day_of_month:31, dtstart:"2026-01-31"}`) and inspecting the
output:

| Check | `mode:"rrule"` | `mode:"rdate"` |
|---|---|---|
| `DTSTAMP` present (REQUIRED, RFC 5545 section 3.6.1) | **MISSING** | **MISSING** |
| Longest line vs the 75-octet fold limit | **111 octets** | **349 octets** |
| Expanded by ical.js to our intent (12/yr) | **no, 38/yr** | **yes, 12** |
| Expanded by rrule to our intent (12/yr) | DTSTART ignored | **yes, 12** |

Three real defects, none of which would exist if a library wrote the file:

1. **No `DTSTAMP`.** RFC 5545 makes it mandatory in a `VEVENT`. Tolerant parsers
   accept the file anyway, which is why this has not been noticed; strict ones
   and some Exchange import paths do not.
2. **No line folding.** `finish()` and `toICS()` join values without folding at
   75 octets. In `mode:"rdate"` the `RDATE` line is a single comma-joined list;
   at the default `years:3` and `cap:200` that line can exceed 1,800 octets.
3. **`mode:"rrule"` is misread by the most widely deployed parser.** As above.

Worth stating plainly: `mode:"rdate"`, the "belt-and-braces" fallback that the
file's own header calls the safe option, is the only mode that both parsers read
correctly. The header was right.

### Verdicts

| Candidate | Version / last release | License | Bytes (raw / gzip) | Bare specifiers | Verdict |
|---|---|---|---|---|---|
| **`ical.js`** | 2.2.1, 2025-08-08 | MPL-2.0 | **77,698 / 22,993** | **none** | **ADOPT (both environments)** |
| `ical-generator` | 11.1.0, 2026-07-24 | MIT | 36,968 / 9,231 (`dist/index.mjs`) | **none** | **REJECT (redundant)** |
| `node-ical` | 0.27.1, 2026-07-21 | Apache-2.0 | not measured | `rrule-temporal`, `temporal-polyfill` | **REJECT** |

- **`ical.js` ADOPT** - it is the only one that both parses and serializes, and
  it does both correctly. Verified serialization: it emits `DTSTAMP`, folds at
  exactly 75 octets (measured: longest line 75), and writes
  `DTSTART;VALUE=DATE:20260131` in the correct form. One library replaces the
  hand-written `finish()`/`icsEscape()`/`parseICalendar()` layer in both
  directions. It also runs in Deno via `npm:ical.js@2.2.1` (independently
  verified by parsing a VEVENT and expanding `FREQ=WEEKLY;COUNT=3` correctly).
- **`ical-generator` REJECT** - genuinely good and genuinely small (36,968 bytes,
  zero dependencies, zero bare specifiers, so it too is a drop-in file), and it
  emits Outlook compatibility properties we do not. But it is *export only*, so
  adopting it still leaves the import side hand-rolled, and 9 KB gzip to avoid
  writing `BEGIN:VCALENDAR` is not the win. It also has a specific trap for us:
  its object API **throws** on our exact dialect with
  ``repeating.bySetPos` must be used along with `repeating.byDay`!``, a
  validation rule stricter than RFC 5545, which permits `BYSETPOS` with any
  `BYxxx` part. Passing the rule as a raw string (`repeating: "FREQ=MONTHLY;
  BYMONTHDAY=28,29,30,31;BYSETPOS=-1"`) bypasses the validator and emits
  correctly, but needing an escape hatch on the first real rule is a bad sign.
- **`node-ical` REJECT** - Node-oriented (its main entry is `node-ical.cjs`) and
  it drags in `rrule-temporal` plus `temporal-polyfill`, whose unpacked sizes are
  758 KB and 991 KB. Its dependency switch away from `rrule` is a useful signal
  about where the ecosystem is heading, and that is all we should take from it.

---

## 3. CalDAV from Deno

Browser CalDAV is not merely awkward, it is impossible against hosted providers.
Real preflight requests (`OPTIONS` with `Origin` and
`Access-Control-Request-Method: PROPFIND`) were sent to three providers:
Google's `apidata.googleusercontent.com/caldav/v2/` returns 403 with no
`Access-Control-Allow-Origin`; iCloud returns 200 with `DAV:` and
`access-control-expose-headers` but **no** `Access-Control-Allow-Origin`;
Fastmail returns 401 with no `Access-Control-Allow-Origin`. None of the three
sends the header, so any CalDAV work must live in an edge function. (Trap worth
recording: iCloud's `DAV:` header contains the token `access-control`, which is
RFC 3744 WebDAV ACL, not CORS, and `expose-headers` without `allow-origin` is
inert.) Self-hosted servers vary: Radicale documents an
`Access-Control-Allow-Origin` setting in its shipped config, Baikal returns 401
on the preflight itself so it can never work
([issue #1012](https://github.com/sabre-io/Baikal/issues/1012), open since
2020-12-28), and Nextcloud's CORS request
([#3131](https://github.com/nextcloud/server/issues/3131)) has been open since
2017.

Google's CalDAV endpoint is still supported but is **OAuth2 only** - basic auth
returns 401, and the old `google.com/calendar/dav` path is deprecated in favour
of `https://apidata.googleusercontent.com/caldav/v2/`.

| Candidate | Version / last release | License | Size | Verdict |
|---|---|---|---|---|
| **`tsdav`** | 2.3.1, 2026-07-10 | MIT | 39.6 KB min / 10.4 KB gzip | **ADOPT-IN-EDGE-ONLY** |
| `ts-caldav` | 0.4.0, 2026-07-10 | MIT | small | **REJECT (too young)** |
| `dav` | 1.8.0, **2018-08-11** | MPL-2.0 | - | **REJECT** |
| `@nextcloud/cdav-library` | 2.6.2, 2026-06-11 | AGPL-3.0-or-later | - | **REJECT** |

- **`tsdav` ADOPT-IN-EDGE-ONLY** - it was actually run under Deno 2.9.4, not
  merely inspected: `import ... from "npm:tsdav@2.3.1"` resolves, and a full
  round trip (login, principal discovery, `calendar-home-set`, `fetchCalendars`,
  `fetchCalendarObjects` with etag and VEVENT extraction) completed against a
  mock server, as did Google's OAuth2 refresh-token flow. Its `package.json`
  carries an explicit `"deno"` export condition, its only dependencies are
  `debug` and `xml-js`, and the `cross-fetch` dependency that used to break edge
  runtimes is gone. Zero open issues at time of writing.
  - API gotcha found the hard way: `getOauthHeaders` takes the credentials object
    **directly**, not wrapped in `{credentials}`. The wrong shape silently falls
    into the authorization-code branch and throws a misleading "missing
    authorizationCode, redirectUrl" error.
  - Honest caveat: 351 stars and a single maintainer is bus-factor 1. Mitigated
    by MIT, by the small surface we would use (about six functions), and by the
    fact that vendoring 40 KB later is cheap.
- **`ts-caldav` REJECT** - real and modern but 27 stars and 765 weekly downloads.
  Note it as the fallback if `tsdav` is abandoned.
- **`dav` REJECT** - last published 2018-08-11, and it depends on `xmldom@0.1.19`
  (known CVEs) and an `XMLHttpRequest` shim that cannot work in Deno.
- **`@nextcloud/cdav-library` REJECT** - AGPL-3.0-or-later is viral, it requires
  `node ^24`, it depends on `@nextcloud/axios` for Nextcloud CSRF handling, and
  it assumes a Nextcloud session.

**There is no Deno-native or JSR-native CalDAV module.** Querying the JSR API for
"caldav" returns zero packages. `npm:tsdav` is the answer.

---

## 4. Google Calendar API from Deno

### The client libraries

Sizes pulled live from the npm registry today and independently re-checked:

| Package | Version | Published | Unpacked | Files | `engines` | Verdict |
|---|---|---|---|---|---|---|
| `googleapis` | 174.0.1 | 2026-08-05 | **211,656,184 B (212 MB)** | **1,881** | `node >=18` | **REJECT** |
| `@googleapis/calendar` | 16.0.0 | 2026-08-03 | 840,711 B | 14 | `node >=12` | **REJECT** |
| `google-auth-library` | 11.0.0 | 2026-07-30 | 601,779 B | 95 | `node >=22` | **REJECT** |
| **raw REST + WebCrypto** | - | - | **0** | 0 | - | **ADOPT-IN-EDGE-ONLY** |

`@googleapis/calendar` is **252x smaller** than the mega-package and 134x fewer
files, so the obvious move is the per-API subpackage. It does not help, for a
reason that has nothing to do with size.

**Deno is officially unsupported, on the record.** googleapis issue
[#3453](https://github.com/googleapis/google-api-nodejs-client/issues/3453) was
closed 2025-02-03 with a maintainer stating "we are not planning on adding
support for additional runtimes for this library in the future". Issue
[#2715](https://github.com/googleapis/google-api-nodejs-client/issues/2715)
("Should we have a Deno version?") has sat open since 2021 with no maintainer
response. Anything that works is incidental, not contractual.

**And it demonstrably breaks on Supabase specifically.**
[supabase/discussions#33244](https://github.com/orgs/supabase/discussions/33244)
reports `Cannot read properties of undefined (reading 'GOOGLE_SDK_NODE_LOGGING')`
thrown at *module init*, before `Deno.serve()` ever runs. Root cause is
`gcp-metadata` 6.1.0 to 6.1.1 adding a `google-logging-utils` dependency that
reads `process.env` in a way pre-2.1.10 Deno mishandles. Deno fixed it in
[v2.1.10](https://github.com/denoland/deno/releases/tag/v2.1.10) (2025-02-13),
but Supabase Edge Runtime was confirmed on **Deno 2.1.4** as of 2025-10-22
([discussion #38898](https://github.com/orgs/supabase/discussions/38898)), below
the fix, and a commenter reported the bug recurring in February 2026.

**The subpackage does not dodge this.** The #33244 report was filed against
`@googleapis/sheets`, not the mega-package. `@googleapis/calendar` depends on
`googleapis-common`, which depends on `google-auth-library`, `gcp-metadata` and
`google-logging-utils`. That is the exact failing path. Subpackages buy size and
import time, not runtime compatibility. Also open:
[#3712](https://github.com/googleapis/google-api-nodejs-client/issues/3712)
("does not work in deno", `Premature close` on the token endpoint) and Deno
[#27803](https://github.com/denoland/deno/issues/27803), where
google-auth-library network errors become uncatchable
`Top-level await promise never resolved`.

**Cold start, with an honest caveat.** The best published number is from a
googleapis maintainer on the
[Google Cloud blog](https://cloud.google.com/blog/products/serverless/running-effective-nodejs-apps-on-cloud-functions):
loading full `googleapis` spans **~3,000 ms** of cold start against **195 ms**
for a single submodule, "over 10 times faster". That was 2020, when the package
was 72 MB; it is 212 MB now, so treat 3 s as a floor. Issue
[#3335](https://github.com/googleapis/google-api-nodejs-client/issues/3335), open
since 2023, reports "requiring this packages currently takes about 650ms" on an
M1. **Negative result worth stating: there is no published benchmark anywhere
with measured milliseconds for a googleapis import on Deno, Deno Deploy or
Supabase Edge Functions. Every number that exists is Node.** We would have to
measure it ourselves, and given the runtime is unsupported that measurement is
not worth taking.

`google-auth-library` alone is no safer: it declares `node >=22`, its
`jws`/`ecdsa-sig-formatter` deps use `node:crypto`, `gaxios@7` still declares
`node-fetch` and `https-proxy-agent`, and it carries the same
`gcp-metadata` + `google-logging-utils` surface that broke Supabase.

### Raw REST is genuinely small

For a single user with a refresh token it is two steps and zero dependencies:

1. `POST https://oauth2.googleapis.com/token`,
   `Content-Type: application/x-www-form-urlencoded`, body `client_id`,
   `client_secret`, `refresh_token`, `grant_type=refresh_token`. Access token
   lifetime ~3,600 s.
2. `Authorization: Bearer <access_token>` against
   `https://www.googleapis.com/calendar/v3/...`.

**No JWT signing is needed on this path.** JWT signing is only for service
accounts, and a service account cannot see a personal Gmail calendar without
domain-wide delegation (Workspace only), so it is the wrong tool here. If it were
ever needed, Deno's WebCrypto does `RSASSA-PKCS1-v1_5` + SHA-256 natively, so
even that path needs no npm package.

### The 2026 contract, verified (two premises in the brief were wrong)

**Incremental sync.** `syncToken` is invalidated "for various reasons including
token expiration or changes in related ACLs"; on **410 GONE** the required client
response is to **wipe the local store and perform a full resync**. Two details
that bite: `nextSyncToken` "is present only on the very last page" of a paginated
result, and incremental results always contain deleted entries with status
`cancelled`. No sync-token changes appear in the Calendar release notes for 2025
or 2026.

**`events.watch` channel expiry is 7 days, not ~30.** The
[events.watch reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch)
gives `params.ttl` a **default of 604800 seconds**. No maximum is documented, and
I could not find any Google page stating a hard cap, so treat "the max" as
unverified. The push guide notes expiration is "determined either by your request
or by any Google Calendar API internal limits or defaults (the more restrictive
value is used)", so asking for longer does not guarantee longer. Renewal is
manual: "there's no automatic way to renew a notification channel", you must call
`watch` again with a fresh unique `id`, and the receiver must be HTTPS with a
valid non-self-signed cert. No deprecation notice exists.
**Practical consequence: push would need a weekly re-`watch` cron. Polling
`events.list` with a `syncToken` is strictly less machinery for one user.**

**The CASA premise is wrong, and in our favour.** Per the authoritative
[restricted scopes list](https://support.google.com/cloud/answer/13464325),
restricted scopes cover Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient
and Health. **No Calendar scope is restricted at all**, so neither
`calendar.events` nor full `calendar` triggers the CASA security assessment or
annual audit. That burden simply does not apply to Calendar. What Calendar scopes
do trigger is *sensitive* scope verification: brand verification, scope
justification, a demo video, "up to 10 days".

**`calendar.app.created`** grants "make secondary Google calendars, and see,
create, change, and delete events on them" - confined to calendars the app itself
created, so it requires creating a dedicated secondary calendar and gives no
access to the user's primary. **Negative result: I could not verify whether it is
labelled sensitive or non-sensitive.** Google publishes no per-scope sensitivity
table for Calendar; the indicator appears only in the Cloud Console consent
screen. Check it there rather than trusting a blog.

**The 7-day refresh token expiry in Testing mode is still real in 2026.**
Verbatim from
[Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2#expiration):
a project "with an OAuth consent screen configured for an external user type and
a publishing status of 'Testing' is issued a refresh token expiring in 7 days,
unless the only OAuth scopes requested are a subset of name, email address, and
user profile". Calendar scopes are not in that subset. **Adding yourself as a
test user does not change this** - test-user status is what lets you authorise at
all, and has no effect on token lifetime.

**The fix is to publish to "In production" and stay unverified.** Per
[when verification is not needed](https://support.google.com/cloud/answer/13464323),
personal use under 100 users is an explicit exemption: click through the
"unverified app" warning once during consent, and the refresh token then behaves
normally (no expiry unless revoked, unused for 6 months, or a password change on
Gmail scopes). Note the cap of **100 refresh tokens per Google Account per client
ID**; exceeding it silently invalidates the oldest. This also makes the
sensitive-scope question moot, so `calendar.events` is available if
`app.created`'s secondary-calendar-only restriction is inconvenient.

**Quotas** are irrelevant at our scale by three orders of magnitude: 10,000
requests/minute per project, 600/minute per user per project, 1,000,000/day.
Worth knowing that a quota tiering change took effect 2026-05-01 and Google
states that exceeding quota "is planned to incur charges" in 2026 with 90 days
notice.

**Verdict: ADOPT-IN-EDGE-ONLY, raw REST, zero packages.** The decisive reason is
not size, it is that every client library routes through an auth stack whose
maintainers have said on the record they will not support Deno, and which has a
reproduced module-init crash on the exact Deno version Supabase runs.

---

## 5. Calendar UI without a bundler

All of these are *loadable* without a bundler, because esm.sh plus the existing
crawler resolves bare specifiers into relative paths. The question is what the
bytes buy. Sizes are the full vendored graph, which is what ships to Pages and
gets baked into the APK.

| Candidate | Version / last release | License | Vendored raw / gzip | Files | Framework runtime | Verdict |
|---|---|---|---|---|---|---|
| **`vanilla-calendar-pro`** | 3.1.0, 2026-01-09 | MIT | **62,412 / 15,997** + 48,190 CSS (4,784 gz) | **1 + 1 CSS** | **none** | **ADOPT (date picker only)** |
| `cally` | 0.9.2, 2026-02-05 | MIT | 38,355 / 12,302 | **1** | atomico, bundled in | **ADOPT (if web components preferred)** |
| `@event-calendar/core` | 5.12.0, 2026-07-31 | MIT | 284,673 / 88,017 + 19,436 CSS | **57** | **Svelte 5, required** | **REJECT** |
| `@fullcalendar/core` | 6.1.21, 2026-06-18 | MIT | 188,181 / 58,930 | 8 | **Preact, required** | **REJECT** |
| `fullcalendar` (v7 bundle) | 7.0.2, 2026-07-24 | MIT | 278,762 / 91,323 | 21 | **Preact, required** | **REJECT** |
| `@toast-ui/calendar` | 2.1.3, **2022-08-16** | MIT | 265,264 / 86,002 | 6 | **Preact + immer + DOMPurify** | **REJECT** |

**The `@event-calendar/core` claim in the brief is false, and this was worth
checking.** The premise was "Svelte-compiled, no runtime dep, and it is small".
Measured, `dist/index.js` (202,714 bytes) contains four bare specifiers:
`svelte`, `svelte/internal/client`, `svelte/internal/disclose-version` and
`svelte/reactivity`. It needs the Svelte 5 runtime at run time, and
`package.json` lists `svelte: ^5.56.7` as a real `dependencies` entry, not a
peer or dev dependency. Nor was this a v5 regression: `@event-calendar/core@3.12.0`
also imports `svelte/internal`, `svelte` and `svelte/store`. It was never
runtime-free. Vendored through esm.sh it resolves to **57 files, 284,673 bytes**,
which is 45% of everything currently in `vendor/` for one widget, and it would
put a second UI framework runtime into an app whose stated convention is "no
framework".

**FullCalendar v7 restructured; do not import `@fullcalendar/core` for it.**
`@fullcalendar/core@7.0.2` is a 6 KB stub whose `index.js` is literally
`console.log('@fullcalendar/core should not be imported directly');`. The real v7
package is `fullcalendar`, which depends on `preact` and `@full-ui/headless-calendar`
and unpacks to 2,123 KB across 413 files. The stable v6 line
(`@fullcalendar/core@6.1.21`) imports `preact` and `preact/compat` as bare
specifiers and vendors to 188,181 bytes for the **core alone, with no views** -
`@fullcalendar/daygrid@6.1.21` is a 941-byte re-export shim that pulls
`@fullcalendar/core/internal.js` on top.

**`@toast-ui/calendar` is four years stale.** Last publish 2022-08-16, and it
carries `preact`, `immer`, `isomorphic-dompurify`, `tui-date-picker` and
`tui-time-picker`.

**The honest caveat on the two ADOPT rows:** `vanilla-calendar-pro` and `cally`
are **date pickers, not event calendars**. Neither renders event chips on a month
grid. If what is wanted is "pick a date for a reminder", either is a clean,
zero-runtime, single-file drop-in. If what is wanted is "see my month with
reminders drawn on it", neither does it and the honest options are FullCalendar's
59 KB gzip plus a Preact runtime, or ~200 lines of our own CSS grid. Given the
repo already hand-draws its own SVG charts, a month grid is well within the
existing idiom and I would write it rather than import a framework.

---

## 6. Self-hosted calendar servers

**Decisive constraint: this app has no always-on process.** It is static files on
GitHub Pages plus short-lived Deno edge invocations. All five candidates require
a long-running server and a persistent filesystem or database, so all five mean
provisioning and maintaining a VPS that does not currently exist.

| Server | Language / License | Current | Storage | Needs a VPS | Verdict |
|---|---|---|---|---|---|
| Radicale | Python, GPL-3.0 | 3.7.7, 2026-07-19 | loose `.ics` files, **no DB backend** | yes | **REJECT (over-engineering)** |
| Baikal | PHP 8.2+, GPL-3.0 | 0.12.1, 2026-08-05 | SQLite/MySQL | yes | **REJECT (over-engineering)** |
| Nextcloud Calendar | PHP/Vue, AGPL-3.0 | 5.5.22, 2026-07-13 | Nextcloud DB | yes, a whole Nextcloud | **REJECT** |
| EteSync / Etebase | Python/TS, AGPL/BSD | **abandoned** | encrypted blobs | yes | **REJECT (dead)** |
| Cal.com | TypeScript, MIT | 6.2.0, 2026-03-01 | not a calendar store | yes | **REJECT (mirror ideas only)** |

Honest answer to the question as asked: **none of these is worth it for a
single-user personal app, and it is not close.** These servers exist to solve
multi-user, multi-device CalDAV sync with access control. We have one user and
already have Postgres. Adopting one would move calendar data *out* of the
database that every insight engine in this app queries, into either loose `.ics`
files (Radicale) or an opaque schema, and would add a server to operate.

Three findings worth keeping anyway:

- **EteSync/Etebase is dead.** `etesync/server`'s last commit was 2024-07-12 and
  it has never cut a GitHub release; npm `etebase` is stuck at 0.43.1 from
  2021-08-08. Separately, its end-to-end encryption is actively hostile to this
  app: encrypted blobs are unqueryable, so no aggregation or insight engine could
  read the data.
- **Nextcloud Calendar looks abandoned on GitHub Releases and is not.** That tab
  is stale at v3.3.2/2022; they ship through the Nextcloud app store, where
  5.5.22 landed 2026-07-13. Do not draw the wrong conclusion from the repo page.
- **Cal.com's CalDAV connector is a wrapper around `tsdav`.** Its
  `packages/lib/CalendarService.ts` (1,023 lines) imports `createAccount`,
  `fetchCalendars` and friends from `tsdav` and pins `tsdav: 2.0.3`. That is
  independent confirmation that `tsdav` is the right library. None of it is
  reusable directly: `scope:calcom` on npm returns zero published packages, and
  the service is hard-coupled to their Prisma schema and credential encryption.
  Read those 1,023 lines as a field guide to CalDAV potholes (timezone
  normalisation, `sanitizeCalendarObject`, free-busy fallbacks) and copy
  individual helpers; the licence is MIT so that is permitted. Note the repo has
  moved to `calcom/cal.diy`.

---

## 7. Job schedulers: is our claim loop worse?

**No. It is the same pattern, and in one respect it is ahead.**

`claim_agent_tasks` was compared against `pgmq`'s actual implementation
(`pgmq.read()` in `pgmq-extension/sql/pgmq.sql`). pgmq does a CTE that selects
with `FOR UPDATE SKIP LOCKED` and then updates from that CTE, setting a
visibility timeout. Ours does a CTE that selects with `FOR UPDATE SKIP LOCKED`
and then updates from that CTE, setting `claimed_at`. The shapes are the same;
`vt` plays the role of `claimed_at + 10 minutes`. pg-boss and river use the same
primitive underneath.

**The suspected correctness gap is not real.** There is no "SKIP LOCKED in a
subquery fails to lock the outer UPDATE" bug here: `FOR UPDATE` row locks are held
to end of transaction, a plpgsql function body is one transaction, so the
`UPDATE` operates on rows this transaction already holds. Concurrent claimers
skip them. The genuine limitation of `SKIP LOCKED` is that it cannot enforce a
*global* constraint like "never more than N running" without an advisory lock,
and this design has no such constraint. The pattern would only break if the
`SELECT ... FOR UPDATE` and the `UPDATE` were in different transactions, for
example selecting in the edge function and updating on a later round trip. They
are not.

| Candidate | Version / last release | License | Verdict |
|---|---|---|---|
| `pgmq` | 1.12.0, 2026-07-14 | PostgreSQL | **REJECT (lateral move)** |
| `pg-boss` | 12.27.0, 2026-08-03 | MIT | **REJECT (still needs pg_cron)** |
| `graphile-worker` | 0.17.3, 2026-07-08 | MIT | **REJECT (runOnce has no cron)** |
| `river` | 0.43.0, 2026-08-05 | MPL-2.0 | **REJECT (Go runtime absent)** |

- **`pgmq` REJECT** - it is what Supabase Queues is built on, it is well
  maintained, and it would be a lateral move: we would gain `read_ct` and
  `archive`, still hand-roll retries (it has no backoff, no dead-letter, no
  priorities, no cron), and trade a PostgREST-queryable domain table for an
  opaque jsonb message.
- **`pg-boss` REJECT** - the only candidate with a real feature edge (retries
  with exponential backoff, dead-letter queues with redrive, priorities, rate
  limiting, debouncing via `singletonKey`, cron) and it does have a serverless
  path (`fetch`/`complete`/`fail` without `work()`, `supervise:false`,
  `maintain()`). But its own docs state that for scheduling "at least one
  instance needs to be running", so pg_cron stays anyway and we add a npm
  dependency plus a schema.
- **`graphile-worker` REJECT** - `runOnce()` exists, but `runOnceInternal` calls
  `_runTaskList` with `continuous:false` and never calls `runCron`, so the
  one-shot mode costs you the crontab entirely. Also requires Node 22.18+, which
  does not exist in this stack.
- **`river` REJECT** - Go only. There is no Go runtime here. Full stop.

**What our design already does better than all four:** `agent_task_runs unique
(task_id, slot_key)` is idempotency at the *effect* level. pg-boss,
graphile-worker and river all promise at-least-once and leave effect-level
idempotency to the caller. And the dual pg_cron plus GitHub Actions scheduler is
redundancy none of them offer, which is the correct response to pg_net's queue
tables being `UNLOGGED` and documented as not crash-safe.

### But there are five real gaps, and they are ours to fix

Verified against `supabase/migrations/20260806000030_calendar_engine.sql`:

1. **No index serves the stuck-row reset.** The table has
   `ux_agent_tasks_dedupe`, `ix_agent_tasks_due (fire_at) where status='scheduled'`
   and `ix_agent_tasks_user`. Nothing covers
   `status='running' and claimed_at < now() - interval '10 minutes'`, so every
   claim call scans, once per user, every minute, forever. Fix:
   `create index on agent_tasks (claimed_at) where status = 'running'`.
2. **The crash-recovery reset does not increment `consecutive_failures`.** The
   table *does* have `runs`, `consecutive_failures`, `disabled_reason` and a
   documented three-strikes breaker, so the "no retry limit" criticism is only
   half true and the design deserves credit. But the reset does
   `set status='scheduled', updated_at=now()` and nothing else, so a task that
   *crashes* the edge function (rather than returning a failure) never trips the
   breaker and loops every 10 minutes indefinitely.
3. **No backoff, so a poison task blocks the head of the queue.** The reset
   preserves the original `fire_at`, and the claim is `order by fire_at limit N`,
   so a permanently-failing overdue task sits at the head and burns a claim slot
   on every tick. Libraries dodge this by setting `run_at = now() + backoff` on
   retry. Fixing gap 2 and 3 together is one `update`: increment
   `consecutive_failures`, push `fire_at` forward exponentially, and let the
   existing breaker do its job.
4. **The reset `UPDATE` has no `skip locked`.** It runs before the claim in the
   same transaction and holds write locks on every stuck row for the rest of the
   function, so the pg_cron tick and the GitHub heartbeat arriving together
   serialise on the *reset* rather than skipping past each other on the claim.
5. **`pg_net`'s default timeout is 2000 ms.** If `net.http_post` is called
   without an explicit `timeout_milliseconds`, an edge invocation that takes
   longer (it will) is recorded as a timeout in `net._http_response` even though
   it succeeded, and a genuine 500 is invisible unless something reads that table
   inside the 6-hour retention. That is exactly the silent-failure class this
   codebase has been bitten by before.

One criticism that turned out **not** to apply: the dedupe index predicate is
`where dedupe_key is not null`, not status-scoped, so it already covers the
`running` state and there is no insert window during a run.

The 10-minute recovery window is currently safe, but by coincidence rather than
design: Supabase Edge Functions cap at 400 s wall clock, so a live worker cannot
outlive the reset. If that limit becomes configurable, this becomes a
double-execution bug, caught only for effects routed through `agent_task_runs`.

---

## RECOMMENDED STACK

Adopt three packages. Reject the rest. Total added weight to what ships from
Pages and into the APK: **77,698 bytes raw, 22,993 gzip** - one file.

| # | Package | Version | Environment | Role |
|---|---|---|---|---|
| 1 | **`ical.js`** | **2.2.1** | **Browser**, vendored as `vendor/ical.js/ical.js@2.2.1/index.mjs` (copy `dist/ical.min.js`; no crawler needed, it has zero imports) | Parse imported `.ics`; serialize our export. **Never** `ICAL.Recur.iterator` for expansion. |
| 2 | **`ical.js`** | **2.2.1** | **Edge (Deno)**, via `npm:ical.js@2.2.1` | Same, server side. Verified working under Deno. |
| 3 | **`tsdav`** | **2.3.1** | **Edge (Deno) only**, via `npm:tsdav@2.3.1` | CalDAV, if and when two-way sync is wanted. Impossible in the browser: no provider sends `Access-Control-Allow-Origin`. |

**Keep, do not replace:**

- `lib/reminders.mjs` stays the expansion engine. It is correct on all the cases
  *we* generate, it works in integer date keys so it has no timezone class of bug
  at all, and at 30,623 bytes it is smaller than `rrule` vendored (57,192) and
  24x smaller than `rrule-temporal` unpacked.
- `pg_cron` + `agent_tasks` + `FOR UPDATE SKIP LOCKED` stays. It is pgmq's own
  implementation with fewer moving parts, and no candidate library can run
  without a persistent process this architecture does not have.

**Reject, with the decisive reason:**

| Package | Reason |
|---|---|
| `rrule` | Silently discards `DTSTART;VALUE=DATE` and re-anchors the series to today; maintainer says it needs a ground-up rewrite; 0 merged PRs since 2023-11-10. |
| `rrule-temporal` | Closest to right, and the marginal call in this document. 758 KB unpacked (bundled Temporal polyfill) for a job `lib/reminders.mjs` already does. **Revisit when Safari ships Temporal.** |
| `@rrulenet/rrule` | 5 downloads/week, v0.1.8, marketing-only comparison docs, unverifiable claims. |
| `@rschedule/core` | BYSETPOS, BYWEEKNO and BYYEARDAY are not implemented in shipped code; requested since 2018-08-14. |
| `dayspan`, `@ephys/rrule` | dayspan cannot parse or emit RRULE at all; `@ephys/rrule` is 4 downloads/week, last published 2021-09-30. |
| `luxon` | Measured: changes nothing, and cannot, since luxon stopped being an rrule dependency in 2.7.0. |
| `ical-generator` | Export only, so the import side stays hand-rolled; and it throws on our `BYSETPOS` + `BYMONTHDAY` dialect. |
| `node-ical` | Node-oriented, drags in `rrule-temporal` + `temporal-polyfill`. |
| `@event-calendar/core` | **Not runtime-free** - 4 bare `svelte` imports, 57 files, 284,673 bytes. |
| `@fullcalendar/*`, `fullcalendar` | Requires a Preact runtime; 59-91 KB gzip for core alone. |
| `@toast-ui/calendar` | Last release 2022-08-16; Preact + immer + DOMPurify. |
| Radicale, Baikal, Nextcloud, EteSync, Cal.com | All need an always-on server this app does not have; EteSync is dead. |
| `pgmq`, `pg-boss`, `graphile-worker`, `river` | Lateral move, still needs pg_cron, no cron in `runOnce`, no Go runtime. |

**For a month-grid UI**, write it. `vanilla-calendar-pro@3.1.0` (62,412 bytes,
zero dependencies, zero bare specifiers) or `cally@0.9.2` (38,355 bytes, single
file) are clean drop-ins if a **date picker** is all that is needed, but neither
draws events on a grid, and the alternative that does costs a framework runtime.
This repo already hand-draws SVG charts; a month grid belongs in the same idiom.

### The four follow-up work items this research implies

Listed in decreasing order of what they cost the user when wrong. Not done here -
this document only decides what to adopt.

1. **Change the default export mode to `rdate`.** It is the only mode both
   parsers read correctly today. `mode:"rrule"` fires the GST reminder ~38 times
   a year in anything ical.js-based, including Thunderbird.
2. **Add `DTSTAMP` and 75-octet line folding**, or hand serialization to
   `ical.js` and get both for free.
3. **Guard the import path against rrule-style breakage** by parsing with
   `ical.js` (which honours `VALUE=DATE` and `TZID`) rather than anything in the
   rrule family.
4. **Close the five scheduler gaps** in section 7, especially the missing
   `(claimed_at) where status='running'` index and the reset that never
   increments `consecutive_failures`.

---

## What this document could not verify

Listed so nobody treats an unknown as a finding.

- **Whether `calendar.app.created` is classified sensitive or non-sensitive.**
  Google publishes no per-scope sensitivity table for Calendar; the indicator
  appears only in the Cloud Console consent screen. Moot if we publish to
  production unverified, which is the recommendation anyway.
- **The documented maximum for an `events.watch` channel TTL.** The default is
  604800 s (7 days) and that is stated; no page states a hard cap.
- **Measured googleapis import cost on Deno / Supabase Edge Functions.** No such
  benchmark exists publicly. Every number in section 4 is from Node, and the
  headline ~3,000 ms figure is from 2020 when the package was a third of its
  current size.
- **Whether `rrule-temporal`'s published benchmark numbers reproduce.** They were
  read from its README, not run. Its correctness results in section 1 *were*
  measured here.
- **The direct-versus-transitive split of `rrule-temporal`'s 257k weekly
  downloads.** The npm API does not expose it, and `node-ical` alone pulls
  262k/week, so organic adoption could be much smaller than the headline.
- **Whether `rrule.net` sells a paid tier.** The site returned HTTP 403.
  Commercial intent is established by the org bio and the CLI/n8n packages; a
  paid product is not confirmed.
- **`vanilla-calendar-pro` and `cally` were measured, not used.** Byte counts,
  dependency graphs and bare-specifier checks are real; neither was built into a
  working picker, so ergonomics are unassessed.
- **Section 7's claims about `pg_net` defaults and Supabase Edge Function limits**
  come from Supabase's documentation, not from instrumenting our own project. The
  five gaps in `claim_agent_tasks` were read directly from
  `supabase/migrations/20260806000030_calendar_engine.sql` and are not in doubt.

One premise in the brief was checked and found false, one was found false in our
favour, and one of my own early findings was wrong and is corrected in place:

- `@event-calendar/core` is **not** runtime-free. It has always required Svelte.
- Calendar scopes are **not** restricted scopes, so CASA never applies. The real
  hurdle is sensitive-scope verification, and publishing unverified skips it.
- My first TZID measurement read as "rrule adds the host offset to every
  occurrence". It does not; rrule returns correct instants under a documented
  reinterpretation convention. The corrected finding is a footgun, not a
  miscomputation, and section 1 says so.
