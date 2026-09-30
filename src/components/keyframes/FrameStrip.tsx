/**
 * 关键帧 · 一面帧（首帧或尾帧）的候选条：候选并排 + 挑选定稿 + 生成 / 上传 / 删除。
 *
 * 与资产图片条（`ImageStrip`）的差别在于"一面帧"是个有状态的小对象：
 * 候选池、定稿、跨镜参考都挂在它身上，所以这里直接吃 `Shot` + `role`，
 * 把帧的解析交给纯函数层，组件只负责展示与触发。
 */

import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { assetSrc } from "../../lib/assetOps";
import { frameByRole, frameRoleLabel, makeFrame, type RefShotOption } from "../../lib/frameOps";
import type { FrameRole, Shot } from "../../lib/types";
import {
  deleteFrameCandidate,
  generateFrameCandidates,
  importFrameCandidates,
} from "../../state/keyframes";
import { useAppStore } from "../../state/store";
import { Select } from "../controls";

const IMAGE_FILTERS = [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }];

export interface FrameStripProps {
  episodeId: string;
  sceneId: string;
  shot: Shot;
  role: FrameRole;
  /** 除自己外、已有定稿帧的镜头；作为跨镜参考的候选。 */
  refOptions: RefShotOption[];
}

export function FrameStrip({ episodeId, sceneId, shot, role, refOptions }: FrameStripProps) {
  const projectPath = useAppStore((state) => state.projectPath);
  const ensureShotFrame = useAppStore((state) => state.ensureShotFrame);
  const adoptFrame = useAppStore((state) => state.adoptFrame);
  const setFrameRefShot = useAppStore((state) => state.setFrameRefShot);
  const [busy, setBusy] = useState<"generate" | "upload" | null>(null);

  const existing = frameByRole(shot, role);
  const label = frameRoleLabel(role);

  // 尾帧可选：还没建就先给一个"添加"，不强迫每镜都出两面帧。
  if (!existing && role === "last") {
    return (
      <section className="kf-frame kf-frame--empty">
        <header className="kf-frame__head">
          <span className="kf-frame__title">{label}</span>
          <span className="kf-frame__req kf-frame__req--opt">可选</span>
        </header>
        <p className="muted kf-frame__empty">
          已经有首帧就可以生成视频了。想让这一镜「停在一个确定的画面上」，再补一面尾帧。
        </p>
        <button
          type="button"
          className="icon-btn"
          onClick={() => ensureShotFrame(episodeId, sceneId, shot.id, role)}
        >
          ＋ 添加尾帧
        </button>
      </section>
    );
  }

  // 首帧必需：还没落库时用一张空帧渲染；生成/定稿/上传候选都会由 store 自动补建。
  const frame = existing ?? makeFrame(role);

  const generate = async (): Promise<void> => {
    setBusy("generate");
    try {
      await generateFrameCandidates(episodeId, sceneId, shot.id, role);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (): Promise<void> => {
    const chosen = await openDialog({ multiple: true, filters: IMAGE_FILTERS });
    if (!chosen) return;
    const sources = Array.isArray(chosen) ? chosen : [chosen];
    if (sources.length === 0) return;
    setBusy("upload");
    try {
      await importFrameCandidates(episodeId, sceneId, shot.id, role, sources);
    } finally {
      setBusy(null);
    }
  };

  const refOptionsAll = [
    { value: "", label: "不用跨镜参考" },
    ...refOptions.map((option) => ({
      value: option.shotId,
      label: `${option.label}（${frameRoleLabel(option.role)}）`,
    })),
  ];

  return (
    <section className="kf-frame" data-testid={`frame-${role}`}>
      <header className="kf-frame__head">
        <span className="kf-frame__title">{label}</span>
        {frame.adopted ? (
          <span className="kf-frame__flag">已定稿</span>
        ) : (
          <span className="kf-frame__flag kf-frame__flag--todo">待定稿</span>
        )}
        <span className="kf-frame__req kf-frame__req--opt">
          {role === "first" ? "必需" : "可选"}
        </span>
      </header>

      {frame.candidates.length === 0 ? (
        <p className="muted kf-frame__empty">还没有候选图，先生成 4 张挑一张。</p>
      ) : (
        <div className="thumbs">
          {frame.candidates.map((path) => (
            <figure className="thumb" key={path}>
              <img className="thumb__img" src={assetSrc(projectPath, path)} alt="" />
              <figcaption className="thumb__bar">
                {frame.adopted === path ? <span className="thumb__flag">定稿</span> : null}
                {frame.adopted !== path ? (
                  <button
                    type="button"
                    className="thumb__btn"
                    title="以这张作为这一面帧的定稿"
                    onClick={() => adoptFrame(episodeId, sceneId, shot.id, role, path)}
                  >
                    设为定稿
                  </button>
                ) : null}
                <button
                  type="button"
                  className="thumb__btn thumb__btn--danger"
                  title="删除这张候选"
                  onClick={() => void deleteFrameCandidate(episodeId, sceneId, shot.id, role, path)}
                >
                  删除
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="kf-frame__ref">
        <span className="kf-frame__reflabel">跨镜参考</span>
        <Select
          value={frame.refShotId ?? ""}
          options={refOptionsAll}
          onChange={(next) => setFrameRefShot(episodeId, sceneId, shot.id, role, next || null)}
        />
        <span className="kf-frame__refhint">
          同场景的连续镜头选上一镜的定稿帧，出图会带上它，画面才不会跳。
        </span>
      </div>

      <div className="thumbs__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy !== null}
          onClick={() => void generate()}
        >
          {busy === "generate" ? "生成中…" : "生成 4 张候选"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void upload()}
        >
          {busy === "upload" ? "导入中…" : "上传图片"}
        </button>
      </div>
    </section>
  );
}
