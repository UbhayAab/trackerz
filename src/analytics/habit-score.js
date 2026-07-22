// There were two rival computeHabitScore implementations. This module held a
// second one that scored a bag of pre-normalised 0-100 metrics against
// src/domain/wellness/habit-weights.js - different components and different
// weights from the scorer weekly reviews and Jarvis actually read, so the same
// week could score two different numbers depending on which module a surface
// imported. It also weighted a `hydration` habit that no caller ever supplied
// and no scorer computed, which quietly rescaled everything else.
//
// The domain scorer (raw rows in, {score, components} out, weights summing to
// 100) is now the only one. This file stays as the src/analytics/ entry point
// so existing importers keep working.

export { computeHabitScore } from "../domain/wellness/habit-score.js";
