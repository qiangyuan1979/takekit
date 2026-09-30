/**
 * 关键帧（第 5 步）的纯函数工具：帧工厂、首/尾帧取用、候选增删与定稿、
 * 首帧缺失判定、跨镜参考候选，以及参考表分区标注。
 *
 * 和其它 `*Ops` 一样，这里不碰 store、不做 IO。分区规则必须与 Rust 侧
 * `src-tauri/src/refsheet.rs` 的 `layout_for` 保持一致——两端各写一份、各有一组
 * 单测钉死同一规则（Rust 管像素布局，这里管中文分区文案）。
 */

import { newId } from "./scriptOps";
import type { Episode, Frame, FrameRole, Project, Scene, Shot } from "./types";

/**
 * 一张参考表最多拼几张图；与 Rust `refsheet::MAX_REFS` 保持一致。
 * 超出后由调用层截断（多余的参考图直接丢弃，避免"看起来传了其实没用"）。
 */
export const MAX_FRAME_REFS = 4;

// ---------- 工厂与取用 ----------

export function makeFrame(role: FrameRole): Frame {
  return { id: newId("frame"), role, candidates: [], adopted: null, refShotId: null };
}

export function frameRoleLabel(role: FrameRole): string {
  return role === "first" ? "首帧" : "尾帧";
}

export function frameByRole(shot: Shot, role: FrameRole): Frame | undefined {
  return shot.frames.find((frame) => frame.role === role);
}

export function firstFrame(shot: Shot): Frame | undefined {
  return frameByRole(shot, "first");
}

export function lastFrame(shot: Shot): Frame | undefined {
  return frameByRole(shot, "last");
}

/** 首帧必需、尾帧按需：没有就补一个空帧，已有则原样返回。 */
export function ensureFrame(shot: Shot, role: FrameRole): Shot {
  if (frameByRole(shot, role)) return shot;
  return { ...shot, frames: [...shot.frames, makeFrame(role)] };
}

/** 就地替换某个角色的帧；该角色不存在时补建。 */
export function updateFrame(shot: Shot, role: FrameRole, change: (frame: Frame) => Frame): Shot {
  const target = frameByRole(shot, role);
  if (!target) return { ...shot, frames: [...shot.frames, change(makeFrame(role))] };
  return {
    ...shot,
    frames: shot.frames.map((frame) => (frame.role === role ? change(frame) : frame)),
  };
}

// ---------- 候选与定稿 ----------

/** 追加候选图，按原顺序去重（重复路径不再进候选池）。 */
export function addCandidates(frame: Frame, paths: string[]): Frame {
  const incoming = paths.map((path) => path.trim()).filter(Boolean);
  if (incoming.length === 0) return frame;
  const merged = [...frame.candidates];
  for (const path of incoming) {
    if (!merged.includes(path)) merged.push(path);
  }
  if (merged.length === frame.candidates.length) return frame;
  return { ...frame, candidates: merged };
}

export function adoptCandidate(frame: Frame, path: string): Frame {
  return frame.adopted === path ? frame : { ...frame, adopted: path };
}

/** 从候选池移除一张；若它正是定稿图，定稿一并清空，避免留下悬空路径。 */
export function detachCandidate(frame: Frame, path: string): Frame {
  const candidates = frame.candidates.filter((candidate) => candidate !== path);
  const adopted = frame.adopted === path ? null : frame.adopted;
  if (candidates.length === frame.candidates.length && adopted === frame.adopted) return frame;
  return { ...frame, candidates, adopted };
}

/** 设为跨镜参考（传镜头 id）；该镜头被删时可传 `null` 解除。 */
export function setFrameRefShot(frame: Frame, refShotId: string | null): Frame {
  return frame.refShotId === refShotId ? frame : { ...frame, refShotId };
}

// ---------- 定稿帧解析 ----------

/**
 * 某镜头"可作为别人参考"的定稿帧：优先尾帧（衔接下一镜），退回首帧。
 * `Frame.refShotId` 只存镜头 id，所以这里必须是确定的解析口径。
 */
export function shotReferenceFrame(shot: Shot): { role: FrameRole; path: string } | null {
  const last = lastFrame(shot);
  if (last?.adopted) return { role: "last", path: last.adopted };
  const first = firstFrame(shot);
  if (first?.adopted) return { role: "first", path: first.adopted };
  return null;
}

export interface RefShotOption {
  shotId: string;
  /** 下拉展示文案：`第1集 第2场 · 镜3`。 */
  label: string;
  /** 解析出的定稿帧角色，用来在选项里标注「首帧 / 尾帧」。 */
  role: FrameRole;
  path: string;
}

/** 镜头在下拉里的展示名。 */
export function shotOptionLabel(episode: Episode, scene: Scene, shot: Shot): string {
  return `第 ${episode.no} 集 第 ${scene.no} 场 · 镜 ${shot.no}`;
}

/** 在整份项目里按 id 找镜头；跨镜参考要拿它解析"被引用的那面定稿帧"。 */
export function findShot(project: Project, shotId: string): Shot | undefined {
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      const shot = scene.shots.find((item) => item.id === shotId);
      if (shot) return shot;
    }
  }
  return undefined;
}

/** 除自己外、已经有定稿帧的镜头；按集/场/镜顺序排列。 */
export function refShotOptions(project: Project, currentShotId: string): RefShotOption[] {
  const options: RefShotOption[] = [];
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        if (shot.id === currentShotId) continue;
        const reference = shotReferenceFrame(shot);
        if (!reference) continue;
        options.push({
          shotId: shot.id,
          label: shotOptionLabel(episode, scene, shot),
          role: reference.role,
          path: reference.path,
        });
      }
    }
  }
  return options;
}

// ---------- 首帧缺失判定（第 6/7 步的门禁口径） ----------

export function shotKeyframeIssue(shot: Shot): string | null {
  const first = firstFrame(shot);
  if (first?.adopted) return null;
  return `镜 ${shot.no}：首帧还没定稿`;
}

export function shotKeyframeIssues(shot: Shot): string[] {
  const issue = shotKeyframeIssue(shot);
  return issue ? [issue] : [];
}

/** 扫全集：每镜首帧未定稿即视为阻塞下游。 */
export function pendingKeyframeIssues(project: Project): string[] {
  const issues: string[] = [];
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      for (const shot of scene.shots) {
        const issue = shotKeyframeIssue(shot);
        if (issue) issues.push(`第 ${episode.no} 集 第 ${scene.no} 场 · ${issue}`);
      }
    }
  }
  return issues;
}

// ---------- 参考表分区标注（与 Rust `refsheet::layout_for` 同规则） ----------

/**
 * 每张参考图在拼图里的中文分区名，下标即参考图顺序。
 *
 * 规则与 Rust 完全一致：1 张不拼图（`[]`，单图原样下发）；2 张左右各一；
 * 3 张为 2×2 行优先、右下留底色；4 张填满 2×2；0 或 5 张以上不适用。
 */
export function refSheetCells(count: number): string[] {
  switch (count) {
    case 2:
      return ["左", "右"];
    case 3:
      return ["左上", "右上", "左下"];
    case 4:
      return ["左上", "右上", "左下", "右下"];
    default:
      return [];
  }
}

/** 参考表是否走本地拼图（≥2 张才拼，与 Rust 一致）。 */
export function usesRefSheet(count: number): boolean {
  return count >= 2 && count <= MAX_FRAME_REFS;
}
