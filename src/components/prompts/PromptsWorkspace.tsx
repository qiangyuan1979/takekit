/**
 * 第 6 步「出题」的工作区：把分镜字段拼成各家模型可用的提示词与参数，并导出交接。
 *
 * 这一步同样没有左栏聊天：出题是确定性的——字段怎么填，提示词就怎么拼。
 * 界面只有四件事可做：逐镜出题、改提示词与参数、预览各家请求体、导出 / 导入。
 */

import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/ipc";
import { useAppStore } from "../../state/store";
import {
  exportHandoverPackFile,
  exportStoryboardFile,
  generatePromptBundles,
  importStoryboardFile,
} from "../../state/prompts";
import { Select } from "../controls";
import { ShotPromptCard } from "./ShotPromptCard";

const STORYBOARD_FORMATS = [
  { value: "csv", label: "CSV（通用表格）" },
  { value: "json", label: "JSON（程序交换）" },
  { value: "xlsx", label: "Excel（.xlsx）" },
] as const;

const STORYBOARD_FILTERS = [{ name: "分镜表", extensions: ["csv", "json", "xlsx"] }];

type ExportFormat = (typeof STORYBOARD_FORMATS)[number]["value"];

export function PromptsWorkspace() {
  const project = useAppStore((state) => state.project);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .listVideoProviders()
      .then((list) => {
        if (alive) setProviders(list);
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;
  if (project.episodes.length === 0) {
    return <p className="muted">还没有剧集。先回第 2 步写一集、第 4 步拆好镜，再回来出题。</p>;
  }

  const episode = project.episodes.find((item) => item.id === episodeId) ?? project.episodes[0];
  const shots = episode.scenes.flatMap((scene) => scene.shots);
  const pending = shots.filter((shot) => !shot.promptBundle).length;

  const episodeOptions = project.episodes.map((item) => ({
    value: item.id,
    label: `第 ${item.no} 集${item.title ? ` · ${item.title}` : ""}`,
  }));

  const exportStoryboard = async (): Promise<void> => {
    const chosen = await saveDialog({
      title: "导出分镜表",
      defaultPath: `分镜表-${episode.no}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (typeof chosen !== "string") return;
    setBusy("export");
    try {
      const record = await exportStoryboardFile(format, chosen);
      setStatus(record ? `已导出分镜表 → ${record.path}` : "导出失败，请看顶部错误提示。");
    } finally {
      setBusy(null);
    }
  };

  const importStoryboard = async (): Promise<void> => {
    const chosen = await openDialog({ title: "导入分镜表", filters: STORYBOARD_FILTERS });
    if (typeof chosen !== "string") return;
    setBusy("import");
    try {
      const outcome = await importStoryboardFile(chosen);
      setStatus(
        outcome
          ? `导入完成：覆盖 ${outcome.updated} 镜，跳过 ${outcome.skipped} 行。`
          : "导入失败，请看顶部错误提示。",
      );
    } finally {
      setBusy(null);
    }
  };

  const exportHandover = async (): Promise<void> => {
    const chosen = await openDialog({
      title: "选择交接包导出目录",
      directory: true,
    });
    if (typeof chosen !== "string") return;
    setBusy("handover");
    try {
      const outcome = await exportHandoverPackFile(chosen);
      setStatus(
        outcome
          ? `已导出交接包 → ${outcome.dir}（${outcome.files.length} 个文件）`
          : "导出交接包失败，请看顶部错误提示。",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="workspace">
      <div className="sdbar">
        <Select value={episode.id} options={episodeOptions} onChange={setEpisodeId} />
        <span className="kf-summary">
          本集 {shots.length} 镜，其中 {pending} 镜还没出题
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={shots.length === 0}
          onClick={() => {
            for (const scene of episode.scenes) generatePromptBundles(episode.id, scene.id);
          }}
        >
          整集出题
        </button>
      </div>

      {shots.length === 0 ? <p className="muted">本集还没有镜头，先回第 4 步拆镜。</p> : null}

      <div className="prompt-cards">
        {episode.scenes.map((scene) => (
          <section className="prompt-group" key={scene.id}>
            <div className="scenebar">
              <span className="scenebar__title">
                第 {scene.no} 场{scene.location ? ` · ${scene.location}` : ""}
              </span>
              <span className="scenebar__count">{scene.shots.length} 镜</span>
              <button
                type="button"
                className="link-btn"
                disabled={scene.shots.length === 0}
                onClick={() => generatePromptBundles(episode.id, scene.id)}
              >
                本场批量出题
              </button>
            </div>

            {scene.shots.map((shot) => (
              <ShotPromptCard
                key={shot.id}
                episodeId={episode.id}
                scene={scene}
                shot={shot}
                providers={providers}
              />
            ))}
          </section>
        ))}
      </div>

      <section className="card export-panel">
        <header className="export-panel__head">
          <h3 className="export-panel__title">导出与交接</h3>
          <span className="muted">
            分镜表可以导出后再导入，往返不会丢字段；交接包是给下游同事的完整档。
          </span>
        </header>

        <div className="export-row">
          <span className="export-row__label">分镜表</span>
          <Select
            value={format}
            options={STORYBOARD_FORMATS}
            onChange={(next) => setFormat(next)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void exportStoryboard()}
          >
            {busy === "export" ? "导出中…" : "导出"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void importStoryboard()}
          >
            {busy === "import" ? "导入中…" : "导入并覆盖"}
          </button>
        </div>

        <div className="export-row">
          <span className="export-row__label">交接包</span>
          <span className="muted">
            分镜表（csv / json / xlsx）+ 提示词 + 参数 + 关键帧清单 + frames/ 图片
          </span>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void exportHandover()}
          >
            {busy === "handover" ? "导出中…" : "导出交接包"}
          </button>
        </div>

        {status ? (
          <p className="export-status" data-testid="export-status">
            {status}
          </p>
        ) : null}
      </section>

      <p className="sdnote sdnote--hint">
        提示词是"字段的投影"：改了第 4、5 步的字段，回来点「重出」即可刷新，不用手写。
      </p>
    </div>
  );
}
