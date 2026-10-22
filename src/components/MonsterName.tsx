import { MonsterInstance } from "@/game/types";
import { MONSTER_SPECS } from "@/game/data";

export function MonsterName({ m, className = "" }: { m: MonsterInstance, className?: string }) {
  const name = m.nickname || MONSTER_SPECS[m.specId].name;
  if (m.isShiny) {
    return (
      <span className={`font-bold animate-pulse bg-clip-text text-transparent bg-gradient-to-r from-red-500 via-yellow-500 via-green-500 to-blue-500 ${className}`}>
        {name} ✦
      </span>
    );
  }
  return <span className={className}>{name}</span>;
}
