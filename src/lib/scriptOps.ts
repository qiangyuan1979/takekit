/**
 * 剧本单元的纯函数工具：id 生成、集/场/对白工厂、场号重排、排序、占位收集。
 *
 * 这里不碰 store，也不做任何 IO——所有写回都由 `store` 的 mutate 完成，
 * 便于单独测试这些容易出错的顺序与编号逻辑。
 */

import type { Dialogue, Episode, Project, Scene } from "./types";

/** 实体 id：前缀 + 随机串，便于在日志与调试器里一眼看出类型。 */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export function makeDialogue(patch: Partial<Dialogue> = {}): Dialogue {
  return { characterId: "", text: "", isNarration: false, ...patch };
}

export function makeScene(patch: Partial<Scene> = {}): Scene {
  return {
    id: newId("scene"),
    no: 0,
    location: "",
    timeOfDay: "",
    interior: true,
    characters: [],
    actionDesc: "",
    dialogues: [],
    shots: [],
    ...patch,
  };
}

export function makeEpisode(no: number, patch: Partial<Episode> = {}): Episode {
  return {
    id: newId("ep"),
    no,
    title: "",
    summary: "",
    beats: [],
    scenes: [],
    ...patch,
  };
}

/** 场号连续化为 1..n：删场之后必须调用，否则第 4 步拆镜的场号会断档。 */
export function renumberScenes(scenes: Scene[]): Scene[] {
  return scenes.map((scene, index) =>
    scene.no === index + 1 ? scene : { ...scene, no: index + 1 },
  );
}

/** 集号连续化为 1..n。 */
export function renumberEpisodes(episodes: Episode[]): Episode[] {
  return episodes.map((episode, index) =>
    episode.no === index + 1 ? episode : { ...episode, no: index + 1 },
  );
}

/** 场上移/下移一位；越界时原样返回（不循环，避免新手误操作把场挪到另一端）。 */
export function moveScene(scenes: Scene[], sceneId: string, delta: number): Scene[] {
  const from = scenes.findIndex((scene) => scene.id === sceneId);
  if (from < 0) return scenes;
  const to = from + delta;
  if (to < 0 || to >= scenes.length) return scenes;

  const next = [...scenes];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumberScenes(next);
}

/** C 段出现过的全部角色引用（去重，保留首次出现顺序）。 */
export function collectCharacterRefs(project: Project): string[] {
  const seen: string[] = [];
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const name of scene.characters) {
        const trimmed = name.trim();
        if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
      }
    }
  }
  return seen;
}

/**
 * D 段待办：C 段引用了、但资产里还没有对应角色卡的引用。
 *
 * 匹配口径是 `id | name | aliases` 三者任一命中，因为在第 3 步补全之前，
 * C 段里写的通常只是占位名。
 */
export function undefinedCharacterRefs(project: Project): string[] {
  const known = new Set<string>();
  for (const character of project.assets.characters) {
    for (const key of [character.id, character.name, ...character.aliases]) {
      const trimmed = key.trim();
      if (trimmed) known.add(trimmed);
    }
  }
  return collectCharacterRefs(project).filter((ref) => !known.has(ref));
}

// ---------- 纯文本粘贴导入 ----------

/** 时间词按长度降序，保证「深夜」先于「夜」命中。 */
const TIME_WORDS = [
  "清晨",
  "早晨",
  "上午",
  "中午",
  "午后",
  "下午",
  "黄昏",
  "傍晚",
  "深夜",
  "凌晨",
  "白天",
  "夜",
  "日",
].sort((a, b) => b.length - a.length);

const INTERIOR_WORDS = ["内景", "室内"];
const EXTERIOR_WORDS = ["外景", "室外"];

/** 这些标签后面跟的内容不是台词，而是场头信息，并入动作描述。 */
const FIELD_LABELS = new Set([
  "人物",
  "角色",
  "出场",
  "出场人物",
  "地点",
  "时间",
  "场景",
  "景别",
  "道具",
  "音效",
  "备注",
]);

/** 旁白类说话人：写进对白列表但标记为旁白，不占用角色位。 */
const NARRATION_LABELS = new Set(["旁白", "画外音", "内心", "心声", "OS", "VO", "os", "vo"]);

const DIALOGUE_PATTERN = /^([^：:]{1,12})[：:](.+)$/;

interface SceneHeader {
  interior: boolean;
  timeOfDay: string;
  location: string;
}

/** 解析场头，如「第 2 场 外景 街道 黄昏」「内景 客厅 夜」。 */
function parseSceneHeader(raw: string): SceneHeader {
  let text = raw
    .trim()
    .replace(/^第\s*\d+\s*场\s*[·:：、.．-]*/, "")
    .replace(/^场\s*\d+\s*[·:：、.．-]*/, "")
    .replace(/^\d+\s*[·:：、.．-]+/, "");

  let interior = true;
  for (const word of EXTERIOR_WORDS) {
    if (text.includes(word)) {
      interior = false;
      text = text.replace(word, " ");
      break;
    }
  }
  if (interior) {
    for (const word of INTERIOR_WORDS) {
      if (text.includes(word)) {
        text = text.replace(word, " ");
        break;
      }
    }
  }

  let timeOfDay = "";
  for (const word of TIME_WORDS) {
    if (text.includes(word)) {
      timeOfDay = word;
      text = text.replace(word, " ");
      break;
    }
  }

  const location = text.replace(/[·|｜/\\,，、\s]+/g, " ").trim();
  return { interior, timeOfDay, location };
}

/**
 * 把粘贴进来的纯文本按空行切成「场」。
 *
 * 约定（也写在界面的导入提示里）：每块首行是场头，其余行形如「角色：台词」
 * 的算对白，其余并进动作描述。文件解析（.txt/.docx）归 v1.5，这里只做纯文本。
 */
export function parseScenesFromText(text: string): Scene[] {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const [headerLine = "", ...bodyLines] = lines;
    const header = parseSceneHeader(headerLine);

    const dialogues: Dialogue[] = [];
    const actionParts: string[] = [];

    for (const line of bodyLines) {
      const matched = line.match(DIALOGUE_PATTERN);
      const speaker = matched?.[1]?.trim() ?? "";
      if (matched && FIELD_LABELS.has(speaker)) {
        actionParts.push(line);
        continue;
      }
      if (matched) {
        const isNarration = NARRATION_LABELS.has(speaker);
        dialogues.push(
          makeDialogue({ characterId: speaker, text: matched[2].trim(), isNarration }),
        );
        continue;
      }
      actionParts.push(line);
    }

    const characters = [
      ...new Set(
        dialogues
          .filter((dialogue) => !dialogue.isNarration)
          .map((dialogue) => dialogue.characterId)
          .filter(Boolean),
      ),
    ];

    return makeScene({
      no: index + 1,
      location: header.location,
      timeOfDay: header.timeOfDay,
      interior: header.interior,
      characters,
      actionDesc: actionParts.join("\n"),
      dialogues,
    });
  });
}
