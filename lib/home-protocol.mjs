// Home Protocol - the 6-day rotation Ubhay actually trains now, at home, with a
// hard 25 kg dumbbell ceiling. Pure data + tiny derivations. No DOM, no Supabase.
//
// It replaces the old gym scaffold (Workout A / Workout B / "forgiven cardio"),
// which described a commercial gym floor - treadmill, leg press, lat pulldown,
// cable row - none of which exists in the room the training now happens in. A
// plan that prescribes a machine you do not own is a plan you log zero sets
// against, which is exactly what the workout panel's own header comment records.
//
// Two ideas carry the whole program and both are encoded here rather than left
// in prose:
//
//   ZONES. Every muscle is touched 4-6 times a week but each movement pattern
//   gets exactly ONE heavy exposure. `zone` is that dial: heavy / med / pump /
//   core. It sets the rest gap, the reps-in-reserve, and how hard you are meant
//   to push. Daily training survives because of the zone spread, not because
//   the exercise names rotate.
//
//   THE CEILING. 25 kg per dumbbell is a wall, not a target. Once a lift is at
//   the wall, more weight is not available, so progression moves to tempo,
//   pauses, unilateral work and leverage - PROGRESSION_LADDER, in order. The UI
//   reads LOAD_CEILING_KG to say so at the moment the number is entered rather
//   than leaving the user to nudge a stepper that has nowhere left to go.

export const LOAD_CEILING_KG = 25;

// Rest between sets, by zone. Heavy work needs the full gap or it stops being
// heavy; pump work is supposed to stay short.
export const REST_BY_ZONE = Object.freeze({ heavy: 150, med: 90, pump: 55, core: 45 });

export const ZONE_LABEL = Object.freeze({ heavy: "Heavy", med: "Medium", pump: "Pump", core: "Core" });

// What to do INSTEAD of adding weight, once a lift sits at the ceiling. Indexed
// off the exercise position so two maxed lifts in one session do not both get
// told to slow the eccentric.
export const CEILING_TACTICS = Object.freeze([
  "3s eccentric",
  "add a 2s pause",
  "1.5 reps",
  "myo-reps",
  "go unilateral",
  "cut rest by 15s",
]);

// Double progression first; this ladder is what you climb when the dumbbells
// run out. Each rung is a real increase in stimulus at the same 25 kg.
export const PROGRESSION_LADDER = Object.freeze([
  "Add reps within the prescribed range.",
  "Add a set (cap: 5 working sets per exercise).",
  "Slow the eccentric to 3-4 seconds.",
  "Add a 1-2 second pause at the hardest position.",
  "Cut rest by 15 seconds.",
  "1.5 reps - full rep, then half rep, count as one.",
  "Myo-reps: one hard set, rest 15s, do 3-5 more, repeat x4.",
  "Go unilateral - one arm or one leg carries the same load.",
  "Extend the range - deficit push-ups, deep split squats, elevated heels.",
  "Change leverage - decline to archer to pseudo-planche; pull-ups to archer to weighted.",
]);

// The reasoning that has to survive a bad week, kept as data so the page renders
// it rather than a second copy living in a template.
export const SYSTEM_NOTES = Object.freeze([
  {
    title: "Why it is built this way",
    body: [
      "Every muscle gets touched 4-6 times a week, but only ONE heavy exposure per movement pattern. The rest is medium and pump work. That is what makes daily training survivable, not the fact that the exercise names change.",
      "Rotating exercises buys joint variety, skill spread and boredom insurance. It does not buy recovery. Your pecs do not know whether you pressed flat or incline; they only know how much hard work landed on them.",
    ],
  },
  {
    title: "Legs are the real constraint",
    body: [
      "50 kg total is heavy for pressing and light for squatting. Legs outgrow the dumbbells almost immediately, so leg work here is built on single-leg positions, slow tempo, pauses and higher reps rather than load.",
      "Bulgarian split squats, single-leg RDLs and step-ups are the heavy leg work for the foreseeable future. Done properly they are brutal, so that is not a compromise.",
    ],
  },
  {
    title: "Running it on a deficit",
    body: [
      "Eating under maintenance makes recovery the scarce resource, not effort. Keep the heavy sets to 1-2 reps in reserve and never grind to failure on the compounds; take failure only on pump work, where the joints are not loaded.",
      "Every fourth week, cut all working sets by roughly a third and keep the loads the same. You come back stronger, not detrained.",
      "If sleep was short or the day was brutal, run the session at medium intensity instead of skipping. A 60% session beats a missed one, which is the whole reason training moved home.",
    ],
  },
  {
    title: "Session mechanics",
    body: [
      "Rest: heavy 150s, medium 90s, pump 45-60s, core 45s.",
      "Warm-up, 6 minutes: 30 band pull-aparts, 20 bodyweight squats, 10 push-ups, 10 arm circles each way, then two ramp-up sets on the first exercise.",
      "Days A-E run 50-60 minutes, day F runs 35. Short on time: cut from the bottom of the list, never the top.",
      "Order is not decorative. The first two exercises drive the adaptation; everything below is accessory.",
    ],
  },
]);

// Movements worth having in reserve - mostly ways to make 25 kg feel heavier.
// Not prescribed; the swap list for a joint that is complaining or a day that
// has gone stale.
export const MOVEMENT_BANK = Object.freeze([
  "DB Floor Press", "Deficit Push-ups", "Archer Push-ups", "Pseudo-Planche Push-ups",
  "DB Squeeze Press", "Z-Press", "Half-Kneeling Single-Arm Press", "Leaning Lateral Raise",
  "JM Press", "Seal Row", "Inverted Row", "Dead-Stop Row", "Scapular Pull-ups",
  "Archer Pull-ups", "Towel Pull-ups", "Spider Curl", "Drag Curl",
  "Preacher Curl on Incline Bench", "Heel-Elevated Goblet Squat", "B-Stance RDL",
  "Nordic Curl Negatives", "Reverse Nordic", "Cossack Squat", "Sissy Squat",
  "DB Sumo Deadlift", "Copenhagen Plank", "Pallof Press", "Hollow Body Hold",
  "Bird Dog", "Suitcase March", "Farmer's Carry", "DB Thrusters", "DB Clean & Press",
  "Reverse Crunch",
]);

// One exercise row.
//   sets      prescribed working sets (rounds, on the circuit day)
//   reps      the LOW end of the range - what ticking the row logs. The range
//             itself is `repsLabel`; you are meant to climb it before adding load.
//   unit      "reps" | "sec"
//   perSide   the prescription is per leg / per arm
//   zone      heavy | med | pump | core  (drives rest, RIR and the chip colour)
//   load      takes a dumbbell, so the 25 kg ceiling gauge applies
//   muscle    primary group, stated rather than inferred from the name
function ex(name, sets, reps, repsLabel, zone, muscle, cue, opts = {}) {
  return Object.freeze({
    name, sets, reps, repsLabel, zone, muscle, cue,
    unit: opts.unit || "reps",
    perSide: Boolean(opts.perSide),
    load: opts.load !== false,
    loggable: opts.loggable !== false,
  });
}

export const PROTOCOL_DAYS = Object.freeze([
  {
    letter: "A", id: "protocol-a", name: "Day A - Press heavy / Pull heavy",
    focus: "Horizontal push · Vertical pull · Quad accessory",
    kind: "gym", duration_min: 55,
    rules: "One heavy exposure per pattern · 1-2 RIR on the compounds · 25 kg ceiling",
    exercises: [
      ex("Flat DB Bench Press", 4, 6, "6-8", "heavy", "chest", "2 RIR. Elbows ~45 degrees, touch the chest, no bounce."),
      ex("Pull-ups", 4, 5, "5-8", "heavy", "back", "Add a DB between the feet if you clear 8. Band-assist if you cannot hit 5.", { load: false }),
      ex("Bulgarian Split Squat", 3, 10, "10-12", "med", "quads", "Rear foot on the bench. 3s down. Front shin vertical.", { perSide: true }),
      ex("Incline DB Press", 3, 10, "10-12", "med", "chest", "30-45 degree bench. Stop an inch short of lockout, keep tension."),
      ex("One-Arm DB Row", 3, 10, "10-12", "med", "back", "Knee on bench. Pull to the hip, 1s squeeze, 3s down.", { perSide: true }),
      ex("Standing DB Calf Raise", 3, 15, "15-20", "pump", "calves", "2s pause stretched at the bottom. Full extension at the top."),
      ex("Hanging Knee Raise", 3, 12, "12-15", "core", "core", "Curl the pelvis up. No swinging, control the drop.", { load: false }),
      ex("Band Pull-Aparts", 2, 25, "25", "pump", "shoulders", "Shoulder insurance. Do these every single day.", { load: false }),
    ],
  },
  {
    letter: "B", id: "protocol-b", name: "Day B - Overhead heavy / Row heavy",
    focus: "Vertical push · Horizontal pull · Hinge accessory",
    kind: "gym", duration_min: 55,
    rules: "One heavy exposure per pattern · 1-2 RIR on the compounds · 25 kg ceiling",
    exercises: [
      ex("Seated DB Shoulder Press", 4, 6, "6-8", "heavy", "shoulders", "Back supported. Ribs down, do not arch to cheat the press."),
      ex("Two-Arm Bent-Over Row", 4, 8, "8-10", "heavy", "back", "Dead-stop each rep on the floor. Torso ~45 degrees, no jerking."),
      ex("DB Romanian Deadlift", 4, 10, "10-12", "med", "hamstrings", "3s eccentric. Push the hips back, feel the hamstring, stop at mid-shin."),
      ex("Deficit Push-ups", 3, 10, "AMRAP-1", "med", "chest", "Hands on the dumbbells for extra depth. Leave one rep in the tank.", { load: false }),
      ex("Seal Row", 3, 12, "12-15", "pump", "back", "Chest down on the flat bench. Zero body english, pure back."),
      ex("Lateral Raises", 3, 15, "15-20", "pump", "shoulders", "Light. Lead with the elbow, stop at shoulder height, 3s down."),
      ex("Plank", 3, 45, "45-60s", "core", "core", "Squeeze the glutes, tuck the pelvis. Hard, not restful.", { unit: "sec", load: false }),
      ex("Dead Bug", 2, 10, "10", "core", "core", "Lower back stays glued to the mat the whole time.", { perSide: true, load: false }),
    ],
  },
  {
    letter: "C", id: "protocol-c", name: "Day C - Quad heavy / Incline and arms",
    focus: "Squat pattern · Upper chest · Direct arms",
    kind: "gym", duration_min: 55,
    rules: "One heavy exposure per pattern · 1-2 RIR on the compounds · 25 kg ceiling",
    exercises: [
      ex("Heel-Elevated Goblet Squat", 4, 12, "12-15", "heavy", "quads", "Heels on plates or a book. 3s down, 1s pause in the hole."),
      ex("Incline DB Press", 4, 8, "8-10", "heavy", "chest", "Heavier than day A's incline. 2 RIR."),
      ex("Chin-ups", 4, 6, "6-10", "med", "back", "Supinated grip. Chest to the bar, 3s negative.", { load: false }),
      ex("Reverse Lunges", 3, 12, "12", "med", "quads", "Step back, drop the knee softly, drive through the front heel.", { perSide: true }),
      ex("Incline DB Fly", 3, 12, "12-15", "pump", "chest", "Soft elbows, wide arc, stretch at the bottom. Light weight."),
      ex("Hammer Curl", 3, 10, "10-12", "med", "biceps", "No swing. Brachialis work, which is what builds arm thickness."),
      ex("Overhead DB Extension", 3, 10, "10-12", "med", "triceps", "Both hands, one bell. Deep stretch behind the head."),
      ex("Russian Twists", 3, 20, "20 total", "core", "core", "Feet off the floor, rotate through the ribcage not the arms."),
    ],
  },
  {
    letter: "D", id: "protocol-d", name: "Day D - Hinge heavy / Bodyweight",
    focus: "Posterior chain · Vertical pull · Bodyweight push",
    kind: "gym", duration_min: 55,
    rules: "One heavy exposure per pattern · 1-2 RIR on the compounds · 25 kg ceiling",
    exercises: [
      ex("Single-Leg RDL", 4, 10, "10-12", "heavy", "hamstrings", "DB in the opposite hand. Hips square, slow. Balance is part of the lift.", { perSide: true }),
      ex("Neutral-Grip Pull-ups", 4, 6, "6-10", "med", "back", "Easiest on the elbows. Full hang each rep.", { load: false }),
      ex("Decline Push-ups", 4, 12, "AMRAP-1", "med", "chest", "Feet on the bench. Wear a loaded backpack once you clear 20.", { load: false }),
      ex("DB Hip Thrust", 3, 12, "12-15", "med", "glutes", "Shoulders on the bench, DB across the hips, 2s squeeze at the top."),
      ex("Arnold Press", 3, 10, "10-12", "med", "shoulders", "Rotate through the full range. Lighter than day B, this is a control lift."),
      ex("Bent-Over Reverse Flyes", 3, 15, "15-20", "pump", "shoulders", "Chest on the incline bench. Tiny weights, huge squeeze."),
      ex("Single-Leg Calf Raise", 3, 12, "12-15", "pump", "calves", "Off a step or a book. Full stretch, full contraction.", { perSide: true }),
      ex("Side Plank", 3, 30, "30-45s", "core", "core", "Stack the hips, drive the bottom hip toward the ceiling.", { unit: "sec", perSide: true, load: false }),
    ],
  },
  {
    letter: "E", id: "protocol-e", name: "Day E - Arms and delts / Glute-ham",
    focus: "Isolation volume · Unilateral · Metabolic",
    kind: "gym", duration_min: 50,
    rules: "No heavy compound today · take the pump work to failure · 25 kg ceiling",
    exercises: [
      ex("DB Floor Press", 4, 10, "10-12", "med", "chest", "Pause where the triceps touch the floor. Shoulder-friendly pressing."),
      ex("Renegade Row", 3, 8, "8-10", "med", "back", "Wide feet. Do not let the hips rotate - that is the whole exercise.", { perSide: true }),
      ex("DB Step-Ups", 3, 12, "12", "med", "quads", "Onto the bench. Drive through the heel, lower under control.", { perSide: true }),
      ex("Leaning Lateral Raise", 3, 12, "12-15", "pump", "shoulders", "Hold the pull-up bar upright and lean away. Loads the delt at the bottom.", { perSide: true }),
      ex("Incline DB Curl", 3, 10, "10-12", "med", "biceps", "Bench at 45 degrees, arms hanging behind. The longest stretch you can get on a bicep."),
      ex("Skull Crushers", 3, 10, "10-12", "med", "triceps", "Lower to the forehead or just behind. Elbows still."),
      ex("Band Face Pulls", 3, 20, "20", "pump", "shoulders", "Pull to the eyes, externally rotate at the end. Fixes desk posture.", { load: false }),
      ex("Leg Raises", 3, 15, "15", "core", "core", "On the mat or hanging. Lower slowly, do not drop.", { load: false }),
    ],
  },
  {
    letter: "F", id: "protocol-f", name: "Day F - Circuit day",
    focus: "4 rounds · 60s between rounds · lighter loads",
    kind: "circuit", duration_min: 35,
    rules: "4 rounds, 60s between rounds. Lighter loads, no grinding - this is the short day",
    exercises: [
      ex("DB Thrusters", 4, 12, "12", "med", "quads", "Squat into an overhead press, one movement. Sets the tone."),
      ex("Inverted Row", 4, 15, "15", "med", "back", "Under the bar or bench, heels on the floor. Band rows if awkward.", { load: false }),
      ex("Goblet Squat", 4, 15, "15", "med", "quads", "Moderate weight, smooth pace, full depth."),
      ex("Push-ups", 4, 12, "AMRAP-3", "pump", "chest", "Stop three short of failure every round.", { load: false }),
      ex("DB Good Mornings", 4, 15, "15", "pump", "hamstrings", "Bell on the upper back. Light - this is a hamstring pump, not a max."),
      ex("Suitcase March", 4, 40, "40s", "core", "core", "One heavy DB, walk or march in place. Anti-lateral core, loaded.", { unit: "sec" }),
      ex("Hollow Body Hold", 4, 30, "30s", "core", "core", "Lower back pressed flat. Bend the knees to regress.", { unit: "sec", load: false }),
      ex("Zottman Curl", 2, 15, "15", "pump", "biceps", "Finisher. Curl up supinated, rotate, lower pronated."),
    ],
  },
  {
    letter: "R", id: "protocol-r", name: "Day R - Rest day",
    focus: "Recovery is a training variable",
    kind: "rest", duration_min: 0, rest: true,
    rules: "30-45 minutes of walking, 10 minutes of mobility. Nothing that needs recovering from",
    exercises: [
      ex("Walk 30-45 minutes", 0, 0, "", "core", "cardio", "Easy pace. This is the walk, not a session.", { load: false, loggable: false }),
      ex("Mobility 10 minutes", 0, 0, "", "core", "other", "Hips, thoracic spine, shoulders.", { load: false, loggable: false }),
      ex("Eat and sleep", 0, 0, "", "core", "other", "Six hard days only turn into muscle here.", { load: false, loggable: false }),
    ],
  },
]);

export const PROTOCOL_LETTERS = Object.freeze(PROTOCOL_DAYS.map((d) => d.letter));

export function protocolDay(letter) {
  return PROTOCOL_DAYS.find((d) => d.letter === String(letter || "").toUpperCase()) || null;
}

// The rotation runs Monday to Sunday: A-F are the six training days, R is Sunday.
// One calendar day resolves to exactly one rotation day, which is what keeps the
// morning brief, the diet page and the gym panel from disagreeing about what
// today is. Training a different letter today is a per-day choice made in the UI,
// not a drifting counter.
export const PROTOCOL_BY_WEEKDAY = Object.freeze({ 1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F", 7: "R" });

// Free-text line for one exercise, e.g. "Bulgarian Split Squat 3x10-12 /leg".
// The legacy `items` contract (plain strings) is still what the plan-merge
// payloads, the morning brief and the diet page's workout list consume.
export function exerciseLine(e) {
  if (!e.sets || !e.repsLabel) return e.name;
  return `${e.name} ${e.sets}x${e.repsLabel}${e.perSide ? " /side" : ""}`;
}

// The protocol as the WORKOUTS map the plan resolver already expects: `items`
// derived from the structured exercises, so nothing downstream has to know the
// richer shape exists, while `exercises` is there for anything that does.
export function protocolWorkouts() {
  const out = {};
  for (const day of PROTOCOL_DAYS) {
    out[day.letter] = Object.freeze({
      id: day.id,
      name: day.name,
      letter: day.letter,
      kind: day.kind,
      duration_min: day.duration_min,
      focus: day.focus,
      rest: Boolean(day.rest),
      items: day.exercises.map(exerciseLine),
      exercises: day.exercises,
      rules: day.rules,
    });
  }
  return Object.freeze(out);
}
