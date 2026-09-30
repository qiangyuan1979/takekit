/**
 * 资产图片条：缩略图 + 上传 / 生成 / 设为基准 / 删除。
 *
 * 角色卡、场景卡、道具卡、画风锁定共用这一件，差异全部由 props 表达：
 * 道具卡是单张（`multiple={false}`）且不出生成按钮，画风锁定不传「设为基准」。
 */

import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { assetSrc } from "../../lib/assetOps";
import type { AssetKind, Material } from "../../lib/types";
import { deleteAssetImage, importAssetImage } from "../../state/assetImages";
import { useAppStore } from "../../state/store";
import { MaterialPicker } from "../MaterialLibrary";

const IMAGE_FILTERS = [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }];

export interface ImageStripProps {
  kind: AssetKind;
  ownerId: string;
  /** 已引用的图片（项目相对路径）。 */
  paths: string[];
  /** 定妆基准；省略或传 `null` 表示这张卡没有「基准」概念。 */
  primary?: string | null;
  onSetPrimary?: (path: string) => void;
  /** 省略则不出现生成按钮。 */
  onGenerate?: () => Promise<void>;
  generateLabel?: string;
  /** 有值时生成按钮禁用，并把这句话显示成原因。 */
  generateDisabledReason?: string;
  emptyHint: string;
  /** 道具卡只保留一张图。 */
  multiple?: boolean;
}

export function ImageStrip({
  kind,
  ownerId,
  paths,
  primary = null,
  onSetPrimary,
  onGenerate,
  generateLabel = "生成候选图",
  generateDisabledReason,
  emptyHint,
  multiple = true,
}: ImageStripProps) {
  const projectPath = useAppStore((state) => state.projectPath);
  const [busy, setBusy] = useState<"upload" | "generate" | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleUpload = async () => {
    const chosen = await openDialog({ multiple, filters: IMAGE_FILTERS });
    if (!chosen) return;
    const sources = Array.isArray(chosen) ? chosen : [chosen];
    if (sources.length === 0) return;
    setBusy("upload");
    await importAssetImage(kind, ownerId, sources);
    setBusy(null);
  };

  /** 从素材库选用：把库内文件复制进当前项目（项目依然可以整体搬家）。 */
  const handlePick = async (material: Material): Promise<void> => {
    await importAssetImage(kind, ownerId, [material.path]);
  };

  const handleGenerate = async () => {
    if (!onGenerate) return;
    setBusy("generate");
    await onGenerate();
    setBusy(null);
  };

  return (
    <div className="imagestrip">
      {paths.length === 0 ? (
        <p className="muted imagestrip__empty">{emptyHint}</p>
      ) : (
        <div className="thumbs">
          {paths.map((path) => (
            <figure className="thumb" key={path}>
              <img className="thumb__img" src={assetSrc(projectPath, path)} alt="" />
              <figcaption className="thumb__bar">
                {primary === path ? <span className="thumb__flag">基准</span> : null}
                {onSetPrimary && primary !== path ? (
                  <button
                    type="button"
                    className="thumb__btn"
                    title="以这张作为后续分镜的人物基准"
                    onClick={() => onSetPrimary(path)}
                  >
                    设为基准
                  </button>
                ) : null}
                <button
                  type="button"
                  className="thumb__btn thumb__btn--danger"
                  title="删除这张图片"
                  onClick={() => void deleteAssetImage(kind, ownerId, path)}
                >
                  删除
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="thumbs__actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void handleUpload()}
        >
          {busy === "upload" ? "导入中…" : paths.length === 0 ? "上传图片" : "追加图片"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          title="从跨项目复用的素材库里选图"
          onClick={() => setPickerOpen(true)}
        >
          从素材库选图
        </button>
        {onGenerate ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null || Boolean(generateDisabledReason)}
            title={generateDisabledReason}
            onClick={() => void handleGenerate()}
          >
            {busy === "generate" ? "生成中…" : generateLabel}
          </button>
        ) : null}
        {generateDisabledReason ? (
          <span className="thumbs__note">{generateDisabledReason}</span>
        ) : null}
      </div>

      {pickerOpen ? (
        <MaterialPicker kind="image" onPick={handlePick} onClose={() => setPickerOpen(false)} />
      ) : null}
    </div>
  );
}
