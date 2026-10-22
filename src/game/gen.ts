import { MONSTER_SPECS, THEME_TABLE } from "@/game/data";
import type { EncounterTheme } from "@/game/types";
import { clamp, createInstance, roll } from "@/game/rules";

export function choose<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateEncounter(theme: EncounterTheme, partyLevel: number) {
  const table = THEME_TABLE[theme];
  const rare = roll(0.08);
  const elite = roll(0.12);
  const levelBase = clamp(partyLevel + (elite ? 2 : 0) + (rare ? 3 : 0) + (Math.random() < 0.5 ? 0 : 1), 1, 30);
  const specId = choose(table);
  const inst = createInstance(specId, levelBase);
  const spec = MONSTER_SPECS[specId];
  return { enemy: inst, label: `${rare ? "稀有" : elite ? "精英" : "野生"} ${spec.name}` };
}
