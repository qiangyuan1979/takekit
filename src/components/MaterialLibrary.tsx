/**
 * 素材库（M8 ④）：参考图 / 音频 / 字体的跨项目复用。
 *
 * 两个出口共用同一份 store 数据：
 * - `MaterialLibrary`：顶栏打开的「管理」弹层（分页签、导入、删除、预览）。
 * - `MaterialPicker`：资产卡 / 关键帧里的「从素材库选图」轻量选择器。
 *
 * 库存在应用数据目录（不属于任何项目）；选用时把库内绝对路径交给
 * `importAssetImage` 复制一份进当前项目，因此项目依然可以整体搬家。
 */

import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Material, MaterialKind } from "../lib/types";
import { MATERIAL_KINDS } from "../lib/types";
import { useAppStore } from "../state/store";

const KIND_LABELS: Record<MaterialKind, string> = {
  image: "图片",
  audio: "音频",
  font: "字体",
};

const KIND_FILTERS: Record<MaterialKind, { name: string; extensions: string[] }> = {
  image: { name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] },
  audio: { name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },
  font: { name: "字体", extensions: ["ttf", "otf", "woff", "woff2"] },
};

/** 每种素材在 v1 里被谁消费——写清楚，免得用户以为导入就自动生效。 */
const KIND_USAGE: Record<MaterialKind, string> = {
  image: "资产卡与关键帧里点「从素材库选图」即可复制进当前项目。",
  audio: "供配音与 BGM 使用（第 8 步后期，v1.5 开放）。",
  font: "在「设置 → 界面字体」里选作界面字体。",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 库内绝对路径 → 可在 webview 里显示的 URL。 */
function materialSrc(material: Material): string {
  return material.path ? convertFileSrc(material.path) : "";
}

interface MaterialTileProps {
  material: Material;
  /** 省略则不出现「删除」按钮（选择器里只选不删）。 */
  onDelete?: (id: string) => void;
  onPick?: (material: Material) => void;
}

function MaterialTile({ material, onDelete, onPick }: MaterialTileProps) {
  return (
    <figure className="material">
      <div className="material__media">
        {material.kind === "image" ? (
          <img className="material__img" src={materialSrc(material)} alt="" />
        ) : (
          <span className="material__ext">{material.ext.toUpperCase()}</span>
        )}
      </div>
      <figcaption className="material__body">
        <span className="material__name" title={material.name}>
          {material.name}
        </span>
        <span className="material__meta">
          {material.ext} · {formatBytes(material.bytes)}
        </span>
        {onPick ? (
          <button
            type="button"
            className="thumb__btn"
            title="复制进当前项目"
            onClick={() => onPick(material)}
          >
            选用
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className="thumb__btn thumb__btn--danger"
            title="从素材库删除"
            onClick={() => onDelete(material.id)}
          >
            删除
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

export interface MaterialLibraryProps {
  onClose: () => void;
}

export function MaterialLibrary({ onClose }: MaterialLibraryProps) {
  const materials = useAppStore((state) => state.materials);
  const importMaterial = useAppStore((state) => state.importMaterial);
  const deleteMaterial = useAppStore((state) => state.deleteMaterial);
  const [kind, setKind] = useState<MaterialKind>("image");
  const [busy, setBusy] = useState(false);

  const items = materials.filter((material) => material.kind === kind);

  const handleImport = async (): Promise<void> => {
    const chosen = await openDialog({ multiple: true, filters: [KIND_FILTERS[kind]] });
    if (!chosen) return;
    const sources = Array.isArray(chosen) ? chosen : [chosen];
    if (sources.length === 0) return;
    setBusy(true);
    for (const source of sources) await importMaterial(kind, source);
    setBusy(false);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="素材库">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">素材库</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal__body">
          <div className="materialtabs" role="tablist">
            {MATERIAL_KINDS.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={kind === item}
                className={`materialtabs__tab${kind === item ? " materialtabs__tab--on" : ""}`}
                onClick={() => setKind(item)}
              >
                {KIND_LABELS[item]}（{materials.filter((m) => m.kind === item).length}）
              </button>
            ))}
          </div>

          <p className="thumbs__note">{KIND_USAGE[kind]}</p>

          {items.length === 0 ? (
            <p className="muted">这里还没有{KIND_LABELS[kind]}，点下面的按钮导入。</p>
          ) : (
            <div className="materialgrid">
              {items.map((material) => (
                <MaterialTile
                  key={material.id}
                  material={material}
                  onDelete={(id) => void deleteMaterial(id)}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="modal__foot">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void handleImport()}
          >
            {busy ? "导入中…" : `导入${KIND_LABELS[kind]}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

export interface MaterialPickerProps {
  kind: MaterialKind;
  /** 选中后回调（通常是复制进当前项目）；完成后选择器自动关闭。 */
  onPick: (material: Material) => void | Promise<void>;
  onClose: () => void;
}

export function MaterialPicker({ kind, onPick, onClose }: MaterialPickerProps) {
  const materials = useAppStore((state) => state.materials);
  const items = materials.filter((material) => material.kind === kind);

  const choose = async (material: Material): Promise<void> => {
    await onPick(material);
    onClose();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="从素材库选择">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">从素材库选择{KIND_LABELS[kind]}</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal__body">
          {items.length === 0 ? (
            <p className="muted">素材库里还没有{KIND_LABELS[kind]}，先到顶栏「素材库」导入。</p>
          ) : (
            <div className="materialgrid">
              {items.map((material) => (
                <MaterialTile
                  key={material.id}
                  material={material}
                  onPick={(picked) => void choose(picked)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
