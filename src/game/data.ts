import type { Element, ItemId, ItemSpec, MonsterSpec, MoveId, MoveSpec, LocationId, LocationSpec } from "@/game/types";

export const ELEMENT_LABEL: Record<Element, string> = {
  normal: "一般",
  fire: "火",
  water: "水",
  grass: "草",
  electric: "电",
  ice: "冰",
  fighting: "格斗",
  poison: "毒",
  ground: "地面",
  flying: "飞行",
  psychic: "超能",
  bug: "虫",
  rock: "岩石",
  ghost: "幽灵",
  dragon: "龙",
  dark: "恶",
  steel: "钢",
  fairy: "妖精"
};

export const ELEMENT_COLORS: Record<Element, string> = {
  normal: "text-stone-400",
  fire: "text-red-500",
  water: "text-blue-500",
  grass: "text-emerald-500",
  electric: "text-yellow-400",
  ice: "text-cyan-300",
  fighting: "text-orange-600",
  poison: "text-purple-500",
  ground: "text-amber-600",
  flying: "text-indigo-300",
  psychic: "text-pink-500",
  bug: "text-lime-500",
  rock: "text-yellow-700",
  ghost: "text-indigo-600",
  dragon: "text-indigo-500",
  dark: "text-slate-600",
  steel: "text-slate-400",
  fairy: "text-pink-300"
};

export const MOVE_SPECS: Record<MoveId, MoveSpec> = {
  // ================= 普通 (Normal) =================
  tackle: { id: "tackle", name: "冲撞", element: "normal", category: "physical", power: 40, accuracy: 1, target: "enemy", desc: "用尽全身力气撞向敌人。" },
  scratch: { id: "scratch", name: "爪击", element: "normal", category: "physical", power: 40, accuracy: 1, target: "enemy", desc: "用尖锐的爪子抓挠敌人。" },
  growl: { id: "growl", name: "叫声", element: "normal", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: -1, chance: 1, target: "enemy" }], desc: "发出可爱的叫声疏忽敌人的防备，必定降低敌方攻击力。" },
  body_slam: { id: "body_slam", name: "泰山压顶", element: "normal", category: "physical", power: 85, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "用整个身体压倒敌人。有概率使敌人麻痹。" },
  hyper_beam: { id: "hyper_beam", name: "毁灭光束", element: "normal", category: "special", power: 150, accuracy: 0.9, target: "enemy", desc: "发射充满毁灭能量的光束。威力极大。" },
  quick_attack: { id: "quick_attack", name: "电光一闪", element: "normal", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "以肉眼无法捕捉的速度撞击敌人。必定先手出击。" },
  slash: { id: "slash", name: "劈开", element: "normal", category: "physical", power: 70, accuracy: 1, target: "enemy", critChance: 0.125, desc: "用锋利的爪子劈开敌人。容易击中要害。" },
  tail_whip: { id: "tail_whip", name: "摇尾巴", element: "normal", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 1, target: "enemy" }], desc: "可爱的摇尾巴让敌人疏忽大意，必定降低敌方物防。" },
  fury_swipes: { id: "fury_swipes", name: "乱抓", element: "normal", category: "physical", power: 18, accuracy: 0.8, target: "enemy", multiHit: [2, 5], desc: "用爪子疯狂抓挠敌人，连续攻击2~5次。" },
  double_edge: { id: "double_edge", name: "舍身冲撞", element: "normal", category: "physical", power: 120, accuracy: 1, target: "enemy", recoilPct: 0.33, desc: "拼命的猛撞。自身也会受到所造成伤害约1/3的反作用力伤害。" },
  swords_dance: { id: "swords_dance", name: "剑舞", element: "normal", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "atk", stages: 2, chance: 1, target: "self" }], desc: "跳起激昂的战舞，必定大幅提升自身的物攻。" },
  recover: { id: "recover", name: "自我再生", element: "normal", category: "status", power: 0, accuracy: 1, target: "self", healPct: 0.5, desc: "让细胞再生，恢复自身最大HP的一半。" },
  headbutt: { id: "headbutt", name: "头槌", element: "normal", category: "physical", power: 70, accuracy: 1, target: "enemy", flinchChance: 0.3, desc: "用头猛烈撞击敌人。有概率使敌人畏缩。" },
  facade: { id: "facade", name: "硬撑", element: "normal", category: "physical", power: 70, accuracy: 1, target: "enemy", desc: "在异常状态（烧伤/中毒/麻痹）下，威力会翻倍。" },
  smokescreen: { id: "smokescreen", name: "烟幕", element: "normal", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "accuracy", stages: -1, chance: 1, target: "enemy" }], desc: "喷出浓烟，必定降低敌方命中率。" },
  leer: { id: "leer", name: "瞪眼", element: "normal", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 1, target: "enemy" }], desc: "用锐利的眼神震慑敌人，必定降低敌方物防。" },
  hyper_voice: { id: "hyper_voice", name: "巨声", element: "normal", category: "special", power: 90, accuracy: 1, target: "all", desc: "发出震耳欲聋的吼声，攻击场上所有敌人。" },

  // ================= 火 (Fire) =================
  ember: { id: "ember", name: "星火燎原", element: "fire", category: "special", power: 40, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, desc: "星星之火可以燎原，燃之不尽。小概率使敌人灼伤。" },
  fire_punch: { id: "fire_punch", name: "炎阳重拳", element: "fire", category: "physical", power: 75, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, desc: "附带高温火焰的重拳。小概率使敌人灼伤。" },
  flamethrower: { id: "flamethrower", name: "龙息赤焰", element: "fire", category: "special", power: 90, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, desc: "喷射出猛烈的火焰灼烧敌人。小概率使敌人灼伤。" },
  fire_spin: { id: "fire_spin", name: "烈焰风暴", element: "fire", category: "special", power: 35, accuracy: 0.85, target: "enemy", desc: "将敌人困在狂暴的火焰旋涡中，持续造成伤害。" },
  fire_blast: { id: "fire_blast", name: "大字爆炎", element: "fire", category: "special", power: 110, accuracy: 0.85, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, desc: "喷出大字型的烈焰。威力极高，小概率使敌人灼伤。" },
  flare_blitz: { id: "flare_blitz", name: "闪焰冲锋", element: "fire", category: "physical", power: 120, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, recoilPct: 0.33, desc: "全身裹着火焰猛撞。自身受到反伤，小概率使敌人灼伤。" },
  will_o_wisp: { id: "will_o_wisp", name: "鬼火", element: "fire", category: "status", power: 0, accuracy: 0.85, target: "enemy", status: { type: "burn", chance: 1, target: "enemy" }, desc: "放出诡异的火焰，大概率使敌人陷入灼伤状态。" },
  flame_wheel: { id: "flame_wheel", name: "火焰轮", element: "fire", category: "physical", power: 60, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, desc: "全身缠绕火焰滚向敌人。小概率使敌人灼伤。" },
  heat_wave: { id: "heat_wave", name: "热风", element: "fire", category: "special", power: 95, accuracy: 0.9, target: "all", status: { type: "burn", chance: 0.1, target: "enemy" }, desc: "吹出炎热的气息攻击全体敌人。小概率使敌人灼伤。" },
  overheat: { id: "overheat", name: "过热", element: "fire", category: "special", power: 130, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "spAtk", stages: -2, chance: 1, target: "self" }], desc: "使出全力喷射火焰。威力极大，但使用后自身特攻大幅下降。" },
  mystical_fire: { id: "mystical_fire", name: "魔法火焰", element: "fire", category: "special", power: 75, accuracy: 1, target: "enemy", statChanges: [{ stat: "spAtk", stages: -1, chance: 1, target: "enemy" }], desc: "喷出特殊的火焰，必定降低敌方特攻。" },
  flame_charge: { id: "flame_charge", name: "蓄能焰袭", element: "fire", category: "physical", power: 50, accuracy: 1, target: "enemy", statChanges: [{ stat: "spd", stages: 1, chance: 1, target: "self" }], desc: "用火焰包裹身体攻击。必定提升自身速度。" },
  inferno: { id: "inferno", name: "炼狱", element: "fire", category: "special", power: 100, accuracy: 0.5, target: "enemy", status: { type: "burn", chance: 1, target: "enemy" }, desc: "将敌人拖入烈火地狱。命中率很低，但命中后必定使敌人灼伤。" },
  lava_plume: { id: "lava_plume", name: "喷烟", element: "fire", category: "special", power: 80, accuracy: 1, target: "all", status: { type: "burn", chance: 0.3, target: "enemy" }, desc: "喷出灼热的烟雾攻击周围所有目标。有概率使其灼伤。" },
  fire_fang: { id: "fire_fang", name: "火焰牙", element: "fire", category: "physical", power: 65, accuracy: 0.95, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, flinchChance: 0.1, desc: "带有火焰的啃咬。小概率使敌人灼伤或畏缩。" },
  sacred_fire: { id: "sacred_fire", name: "神圣之火", element: "fire", category: "physical", power: 100, accuracy: 0.95, target: "enemy", status: { type: "burn", chance: 0.5, target: "enemy" }, desc: "传说中神圣的火焰。大概率使敌人灼伤。" },
  blaze_kick: { id: "blaze_kick", name: "火焰踢", element: "fire", category: "physical", power: 85, accuracy: 0.9, target: "enemy", status: { type: "burn", chance: 0.1, target: "enemy" }, critChance: 0.125, desc: "带有高热的踢击。容易击中要害，小概率使敌人灼伤。" },
  eruption: { id: "eruption", name: "喷火", element: "fire", category: "special", power: 150, accuracy: 1, target: "all", desc: "爆发出火山般的能量。自身HP越少，威力越低。" },

  // ================= 水 (Water) =================
  water_gun: { id: "water_gun", name: "水流弹", element: "water", category: "special", power: 40, accuracy: 1, target: "enemy", desc: "喷射出强力的水流攻击敌人。" },
  aqua_jet: { id: "aqua_jet", name: "破浪激流", element: "water", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "裹挟着水流以迅雷不及掩耳之势撞击，必定先手出击。" },
  hydro_pump: { id: "hydro_pump", name: "海神之怒", element: "water", category: "special", power: 110, accuracy: 0.8, target: "enemy", desc: "喷射出高压水柱，威力巨大但命中率稍低。" },
  bubble_beam: { id: "bubble_beam", name: "泡沫射线", element: "water", category: "special", power: 65, accuracy: 1, target: "enemy", statChanges: [{ stat: "spd", stages: -1, chance: 0.1, target: "enemy" }], desc: "发射大量高速气泡。小概率降低敌方速度。" },
  withdraw: { id: "withdraw", name: "甲壳庇护", element: "water", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "def", stages: 1, chance: 1, target: "self" }], desc: "缩入坚硬的甲壳中，提升自身防御力。" },
  waterfall: { id: "waterfall", name: "攀瀑", element: "water", category: "physical", power: 80, accuracy: 1, target: "enemy", flinchChance: 0.2, desc: "以惊人的气势撞向敌人，有概率使敌人畏缩。" },
  surf: { id: "surf", name: "冲浪", element: "water", category: "special", power: 90, accuracy: 1, target: "all", desc: "掀起巨浪攻击场上所有敌人。" },
  scald: { id: "scald", name: "沸水", element: "water", category: "special", power: 80, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.3, target: "enemy" }, desc: "喷射出滚烫的热水。有概率使敌人灼伤。" },
  muddy_water: { id: "muddy_water", name: "浊流", element: "water", category: "special", power: 90, accuracy: 0.85, target: "all", statChanges: [{ stat: "accuracy", stages: -1, chance: 0.3, target: "enemy" }], desc: "用浑浊的泥水攻击敌人，有概率降低其命中率。" },
  aqua_tail: { id: "aqua_tail", name: "水流尾", element: "water", category: "physical", power: 90, accuracy: 0.9, target: "enemy", desc: "挥动如大浪般汹涌的尾巴进行攻击。" },
  liquidation: { id: "liquidation", name: "水流裂破", element: "water", category: "physical", power: 85, accuracy: 1, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 0.2, target: "enemy" }], desc: "用水之力量猛烈撞击。有概率降低敌方物防。" },
  razor_shell: { id: "razor_shell", name: "贝壳刃", element: "water", category: "physical", power: 75, accuracy: 0.95, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 0.5, target: "enemy" }], desc: "用锋利的贝壳斩击。大概率降低敌方物防。" },
  crabhammer: { id: "crabhammer", name: "蟹钳锤", element: "water", category: "physical", power: 100, accuracy: 0.9, target: "enemy", critChance: 0.125, desc: "用巨大的钳子砸向敌人。容易击中要害。" },
  brine: { id: "brine", name: "盐水", element: "water", category: "special", power: 65, accuracy: 1, target: "enemy", desc: "喷射高浓度的盐水。如果敌人HP低于一半，威力翻倍。" },
  octazooka: { id: "octazooka", name: "章鱼桶炮", element: "water", category: "special", power: 65, accuracy: 0.85, target: "enemy", statChanges: [{ stat: "accuracy", stages: -1, chance: 0.5, target: "enemy" }], desc: "喷射出特殊的墨汁弹。大概率降低敌方命中率。" },
  water_spout: { id: "water_spout", name: "喷水", element: "water", category: "special", power: 150, accuracy: 1, target: "all", desc: "喷出极高压的水柱。自身HP越少，威力越低。" },

  // ================= 草 (Grass) =================
  wood_strike: { id: "wood_strike", name: "原木重击", element: "grass", category: "physical", power: 40, accuracy: 1, target: "enemy", desc: "用坚硬的木头重击敌人。" },
  vine_whip: { id: "vine_whip", name: "荆棘之鞭", element: "grass", category: "physical", power: 45, accuracy: 1, target: "enemy", desc: "挥舞长满倒刺的藤蔓抽打敌人。" },
  leaf_storm: { id: "leaf_storm", name: "万叶狂风", element: "grass", category: "special", power: 130, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "spAtk", stages: -2, chance: 1, target: "self" }], desc: "卷起锋利的落叶风暴。使用后自身特攻会大幅下降。" },
  seed_bomb: { id: "seed_bomb", name: "爆裂飞种", element: "grass", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "将坚硬的种子如炮弹般砸向敌人。" },
  leech_seed: { id: "leech_seed", name: "汲血之芽", element: "grass", category: "status", power: 0, accuracy: 0.9, target: "enemy", desc: "在敌人身上种下寄生种子，持续吸取体力。" },
  absorb: { id: "absorb", name: "生命吸取", element: "grass", category: "special", power: 20, accuracy: 1, target: "enemy", healPct: 0.5, desc: "吸取敌人的养分。造成伤害的50%将转化为自身的HP。" },
  mega_drain: { id: "mega_drain", name: "超级吸取", element: "grass", category: "special", power: 40, accuracy: 1, target: "enemy", healPct: 0.5, desc: "强力吸取敌人的养分。造成伤害的一半将转化为自身的HP。" },
  giga_drain: { id: "giga_drain", name: "终极吸取", element: "grass", category: "special", power: 75, accuracy: 1, target: "enemy", healPct: 0.5, desc: "疯狂吸取敌人的养分。造成伤害的一半将转化为自身的HP。" },
  razor_leaf: { id: "razor_leaf", name: "飞叶快刀", element: "grass", category: "physical", power: 55, accuracy: 0.95, target: "enemy", critChance: 0.125, desc: "发射如刀般锋利的叶片。容易击中要害。" },
  energy_ball: { id: "energy_ball", name: "能量球", element: "grass", category: "special", power: 90, accuracy: 1, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "发射凝聚自然力量的光球。小概率降低敌方特防。" },
  leaf_blade: { id: "leaf_blade", name: "叶刃", element: "grass", category: "physical", power: 90, accuracy: 1, target: "enemy", critChance: 0.125, desc: "像剑一样挥舞长叶斩击。容易击中要害。" },
  wood_hammer: { id: "wood_hammer", name: "木槌", element: "grass", category: "physical", power: 120, accuracy: 1, target: "enemy", recoilPct: 0.33, desc: "用坚硬的身躯猛砸敌人。自身也会受到一定反伤。" },
  bullet_seed: { id: "bullet_seed", name: "种子机关枪", element: "grass", category: "physical", power: 25, accuracy: 1, target: "enemy", multiHit: [2, 5], desc: "连续发射种子进行攻击，会击中2~5次。" },
  synthesis: { id: "synthesis", name: "光合作用", element: "grass", category: "status", power: 0, accuracy: 1, target: "self", healPct: 0.5, desc: "沐浴阳光恢复体力。" },
  stun_spore: { id: "stun_spore", name: "麻痹粉", element: "grass", category: "status", power: 0, accuracy: 0.75, target: "enemy", status: { type: "paralyze", chance: 1, target: "enemy" }, desc: "散布能麻痹神经的粉末。大概率使敌人麻痹。" },
  sleep_powder: { id: "sleep_powder", name: "催眠粉", element: "grass", category: "status", power: 0, accuracy: 0.75, target: "enemy", status: { type: "sleep", chance: 1, target: "enemy" }, desc: "散布能引发睡意的粉末。大概率使敌人陷入沉睡。" },
  poison_powder: { id: "poison_powder", name: "毒粉", element: "grass", category: "status", power: 0, accuracy: 0.75, target: "enemy", status: { type: "poison", chance: 1, target: "enemy" }, desc: "散布含有剧毒的粉末。大概率使敌人中毒。" },

  // ================= 电 (Electric) =================
  thunder_shock: { id: "thunder_shock", name: "雷霆震击", element: "electric", category: "special", power: 40, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.1, target: "enemy" }, desc: "释放微弱的电流。小概率使敌人麻痹。" },
  spark: { id: "spark", name: "电光", element: "electric", category: "physical", power: 65, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "包裹着电流撞击敌人。有概率使敌人麻痹。" },
  thunderbolt: { id: "thunderbolt", name: "十万伏特", element: "electric", category: "special", power: 90, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.1, target: "enemy" }, desc: "释放强烈的电流攻击。小概率使敌人麻痹。" },
  thunder: { id: "thunder", name: "打雷", element: "electric", category: "special", power: 110, accuracy: 0.7, target: "enemy", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "召唤狂暴的落雷。威力极大但命中低，有概率使敌人麻痹。" },
  volt_tackle: { id: "volt_tackle", name: "伏特攻击", element: "electric", category: "physical", power: 120, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.1, target: "enemy" }, recoilPct: 0.33, desc: "全身缠绕高压电流猛撞。自身受到反伤，小概率麻痹敌人。" },
  thunder_wave: { id: "thunder_wave", name: "电磁波", element: "electric", category: "status", power: 0, accuracy: 0.9, target: "enemy", status: { type: "paralyze", chance: 1, target: "enemy" }, desc: "放出微弱的电磁波。必定使敌人陷入麻痹状态。" },
  discharge: { id: "discharge", name: "放电", element: "electric", category: "special", power: 80, accuracy: 1, target: "all", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "向四周释放电流攻击。有概率使目标麻痹。" },
  charge_beam: { id: "charge_beam", name: "充电光束", element: "electric", category: "special", power: 50, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "spAtk", stages: 1, chance: 0.7, target: "self" }], desc: "发射电击光束。大概率提升自身的特攻。" },
  wild_charge: { id: "wild_charge", name: "疯狂伏特", element: "electric", category: "physical", power: 90, accuracy: 1, target: "enemy", recoilPct: 0.25, desc: "带电进行猛烈撞击。自身会受到四分之一的反作用力伤害。" },
  thunder_fang: { id: "thunder_fang", name: "雷电牙", element: "electric", category: "physical", power: 65, accuracy: 0.95, target: "enemy", status: { type: "paralyze", chance: 0.1, target: "enemy" }, flinchChance: 0.1, desc: "带有电流的啃咬。小概率使敌人麻痹或畏缩。" },
  zap_cannon: { id: "zap_cannon", name: "电磁炮", element: "electric", category: "special", power: 120, accuracy: 0.5, target: "enemy", status: { type: "paralyze", chance: 1, target: "enemy" }, desc: "发射大威力的电磁炮。命中极低，但打中必定麻痹敌人。" },
  shock_wave: { id: "shock_wave", name: "电击波", element: "electric", category: "special", power: 60, accuracy: 100, target: "enemy", desc: "放出快速的电击波。攻击必定命中。" },
  electro_ball: { id: "electro_ball", name: "电球", element: "electric", category: "special", power: 80, accuracy: 1, target: "enemy", desc: "投掷出电气球。自身速度比对方越快，威力越大。" },
  nuzzle: { id: "nuzzle", name: "蹭蹭脸颊", element: "electric", category: "physical", power: 20, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 1, target: "enemy" }, desc: "用带电的脸颊触碰敌人。必定使敌人麻痹。" },
  parabolic_charge: { id: "parabolic_charge", name: "抛物面充电", element: "electric", category: "special", power: 65, accuracy: 1, target: "all", healPct: 0.5, desc: "造成伤害的同时，将伤害的一半转化为自身的HP。" },
  eerie_impulse: { id: "eerie_impulse", name: "怪异电波", element: "electric", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "spAtk", stages: -2, chance: 1, target: "enemy" }], desc: "放射出怪异的电波。必定大幅降低敌方特攻。" },
  electroweb: { id: "electroweb", name: "电网", element: "electric", category: "special", power: 55, accuracy: 0.95, target: "all", statChanges: [{ stat: "spd", stages: -1, chance: 1, target: "enemy" }], desc: "撒出电网捕捉敌人。必定降低敌方速度。" },
  bolt_strike: { id: "bolt_strike", name: "雷击", element: "electric", category: "physical", power: 130, accuracy: 0.85, target: "enemy", status: { type: "paralyze", chance: 0.2, target: "enemy" }, desc: "释放强烈的雷击。威力极大，有概率使敌人麻痹。" },

    // ================= 岩石 (Rock) =================
  rock_throw: { id: "rock_throw", name: "飞岩术", element: "rock", category: "physical", power: 50, accuracy: 0.9, target: "enemy", desc: "举起沉重的岩石砸向敌人。" },
  rock_slide: { id: "rock_slide", name: "陨石碎击", element: "rock", category: "physical", power: 75, accuracy: 0.9, target: "enemy", flinchChance: 0.3, desc: "召唤巨大的岩石坠落。有概率使敌人畏缩。" },
  stone_edge: { id: "stone_edge", name: "尖石攻击", element: "rock", category: "physical", power: 100, accuracy: 0.8, target: "enemy", critChance: 0.125, desc: "用尖锐的岩石刺穿敌人。容易击中要害。" },
  rock_blast: { id: "rock_blast", name: "岩石爆击", element: "rock", category: "physical", power: 25, accuracy: 0.9, target: "enemy", multiHit: [2, 5], desc: "连续发射坚硬的岩石，会击中2~5次。" },
  rock_tomb: { id: "rock_tomb", name: "碎岩禁锢", element: "rock", category: "physical", power: 60, accuracy: 0.95, target: "enemy", statChanges: [{ stat: "spd", stages: -1, chance: 1, target: "enemy" }], desc: "投掷岩石封锁敌人退路。必定降低敌方速度。" },
  smack_down: { id: "smack_down", name: "坠空击", element: "rock", category: "physical", power: 50, accuracy: 1, target: "enemy", desc: "扔出石头击落飞行的敌人。" },
  power_gem: { id: "power_gem", name: "晶耀射线", element: "rock", category: "special", power: 80, accuracy: 1, target: "enemy", desc: "发射闪耀如宝石般的光芒。" },
  stealth_rock: { id: "stealth_rock", name: "浮空岩阵", element: "rock", category: "status", power: 0, accuracy: 1, target: "all", desc: "在敌人周围悬浮无数岩石。替换上场的敌人会受到伤害。" },
  head_smash: { id: "head_smash", name: "粉碎头槌", element: "rock", category: "physical", power: 150, accuracy: 0.8, target: "enemy", recoilPct: 0.5, desc: "拼命的猛烈头槌。自身受到极大的反作用力伤害。" },
  rock_polish: { id: "rock_polish", name: "石肤淬炼", element: "rock", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "spd", stages: 2, chance: 1, target: "self" }], desc: "打磨身体减少空气阻力。大幅提升自身速度。" },
  sandstorm: { id: "sandstorm", name: "狂沙呼啸", element: "rock", category: "status", power: 0, accuracy: 1, target: "all", desc: "扬起沙暴，每回合对岩石、地面、钢以外的属性造成伤害。" },
  ancient_power: { id: "ancient_power", name: "太古唤醒", element: "rock", category: "special", power: 60, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: 1, chance: 0.1, target: "self" }, { stat: "def", stages: 1, chance: 0.1, target: "self" }, { stat: "spAtk", stages: 1, chance: 0.1, target: "self" }, { stat: "spDef", stages: 1, chance: 0.1, target: "self" }, { stat: "spd", stages: 1, chance: 0.1, target: "self" }], desc: "唤醒太古的力量。小概率提升自身所有能力。" },
  rollout: { id: "rollout", name: "岩石翻滚", element: "rock", category: "physical", power: 30, accuracy: 0.9, target: "enemy", desc: "连续滚动攻击。每次命中威力都会提升。" },
  accelerock: { id: "accelerock", name: "疾风碎岩", element: "rock", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "用坚硬的岩石身躯撞击，必定先手出击。" },
  diamond_storm: { id: "diamond_storm", name: "璀璨风暴", element: "rock", category: "physical", power: 100, accuracy: 0.95, target: "all", statChanges: [{ stat: "def", stages: 2, chance: 0.5, target: "self" }], desc: "掀起钻石般的风暴。大概率大幅提升自身防御。" },
  meteor_beam: { id: "meteor_beam", name: "星辰冲击", element: "rock", category: "special", power: 120, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "spAtk", stages: 1, chance: 1, target: "self" }], desc: "聚集宇宙之力发射光束。使用后必定提升自身特攻。" },
  tar_shot: { id: "tar_shot", name: "黏滞黑泥", element: "rock", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "spd", stages: -1, chance: 1, target: "enemy" }], desc: "投掷黏糊糊的焦油。降低敌方速度，并使其更怕火。" },

    // ================= 地面 (Ground) =================
  mud_slap: { id: "mud_slap", name: "泥沼飞弹", element: "ground", category: "special", power: 20, accuracy: 1, target: "enemy", statChanges: [{ stat: "accuracy", stages: -1, chance: 1, target: "enemy" }], desc: "向敌人脸上投掷泥巴，必定降低其命中率。" },
  earthquake: { id: "earthquake", name: "地动山摇", element: "ground", category: "physical", power: 100, accuracy: 1, target: "all", desc: "引发强烈的地震，对场上所有其他目标造成巨大伤害。" },
  sand_attack: { id: "sand_attack", name: "尘沙蔽目", element: "ground", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "accuracy", stages: -1, chance: 1, target: "enemy" }], desc: "向敌人扬起沙尘，必定降低其命中率。" },
  earth_power: { id: "earth_power", name: "大地之力", element: "ground", category: "special", power: 90, accuracy: 1, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "向敌人释放大地的能量。小概率降低敌方特防。" },
  bulldoze: { id: "bulldoze", name: "撼地践踏", element: "ground", category: "physical", power: 60, accuracy: 1, target: "all", statChanges: [{ stat: "spd", stages: -1, chance: 1, target: "enemy" }], desc: "用力踩踏地面。必定降低敌方速度。" },
  bone_rush: { id: "bone_rush", name: "骨刃回旋", element: "ground", category: "physical", power: 25, accuracy: 0.9, target: "enemy", multiHit: [2, 5], desc: "将坚硬的骨头如回力镖般投掷，会击中2~5次。" },
  dig: { id: "dig", name: "遁地突袭", element: "ground", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "第一回合潜入地下，第二回合攻击敌人。" },
  magnitude: { id: "magnitude", name: "大地脉动", element: "ground", category: "physical", power: 70, accuracy: 1, target: "all", desc: "引发随机震级的地震。威力在10到150之间波动。" },
  spikes: { id: "spikes", name: "地刺陷阱", element: "ground", category: "status", power: 0, accuracy: 1, target: "all", desc: "在对方脚下撒满尖刺。替换上场的敌人会受到伤害。" },
  mud_bomb: { id: "mud_bomb", name: "泥浆爆破", element: "ground", category: "special", power: 65, accuracy: 0.85, target: "enemy", statChanges: [{ stat: "accuracy", stages: -1, chance: 0.3, target: "enemy" }], desc: "发射泥巴块。有概率降低敌方命中率。" },
  high_horsepower: { id: "high_horsepower", name: "蛮牛冲撞", element: "ground", category: "physical", power: 95, accuracy: 0.95, target: "enemy", desc: "使出全身力气猛撞敌人。威力巨大。" },
  sand_tomb: { id: "sand_tomb", name: "流沙深渊", element: "ground", category: "physical", power: 35, accuracy: 0.85, target: "enemy", desc: "将敌人困在流沙中持续造成伤害。" },
  scorching_sands: { id: "scorching_sands", name: "焦渴荒土", element: "ground", category: "special", power: 70, accuracy: 1, target: "enemy", status: { type: "burn", chance: 0.3, target: "enemy" }, desc: "掀起灼热的沙子攻击。有概率使敌人烧伤。" },
  precipice_blades: { id: "precipice_blades", name: "裂地巨刃", element: "ground", category: "physical", power: 120, accuracy: 0.85, target: "all", desc: "召唤大地的利刃刺穿敌人。威力极高。" },
  stomping_tantrum: { id: "stomping_tantrum", name: "狂怒践踏", element: "ground", category: "physical", power: 75, accuracy: 1, target: "enemy", desc: "化悲愤为力量。如果上一回合招式未命中，威力翻倍。" },

    // ================= 钢 (Steel) =================
  metal_claw: { id: "metal_claw", name: "精钢爪", element: "steel", category: "physical", power: 50, accuracy: 0.95, target: "enemy", statChanges: [{ stat: "atk", stages: 1, chance: 0.1, target: "self" }], desc: "用钢铁般坚硬的爪子撕裂敌人。小概率提升自身攻击力。" },
  iron_head: { id: "iron_head", name: "玄铁头槌", element: "steel", category: "physical", power: 80, accuracy: 1, target: "enemy", flinchChance: 0.3, desc: "如钢铁般坚硬的头部猛撞敌人。有概率使敌人畏缩。" },
  flash_cannon: { id: "flash_cannon", name: "耀斑加农", element: "steel", category: "special", power: 80, accuracy: 1, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "聚集光芒发射耀眼的加农炮。小概率降低敌方特防。" },
  iron_defense: { id: "iron_defense", name: "铜墙铁壁", element: "steel", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "def", stages: 2, chance: 1, target: "self" }], desc: "使皮肤变得如钢铁般坚硬，大幅提升自身防御力。" },
  meteor_mash: { id: "meteor_mash", name: "彗星拳", element: "steel", category: "physical", power: 90, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "atk", stages: 1, chance: 0.2, target: "self" }], desc: "如彗星般沉重的一击。有概率提升自身的物攻。" },
  steel_wing: { id: "steel_wing", name: "钢铁之翼", element: "steel", category: "physical", power: 70, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "def", stages: 1, chance: 0.1, target: "self" }], desc: "用坚硬的翅膀敲打敌人。小概率提升自身防御。" },
  iron_tail: { id: "iron_tail", name: "玄铁之尾", element: "steel", category: "physical", power: 100, accuracy: 0.75, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 0.3, target: "enemy" }], desc: "用坚硬的尾巴重击。有概率降低敌方防御。" },
  bullet_punch: { id: "bullet_punch", name: "穿甲疾拳", element: "steel", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "如子弹般迅速的拳击。必定先手出击。" },
  gyro_ball: { id: "gyro_ball", name: "螺旋钢球", element: "steel", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "高速旋转撞击敌人。自身速度比对方越慢，威力越大。" },
  heavy_slam: { id: "heavy_slam", name: "泰坦坠击", element: "steel", category: "physical", power: 100, accuracy: 1, target: "enemy", desc: "用沉重的身体撞击敌人。自身体重比对方越重，威力越大。" },
  smart_strike: { id: "smart_strike", name: "贯甲尖角", element: "steel", category: "physical", power: 70, accuracy: 100, target: "enemy", desc: "用尖锐的角刺向敌人。攻击必定命中。" },
  metal_sound: { id: "metal_sound", name: "刺耳锐鸣", element: "steel", category: "status", power: 0, accuracy: 0.85, target: "enemy", statChanges: [{ stat: "spDef", stages: -2, chance: 1, target: "enemy" }], desc: "发出摩擦金属般的刺耳声音。大幅降低敌方特防。" },
  autotomize: { id: "autotomize", name: "卸甲疾行", element: "steel", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "spd", stages: 2, chance: 1, target: "self" }], desc: "卸下身上的装甲。减轻体重并大幅提升速度。" },
  shift_gear: { id: "shift_gear", name: "机械超载", element: "steel", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "atk", stages: 1, chance: 1, target: "self" }, { stat: "spd", stages: 2, chance: 1, target: "self" }], desc: "转动齿轮提升运转。提升物攻并大幅提升速度。" },
  gear_grind: { id: "gear_grind", name: "飞旋钢刃", element: "steel", category: "physical", power: 50, accuracy: 0.85, target: "enemy", multiHit: [2, 2], desc: "投掷钢铁齿轮进行攻击。必定击中2次。" },
  sunsteel_strike: { id: "sunsteel_strike", name: "日轮陨坠", element: "steel", category: "physical", power: 100, accuracy: 1, target: "enemy", desc: "化为流星猛烈撞击。无视敌方的特性。" },
  behemoth_blade: { id: "behemoth_blade", name: "破城巨剑", element: "steel", category: "physical", power: 100, accuracy: 1, target: "enemy", desc: "用巨大的剑劈开敌人。对极巨化敌人造成巨大伤害。" },

  // ================= 冰 (Ice) =================
  ice_beam: { id: "ice_beam", name: "极寒射线", element: "ice", category: "special", power: 90, accuracy: 1, target: "enemy", status: { type: "freeze", chance: 0.1, target: "enemy" }, desc: "发射极寒的冷气光束。小概率将敌人冰冻。" },
  blizzard: { id: "blizzard", name: "暴风雪", element: "ice", category: "special", power: 110, accuracy: 0.7, target: "all", status: { type: "freeze", chance: 0.1, target: "enemy" }, desc: "召唤猛烈的暴风雪。威力大但命中率低，小概率冰冻敌人。" },
  ice_shard: { id: "ice_shard", name: "冰砾", element: "ice", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "瞬间制作冰块砸向敌人。必定先手出击。" },
  icicle_spear: { id: "icicle_spear", name: "冰柱坠击", element: "ice", category: "physical", power: 25, accuracy: 1, target: "enemy", multiHit: [2, 5], desc: "连续发射锐利的冰柱，会击中2~5次。" },
  aurora_beam: { id: "aurora_beam", name: "极光束", element: "ice", category: "special", power: 65, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: -1, chance: 0.1, target: "enemy" }], desc: "发射如极光般绚丽的光束。小概率降低敌方物攻。" },
  haze: { id: "haze", name: "白雾", element: "ice", category: "status", power: 0, accuracy: 1, target: "all", desc: "被白雾笼罩，5回合内双方能力阶级无法被降低。（待完善）" },
  mist: { id: "mist", name: "黑雾", element: "ice", category: "status", power: 0, accuracy: 1, target: "self", desc: "将能力变化复原，消除所有Buff和Debuff。（待完善）" },
  ice_punch: { id: "ice_punch", name: "冰冻拳", element: "ice", category: "physical", power: 75, accuracy: 1, target: "enemy", status: { type: "freeze", chance: 0.1, target: "enemy" }, desc: "附带刺骨寒气的重拳。小概率使敌人冰冻。" },
  powder_snow: { id: "powder_snow", name: "细雪", element: "ice", category: "special", power: 40, accuracy: 1, target: "all", status: { type: "freeze", chance: 0.1, target: "enemy" }, desc: "吹出冰冷的细雪攻击。小概率使敌人冰冻。" },
  icy_wind: { id: "icy_wind", name: "冰冻之风", element: "ice", category: "special", power: 55, accuracy: 0.95, target: "all", statChanges: [{ stat: "spd", stages: -1, chance: 1, target: "enemy" }], desc: "吹出结冰的冷风。必定降低敌方速度。" },
  avalanche: { id: "avalanche", name: "雪崩", element: "ice", category: "physical", power: 60, accuracy: 1, target: "enemy", priority: -4, desc: "如果在该回合受过伤害，威力翻倍。（待完善后手判定）" },
  ice_fang: { id: "ice_fang", name: "冰冻牙", element: "ice", category: "physical", power: 65, accuracy: 0.95, target: "enemy", status: { type: "freeze", chance: 0.1, target: "enemy" }, flinchChance: 0.1, desc: "带有寒气的啃咬。小概率使敌人冰冻或畏缩。" },
  frost_breath: { id: "frost_breath", name: "冰息", element: "ice", category: "special", power: 60, accuracy: 0.9, target: "enemy", critChance: 1, desc: "吹出冰冷的气息。必定击中要害。" },
  sheer_cold: { id: "sheer_cold", name: "绝对零度", element: "ice", category: "special", power: 9999, accuracy: 0.3, target: "enemy", desc: "造成一击必杀的绝对零度。命中率极低。（待完善一击必杀）" },
  hail: { id: "hail", name: "冰雹", element: "ice", category: "status", power: 0, accuracy: 1, target: "all", desc: "降下冰雹，除冰系外每回合扣血。（待完善天气系统）" },
  freeze_dry: { id: "freeze_dry", name: "冷冻干燥", element: "ice", category: "special", power: 70, accuracy: 1, target: "enemy", status: { type: "freeze", chance: 0.1, target: "enemy" }, desc: "急冻水分。对水系也能造成效果拔群的伤害。（待完善特殊克制）" },

  // ================= 飞行 (Flying) =================
  gust: { id: "gust", name: "狂风术", element: "flying", category: "special", power: 40, accuracy: 1, target: "enemy", desc: "用力拍打翅膀卷起狂风攻击敌人。" },
  air_slash: { id: "air_slash", name: "空气斩", element: "flying", category: "special", power: 75, accuracy: 0.95, target: "enemy", flinchChance: 0.3, desc: "挥出如刀刃般的空气波。有概率使敌人畏缩。" },
  brave_bird: { id: "brave_bird", name: "勇鸟猛攻", element: "flying", category: "physical", power: 120, accuracy: 1, target: "enemy", recoilPct: 0.33, desc: "收拢翅膀进行舍身冲撞。自身也会受到极大的反作用力伤害。" },
  roost: { id: "roost", name: "羽栖", element: "flying", category: "status", power: 0, accuracy: 1, target: "self", healPct: 0.5, desc: "降落到地面休息，恢复自身最大HP的一半。当回合失去飞行属性。（待完善失去属性）" },
  peck: { id: "peck", name: "啄击", element: "flying", category: "physical", power: 35, accuracy: 1, target: "enemy", desc: "用尖锐的喙啄向敌人。" },
  drill_peck: { id: "drill_peck", name: "冲钻", element: "flying", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "一边旋转一边用尖喙突刺。" },
  fly: { id: "fly", name: "飞翔", element: "flying", category: "physical", power: 90, accuracy: 0.95, target: "enemy", desc: "第一回合飞上天空，第二回合发动攻击。（待完善蓄力技能）" },
  aerial_ace: { id: "aerial_ace", name: "燕返", element: "flying", category: "physical", power: 60, accuracy: 100, target: "enemy", desc: "以极快的速度戏弄并斩击。攻击必定命中。" },
  hurricane: { id: "hurricane", name: "暴风", element: "flying", category: "special", power: 110, accuracy: 0.7, target: "enemy", desc: "用强烈的风暴卷起敌人。有概率使敌人混乱。（待完善混乱）" },
  acrobatics: { id: "acrobatics", name: "杂技", element: "flying", category: "physical", power: 55, accuracy: 1, target: "enemy", desc: "轻巧地攻击。如果未携带道具，威力翻倍。（待完善道具系统）" },
  tailwind: { id: "tailwind", name: "顺风", element: "flying", category: "status", power: 0, accuracy: 1, target: "self", desc: "刮起猛烈的顺风。5回合内己方全员速度翻倍。（待完善场地效果）" },
  defog: { id: "defog", name: "清除浓雾", element: "flying", category: "status", power: 0, accuracy: 1, target: "all", desc: "吹散场上的雾气和场地效果。（待完善场地效果）" },
  bounce: { id: "bounce", name: "弹跳", element: "flying", category: "physical", power: 85, accuracy: 0.85, target: "enemy", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "第一回合弹跳至空中，第二回合攻击。有概率使敌人麻痹。（待完善蓄力）" },
  sky_attack: { id: "sky_attack", name: "神鸟猛击", element: "flying", category: "physical", power: 140, accuracy: 0.9, target: "enemy", flinchChance: 0.3, critChance: 0.125, desc: "蓄力一回合后发动的毁灭性冲撞。容易击中要害且有概率使敌人畏缩。（待完善蓄力）" },
  air_cutter: { id: "air_cutter", name: "空气利刃", element: "flying", category: "special", power: 60, accuracy: 0.95, target: "all", critChance: 0.125, desc: "用锐利的风刃切裂敌人。容易击中要害。" },

  // ================= 虫 (Bug) =================
  bug_bite: { id: "bug_bite", name: "虫群啃噬", element: "bug", category: "physical", power: 60, accuracy: 1, target: "enemy", desc: "用力啃咬敌人进行攻击。" },
  x_scissor: { id: "x_scissor", name: "十字剪", element: "bug", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "将镰刀或爪子交叉成十字斩击敌人。" },
  bug_buzz: { id: "bug_buzz", name: "虫鸣", element: "bug", category: "special", power: 90, accuracy: 1, target: "all", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "发出刺耳的虫鸣。小概率降低敌方特防。" },
  quiver_dance: { id: "quiver_dance", name: "蝶舞", element: "bug", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "spAtk", stages: 1, chance: 1, target: "self" }, { stat: "spDef", stages: 1, chance: 1, target: "self" }, { stat: "spd", stages: 1, chance: 1, target: "self" }], desc: "跳起神秘美丽的舞蹈，必定提升特攻、特防和速度。" },
  string_shot: { id: "string_shot", name: "吐丝", element: "bug", category: "status", power: 0, accuracy: 0.95, target: "enemy", statChanges: [{ stat: "spd", stages: -2, chance: 1, target: "enemy" }], desc: "向敌人吐出黏糊糊的丝线，大幅降低其速度。" },
  leech_life: { id: "leech_life", name: "吸血", element: "bug", category: "physical", power: 80, accuracy: 1, target: "enemy", healPct: 0.5, desc: "吸取敌人的血液。造成伤害的一半将转化为自身的HP。" },
  pin_missile: { id: "pin_missile", name: "飞弹针", element: "bug", category: "physical", power: 25, accuracy: 0.95, target: "enemy", multiHit: [2, 5], desc: "连续发射锐利的尖针，会击中2~5次。" },
  megahorn: { id: "megahorn", name: "超级角击", element: "bug", category: "physical", power: 120, accuracy: 0.85, target: "enemy", desc: "用坚硬且巨大的角猛烈突刺敌人。威力极大。" },
  signal_beam: { id: "signal_beam", name: "信号光束", element: "bug", category: "special", power: 75, accuracy: 1, target: "enemy", desc: "发射不可思议的光线。有概率使敌人混乱。（待完善混乱）" },
  u_turn: { id: "u_turn", name: "急速折返", element: "bug", category: "physical", power: 70, accuracy: 1, target: "enemy", desc: "攻击之后，立刻与后备的幻兽进行替换。（待完善替换逻辑）" },
  struggle_bug: { id: "struggle_bug", name: "虫之抵抗", element: "bug", category: "special", power: 50, accuracy: 1, target: "all", statChanges: [{ stat: "spAtk", stages: -1, chance: 1, target: "enemy" }], desc: "散发抵抗的波动。必定降低敌方特攻。" },
  sticky_web: { id: "sticky_web", name: "黏黏网", element: "bug", category: "status", power: 0, accuracy: 1, target: "all", desc: "在对方场地布下黏网。替换上场的敌人会降低速度。（待完善场地效果）" },
  pollen_puff: { id: "pollen_puff", name: "花粉团", element: "bug", category: "special", power: 90, accuracy: 1, target: "enemy", desc: "向敌人投掷爆炸的花粉团。如果是对友方使用则会恢复HP。（待完善友方目标）" },
  lunge: { id: "lunge", name: "猛扑", element: "bug", category: "physical", power: 80, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: -1, chance: 1, target: "enemy" }], desc: "全身扑向敌人进行攻击。必定降低敌方物攻。" },
  first_impression: { id: "first_impression", name: "迎头一击", element: "bug", category: "physical", power: 90, accuracy: 1, priority: 2, target: "enemy", desc: "出场第一回合才能使用的先制攻击。（待完善出场限制）" },
  
    // ================= 毒 (Poison) =================
  poison_fang: { id: "poison_fang", name: "剧毒之牙", element: "poison", category: "physical", power: 50, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.7, target: "enemy" }, desc: "带有剧毒的啃咬。大概率使敌人中毒。" },
  venom_burst: { id: "venom_burst", name: "毒沼爆裂", element: "poison", category: "special", power: 90, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.3, target: "enemy" }, desc: "引爆剧毒的泥沼。有概率使敌人中毒。" },
  sludge_bomb: { id: "sludge_bomb", name: "污泥炸弹", element: "poison", category: "special", power: 90, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.3, target: "enemy" }, desc: "投掷剧毒的污泥。有概率使敌人中毒。" },
  toxic: { id: "toxic", name: "剧毒", element: "poison", category: "status", power: 0, accuracy: 0.9, target: "enemy", status: { type: "poison", chance: 1, target: "enemy" }, desc: "释放强烈的毒素。必定使敌人陷入严重的中毒状态。" },
  poison_sting: { id: "poison_sting", name: "腐蚀毒刺", element: "poison", category: "physical", power: 15, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.3, target: "enemy" }, desc: "发射带有毒液的针。有概率使敌人中毒。" },
  acid: { id: "acid", name: "腐蚀酸液", element: "poison", category: "special", power: 40, accuracy: 1, target: "all", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "喷射强酸。小概率降低敌方特防。" },
  smog: { id: "smog", name: "致命毒瘴", element: "poison", category: "special", power: 30, accuracy: 0.7, target: "enemy", status: { type: "poison", chance: 0.4, target: "enemy" }, desc: "喷出剧毒的雾气。有概率使敌人中毒。" },
  sludge: { id: "sludge", name: "毒泥抛射", element: "poison", category: "special", power: 65, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.3, target: "enemy" }, desc: "投掷污泥。有概率使敌人中毒。" },
  poison_tail: { id: "poison_tail", name: "淬毒之尾", element: "poison", category: "physical", power: 50, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.1, target: "enemy" }, critChance: 0.125, desc: "带有剧毒的尾巴扫击。容易击中要害，小概率中毒。" },
  cross_poison: { id: "cross_poison", name: "交叉毒刃", element: "poison", category: "physical", power: 70, accuracy: 1, target: "enemy", status: { type: "poison", chance: 0.1, target: "enemy" }, critChance: 0.125, desc: "交叉斩击。容易击中要害，小概率中毒。" },
  gunk_shot: { id: "gunk_shot", name: "秽物倾泻", element: "poison", category: "physical", power: 120, accuracy: 0.8, target: "enemy", status: { type: "poison", chance: 0.3, target: "enemy" }, desc: "投掷恶臭的垃圾。威力巨大，有概率使敌人中毒。" },
  venoshock: { id: "venoshock", name: "毒素爆发", element: "poison", category: "special", power: 65, accuracy: 1, target: "enemy", desc: "向敌人喷射特殊的毒液。如果敌人已中毒，威力翻倍。" },
  sludge_wave: { id: "sludge_wave", name: "剧毒浪潮", element: "poison", category: "special", power: 95, accuracy: 1, target: "all", status: { type: "poison", chance: 0.1, target: "enemy" }, desc: "用剧毒的波浪攻击周围所有目标。小概率中毒。" },
  clear_smog: { id: "clear_smog", name: "净化毒雾", element: "poison", category: "special", power: 50, accuracy: 100, target: "enemy", desc: "投掷特殊的泥块。命中后消除目标的能力变化。" },
  toxic_spikes: { id: "toxic_spikes", name: "剧毒陷阱", element: "poison", category: "status", power: 0, accuracy: 1, target: "all", desc: "在敌人脚下撒满毒刺。替换上场的敌人会中毒。" },
  gastro_acid: { id: "gastro_acid", name: "销蚀酸水", element: "poison", category: "status", power: 0, accuracy: 1, target: "enemy", desc: "喷出强酸胃液。消除敌人的特性。" },

    // ================= 恶 (Dark) =================
  bite: { id: "bite", name: "撕咬", element: "dark", category: "physical", power: 60, accuracy: 1, target: "enemy", flinchChance: 0.3, desc: "用尖锐的牙齿咬住敌人。有概率使敌人畏缩。" },
  dark_crunch: { id: "dark_crunch", name: "幽冥狂噬", element: "dark", category: "physical", power: 80, accuracy: 1, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 0.2, target: "enemy" }], desc: "用附带黑暗气息的獠牙撕咬敌人。有概率降低敌方物防。" },
  dark_scheme: { id: "dark_scheme", name: "深渊谋划", element: "dark", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "spAtk", stages: 2, chance: 1, target: "self" }], desc: "在脑海中谋划恶毒的战术，必定大幅提升自身的特攻。" },
  sucker_punch: { id: "sucker_punch", name: "突袭", element: "dark", category: "physical", power: 70, accuracy: 1, priority: 1, target: "enemy", desc: "察觉对方的攻击意图并先发制人。" },
  pursuit: { id: "pursuit", name: "追猎痛击", element: "dark", category: "physical", power: 40, accuracy: 1, target: "enemy", desc: "如果敌方准备替换下场，威力翻倍且必定先手。" },
  thief: { id: "thief", name: "暗影窃夺", element: "dark", category: "physical", power: 60, accuracy: 1, target: "enemy", desc: "攻击的同时，夺取敌人携带的道具。" },
  faint_attack: { id: "faint_attack", name: "无影突袭", element: "dark", category: "physical", power: 60, accuracy: 100, target: "enemy", desc: "趁敌人不备发动攻击。攻击必定命中。" },
  beat_up: { id: "beat_up", name: "群起围剿", element: "dark", category: "physical", power: 20, accuracy: 1, target: "enemy", desc: "召唤队伍中的幻兽一起攻击。队伍状态越好威力越高。" },
  knock_off: { id: "knock_off", name: "震落", element: "dark", category: "physical", power: 65, accuracy: 1, target: "enemy", desc: "打落敌人的道具。如果敌人持有道具，威力提升。" },
  taunt: { id: "taunt", name: "无礼嘲弄", element: "dark", category: "status", power: 0, accuracy: 1, target: "enemy", desc: "挑衅敌人。使其在几回合内只能使用攻击招式。" },
  dark_pulse: { id: "dark_pulse", name: "深渊脉冲", element: "dark", category: "special", power: 80, accuracy: 1, target: "enemy", flinchChance: 0.2, desc: "释放充满恶意的黑暗波动。有概率使敌人畏缩。" },
  night_slash: { id: "night_slash", name: "死角刺杀", element: "dark", category: "physical", power: 70, accuracy: 1, target: "enemy", critChance: 0.125, desc: "瞄准要害斩击。容易击中要害。" },
  foul_play: { id: "foul_play", name: "借力打力", element: "dark", category: "physical", power: 95, accuracy: 1, target: "enemy", desc: "利用敌人的力量攻击。敌方物攻越高，伤害越大。" },
  snarl: { id: "snarl", name: "威慑怒吼", element: "dark", category: "special", power: 55, accuracy: 0.95, target: "all", statChanges: [{ stat: "spAtk", stages: -1, chance: 1, target: "enemy" }], desc: "发出恐吓的咆哮。必定降低敌方特攻。" },
  parting_shot: { id: "parting_shot", name: "咒骂撤退", element: "dark", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: -1, chance: 1, target: "enemy" }, { stat: "spAtk", stages: -1, chance: 1, target: "enemy" }], desc: "降低敌方双攻，然后与后备幻兽替换。" },
  throat_chop: { id: "throat_chop", name: "锁喉暗杀", element: "dark", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "突刺喉咙。使敌人暂时无法使用声音类招式。" },

    // ================= 幽灵 (Ghost) =================
  shadow_ball: { id: "shadow_ball", name: "冥影之球", element: "ghost", category: "special", power: 80, accuracy: 1, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.3, target: "enemy" }], desc: "投掷出一团黑色的冥影。有概率降低敌方特防。" },
  soul_reaper: { id: "soul_reaper", name: "夺魂之视", element: "ghost", category: "status", power: 0, accuracy: 0.85, target: "enemy", status: { type: "paralyze", chance: 1, target: "enemy" }, desc: "用空洞的眼神直视敌人灵魂。大概率使敌人因恐惧而麻痹。" },
  shadow_claw: { id: "shadow_claw", name: "暗影爪", element: "ghost", category: "physical", power: 70, accuracy: 1, target: "enemy", critChance: 0.125, desc: "用幽影聚集而成的爪子劈裂敌人。容易击中要害。" },
  confuse_ray: { id: "confuse_ray", name: "奇异之光", element: "ghost", category: "status", power: 0, accuracy: 1, target: "enemy", desc: "发出诡异的光芒，必定让敌人陷入混乱。" },
  lick: { id: "lick", name: "怨灵之舐", element: "ghost", category: "physical", power: 30, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "用长长的舌头舔舐。有概率使敌人麻痹。" },
  astonish: { id: "astonish", name: "悚然惊魂", element: "ghost", category: "physical", power: 30, accuracy: 1, target: "enemy", flinchChance: 0.3, desc: "突然惊吓敌人。有概率使敌人畏缩。" },
  night_shade: { id: "night_shade", name: "梦魇缠身", element: "ghost", category: "special", power: 50, accuracy: 1, target: "enemy", desc: "显现可怕的幻影。造成等同于自身等级的固定伤害。" },
  curse: { id: "curse", name: "恶灵诅咒", element: "ghost", category: "status", power: 0, accuracy: 1, target: "enemy", desc: "消耗自身一半HP，对敌人施加每回合扣血的诅咒。" },
  destiny_bond: { id: "destiny_bond", name: "命运羁绊", element: "ghost", category: "status", power: 0, accuracy: 1, target: "self", desc: "使用后若被敌方攻击击倒，敌方也会跟着倒下。" },
  spite: { id: "spite", name: "噬灵怨念", element: "ghost", category: "status", power: 0, accuracy: 1, target: "enemy", desc: "对敌人刚刚使用的招式心怀怨恨，减少其PP值。" },
  shadow_punch: { id: "shadow_punch", name: "幽影重击", element: "ghost", category: "physical", power: 60, accuracy: 100, target: "enemy", desc: "从阴影中挥出的拳头。攻击必定命中。" },
  shadow_sneak: { id: "shadow_sneak", name: "暗影瞬杀", element: "ghost", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "伸长影子从背后攻击。必定先手出击。" },
  ominous_wind: { id: "ominous_wind", name: "幽冥妖风", element: "ghost", category: "special", power: 60, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: 1, chance: 0.1, target: "self" }, { stat: "def", stages: 1, chance: 0.1, target: "self" }, { stat: "spAtk", stages: 1, chance: 0.1, target: "self" }, { stat: "spDef", stages: 1, chance: 0.1, target: "self" }, { stat: "spd", stages: 1, chance: 0.1, target: "self" }], desc: "吹出令人毛骨悚然的风。小概率提升自身所有能力。" },
  hex: { id: "hex", name: "厄运降临", element: "ghost", category: "special", power: 65, accuracy: 1, target: "enemy", desc: "对陷入异常状态的敌人造成翻倍的伤害。" },
  phantom_force: { id: "phantom_force", name: "虚空伏击", element: "ghost", category: "physical", power: 90, accuracy: 1, target: "enemy", desc: "第一回合潜入异空间，第二回合无视防守进行攻击。" },
  poltergeist: { id: "poltergeist", name: "灵动邪咒", element: "ghost", category: "physical", power: 110, accuracy: 0.9, target: "enemy", desc: "操纵敌人携带的道具进行攻击。敌人未携带道具则失败。" },

    // ================= 超能 (Psychic) =================
  hypnosis: { id: "hypnosis", name: "深度催眠", element: "psychic", category: "status", power: 0, accuracy: 0.6, target: "enemy", status: { type: "sleep", chance: 1, target: "enemy" }, desc: "施展强力的催眠暗示，大概率使敌人陷入沉睡。" },
  psychic_blast: { id: "psychic_blast", name: "虚空灵渊", element: "psychic", category: "special", power: 90, accuracy: 1, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "释放强大的精神念力冲击敌人心智。小概率降低敌方特防。" },
  zen_state: { id: "zen_state", name: "禅定凝神", element: "psychic", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "spAtk", stages: 1, chance: 1, target: "self" }, { stat: "spDef", stages: 1, chance: 1, target: "self" }], desc: "排除杂念进入禅定状态，必定提升自身的特攻与特防。" },
  zen_headbutt: { id: "zen_headbutt", name: "意念头槌", element: "psychic", category: "physical", power: 80, accuracy: 0.9, target: "enemy", flinchChance: 0.2, desc: "将意念集中在前额进行猛撞。有概率使敌人畏缩。" },
  confusion: { id: "confusion", name: "意念冲击", element: "psychic", category: "special", power: 50, accuracy: 1, target: "enemy", desc: "释放微弱的念力波。有概率使敌人混乱。" },
  psybeam: { id: "psybeam", name: "迷幻射线", element: "psychic", category: "special", power: 65, accuracy: 1, target: "enemy", desc: "发射神奇的光线。有概率使敌人混乱。" },
  psychic: { id: "psychic", name: "灵能风暴", element: "psychic", category: "special", power: 90, accuracy: 1, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "释放强大的念力。小概率降低敌方特防。" },
  psyshock: { id: "psyshock", name: "意念粉碎", element: "psychic", category: "special", power: 80, accuracy: 1, target: "enemy", desc: "用念力实体化进行攻击。计算伤害时取敌方的物防。" },
  calm_mind: { id: "calm_mind", name: "灵能觉醒", element: "psychic", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "spAtk", stages: 1, chance: 1, target: "self" }, { stat: "spDef", stages: 1, chance: 1, target: "self" }], desc: "静心凝神。必定提升自身的特攻和特防。" },
  reflect: { id: "reflect", name: "灵能护盾", element: "psychic", category: "status", power: 0, accuracy: 1, target: "all", desc: "在5回合内，己方受到的物理伤害减半。" },
  light_screen: { id: "light_screen", name: "魔能屏障", element: "psychic", category: "status", power: 0, accuracy: 1, target: "all", desc: "在5回合内，己方受到的特殊伤害减半。" },
  rest: { id: "rest", name: "安神入梦", element: "psychic", category: "status", power: 0, accuracy: 1, target: "self", status: { type: "sleep", chance: 1, target: "self" }, desc: "进入深度睡眠恢复所有HP，并治愈异常状态。" },
  dream_eater: { id: "dream_eater", name: "梦魇吞噬", element: "psychic", category: "special", power: 100, accuracy: 1, target: "enemy", healPct: 0.5, desc: "吞噬睡眠中敌人的梦境。造成伤害的一半将转化为HP。" },
  future_sight: { id: "future_sight", name: "时空惩戒", element: "psychic", category: "special", power: 120, accuracy: 1, target: "enemy", desc: "预见未来的攻击。在2回合后对敌人造成巨大伤害。" },
  trick_room: { id: "trick_room", name: "扭曲领域", element: "psychic", category: "status", power: 0, accuracy: 1, target: "all", desc: "制造奇妙的空间。5回合内，速度慢的幻兽先行动。" },
  magic_coat: { id: "magic_coat", name: "灵能反弹", element: "psychic", category: "status", power: 0, accuracy: 1, target: "self", desc: "将敌方施加的异常状态和能力降低反射回去。" },
  psycho_cut: { id: "psycho_cut", name: "意念之刃", element: "psychic", category: "physical", power: 70, accuracy: 1, target: "enemy", critChance: 0.125, desc: "用念力形成的刀刃斩击。容易击中要害。" },

    // ================= 妖精 (Fairy) =================
  moonblast: { id: "moonblast", name: "皎月天罚", element: "fairy", category: "special", power: 95, accuracy: 1, target: "enemy", statChanges: [{ stat: "spAtk", stages: -1, chance: 0.3, target: "enemy" }], desc: "借用月亮的神秘力量惩罚敌人。有概率降低敌方特攻。" },
  fey_strike: { id: "fey_strike", name: "妖精幻击", element: "fairy", category: "physical", power: 90, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "atk", stages: -1, chance: 0.1, target: "enemy" }], desc: "以诡异的妖精身法进行猛攻。小概率降低敌方物攻。" },
  play_rough: { id: "play_rough", name: "嬉闹", element: "fairy", category: "physical", power: 90, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "atk", stages: -1, chance: 0.1, target: "enemy" }], desc: "看似在玩耍，实则下手极重。小概率降低敌方物攻。" },
  dazzling_gleam: { id: "dazzling_gleam", name: "魔法闪耀", element: "fairy", category: "special", power: 80, accuracy: 1, target: "all", desc: "放出强光攻击场上所有敌人。" },
  fairy_wind: { id: "fairy_wind", name: "幻灵轻风", element: "fairy", category: "special", power: 40, accuracy: 1, target: "enemy", desc: "刮起神秘的妖精之风攻击敌人。" },
  disarming_voice: { id: "disarming_voice", name: "塞妖之歌", element: "fairy", category: "special", power: 40, accuracy: 100, target: "all", desc: "发出魅惑的声音。攻击必定命中。" },
  draining_kiss: { id: "draining_kiss", name: "幻灵之吻", element: "fairy", category: "special", power: 50, accuracy: 1, target: "enemy", healPct: 0.75, desc: "夺走敌人的体力。造成伤害的75%转化为自身的HP。" },
  charm: { id: "charm", name: "幻灵魅惑", element: "fairy", category: "status", power: 0, accuracy: 1, target: "enemy", statChanges: [{ stat: "atk", stages: -2, chance: 1, target: "enemy" }], desc: "可爱的撒娇让敌人失去战意。大幅降低敌方物攻。" },
  sweet_kiss: { id: "sweet_kiss", name: "仙灵之吻", element: "fairy", category: "status", power: 0, accuracy: 0.75, target: "enemy", desc: "像天使般亲吻敌人。大概率让其陷入混乱。" },
  moonlight: { id: "moonlight", name: "皎月恩赐", element: "fairy", category: "status", power: 0, accuracy: 1, target: "self", healPct: 0.5, desc: "沐浴月光恢复体力。回复量受天气影响。" },
  geomancy: { id: "geomancy", name: "自然之主", element: "fairy", category: "status", power: 0, accuracy: 1, target: "self", desc: "第一回合蓄力，第二回合大幅提升特攻、特防和速度。" },
  floral_healing: { id: "floral_healing", name: "百花恩泽", element: "fairy", category: "status", power: 0, accuracy: 1, target: "enemy", desc: "治愈目标。回复目标最大HP的一半。" },
  nature_madness: { id: "nature_madness", name: "森林震怒", element: "fairy", category: "special", power: 1, accuracy: 0.9, target: "enemy", desc: "释放自然的愤怒。使敌人的HP减半。" },
  spirit_break: { id: "spirit_break", name: "碎灵重击", element: "fairy", category: "physical", power: 75, accuracy: 1, target: "enemy", statChanges: [{ stat: "spAtk", stages: -1, chance: 1, target: "enemy" }], desc: "全力的灵魂冲击。必定降低敌方特攻。" },
  strange_steam: { id: "strange_steam", name: "迷幻蒸汽", element: "fairy", category: "special", power: 90, accuracy: 0.95, target: "enemy", desc: "喷射奇妙的蒸汽。有概率使敌人混乱。" },
  misty_explosion: { id: "misty_explosion", name: "仙境崩塌", element: "fairy", category: "special", power: 100, accuracy: 1, target: "all", desc: "引发妖精能量的大爆炸。自身也会陷入濒死。" },

    // ================= 龙 (Dragon) =================
  dragon_claw: { id: "dragon_claw", name: "苍龙之爪", element: "dragon", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "用锐利的龙爪劈裂敌人。" },
  draco_meteor: { id: "draco_meteor", name: "星陨龙息", element: "dragon", category: "special", power: 130, accuracy: 0.9, target: "enemy", statChanges: [{ stat: "spAtk", stages: -2, chance: 1, target: "self" }], desc: "从天召唤狂暴的陨石龙息。威力极大，但使用后必定大幅降低自身特攻。" },
  dragon_dance: { id: "dragon_dance", name: "逆鳞之舞", element: "dragon", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "atk", stages: 1, chance: 1, target: "self" }, { stat: "spd", stages: 1, chance: 1, target: "self" }], desc: "跳起神秘而古老的战舞，必定提升自身的物攻与速度。" },
  outrage: { id: "outrage", name: "逆鳞", element: "dragon", category: "physical", power: 120, accuracy: 1, target: "enemy", desc: "陷入疯狂连续攻击2~3回合。结束后陷入混乱。" },
  dragon_rage: { id: "dragon_rage", name: "真龙咆哮", element: "dragon", category: "special", power: 40, accuracy: 1, target: "enemy", desc: "喷射愤怒的冲击波。造成40点固定伤害。" },
  dragon_breath: { id: "dragon_breath", name: "远古龙息", element: "dragon", category: "special", power: 60, accuracy: 1, target: "enemy", status: { type: "paralyze", chance: 0.3, target: "enemy" }, desc: "吐出强烈的气息。有概率使敌人麻痹。" },
  twister: { id: "twister", name: "狂暴龙卷", element: "dragon", category: "special", power: 40, accuracy: 1, target: "all", flinchChance: 0.2, desc: "掀起龙卷风攻击。有概率使敌人畏缩。" },
  dragon_pulse: { id: "dragon_pulse", name: "巨龙脉冲", element: "dragon", category: "special", power: 85, accuracy: 1, target: "enemy", desc: "从体内释放强大的冲击波。无特殊效果。" },
  dragon_rush: { id: "dragon_rush", name: "苍龙坠击", element: "dragon", category: "physical", power: 100, accuracy: 0.75, target: "enemy", flinchChance: 0.2, desc: "释放可怕的杀气猛撞。有概率使敌人畏缩。" },
  dragon_tail: { id: "dragon_tail", name: "巨龙扫尾", element: "dragon", category: "physical", power: 60, accuracy: 0.9, target: "enemy", priority: -6, desc: "强力的尾击。强制敌方替换幻兽。" },
  dual_chop: { id: "dual_chop", name: "双重龙劈", element: "dragon", category: "physical", power: 40, accuracy: 0.9, target: "enemy", multiHit: [2, 2], desc: "用坚硬的部位连续劈砍。必定击中2次。" },
  scales_shot: { id: "scales_shot", name: "龙鳞飞射", element: "dragon", category: "physical", power: 25, accuracy: 0.9, target: "enemy", multiHit: [2, 5], statChanges: [{ stat: "spd", stages: 1, chance: 1, target: "self" }, { stat: "def", stages: -1, chance: 1, target: "self" }], desc: "发射鳞片连续攻击2~5次。使用后提升速度但降低防御。" },
  dragon_darts: { id: "dragon_darts", name: "双龙穿心", element: "dragon", category: "physical", power: 50, accuracy: 1, target: "enemy", multiHit: [2, 2], desc: "发射两支龙箭。必定击中2次。" },
  core_enforcer: { id: "core_enforcer", name: "龙源制裁", element: "dragon", category: "special", power: 100, accuracy: 1, target: "all", desc: "释放核心能量。如果后手攻击，消除敌方特性。" },
  clanging_scales: { id: "clanging_scales", name: "刺耳龙吟", element: "dragon", category: "special", power: 110, accuracy: 1, target: "all", statChanges: [{ stat: "def", stages: -1, chance: 1, target: "self" }], desc: "摩擦鳞片发出噪音。威力极大但使用后防御降低。" },
  roar_of_time: { id: "roar_of_time", name: "时空崩毁", element: "dragon", category: "special", power: 150, accuracy: 0.9, target: "enemy", desc: "撕裂时间的咆哮。使用后下一回合无法行动。" },

    // ================= 格斗 (Fighting) =================
  mach_punch: { id: "mach_punch", name: "音速拳", element: "fighting", category: "physical", power: 40, accuracy: 1, priority: 1, target: "enemy", desc: "以突破音速的拳法攻击，必定先手出击。" },
  titan_strike: { id: "titan_strike", name: "泰坦碎击", element: "fighting", category: "physical", power: 120, accuracy: 1, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 1, target: "self" }, { stat: "spDef", stages: -1, chance: 1, target: "self" }], desc: "放弃防御的舍身猛击。威力极大，但使用后必定降低自身的双防。" },
  warrior_spirit: { id: "warrior_spirit", name: "武道真意", element: "fighting", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "atk", stages: 1, chance: 1, target: "self" }, { stat: "def", stages: 1, chance: 1, target: "self" }], desc: "激发体内的武道意志，必定提升自身的物攻与物防。" },
  close_combat: { id: "close_combat", name: "近身战", element: "fighting", category: "physical", power: 120, accuracy: 1, target: "enemy", statChanges: [{ stat: "def", stages: -1, chance: 1, target: "self" }, { stat: "spDef", stages: -1, chance: 1, target: "self" }], desc: "放弃防御突入敌人怀中猛攻。使用后自身双防下降。" },
  aura_sphere: { id: "aura_sphere", name: "波导弹", element: "fighting", category: "special", power: 80, accuracy: 100, target: "enemy", desc: "发射体内波导的能量弹。攻击必定命中。" },
  double_kick: { id: "double_kick", name: "连环飞踢", element: "fighting", category: "physical", power: 30, accuracy: 1, target: "enemy", multiHit: [2, 2], desc: "双脚连续踢击。必定击中2次。" },
  karate_chop: { id: "karate_chop", name: "碎岩手刀", element: "fighting", category: "physical", power: 50, accuracy: 1, target: "enemy", critChance: 0.125, desc: "用手刀锐利地劈下。容易击中要害。" },
  low_kick: { id: "low_kick", name: "扫堂腿", element: "fighting", category: "physical", power: 50, accuracy: 1, target: "enemy", desc: "瞄准脚下使敌人摔倒。敌方越重威力越大。" },
  seismic_toss: { id: "seismic_toss", name: "星体投掷", element: "fighting", category: "physical", power: 50, accuracy: 1, target: "enemy", desc: "利用引力投掷敌人。造成等同于自身等级的固定伤害。" },
  dynamic_punch: { id: "dynamic_punch", name: "混沌重拳", element: "fighting", category: "physical", power: 100, accuracy: 0.5, target: "enemy", desc: "使出浑身解数的重拳。命中极低但必定使敌人混乱。" },
  brick_break: { id: "brick_break", name: "破甲手刀", element: "fighting", category: "physical", power: 75, accuracy: 1, target: "enemy", desc: "强力的手刀。能够打破光墙和反射壁。" },
  bulk_up: { id: "bulk_up", name: "肌肉强化", element: "fighting", category: "status", power: 0, accuracy: 1, target: "self", statChanges: [{ stat: "atk", stages: 1, chance: 1, target: "self" }, { stat: "def", stages: 1, chance: 1, target: "self" }], desc: "绷紧肌肉使身体更强壮。提升物攻和防御。" },
  focus_blast: { id: "focus_blast", name: "斗气爆弹", element: "fighting", category: "special", power: 120, accuracy: 0.7, target: "enemy", statChanges: [{ stat: "spDef", stages: -1, chance: 0.1, target: "enemy" }], desc: "集中精神释放真气。威力极大，小概率降低敌方特防。" },
  high_jump_kick: { id: "high_jump_kick", name: "凌空碎膝", element: "fighting", category: "physical", power: 130, accuracy: 0.9, target: "enemy", desc: "高高跳起使出膝撞。如果未命中，自身会受到巨大伤害。" },
  drain_punch: { id: "drain_punch", name: "嗜血重拳", element: "fighting", category: "physical", power: 75, accuracy: 1, target: "enemy", healPct: 0.5, desc: "打出吸取力量的拳头。造成伤害的一半转化为HP。" },
  body_press: { id: "body_press", name: "野蛮扑撞", element: "fighting", category: "physical", power: 80, accuracy: 1, target: "enemy", desc: "用强壮的身体撞击。自身的防御越高威力越大。" },
};

export const ITEM_SPECS: Record<ItemId, ItemSpec> = {
  capsule_basic: { id: "capsule_basic", name: "普通捕获器", kind: "capture", modifier: 1.0, price: 200, desc: "用于捕获野生幻兽的标准胶囊。" },
  capsule_prism: { id: "capsule_prism", name: "高级捕获器", kind: "capture", modifier: 1.5, price: 600, desc: "捕获率比普通胶囊高1.5倍的高级胶囊。" },
  capsule_ultra: { id: "capsule_ultra", name: "特级捕获器", kind: "capture", modifier: 2.0, price: 1200, desc: "有着极高捕获率的优秀胶囊。" },
  capsule_master: { id: "capsule_master", name: "大师捕获器", kind: "capture", modifier: 255.0, price: 100000, desc: "据说能100%捕获任何幻兽的梦幻胶囊。" },
  
  potion_small: { id: "potion_small", name: "伤药", kind: "heal", heal: 20, price: 300, desc: "回复一只幻兽20点HP。" },
  potion_medium: { id: "potion_medium", name: "好伤药", kind: "heal", heal: 50, price: 700, desc: "回复一只幻兽50点HP。" },
  potion_large: { id: "potion_large", name: "厉害伤药", kind: "heal", heal: 200, price: 1500, desc: "回复一只幻兽200点HP。" },
  potion_max: { id: "potion_max", name: "全满药", kind: "heal", heal: 9999, price: 2500, desc: "完全回复一只幻兽的HP。" },
  
  heal_antidote: { id: "heal_antidote", name: "解毒药", kind: "status_heal", cures: ["poison"], price: 100, desc: "治愈幻兽的中毒状态。" },
  heal_paralyze: { id: "heal_paralyze", name: "解麻药", kind: "status_heal", cures: ["paralyze"], price: 200, desc: "治愈幻兽的麻痹状态。" },
  heal_awake: { id: "heal_awake", name: "解眠药", kind: "status_heal", cures: ["sleep"], price: 250, desc: "唤醒沉睡中的幻兽。" },
  heal_burn: { id: "heal_burn", name: "烧伤药", kind: "status_heal", cures: ["burn"], price: 250, desc: "治愈幻兽的烧伤状态。" },
  heal_ice: { id: "heal_ice", name: "解冻药", kind: "status_heal", cures: ["freeze"], price: 250, desc: "融化幻兽身上的冰块。" },

  berry_oran: { id: "berry_oran", name: "橙橙果", kind: "heal", heal: 10, price: 100, desc: "稍微回复一些HP的果实。" },
  berry_sitrus: { id: "berry_sitrus", name: "文柚果", kind: "heal", heal: 25, healPct: true, price: 800, desc: "回复幻兽25%最大HP的珍贵果实。" },
  berry_lum: { id: "berry_lum", name: "木子果", kind: "status_heal", cures: ["poison", "paralyze", "sleep", "burn", "freeze"], price: 600, desc: "治愈所有异常状态的果实。" },
  
  stone_fire: { id: "stone_fire", name: "火之石", kind: "evolution", element: "fire", price: 2100, desc: "能让特定火属性幻兽进化的奇特石头。" },
  stone_water: { id: "stone_water", name: "水之石", kind: "evolution", element: "water", price: 2100, desc: "能让特定水属性幻兽进化的澄澈石头。" },
  stone_leaf: { id: "stone_leaf", name: "叶之石", kind: "evolution", element: "grass", price: 2100, desc: "能让特定草属性幻兽进化的叶片状石头。" },
  stone_thunder: { id: "stone_thunder", name: "雷之石", kind: "evolution", element: "electric", price: 2100, desc: "能让特定电属性幻兽进化的闪电纹路石头。" },
  
  amulet_coin: { id: "amulet_coin", name: "护符金币", kind: "key_item", price: 10000, desc: "携带后战斗获胜得到的金钱会翻倍。" },
  exp_share: { id: "exp_share", name: "学习装置", kind: "key_item", price: 50000, desc: "开启后，队伍中所有幻兽都能分享经验值。" },
};

export const MONSTER_SPECS: Record<string, MonsterSpec> = {
  ember_marmot: {
    id: "ember_marmot", dexNum: 1, evolutions: [{ targetId: "ember_badger", condition: { type: "level", level: 16 } }],
    name: "焰尾狸",
    element: "fire",
    baseHp: 39,
    baseAtk: 52,
    baseDef: 43,
    baseSpAtk: 60,
    baseSpDef: 50,
    baseSpd: 65,
    captureRate: 0.45,
    growthPerLevel: {
      min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
      max: { hp: 4, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 },
    },
    learnset: [
      { level: 1, moveId: "scratch" },
      { level: 4, moveId: "ember" },
      { level: 7, moveId: "fire_punch" },
      { level: 12, moveId: "flamethrower" },
      { level: 18, moveId: "fire_spin" },
    ],
  },
  tide_newt: {
    id: "tide_newt", dexNum: 4, evolutions: [{ targetId: "tide_siren", condition: { type: "level", level: 16 } }],
    name: "潮纹螈",
    element: "water",
    baseHp: 44,
    baseAtk: 48,
    baseDef: 65,
    baseSpAtk: 50,
    baseSpDef: 64,
    baseSpd: 43,
    captureRate: 0.5,
    growthPerLevel: {
      min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
      max: { hp: 4, atk: 2, def: 3, spAtk: 2, spDef: 3, spd: 2 },
    },
    learnset: [
      { level: 1, moveId: "tackle" },
      { level: 4, moveId: "water_gun" },
      { level: 7, moveId: "aqua_jet" },
      { level: 12, moveId: "hydro_pump" },
    ],
  },
  sprout_owl: {
    id: "sprout_owl", dexNum: 7, evolutions: [{ targetId: "forest_owl", condition: { type: "level", level: 16 } }],
    name: "苔羽鸮",
    element: "grass",
    baseHp: 45,
    baseAtk: 49,
    baseDef: 49,
    baseSpAtk: 65,
    baseSpDef: 65,
    baseSpd: 45,
    captureRate: 0.5,
    initStatsMax: { hp: 50, atk: 49, def: 49, spAtk: 65, spDef: 65, spd: 45 },
    growthPerLevel: {
      min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
      max: { hp: 4, atk: 2, def: 2, spAtk: 3, spDef: 3, spd: 2 },
    },
    learnset: [
      { level: 1, moveId: "tackle" },
      { level: 4, moveId: "wood_strike" },
      { level: 7, moveId: "vine_whip" },
      { level: 12, moveId: "leaf_storm" },
    ],
  },
  rock_golem: {
    id: "rock_golem", dexNum: 10, evolutions: [{ targetId: "titan_golem", condition: { type: "level", level: 25 } }],
    name: "岩刺灵",
    element: "rock",
    baseHp: 40,
    baseAtk: 80,
    baseDef: 100,
    baseSpAtk: 30,
    baseSpDef: 30,
    baseSpd: 20,
    captureRate: 0.62,
    initStatsMax: { hp: 45, atk: 80, def: 100, spAtk: 30, spDef: 30, spd: 20 },
    growthPerLevel: {
      min: { hp: 2, atk: 1, def: 2, spAtk: 1, spDef: 1, spd: 1 },
      max: { hp: 4, atk: 3, def: 4, spAtk: 2, spDef: 2, spd: 1 },
    },
    learnset: [
      { level: 1, moveId: "tackle" },
      { level: 5, moveId: "rock_throw" },
      { level: 10, moveId: "earthquake" },
    ],
  },
  iron_bird: {
    id: "iron_bird", dexNum: 12, evolutions: [{ targetId: "steel_eagle", condition: { type: "level", level: 20 } }],
    name: "铁翎雀",
    element: "steel",
    baseHp: 40,
    baseAtk: 65,
    baseDef: 70,
    baseSpAtk: 40,
    baseSpDef: 40,
    baseSpd: 60,
    captureRate: 0.35,
    initStatsMax: { hp: 45, atk: 65, def: 70, spAtk: 40, spDef: 40, spd: 60 },
    growthPerLevel: {
      min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
      max: { hp: 4, atk: 3, def: 3, spAtk: 2, spDef: 2, spd: 3 },
    },
    learnset: [
      { level: 1, moveId: "scratch" },
      { level: 6, moveId: "metal_claw" },
      { level: 11, moveId: "iron_head" },
    ],
  },
  shadow_spirit: {
    id: "shadow_spirit", dexNum: 14, evolutions: [{ targetId: "phantom_lord", condition: { type: "level", level: 30 } }],
    name: "幽影灵",
    element: "ghost",
    baseHp: 30, baseAtk: 30, baseDef: 30, baseSpAtk: 85, baseSpDef: 85, baseSpd: 80, captureRate: 0.4,
    initStatsMax: { hp: 35, atk: 35, def: 35, spAtk: 85, spDef: 85, spd: 80 },
    growthPerLevel: { min: { hp: 1, atk: 1, def: 1, spAtk: 2, spDef: 2, spd: 2 }, max: { hp: 3, atk: 2, def: 2, spAtk: 4, spDef: 4, spd: 4 } },
    learnset: [{ level: 1, moveId: "growl" }, { level: 8, moveId: "shadow_ball" }]
  },
  frost_cub: {
    id: "frost_cub", dexNum: 16, evolutions: [{ targetId: "glacier_bear", condition: { type: "level", level: 28 } }],
    name: "冰霜幼崽",
    element: "ice",
    baseHp: 50, baseAtk: 50, baseDef: 50, baseSpAtk: 50, baseSpDef: 50, baseSpd: 50, captureRate: 0.45,
    initStatsMax: { hp: 55, atk: 55, def: 55, spAtk: 55, spDef: 55, spd: 55 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 4, atk: 3, def: 3, spAtk: 3, spDef: 3, spd: 3 } },
    learnset: [{ level: 1, moveId: "tackle" }, { level: 10, moveId: "ice_beam" }]
  },
  spark_mouse: {
    id: "spark_mouse", dexNum: 18, evolutions: [{ targetId: "thunder_rat", condition: { type: "item", itemId: "stone_thunder" } }],
    name: "闪电鼠",
    element: "electric",
    baseHp: 35, baseAtk: 55, baseDef: 40, baseSpAtk: 50, baseSpDef: 50, baseSpd: 90, captureRate: 0.5,
    initStatsMax: { hp: 40, atk: 55, def: 40, spAtk: 50, spDef: 50, spd: 90 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 3, atk: 3, def: 2, spAtk: 3, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "scratch" }, { level: 5, moveId: "thunder_shock" }]
  },
  leaf_bug: {
    id: "leaf_bug", dexNum: 20, evolutions: [{ targetId: "thorn_mantis", condition: { type: "level", level: 15 } }],
    name: "叶片虫",
    element: "bug",
    baseHp: 45, baseAtk: 30, baseDef: 35, baseSpAtk: 20, baseSpDef: 20, baseSpd: 45, captureRate: 0.6,
    initStatsMax: { hp: 50, atk: 35, def: 40, spAtk: 25, spDef: 25, spd: 50 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 4, atk: 2, def: 2, spAtk: 1, spDef: 1, spd: 2 } },
    learnset: [{ level: 1, moveId: "tackle" }, { level: 4, moveId: "bug_bite" }]
  },
  fluff_dog: {
    id: "fluff_dog", dexNum: 22, evolutions: [{ targetId: "loyal_hound", condition: { type: "level", level: 20 } }],
    name: "绒毛犬",
    element: "normal",
    baseHp: 45, baseAtk: 55, baseDef: 45, baseSpAtk: 45, baseSpDef: 45, baseSpd: 55, captureRate: 0.6,
    initStatsMax: { hp: 50, atk: 55, def: 45, spAtk: 45, spDef: 45, spd: 55 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 } },
    learnset: [{ level: 1, moveId: "tackle" }, { level: 5, moveId: "bite" }, { level: 10, moveId: "quick_attack" }]
  },
  mud_pig: {
    id: "mud_pig", dexNum: 24, evolutions: [{ targetId: "earth_boar", condition: { type: "level", level: 24 } }],
    name: "泥泥猪",
    element: "ground",
    baseHp: 60, baseAtk: 50, baseDef: 50, baseSpAtk: 40, baseSpDef: 40, baseSpd: 40, captureRate: 0.5,
    initStatsMax: { hp: 65, atk: 50, def: 50, spAtk: 40, spDef: 40, spd: 40 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 4, atk: 3, def: 3, spAtk: 2, spDef: 2, spd: 2 } },
    learnset: [{ level: 1, moveId: "tackle" }, { level: 6, moveId: "mud_slap" }, { level: 12, moveId: "bulldoze" }]
  },
  venom_snake: {
    id: "venom_snake", dexNum: 26, evolutions: [{ targetId: "toxic_cobra", condition: { type: "level", level: 22 } }],
    name: "剧毒蛇",
    element: "poison",
    baseHp: 40, baseAtk: 60, baseDef: 40, baseSpAtk: 40, baseSpDef: 40, baseSpd: 65, captureRate: 0.5,
    initStatsMax: { hp: 45, atk: 60, def: 40, spAtk: 40, spDef: 40, spd: 65 },
    growthPerLevel: { min: { hp: 1, atk: 2, def: 1, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 3, atk: 3, def: 2, spAtk: 2, spDef: 2, spd: 3 } },
    learnset: [{ level: 1, moveId: "poison_sting" }, { level: 7, moveId: "bite" }, { level: 13, moveId: "poison_fang" }]
  },
  shadow_fox: {
    id: "shadow_fox", dexNum: 28, evolutions: [{ targetId: "midnight_wolf", condition: { type: "level", level: 26 } }],
    name: "暗影狐",
    element: "dark",
    baseHp: 45, baseAtk: 65, baseDef: 45, baseSpAtk: 55, baseSpDef: 45, baseSpd: 70, captureRate: 0.45,
    initStatsMax: { hp: 50, atk: 65, def: 45, spAtk: 55, spDef: 45, spd: 70 },
    growthPerLevel: { min: { hp: 1, atk: 2, def: 1, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 3, atk: 3, def: 2, spAtk: 2, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "scratch" }, { level: 6, moveId: "pursuit" }, { level: 14, moveId: "night_slash" }]
  },
  mind_tapir: {
    id: "mind_tapir", dexNum: 30, evolutions: [{ targetId: "dream_eater_tapir", condition: { type: "level", level: 28 } }],
    name: "念力貘",
    element: "psychic",
    baseHp: 60, baseAtk: 40, baseDef: 45, baseSpAtk: 65, baseSpDef: 65, baseSpd: 40, captureRate: 0.45,
    initStatsMax: { hp: 65, atk: 40, def: 45, spAtk: 65, spDef: 65, spd: 40 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 2, spDef: 2, spd: 1 }, max: { hp: 4, atk: 2, def: 2, spAtk: 4, spDef: 4, spd: 2 } },
    learnset: [{ level: 1, moveId: "confusion" }, { level: 8, moveId: "hypnosis" }, { level: 15, moveId: "psybeam" }]
  },
  fairy_sprite: {
    id: "fairy_sprite", dexNum: 32, evolutions: [{ targetId: "moon_nymph", condition: { type: "level", level: 25 } }],
    name: "妖精之灵",
    element: "fairy",
    baseHp: 40, baseAtk: 35, baseDef: 45, baseSpAtk: 60, baseSpDef: 65, baseSpd: 55, captureRate: 0.5,
    initStatsMax: { hp: 45, atk: 35, def: 45, spAtk: 60, spDef: 65, spd: 55 },
    growthPerLevel: { min: { hp: 1, atk: 1, def: 1, spAtk: 2, spDef: 2, spd: 1 }, max: { hp: 3, atk: 2, def: 2, spAtk: 3, spDef: 3, spd: 3 } },
    learnset: [{ level: 1, moveId: "fairy_wind" }, { level: 7, moveId: "disarming_voice" }, { level: 12, moveId: "draining_kiss" }]
  },
  scale_drake: {
    id: "scale_drake", dexNum: 34, evolutions: [{ targetId: "armored_dragon", condition: { type: "level", level: 30 } }],
    name: "鳞甲龙",
    element: "dragon",
    baseHp: 55, baseAtk: 65, baseDef: 50, baseSpAtk: 45, baseSpDef: 50, baseSpd: 55, captureRate: 0.3,
    initStatsMax: { hp: 60, atk: 65, def: 50, spAtk: 45, spDef: 50, spd: 55 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 1, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 4, atk: 4, def: 3, spAtk: 2, spDef: 3, spd: 3 } },
    learnset: [{ level: 1, moveId: "scratch" }, { level: 8, moveId: "dragon_breath" }, { level: 16, moveId: "dragon_claw" }]
  },
  brawl_pup: {
    id: "brawl_pup", dexNum: 37, evolutions: [{ targetId: "martial_hound", condition: { type: "level", level: 25 } }],
    name: "格斗幼犬",
    element: "fighting",
    baseHp: 45, baseAtk: 70, baseDef: 40, baseSpAtk: 35, baseSpDef: 40, baseSpd: 60, captureRate: 0.5,
    initStatsMax: { hp: 50, atk: 70, def: 40, spAtk: 35, spDef: 40, spd: 60 },
    growthPerLevel: { min: { hp: 1, atk: 2, def: 1, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 3, atk: 4, def: 2, spAtk: 2, spDef: 2, spd: 3 } },
    learnset: [{ level: 1, moveId: "scratch" }, { level: 6, moveId: "double_kick" }, { level: 12, moveId: "mach_punch" }]
  },
  gale_hawk: {
    id: "gale_hawk", dexNum: 39, evolutions: [{ targetId: "storm_falcon", condition: { type: "level", level: 22 } }],
    name: "狂风鹰",
    element: "flying",
    baseHp: 40, baseAtk: 55, baseDef: 40, baseSpAtk: 40, baseSpDef: 40, baseSpd: 75, captureRate: 0.5,
    initStatsMax: { hp: 45, atk: 55, def: 40, spAtk: 40, spDef: 40, spd: 75 },
    growthPerLevel: { min: { hp: 1, atk: 2, def: 1, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 3, atk: 3, def: 2, spAtk: 2, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "peck" }, { level: 5, moveId: "gust" }, { level: 11, moveId: "aerial_ace" }]
  },
  ember_badger: {
    id: "ember_badger", dexNum: 2, name: "炎爆獾", element: "fire",
    baseHp: 58, baseAtk: 64, baseDef: 58, baseSpAtk: 80, baseSpDef: 65, baseSpd: 80, captureRate: 0.25,
    initStatsMax: { hp: 60, atk: 65, def: 60, spAtk: 80, spDef: 65, spd: 80 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 }, max: { hp: 4, atk: 3, def: 3, spAtk: 4, spDef: 3, spd: 4 } },
    learnset: [{ level: 1, moveId: "scratch" }, { level: 4, moveId: "ember" }, { level: 7, moveId: "fire_punch" }, { level: 12, moveId: "flamethrower" }, { level: 16, moveId: "flame_charge" }, { level: 22, moveId: "fire_spin" }],
    evolutions: [{ targetId: "ember_behemoth", condition: { type: "level", level: 36 } }]
  },
  ember_behemoth: {
    id: "ember_behemoth", dexNum: 3, name: "烈焰巨兽", element: "fire",
    baseHp: 78, baseAtk: 84, baseDef: 78, baseSpAtk: 109, baseSpDef: 85, baseSpd: 100, captureRate: 0.1,
    initStatsMax: { hp: 80, atk: 85, def: 80, spAtk: 110, spDef: 85, spd: 100 },
    growthPerLevel: { min: { hp: 3, atk: 2, def: 2, spAtk: 3, spDef: 2, spd: 3 }, max: { hp: 5, atk: 4, def: 3, spAtk: 5, spDef: 4, spd: 5 } },
    learnset: [{ level: 1, moveId: "flamethrower" }, { level: 36, moveId: "flare_blitz" }, { level: 45, moveId: "fire_blast" }, { level: 55, moveId: "eruption" }]
  },
  tide_siren: {
    id: "tide_siren", dexNum: 5, name: "海潮海妖", element: "water",
    baseHp: 59, baseAtk: 63, baseDef: 80, baseSpAtk: 65, baseSpDef: 80, baseSpd: 58, captureRate: 0.25,
    initStatsMax: { hp: 60, atk: 65, def: 80, spAtk: 65, spDef: 80, spd: 60 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 }, max: { hp: 4, atk: 3, def: 4, spAtk: 3, spDef: 4, spd: 3 } },
    learnset: [{ level: 1, moveId: "tackle" }, { level: 4, moveId: "water_gun" }, { level: 7, moveId: "aqua_jet" }, { level: 12, moveId: "hydro_pump" }, { level: 16, moveId: "bubble_beam" }, { level: 22, moveId: "waterfall" }],
    evolutions: [{ targetId: "tide_leviathan", condition: { type: "level", level: 36 } }]
  },
  tide_leviathan: {
    id: "tide_leviathan", dexNum: 6, name: "深海巨兽", element: "water",
    baseHp: 79, baseAtk: 83, baseDef: 100, baseSpAtk: 85, baseSpDef: 105, baseSpd: 78, captureRate: 0.1,
    initStatsMax: { hp: 80, atk: 85, def: 100, spAtk: 85, spDef: 105, spd: 80 },
    growthPerLevel: { min: { hp: 3, atk: 2, def: 3, spAtk: 2, spDef: 3, spd: 2 }, max: { hp: 5, atk: 4, def: 5, spAtk: 4, spDef: 5, spd: 3 } },
    learnset: [{ level: 1, moveId: "hydro_pump" }, { level: 36, moveId: "surf" }, { level: 45, moveId: "muddy_water" }, { level: 55, moveId: "water_spout" }]
  },
  forest_owl: {
    id: "forest_owl", dexNum: 8, name: "森羽鸮", element: "grass",
    baseHp: 60, baseAtk: 64, baseDef: 64, baseSpAtk: 80, baseSpDef: 80, baseSpd: 60, captureRate: 0.25,
    initStatsMax: { hp: 65, atk: 65, def: 65, spAtk: 80, spDef: 80, spd: 60 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 }, max: { hp: 4, atk: 3, def: 3, spAtk: 4, spDef: 4, spd: 3 } },
    learnset: [{ level: 1, moveId: "tackle" }, { level: 4, moveId: "wood_strike" }, { level: 7, moveId: "vine_whip" }, { level: 12, moveId: "leaf_storm" }, { level: 16, moveId: "razor_leaf" }, { level: 22, moveId: "seed_bomb" }],
    evolutions: [{ targetId: "mystic_owl", condition: { type: "level", level: 36 } }]
  },
  mystic_owl: {
    id: "mystic_owl", dexNum: 9, name: "幻林神鸮", element: "grass",
    baseHp: 80, baseAtk: 84, baseDef: 84, baseSpAtk: 105, baseSpDef: 105, baseSpd: 80, captureRate: 0.1,
    initStatsMax: { hp: 85, atk: 85, def: 85, spAtk: 105, spDef: 105, spd: 80 },
    growthPerLevel: { min: { hp: 3, atk: 2, def: 2, spAtk: 3, spDef: 3, spd: 2 }, max: { hp: 5, atk: 4, def: 4, spAtk: 5, spDef: 5, spd: 3 } },
    learnset: [{ level: 1, moveId: "leaf_storm" }, { level: 36, moveId: "energy_ball" }, { level: 45, moveId: "wood_hammer" }, { level: 55, moveId: "synthesis" }]
  },
  titan_golem: {
    id: "titan_golem", dexNum: 11, name: "泰坦石像", element: "rock",
    baseHp: 70, baseAtk: 95, baseDef: 110, baseSpAtk: 50, baseSpDef: 60, baseSpd: 40, captureRate: 0.2,
    initStatsMax: { hp: 75, atk: 100, def: 115, spAtk: 50, spDef: 60, spd: 40 },
    growthPerLevel: { min: { hp: 3, atk: 3, def: 3, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 5, atk: 5, def: 5, spAtk: 2, spDef: 2, spd: 2 } },
    learnset: [{ level: 1, moveId: "rock_throw" }, { level: 10, moveId: "rock_slide" }, { level: 25, moveId: "stone_edge" }, { level: 40, moveId: "head_smash" }]
  },
  steel_eagle: {
    id: "steel_eagle", dexNum: 13, name: "钢铁战鹰", element: "steel",
    baseHp: 65, baseAtk: 90, baseDef: 100, baseSpAtk: 50, baseSpDef: 60, baseSpd: 85, captureRate: 0.2,
    initStatsMax: { hp: 70, atk: 95, def: 105, spAtk: 50, spDef: 60, spd: 85 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 2, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 4, atk: 4, def: 4, spAtk: 2, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "scratch" }, { level: 11, moveId: "iron_head" }, { level: 20, moveId: "steel_wing" }, { level: 35, moveId: "heavy_slam" }]
  },
  phantom_lord: {
    id: "phantom_lord", dexNum: 15, name: "幽冥领主", element: "ghost",
    baseHp: 55, baseAtk: 50, baseDef: 50, baseSpAtk: 115, baseSpDef: 115, baseSpd: 105, captureRate: 0.15,
    initStatsMax: { hp: 60, atk: 50, def: 50, spAtk: 115, spDef: 115, spd: 105 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 1, spAtk: 3, spDef: 3, spd: 3 }, max: { hp: 4, atk: 2, def: 2, spAtk: 5, spDef: 5, spd: 5 } },
    learnset: [{ level: 1, moveId: "shadow_ball" }, { level: 30, moveId: "soul_reaper" }, { level: 45, moveId: "phantom_force" }]
  },
  glacier_bear: {
    id: "glacier_bear", dexNum: 17, name: "冰河巨熊", element: "ice",
    baseHp: 85, baseAtk: 95, baseDef: 85, baseSpAtk: 80, baseSpDef: 80, baseSpd: 70, captureRate: 0.2,
    initStatsMax: { hp: 90, atk: 100, def: 90, spAtk: 80, spDef: 80, spd: 70 },
    growthPerLevel: { min: { hp: 3, atk: 3, def: 2, spAtk: 2, spDef: 2, spd: 2 }, max: { hp: 5, atk: 5, def: 4, spAtk: 3, spDef: 3, spd: 3 } },
    learnset: [{ level: 1, moveId: "ice_beam" }, { level: 28, moveId: "ice_punch" }, { level: 42, moveId: "blizzard" }]
  },
  thunder_rat: {
    id: "thunder_rat", dexNum: 19, name: "迅雷电鼠", element: "electric",
    baseHp: 60, baseAtk: 90, baseDef: 60, baseSpAtk: 90, baseSpDef: 80, baseSpd: 110, captureRate: 0.15,
    initStatsMax: { hp: 65, atk: 90, def: 60, spAtk: 90, spDef: 80, spd: 110 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 1, spAtk: 2, spDef: 1, spd: 3 }, max: { hp: 4, atk: 4, def: 2, spAtk: 4, spDef: 3, spd: 5 } },
    learnset: [{ level: 1, moveId: "thunderbolt" }, { level: 20, moveId: "volt_tackle" }, { level: 40, moveId: "thunder" }]
  },
  thorn_mantis: {
    id: "thorn_mantis", dexNum: 21, name: "荆棘螳螂", element: "bug",
    baseHp: 65, baseAtk: 95, baseDef: 75, baseSpAtk: 45, baseSpDef: 60, baseSpd: 85, captureRate: 0.25,
    initStatsMax: { hp: 70, atk: 100, def: 80, spAtk: 45, spDef: 60, spd: 85 },
    growthPerLevel: { min: { hp: 2, atk: 3, def: 2, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 4, atk: 5, def: 3, spAtk: 2, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "bug_bite" }, { level: 15, moveId: "x_scissor" }, { level: 30, moveId: "megahorn" }]
  },
  loyal_hound: {
    id: "loyal_hound", dexNum: 23, name: "忠诚猎犬", element: "normal",
    baseHp: 75, baseAtk: 85, baseDef: 70, baseSpAtk: 60, baseSpDef: 70, baseSpd: 90, captureRate: 0.2,
    initStatsMax: { hp: 80, atk: 90, def: 75, spAtk: 60, spDef: 70, spd: 90 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 2, spAtk: 1, spDef: 2, spd: 2 }, max: { hp: 4, atk: 4, def: 3, spAtk: 2, spDef: 3, spd: 4 } },
    learnset: [{ level: 1, moveId: "quick_attack" }, { level: 20, moveId: "body_slam" }, { level: 35, moveId: "double_edge" }]
  },
  earth_boar: {
    id: "earth_boar", dexNum: 25, name: "大地战猪", element: "ground",
    baseHp: 100, baseAtk: 90, baseDef: 85, baseSpAtk: 60, baseSpDef: 70, baseSpd: 65, captureRate: 0.2,
    initStatsMax: { hp: 105, atk: 95, def: 90, spAtk: 60, spDef: 70, spd: 65 },
    growthPerLevel: { min: { hp: 3, atk: 2, def: 2, spAtk: 1, spDef: 1, spd: 1 }, max: { hp: 5, atk: 4, def: 4, spAtk: 2, spDef: 2, spd: 3 } },
    learnset: [{ level: 1, moveId: "bulldoze" }, { level: 24, moveId: "earthquake" }, { level: 40, moveId: "high_horsepower" }]
  },
  toxic_cobra: {
    id: "toxic_cobra", dexNum: 27, name: "剧毒眼镜蛇", element: "poison",
    baseHp: 65, baseAtk: 95, baseDef: 60, baseSpAtk: 65, baseSpDef: 70, baseSpd: 100, captureRate: 0.2,
    initStatsMax: { hp: 70, atk: 100, def: 60, spAtk: 65, spDef: 70, spd: 100 },
    growthPerLevel: { min: { hp: 2, atk: 3, def: 1, spAtk: 1, spDef: 1, spd: 3 }, max: { hp: 4, atk: 5, def: 2, spAtk: 2, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "poison_fang" }, { level: 22, moveId: "cross_poison" }, { level: 38, moveId: "gunk_shot" }]
  },
  midnight_wolf: {
    id: "midnight_wolf", dexNum: 29, name: "午夜凶狼", element: "dark",
    baseHp: 70, baseAtk: 105, baseDef: 70, baseSpAtk: 80, baseSpDef: 70, baseSpd: 105, captureRate: 0.15,
    initStatsMax: { hp: 75, atk: 110, def: 75, spAtk: 80, spDef: 70, spd: 105 },
    growthPerLevel: { min: { hp: 2, atk: 3, def: 2, spAtk: 2, spDef: 2, spd: 3 }, max: { hp: 4, atk: 5, def: 3, spAtk: 3, spDef: 3, spd: 5 } },
    learnset: [{ level: 1, moveId: "night_slash" }, { level: 26, moveId: "dark_crunch" }, { level: 42, moveId: "foul_play" }]
  },
  dream_eater_tapir: {
    id: "dream_eater_tapir", dexNum: 31, name: "食梦神貘", element: "psychic",
    baseHp: 85, baseAtk: 60, baseDef: 70, baseSpAtk: 100, baseSpDef: 100, baseSpd: 65, captureRate: 0.15,
    initStatsMax: { hp: 90, atk: 60, def: 70, spAtk: 105, spDef: 105, spd: 65 },
    growthPerLevel: { min: { hp: 3, atk: 1, def: 2, spAtk: 3, spDef: 3, spd: 1 }, max: { hp: 5, atk: 2, def: 3, spAtk: 5, spDef: 5, spd: 3 } },
    learnset: [{ level: 1, moveId: "psybeam" }, { level: 28, moveId: "psychic" }, { level: 40, moveId: "dream_eater" }]
  },
  moon_nymph: {
    id: "moon_nymph", dexNum: 33, name: "皎月仙女", element: "fairy",
    baseHp: 75, baseAtk: 60, baseDef: 75, baseSpAtk: 105, baseSpDef: 110, baseSpd: 85, captureRate: 0.15,
    initStatsMax: { hp: 80, atk: 60, def: 75, spAtk: 110, spDef: 115, spd: 85 },
    growthPerLevel: { min: { hp: 2, atk: 1, def: 2, spAtk: 3, spDef: 3, spd: 2 }, max: { hp: 4, atk: 2, def: 3, spAtk: 5, spDef: 5, spd: 4 } },
    learnset: [{ level: 1, moveId: "draining_kiss" }, { level: 25, moveId: "dazzling_gleam" }, { level: 45, moveId: "moonblast" }]
  },
  armored_dragon: {
    id: "armored_dragon", dexNum: 35, name: "重甲鳞龙", element: "dragon",
    baseHp: 75, baseAtk: 85, baseDef: 70, baseSpAtk: 65, baseSpDef: 70, baseSpd: 75, captureRate: 0.1,
    initStatsMax: { hp: 80, atk: 90, def: 75, spAtk: 65, spDef: 70, spd: 75 },
    growthPerLevel: { min: { hp: 2, atk: 2, def: 2, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 4, atk: 4, def: 3, spAtk: 2, spDef: 3, spd: 3 } },
    learnset: [{ level: 1, moveId: "dragon_claw" }, { level: 30, moveId: "dragon_pulse" }, { level: 42, moveId: "dragon_rush" }],
    evolutions: [{ targetId: "apex_dragon", condition: { type: "level", level: 50 } }]
  },
  apex_dragon: {
    id: "apex_dragon", dexNum: 36, name: "霸主苍龙", element: "dragon",
    baseHp: 100, baseAtk: 125, baseDef: 100, baseSpAtk: 105, baseSpDef: 100, baseSpd: 90, captureRate: 0.05,
    initStatsMax: { hp: 105, atk: 130, def: 105, spAtk: 110, spDef: 105, spd: 90 },
    growthPerLevel: { min: { hp: 3, atk: 3, def: 3, spAtk: 2, spDef: 2, spd: 2 }, max: { hp: 5, atk: 5, def: 4, spAtk: 4, spDef: 4, spd: 4 } },
    learnset: [{ level: 1, moveId: "dragon_rush" }, { level: 50, moveId: "outrage" }, { level: 60, moveId: "draco_meteor" }]
  },
  martial_hound: {
    id: "martial_hound", dexNum: 38, name: "武道神犬", element: "fighting",
    baseHp: 75, baseAtk: 110, baseDef: 70, baseSpAtk: 55, baseSpDef: 70, baseSpd: 95, captureRate: 0.15,
    initStatsMax: { hp: 80, atk: 115, def: 75, spAtk: 55, spDef: 70, spd: 95 },
    growthPerLevel: { min: { hp: 2, atk: 3, def: 2, spAtk: 1, spDef: 1, spd: 2 }, max: { hp: 4, atk: 5, def: 3, spAtk: 2, spDef: 2, spd: 4 } },
    learnset: [{ level: 1, moveId: "mach_punch" }, { level: 25, moveId: "close_combat" }, { level: 40, moveId: "high_jump_kick" }]
  },
  storm_falcon: {
    id: "storm_falcon", dexNum: 40, name: "风暴猎隼", element: "flying",
    baseHp: 70, baseAtk: 95, baseDef: 65, baseSpAtk: 70, baseSpDef: 65, baseSpd: 115, captureRate: 0.15,
    initStatsMax: { hp: 75, atk: 100, def: 70, spAtk: 75, spDef: 70, spd: 120 },
    growthPerLevel: { min: { hp: 2, atk: 3, def: 1, spAtk: 2, spDef: 1, spd: 3 }, max: { hp: 4, atk: 4, def: 2, spAtk: 3, spDef: 2, spd: 5 } },
    learnset: [{ level: 1, moveId: "aerial_ace" }, { level: 22, moveId: "air_slash" }, { level: 38, moveId: "brave_bird" }]
  }
};

export const STARTERS = ["sprout_owl", "ember_marmot", "tide_newt"] as const;

export const THEME_TABLE: Record<string, string[]> = {
  grass: ["sprout_owl", "leaf_bug", "fluff_dog", "fairy_sprite"],
  cave: ["rock_golem", "iron_bird", "spark_mouse", "scale_drake", "mud_pig"],
  coast: ["tide_newt", "iron_bird", "gale_hawk"],
  forest: ["sprout_owl", "leaf_bug", "venom_snake", "fluff_dog", "gale_hawk"],
  lake: ["tide_newt", "mud_pig"],
  volcano: ["ember_marmot", "rock_golem", "brawl_pup"],
  mansion: ["shadow_spirit", "shadow_fox", "mind_tapir"],
  snowfield: ["frost_cub", "brawl_pup"]
};

export const LOCATIONS: Record<LocationId, LocationSpec> = {
  town_starter: {
    id: "town_starter",
    name: "初心镇",
    desc: "旅程开始的宁静小镇，微风中夹杂着草木的清香。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_basic", "potion_small", "heal_antidote", "berry_oran"],
    npcs: [
      { id: "mayor", name: "镇长", dialog: ["欢迎来到这个世界，勇敢的旅行者！", "带着你的伙伴去广阔的世界看看吧。", "初心镇虽然小，但却是最温暖的家。"] },
      { id: "bug_catcher", name: "捕虫少年", dialog: ["镇外的微风林道里有很多草系和虫系的怪物！", "记得多买点捕获器，不然遇到稀有幻兽就亏大了。"] },
      { id: "mom", name: "妈妈", dialog: ["路上小心，记得带上伤药。", "如果幻兽受伤了，一定要带它们去恢复中心哦。"] }
    ],
    wildAreas: [
      { id: "wild_starter", name: "微风林道", desc: "充满草属性与虫属性怪物的茂密森林小路。", levelMin: 1, levelMax: 5, encounters: ["grass"] },
      { id: "wild_starter_pond", name: "镇后小池", desc: "镇子后方的一口清澈小池塘，能看到水属性幻兽的踪迹。", levelMin: 3, levelMax: 6, encounters: ["lake"] }
    ]
  },
  city_pebble: {
    id: "city_pebble",
    name: "坚石市",
    desc: "依山而建的繁华都市，这里有商店和充足的补给。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_basic", "capsule_prism", "potion_small", "potion_medium", "heal_antidote", "heal_paralyze", "stone_fire"],
    npcs: [
      { id: "miner", name: "矿工", dialog: ["城外的回音洞窟里有很多坚硬的家伙。", "如果没有带够伤药，可别轻易进去。"] },
      { id: "hiker", name: "登山家", dialog: ["碎石山道虽然难走，但那里的火系幻兽可是非常有活力的！", "听说有人在山道深处见过发光的石头。"] },
      { id: "shopkeeper", name: "商人", dialog: ["欢迎光临坚石市！我们这里的特产是火之石，能让特定幻兽进化哦。"] }
    ],
    wildAreas: [
      { id: "wild_pebble", name: "回音洞窟一层", desc: "漆黑且错综复杂的地下洞穴。", levelMin: 6, levelMax: 12, encounters: ["cave"] },
      { id: "wild_pebble_mountain", name: "碎石山道", desc: "崎岖陡峭的山路，偶尔会有落石。", levelMin: 8, levelMax: 15, encounters: ["volcano"] }
    ]
  },
  town_leafy: {
    id: "town_leafy",
    name: "绿叶镇",
    desc: "被茂密树冠覆盖的静谧村落。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_prism", "potion_medium", "heal_paralyze", "heal_awake", "berry_sitrus", "stone_leaf"],
    npcs: [
      { id: "herbalist", name: "采药人", dialog: ["树林深处能采到很多珍贵的药草。", "传说那里住着能治愈一切的幻兽。"] },
      { id: "ranger", name: "护林员", dialog: ["幽暗林穴里容易让人迷路，请务必小心。", "带点解眠药吧，那里的孢子会让人昏睡。"] }
    ],
    wildAreas: [
      { id: "wild_leafy", name: "繁茂密林", desc: "阳光难以穿透的深邃森林。", levelMin: 12, levelMax: 18, encounters: ["forest"] },
      { id: "wild_leafy_cave", name: "幽暗林穴", desc: "长满发光苔藓的地下洞穴。", levelMin: 15, levelMax: 20, encounters: ["cave", "forest"] }
    ]
  },
  city_spring: {
    id: "city_spring",
    name: "涌泉市",
    desc: "以水系生态闻名的美丽水都。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_prism", "capsule_ultra", "potion_medium", "potion_large", "heal_burn", "berry_lum", "stone_water"],
    npcs: [
      { id: "sailor", name: "水手", dialog: ["出海之前，必须做好充足的准备。", "海里的家伙们可不好惹。"] },
      { id: "fisher", name: "渔夫", dialog: ["海风沙滩可是钓鱼的好地方！", "有时候甚至能钓到奇怪的道具呢。"] },
      { id: "swimmer", name: "游泳者", dialog: ["水之石是我们涌泉市的特产，多买几块准没错！"] }
    ],
    wildAreas: [
      { id: "wild_spring", name: "静谧湖泊", desc: "湖水清澈见底，水系幻兽的乐园。", levelMin: 18, levelMax: 25, encounters: ["lake"] },
      { id: "wild_spring_coast", name: "海风沙滩", desc: "海浪拍打着金色的沙滩，能遇到许多水属性幻兽。", levelMin: 20, levelMax: 28, encounters: ["coast"] }
    ]
  },
  town_sun: {
    id: "town_sun",
    name: "烈阳镇",
    desc: "终年高温，居民们充满热情。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_ultra", "potion_large", "heal_burn", "stone_fire", "stone_thunder", "amulet_coin"],
    npcs: [
      { id: "tourist", name: "游客", dialog: ["这里的阳光太刺眼了，我快融化了。", "不过据说火系幻兽非常喜欢这里。"] },
      { id: "firebreather", name: "喷火者", dialog: ["炽热火山的岩浆温度极高，一定要带足烧伤药！", "雷之石也是这附近的特产。"] }
    ],
    wildAreas: [
      { id: "wild_sun", name: "炽热火山", desc: "岩浆翻滚，危险与机遇并存。", levelMin: 25, levelMax: 35, encounters: ["volcano"] },
      { id: "wild_sun_coast", name: "阳光沙滩", desc: "烈日下的海岸线，海水都被晒得温热。", levelMin: 28, levelMax: 38, encounters: ["coast"] }
    ]
  },
  city_shadow: {
    id: "city_shadow",
    name: "幽影市",
    desc: "常年不见阳光的暗淡城市，充满神秘色彩。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_ultra", "potion_large", "potion_max", "heal_awake", "exp_share"],
    npcs: [
      { id: "occultist", name: "灵媒", dialog: ["你听到了吗？洋馆里的低语...", "幽灵系幻兽最喜欢和人开玩笑了。"] },
      { id: "hex_maniac", name: "咒术师", dialog: ["迷雾沼泽里常有奇怪的光影闪烁。", "不要盯着看太久，否则会被吸进去的..."] }
    ],
    wildAreas: [
      { id: "wild_shadow", name: "废弃洋馆", desc: "空无一人的古老建筑，充满未知的恐惧。", levelMin: 35, levelMax: 45, encounters: ["mansion"] },
      { id: "wild_shadow_swamp", name: "迷雾沼泽", desc: "泥泞不堪的暗色沼泽，常年被毒雾笼罩。", levelMin: 38, levelMax: 48, encounters: ["forest", "mansion"] }
    ]
  },
  town_winter: {
    id: "town_winter",
    name: "凛冬镇",
    desc: "被白雪覆盖的寒冷城镇。",
    hasCenter: true,
    hasShop: true,
    shop: ["capsule_ultra", "capsule_master", "potion_max", "heal_ice", "berry_lum", "berry_sitrus"],
    npcs: [
      { id: "skier", name: "滑雪者", dialog: ["这么冷的天气，只有冰系幻兽才愿意出门吧。", "记得多买点解冻药，被冻住可就麻烦了。"] },
      { id: "boarder", name: "单板手", dialog: ["冰晶洞窟深处有着极度稀有的幻兽！", "准备好大师捕获器了吗？"] }
    ],
    wildAreas: [
      { id: "wild_winter", name: "极寒雪原", desc: "风雪交加，视线模糊。", levelMin: 45, levelMax: 60, encounters: ["snowfield"] },
      { id: "wild_winter_cave", name: "冰晶洞窟", desc: "由不化的坚冰构成的美丽洞穴。", levelMin: 50, levelMax: 65, encounters: ["cave", "snowfield"] }
    ]
  }
};
