// Put back the notes that an ai_action says it wrote and that are not there.
//
// WHAT HAPPENED, established from evidence rather than guessed:
//
// Two `create_note_candidate` actions from the 2026-08-02 12:00 Domino's capture
// (ingestion 06d9bc20) are `auto_applied` and still carry
// `applied_record_table='notes'` with the ids f45076ad… and fac6ab97…. Neither
// row exists. Neither has an `audit_log` entry. They were, at the time of the
// audit, the ONLY rows in this database that an action claims to have written
// and that vanished with no record at all.
//
// HOW THEY VANISHED. The additions feed's ✕ calls `deleteRow()` in
// src/services/supabase-data.js. Soft delete landed in commit 6236125 on
// 2026-08-06 09:43 IST; before it, that function was one line:
//
//     await supabase.from(table).delete().eq("id", id).eq("user_id", userId);
//
// A hard DELETE, no tombstone, no before-image, no audit row - and `notes` is in
// DELETABLE_TABLES. Anything removed from the feed between 2026-08-02 and
// 2026-08-06 left exactly the trace these two left: none.
//
// `scripts/capture.mjs --undo` is RULED OUT as the cause: it also deletes the
// ai_actions, ai_runs and raw_ingestions rows for the ingestion, and all three
// still exist for 06d9bc20. So does `deleteAllUserData`, which would have taken
// the whole account.
//
// THE HOLE IS ALREADY CLOSED for the app path - `deleteRow` now writes
// `deleted_at` and every read filters it - but see the report for the two hard
// deletes that remain in the tree.
//
// WHAT THIS SCRIPT DOES. Rebuilds each missing row from the tool arguments the
// action recorded, at its ORIGINAL id and timestamps, and writes the audit entry
// that should have existed. It is generic: it restores every orphan it finds,
// not a hardcoded pair, so it stays useful if another one ever appears.
//
// Usage: node scripts/restore-orphan-notes-2026-08-08.mjs [--apply]
//        (defaults to a dry run that writes nothing)
import { config as loadEnv } from "dotenv";
import { connectDb } from "./db-connect.mjs";

loadEnv({ path: ".env.local" });
const APPLY = process.argv.includes("--apply");

const NOTE_KINDS = new Set(["note", "aspiration", "todo", "idea"]);
const NOTE_DOMAINS = new Set(["money", "diet", "gym", "wellness", "general"]);
const NOTE_STATUSES = new Set(["open", "done", "archived"]);

// The check constraints on `notes` are a closed set. An argument outside it must
// fall back to the column default rather than fail the insert - the body is the
// thing being rescued, and losing it a second time over a bad enum would be
// absurd.
function pick(value, allowed, fallback) {
  const v = String(value ?? "").trim();
  return allowed.has(v) ? v : fallback;
}

const db = await connectDb();

try {
  // A MISSING ROW IS NOT AUTOMATICALLY A LOST ROW. Eight note rows named by an
  // ai_action are gone; six of them were removed on purpose by
  // scripts/repair-notes-2026-07-31.mjs (five that restated a domain row from
  // the same capture, one converted into the workout row it should have been)
  // and every one of those has an audit_log entry with its full before-image.
  // Restoring them would undo an approved repair and put the misfiled "no gym
  // today" notes back into the AI's memory context, where they contradict days
  // he actually trained. That is the whole reason they were removed.
  //
  // So the discriminator is the audit trail, not the absence: a removal that was
  // RECORDED is a decision; a removal with no record is the hole. The audit row
  // may name the note either as its target (a delete) or inside its before-image
  // (the convert-to-workout case wrote target_table='workout_logs'), so both are
  // checked - keying on target_id alone would have wrongly "rescued" one.
  const { rows: orphans } = await db.query(`
    select a.id            as action_id,
           a.user_id,
           a.ingestion_id,
           a.arguments,
           a.applied_record_id as note_id,
           a.applied_at,
           a.created_at
      from ai_actions a
      left join notes n on n.id = a.applied_record_id
     where a.applied_record_table = 'notes'
       and a.applied_record_id is not null
       and n.id is null
       and not exists (
         select 1 from audit_log l
          where l.target_id = a.applied_record_id
             or l.before->>'id' = a.applied_record_id::text
       )
     order by a.created_at`);

  console.log(APPLY ? "APPLYING\n" : "DRY RUN - nothing will be written (pass --apply)\n");

  if (!orphans.length) {
    console.log("no orphaned notes: every ai_action that claims a notes row has one");
  }

  let restored = 0;
  for (const o of orphans) {
    const args = o.arguments || {};
    const body = String(args.body ?? "").trim();
    if (!body) {
      // Nothing to restore is NOT the same as nothing missing. Say which.
      console.log(`  SKIP  ${o.note_id} - the action recorded no body, so there is nothing to put back`);
      continue;
    }
    const row = {
      id: o.note_id,
      user_id: o.user_id,
      ingestion_id: o.ingestion_id,
      kind: pick(args.kind, NOTE_KINDS, "note"),
      body,
      domain: pick(args.domain, NOTE_DOMAINS, "general"),
      status: pick(args.status, NOTE_STATUSES, "open"),
      due_on: args.due_on || null,
      // The applier stamped both from the same clock. `applied_at` is that
      // clock; it is what the row actually had, so it is what goes back.
      occurred_at: o.applied_at || o.created_at,
      created_at: o.applied_at || o.created_at,
    };

    console.log(`  RESTORE ${row.id}  ${row.kind}/${row.domain}  ${new Date(row.created_at).toISOString()}`);
    console.log(`          "${body.replace(/\s+/g, " ").slice(0, 78)}${body.length > 78 ? "…" : ""}"`);
    console.log(`          ${body.length} chars, from ai_action ${o.action_id.slice(0, 8)}`);

    if (APPLY) {
      // ON CONFLICT DO NOTHING, not an upsert: if the row came back by some
      // other route between the query and here, the live row wins. A restore
      // must never overwrite something that exists.
      const ins = await db.query(
        `insert into notes (id, user_id, ingestion_id, kind, body, domain, status, due_on, occurred_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do nothing
         returning id`,
        [row.id, row.user_id, row.ingestion_id, row.kind, row.body, row.domain,
          row.status, row.due_on, row.occurred_at, row.created_at],
      );
      if (!ins.rowCount) {
        console.log("          already present - left alone");
        continue;
      }
      await db.query(
        `insert into audit_log (user_id, action, target_table, target_id, before, after, source)
         values ($1, 'note.restore_orphan', 'notes', $2, $3, $4, $5)`,
        [
          row.user_id,
          row.id,
          // `before` is the state being corrected: the row was gone, and the
          // only reason we know it existed is the action pointing at it.
          JSON.stringify({
            state: "missing",
            evidence: "ai_actions.applied_record_id pointed at a notes row that did not exist",
            action_id: o.action_id,
            ingestion_id: o.ingestion_id,
            no_prior_audit_entry: true,
            probable_cause:
              "deleteRow() in src/services/supabase-data.js was a hard DELETE with no audit write "
              + "until soft delete landed in commit 6236125 on 2026-08-06; this row was removed before that",
          }),
          JSON.stringify(row),
          "scripts/restore-orphan-notes-2026-08-08.mjs",
        ],
      );
    }
    restored += 1;
  }

  const { rows: left } = await db.query("select count(*)::int n from notes where deleted_at is null");
  console.log(`\n${APPLY ? "restored" : "would restore"}: ${restored}`);
  console.log(`notes now: ${left[0].n}${APPLY ? "" : " (unchanged - dry run)"}`);
} finally {
  await db.end();
}
