/**
 * 后期出片（第 8 步）的纯函数工具：配音句 / 字幕 / 四轨时间线 / 对口型的派生，
 * 配音任务与作业的互转，TTS 事件归并，BGM 与音效的挂接，导出预设。
 *
 * 和其它 `*Ops` 一样，这里不碰 store、不做 IO、不发请求。所有派生都以
 * 「结构化分镜 + 采用片段 + 角色音色」为唯一输入（spec §5.8 的衔接约定），
 * 因此每一步都是幂等的：只要上游没变，重跑一次得到的还是同一批对象
 * （逐项做引用相等判定，避免连带触发脏标记与落盘）。
 */

import { applyGenerateEvent, clipOf } from "./generateOps";
import { newId } from "./scriptOps";
import type {
  AspectRatio,
  BgmTrack,
  GenerateEvent,
  LipsyncCue,
  Material,
  Post,
  Project,
  Scene,
  SfxCue,
  Shot,
  SubtitleCue,
  Task,
  TimelineClip,
  TtsEvent,
  VoiceJob,
  VoiceLine,
} from "./types";

// ---------- 通用小工具 ----------

function sameRefArray<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** 按 id | 名字 | 别名三种口径找角色卡（与 `scriptOps` 的匹配口径一致）。 */
function findCharacter(project: Project, ref: string) {
  const key = ref.trim();
  if (!key) return undefined;
  return project.assets.characters.find(
    (character) =>
      character.id === key ||
      character.name === key ||
      character.aliases.some((alias) => alias.trim() === key),
  );
}

/** 某句的说话人：拆镜时把说话人写在 `shot.characters[0]`。 */
function speakerRef(shot: Shot): string {
  return trimmed(shot.characters[0]);
}

/** 目标音色：角色卡快照优先，缺省退回立项默认音色。 */
function voiceFor(project: Project, characterId: string): string {
  const character = findCharacter(project, characterId);
  return character?.voice.trim() || project.meta.defaultVoice;
}

// ---------- 配音句派生（spec §5.8.1） ----------

/** 一句配音的稳定键：同一镜的对白 / 旁白各占一句。 */
export function voiceLineKey(shotId: string, isNarration: boolean): string {
  return `${shotId}:${isNarration ? "narration" : "dialogue"}`;
}

function makeVoiceLine(patch: Partial<VoiceLine> & Pick<VoiceLine, "id">): VoiceLine {
  return {
    episodeId: "",
    sceneId: "",
    shotId: "",
    shotNo: 0,
    characterId: "",
    text: "",
    isNarration: false,
    voice: "",
    emotion: "",
    speed: 1,
    pauseMs: 0,
    audioPath: null,
    durationMs: 0,
    ...patch,
  };
}

interface DerivedLine {
  episodeId: string;
  sceneId: string;
  shotId: string;
  shotNo: number;
  characterId: string;
  text: string;
  isNarration: boolean;
}

/**
 * 由分镜的 `dialogue` / `narration` 逐句派生配音句。
 *
 * 复用口径：同一镜同类型、且文本未变 → 原样保留旧对象（保住已生成的音频、
 * 用户调过的语速与情绪）；文本变了则视作新句，旧音频成为无引用文件。
 * 分镜里删掉的台词，这里也会跟着消失。
 */
export function deriveVoiceLines(
  project: Project,
  existing: VoiceLine[] = project.post.voiceLines,
): VoiceLine[] {
  const byKey = new Map(
    existing.map((line) => [voiceLineKey(line.shotId, line.isNarration), line]),
  );
  const result: VoiceLine[] = [];

  let shotNo = 0;
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        shotNo += 1;
        const dialogue = trimmed(shot.dialogue);
        const narration = trimmed(shot.narration);
        if (dialogue) {
          result.push(
            resolveVoiceLine(project, byKey, {
              episodeId: episode.id,
              sceneId: scene.id,
              shotId: shot.id,
              shotNo,
              characterId: speakerRef(shot),
              text: dialogue,
              isNarration: false,
            }),
          );
        }
        if (narration) {
          result.push(
            resolveVoiceLine(project, byKey, {
              episodeId: episode.id,
              sceneId: scene.id,
              shotId: shot.id,
              shotNo,
              characterId: "",
              text: narration,
              isNarration: true,
            }),
          );
        }
      }
    }
  }

  return sameRefArray(existing, result) ? existing : result;
}

function resolveVoiceLine(
  project: Project,
  byKey: Map<string, VoiceLine>,
  derived: DerivedLine,
): VoiceLine {
  const previous = byKey.get(voiceLineKey(derived.shotId, derived.isNarration));
  if (previous && previous.text === derived.text) return previous;
  return makeVoiceLine({
    id: previous?.id ?? newId("voice"),
    ...derived,
    voice: voiceFor(project, derived.characterId),
  });
}

/** 还没生成音频的配音句（提交前判断"有没有要跑的"）。 */
export function pendingVoiceLines(project: Project): VoiceLine[] {
  return project.post.voiceLines.filter((line) => line.text.trim() && !line.audioPath);
}

// ---------- 配音任务与作业 ----------

/** `Task.request`（kind = `tts`）里的载荷；`voiceJobFromTask` 从它读出作业。 */
export interface VoiceTaskRequest {
  voiceLineId: string;
  text: string;
  voice: string;
  emotion: string;
  speed: number;
}

export function makeVoiceTask(provider: string, line: VoiceLine, now = new Date()): Task {
  const request: VoiceTaskRequest = {
    voiceLineId: line.id,
    text: line.text,
    voice: line.voice,
    emotion: line.emotion,
    speed: line.speed,
  };
  return {
    id: newId("task"),
    kind: "tts",
    provider,
    request,
    status: "queued",
    result: null,
    error: null,
    createdAt: now.toISOString(),
  };
}

export function voiceTaskRequest(task: Task): VoiceTaskRequest | null {
  if (task.kind !== "tts") return null;
  const request = task.request as Partial<VoiceTaskRequest> | null;
  if (!request || typeof request !== "object") return null;
  if (typeof request.voiceLineId !== "string" || typeof request.text !== "string") return null;
  return request as VoiceTaskRequest;
}

export function voiceJobFromTask(task: Task): VoiceJob | null {
  const request = voiceTaskRequest(task);
  if (!request) return null;
  return {
    taskId: task.id,
    voiceLineId: request.voiceLineId,
    request: {
      text: request.text,
      voice: request.voice,
      emotion: request.emotion,
      speed: request.speed,
    },
  };
}

export function voiceJobsFromTasks(tasks: Task[]): VoiceJob[] {
  const jobs: VoiceJob[] = [];
  for (const task of tasks) {
    const job = voiceJobFromTask(task);
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * 选出要提交的配音句：传了 id 就按 id（单独重生成）；没传就挑还没音频的整批。
 */
export function planVoiceTasks(
  project: Project,
  voiceLineIds: string[],
  provider: string,
  now = new Date(),
): Task[] {
  const wanted = new Set(voiceLineIds);
  const lines =
    voiceLineIds.length > 0
      ? project.post.voiceLines.filter((line) => wanted.has(line.id))
      : pendingVoiceLines(project);
  return lines.filter((line) => line.text.trim()).map((line) => makeVoiceTask(provider, line, now));
}

/**
 * 把一条配音事件写回项目：同时更新任务状态与配音句的音频引用。
 *
 * 事件里没有 `clipPath`，这里翻译成生成环节同形的 `GenerateEvent`，
 * 复用同一套任务归并逻辑；配音句只在成功时接收音频。
 */
export function applyTtsEvent(project: Project, event: TtsEvent): Project {
  const generated: GenerateEvent = {
    taskId: event.taskId,
    status: event.status,
    clipPath: event.audioPath ?? null,
    mime: event.mime ?? null,
    error: event.error ?? null,
    errorCode: event.errorCode ?? null,
    errorArgs: event.errorArgs ?? null,
  };
  const tasks = applyGenerateEvent(project.tasks, generated);

  let touched = false;
  const voiceLines =
    event.status === "succeeded" && typeof event.audioPath === "string"
      ? project.post.voiceLines.map((line) => {
          if (line.id !== event.voiceLineId) return line;
          if (line.audioPath === event.audioPath && line.durationMs === event.durationMs) {
            return line;
          }
          touched = true;
          return { ...line, audioPath: event.audioPath as string, durationMs: event.durationMs };
        })
      : project.post.voiceLines;

  if (tasks === project.tasks && !touched) return project;
  return { ...project, tasks, post: { ...project.post, voiceLines } };
}

// ---------- 四轨时间线拼接（spec §5.8.5） ----------

/** 某镜采用的片段路径；没采用或任务还没成功时为 `null`。 */
export function adoptedClipPath(project: Project, shot: Shot): string | null {
  if (!shot.adoptedClipId) return null;
  const task = project.tasks.find((item) => item.id === shot.adoptedClipId);
  const clip = task ? clipOf(task) : null;
  return clip?.path ?? null;
}

function sameClip(left: TimelineClip, right: TimelineClip): boolean {
  return (
    left.id === right.id &&
    left.episodeId === right.episodeId &&
    left.sceneId === right.sceneId &&
    left.shotId === right.shotId &&
    left.shotNo === right.shotNo &&
    left.clipPath === right.clipPath &&
    left.startMs === right.startMs &&
    left.durationMs === right.durationMs &&
    left.transition === right.transition
  );
}

/**
 * 按集 / 场 / 镜序把「已采用片段」拼成片段轨：起始时间从 0 起累加，
 * 转场取自分镜的「转场」字段；没采用片段的镜头直接跳过（不占时长）。
 * 已存在的同镜片段沿用其 id，便于字幕 / 对口型等下游保持引用稳定。
 */
export function buildTimeline(
  project: Project,
  existing: TimelineClip[] = project.post.timeline,
): TimelineClip[] {
  const byShot = new Map(existing.map((clip) => [clip.shotId, clip]));
  const result: TimelineClip[] = [];

  let startMs = 0;
  let shotNo = 0;
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        shotNo += 1;
        const clipPath = adoptedClipPath(project, shot);
        if (!clipPath) continue;

        const durationMs = Math.max(0, shot.durationMs);
        const previous = byShot.get(shot.id);
        const next: TimelineClip = {
          id: previous?.id ?? newId("tl"),
          episodeId: episode.id,
          sceneId: scene.id,
          shotId: shot.id,
          shotNo,
          clipPath,
          startMs,
          durationMs,
          transition: shot.transition,
        };
        result.push(previous && sameClip(previous, next) ? previous : next);
        startMs += durationMs;
      }
    }
  }

  return sameRefArray(existing, result) ? existing : result;
}

/** 时间线总时长 = 最靠后的片段结束点。 */
export function timelineDurationMs(timeline: TimelineClip[]): number {
  return timeline.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
}

// ---------- 字幕（spec §5.8.3） ----------

/** 没有实测音频时长时的兜底估算：中文约 4 字 / 秒，留一个下限。 */
export function estimateSpeechMs(text: string): number {
  return Math.max(600, text.trim().length * 250);
}

/** 每镜在时间轴上的起点；不在时间线里的镜头退回"分镜时长累加"。 */
function shotStarts(project: Project, timeline: TimelineClip[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const clip of timeline) starts.set(clip.shotId, clip.startMs);

  let acc = 0;
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        if (!starts.has(shot.id)) starts.set(shot.id, acc);
        acc += Math.max(0, shot.durationMs);
      }
    }
  }
  return starts;
}

/**
 * 由配音句生成字幕时间轴：同一镜内多句依次顺排，起点对齐该镜在时间线上的位置。
 *
 * 文本未变的旧字幕原样保留——用户逐句微调过的起止时间不该被重算覆盖。
 */
export function deriveSubtitles(
  project: Project,
  voiceLines: VoiceLine[],
  timeline: TimelineClip[],
  existing: SubtitleCue[] = project.post.subtitles,
): SubtitleCue[] {
  const starts = shotStarts(project, timeline);
  const previousByLine = new Map(existing.map((cue) => [cue.voiceLineId, cue]));
  const offsetByShot = new Map<string, number>();
  const result: SubtitleCue[] = [];

  for (const line of voiceLines) {
    const text = line.text.trim();
    if (!text) continue;

    const offset = offsetByShot.get(line.shotId) ?? 0;
    const duration = line.durationMs > 0 ? line.durationMs : estimateSpeechMs(text);
    offsetByShot.set(line.shotId, offset + duration);

    const previous = previousByLine.get(line.id);
    if (previous && previous.text === text) {
      result.push(previous);
      continue;
    }

    const startMs = (starts.get(line.shotId) ?? 0) + offset;
    result.push({
      id: previous?.id ?? newId("sub"),
      episodeId: line.episodeId,
      voiceLineId: line.id,
      shotId: line.shotId,
      shotNo: line.shotNo,
      text,
      startMs,
      endMs: startMs + duration,
      enabled: previous?.enabled ?? true,
    });
  }

  return sameRefArray(existing, result) ? existing : result;
}

// ---------- 对口型（spec §5.8.2） ----------

/** 判定"这镜是否值得做口型"的确定性线索（没有专门字段，只能从分镜推）。 */
const FRONT_FACE_HINTS = ["正面", "口型", "开口", "说话", "对着镜头"];

export function hasFrontFaceCue(shot: Shot): boolean {
  if (shot.shotSize === "close_up" || shot.shotSize === "extreme_close_up") return true;
  const text = `${shot.visualDesc} ${shot.note}`;
  return FRONT_FACE_HINTS.some((hint) => text.includes(hint));
}

function shotIndex(project: Project): Map<string, Shot> {
  const map = new Map<string, Shot>();
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) map.set(shot.id, shot);
    }
  }
  return map;
}

function sameLipsync(left: LipsyncCue, right: LipsyncCue): boolean {
  return (
    left.id === right.id &&
    left.episodeId === right.episodeId &&
    left.shotId === right.shotId &&
    left.shotNo === right.shotNo &&
    left.voiceLineId === right.voiceLineId &&
    left.clipPath === right.clipPath &&
    left.audioPath === right.audioPath &&
    left.reason === right.reason
  );
}

/**
 * 派生对口型清单：需要「该镜有采用片段」+「该镜有已生成的对白配音」+
 * 「存在正面口型线索」三者同时成立；旁白不参与。
 */
export function deriveLipsync(
  project: Project,
  timeline: TimelineClip[],
  voiceLines: VoiceLine[],
  existing: LipsyncCue[] = project.post.lipsync,
): LipsyncCue[] {
  const shots = shotIndex(project);
  const previousByKey = new Map(
    existing.map((cue) => [voiceLineKey(cue.shotId, false), cue] as const),
  );

  const dialogueByShot = new Map<string, VoiceLine>();
  for (const line of voiceLines) {
    if (line.isNarration || !line.audioPath) continue;
    if (!dialogueByShot.has(line.shotId)) dialogueByShot.set(line.shotId, line);
  }

  const result: LipsyncCue[] = [];
  for (const clip of timeline) {
    const line = dialogueByShot.get(clip.shotId);
    const shot = shots.get(clip.shotId);
    if (!line?.audioPath || !shot || !hasFrontFaceCue(shot)) continue;

    const previous = previousByKey.get(voiceLineKey(clip.shotId, false));
    const next: LipsyncCue = {
      id: previous?.id ?? newId("lip"),
      episodeId: clip.episodeId,
      shotId: clip.shotId,
      shotNo: clip.shotNo,
      voiceLineId: line.id,
      clipPath: clip.clipPath,
      audioPath: line.audioPath,
      enabled: previous?.enabled ?? true,
      reason: "front_face",
    };
    result.push(previous && sameLipsync(previous, next) ? previous : next);
  }

  return sameRefArray(existing, result) ? existing : result;
}

// ---------- 一键同步 ----------

/**
 * 由当前项目重算整份后期数据（配音句 / 时间线 / 字幕 / 对口型）。
 *
 * 四段都是幂等派生，且逐项做引用相等判定：什么都没变时返回原 `post`，
 * 不会凭空标脏。BGM、音效、字幕样式、导出预设属于用户手动维护，不在这里动。
 */
export function syncPost(project: Project): Post {
  const voiceLines = deriveVoiceLines(project, project.post.voiceLines);
  const timeline = buildTimeline(project, project.post.timeline);
  const subtitles = deriveSubtitles(project, voiceLines, timeline, project.post.subtitles);
  const lipsync = deriveLipsync(project, timeline, voiceLines, project.post.lipsync);

  const post = project.post;
  if (
    voiceLines === post.voiceLines &&
    timeline === post.timeline &&
    subtitles === post.subtitles &&
    lipsync === post.lipsync
  ) {
    return post;
  }
  return { ...post, voiceLines, timeline, subtitles, lipsync };
}

// ---------- BGM 与音效（spec §5.8.4） ----------

/** 素材库里的音频条目。 */
export function audioMaterials(materials: Material[]): Material[] {
  return materials.filter((material) => material.kind === "audio");
}

/**
 * 按立项「情绪基调」推荐 BGM：名字里带情绪词的排在前面，其余音频按原名兜底。
 * 素材库还没有标签体系，只能做这种弱匹配——聊胜于无，不假装是智能推荐。
 */
export function recommendBgmMaterials(mood: string, materials: Material[]): Material[] {
  const key = mood.trim();
  const audios = audioMaterials(materials);
  if (!key) return audios;
  const matched = audios.filter((material) => material.name.includes(key));
  const rest = audios.filter((material) => !material.name.includes(key));
  return [...matched, ...rest];
}

export function makeBgmTrack(material: Material, patch: Partial<BgmTrack> = {}): BgmTrack {
  return {
    materialId: material.id,
    name: material.name,
    path: material.path,
    volume: 50,
    ducking: true,
    duckVolume: 20,
    looping: true,
    ...patch,
  };
}

export interface SfxSuggestion {
  shotId: string;
  episodeId: string;
  shotNo: number;
  hint: string;
  /** 该镜在时间线上的起点（毫秒）。 */
  atMs: number;
}

/** 有「音效提示」的镜头清单，供一键挂接素材库音效。 */
export function sfxSuggestions(project: Project, timeline: TimelineClip[]): SfxSuggestion[] {
  const starts = shotStarts(project, timeline);
  const suggestions: SfxSuggestion[] = [];

  let shotNo = 0;
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        shotNo += 1;
        const hint = trimmed(shot.sfxHint);
        if (!hint) continue;
        suggestions.push({
          shotId: shot.id,
          episodeId: episode.id,
          shotNo,
          hint,
          atMs: starts.get(shot.id) ?? 0,
        });
      }
    }
  }
  return suggestions;
}

export function makeSfxCue(
  suggestion: SfxSuggestion,
  material: Material,
  patch: Partial<SfxCue> = {},
): SfxCue {
  return {
    id: newId("sfx"),
    episodeId: suggestion.episodeId,
    shotId: suggestion.shotId,
    shotNo: suggestion.shotNo,
    hint: suggestion.hint,
    materialId: material.id,
    path: material.path,
    atMs: suggestion.atMs,
    volume: 80,
    ...patch,
  };
}

// ---------- 导出预设（spec §5.8.6） ----------

export interface ExportPreset {
  id: string;
  label: string;
  resolution: string;
  aspectRatio: AspectRatio;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: "douyin", label: "抖音", resolution: "1080x1920", aspectRatio: "9:16" },
  { id: "kuaishou", label: "快手", resolution: "1080x1920", aspectRatio: "9:16" },
  { id: "shipinhao", label: "视频号", resolution: "1080x1920", aspectRatio: "9:16" },
  { id: "bilibili", label: "B站", resolution: "1920x1080", aspectRatio: "16:9" },
  { id: "youtube", label: "YouTube", resolution: "1920x1080", aspectRatio: "16:9" },
];

export function exportPresetById(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((preset) => preset.id === id);
}

export function exportPresetLabel(id: string): string {
  return exportPresetById(id)?.label ?? id;
}

/** 场景在时间线上的展示名（时间线视图的行标签）。 */
export function sceneLabel(scene: Scene): string {
  return scene.location.trim() ? `第 ${scene.no} 场 · ${scene.location}` : `第 ${scene.no} 场`;
}
