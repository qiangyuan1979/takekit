/**
 * 第 8 步「后期」的工作区：配音 / 对口型 / 字幕 / BGM 与音效 / 四轨拼接 / 导出。
 *
 * 这一步应用不渲染成片：它把分散在各处的素材与说明整理成一份"剪辑工程包"——
 * 时间线 JSON + SRT / ASS 字幕 + 素材清单 + 可直接运行的 ffmpeg 脚本，交给用户
 * （或剪辑师）一键出片。界面负责派生、微调与导出，真正的合成在包内脚本里。
 *
 * 派生逻辑全在 `lib/postOps.ts`：这里点「一键同步」才会从分镜重算配音句 / 时间线 /
 * 字幕 / 对口型，之后逐项微调只改 `project.post`，不会被再次覆盖。
 */

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { assetSrc } from "../../lib/assetOps";
import { api } from "../../lib/ipc";
import type { PostPackOptions } from "../../lib/ipc";
import {
  EXPORT_PRESETS,
  exportPresetById,
  makeBgmTrack,
  makeSfxCue,
  pendingVoiceLines,
  recommendBgmMaterials,
  sfxSuggestions,
  timelineDurationMs,
} from "../../lib/postOps";
import type { Material, Project, SubtitlePosition, Transition, VoiceLine } from "../../lib/types";
import { SUBTITLE_POSITIONS } from "../../lib/types";
import { cancelVoiceTasks, submitVoiceLines } from "../../state/post";
import { useAppStore } from "../../state/store";
import { Select, TextInput } from "../controls";

const TTS_LABELS: Record<string, string> = {
  openai: "OpenAI 语音",
  mock: "本地模拟（无需 Key）",
};

const POSITION_LABELS: Record<SubtitlePosition, string> = {
  bottom: "底部",
  center: "居中",
  top: "顶部",
};

const TRANSITION_LABELS: Record<Transition, string> = {
  cut: "硬切",
  dissolve: "叠化",
  fade_in: "淡入",
  fade_out: "淡出",
  whip_pan: "甩镜",
};

function ttsLabel(name: string): string {
  return TTS_LABELS[name] ?? name;
}

/** 一秒取整：界面只报整数秒，不暴露毫秒。 */
function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function NumInput({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <input
      className="input"
      type="number"
      value={value}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10);
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export function PostWorkspace() {
  const project = useAppStore((state) => state.project);
  const projectPath = useAppStore((state) => state.projectPath);
  const materials = useAppStore((state) => state.materials);
  const syncPost = useAppStore((state) => state.syncPost);
  const setPost = useAppStore((state) => state.setPost);
  const reportError = useAppStore((state) => state.reportError);
  const addExportRecord = useAppStore((state) => state.addExportRecord);

  const [generators, setGenerators] = useState<string[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState<"voice" | "export" | null>(null);
  const [packOptions, setPackOptions] = useState<PostPackOptions>({
    selfContained: false,
    webvtt: true,
    scriptLines: true,
    edl: true,
    stems: true,
  });

  useEffect(() => {
    let alive = true;
    void api
      .listTtsGenerators()
      .then((list) => {
        if (alive) setGenerators(list);
      })
      .catch(() => {
        if (alive) setGenerators([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;
  if (project.episodes.length === 0) {
    return (
      <p className="muted">还没有剧集。先回第 2 步写剧本、第 7 步生成片段，再回来后期出片。</p>
    );
  }

  const providerValue =
    provider ??
    (generators.includes(project.meta.defaultVoice)
      ? project.meta.defaultVoice
      : (generators[0] ?? ""));

  const pending = pendingVoiceLines(project);
  const openTasks = project.tasks.filter(
    (task) => task.kind === "tts" && (task.status === "queued" || task.status === "running"),
  );
  const timeline = project.post.timeline;
  const totalMs = timelineDurationMs(timeline);
  const preset = exportPresetById(project.post.exportPreset);

  const runVoice = async (ids: string[]): Promise<void> => {
    if (!providerValue) return;
    setBusy("voice");
    try {
      await submitVoiceLines(ids, providerValue);
    } finally {
      setBusy(null);
    }
  };

  const exportPack = async (): Promise<void> => {
    if (!projectPath) return;
    const dir = await openDialog({ title: "选择剪辑工程包的导出目录", directory: true });
    if (typeof dir !== "string") return;
    setBusy("export");
    try {
      const outcome = await api.exportPostPack(projectPath, project, dir, packOptions);
      addExportRecord(outcome.record);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  const providerOptions = generators.map((name) => ({ value: name, label: ttsLabel(name) }));
  const presetOptions = EXPORT_PRESETS.map((item) => ({
    value: item.id,
    label: `${item.label}（${item.resolution} · ${item.aspectRatio}）`,
  }));

  return (
    <div className="workspace">
      <div className="sdbar">
        <span className="export-row__label">配音</span>
        <Select
          value={providerValue}
          options={
            providerOptions.length > 0
              ? providerOptions
              : [{ value: "", label: "没有可用配音服务" }]
          }
          onChange={setProvider}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!providerValue || pending.length === 0 || busy !== null}
          onClick={() => void runVoice([])}
        >
          {busy === "voice" ? "配音中…" : `生成配音（${pending.length}）`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={openTasks.length === 0}
          onClick={() => void cancelVoiceTasks(openTasks.map((task) => task.id))}
        >
          取消在跑（{openTasks.length}）
        </button>
        <button type="button" className="btn" onClick={syncPost} data-testid="post-sync">
          一键同步
        </button>
      </div>

      <p className="sdnote sdnote--hint" data-testid="post-summary">
        时间线 {timeline.length} 段、约 {seconds(totalMs)} 秒；配音句{" "}
        {project.post.voiceLines.length} 条 （待生成 {pending.length}）、字幕{" "}
        {project.post.subtitles.length} 条、对口型 {project.post.lipsync.length}{" "}
        条。改完分镜后点「一键同步」重算。
      </p>

      {timeline.length === 0 ? (
        <p className="sdnote sdnote--error" data-testid="post-empty">
          时间线上还没有片段：先回第 7 步给至少一镜「采用」一条生成结果。
        </p>
      ) : null}

      <VoiceSection
        project={project}
        projectPath={projectPath}
        busy={busy !== null}
        onRegenerate={(id) => void runVoice([id])}
      />

      <LipsyncSection project={project} />

      <SubtitleSection project={project} />

      <BgmSection project={project} materials={materials} />

      <SfxSection project={project} materials={materials} />

      <TimelineSection project={project} />

      <section className="subcard" data-testid="post-export">
        <header className="subcard__head">
          <h3 className="subcard__title">导出成片</h3>
          <div className="subcard__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={timeline.length === 0 || busy !== null}
              onClick={() => void exportPack()}
            >
              {busy === "export" ? "导出中…" : "导出剪辑工程包"}
            </button>
          </div>
        </header>
        <div className="subcard__body">
          <div className="export-row">
            <span className="export-row__label">导出预设</span>
            <Select
              value={project.post.exportPreset}
              options={presetOptions}
              onChange={(id) => setPost((post) => ({ ...post, exportPreset: id }))}
            />
            <span className="muted">
              {preset ? `${preset.resolution} · ${preset.aspectRatio}` : "未选预设"}
            </span>
          </div>
          <div className="export-row">
            <span className="export-row__label">附加内容</span>
            <Toggle
              checked={packOptions.webvtt}
              onChange={(next) => setPackOptions((prev) => ({ ...prev, webvtt: next }))}
              label="WebVTT 字幕"
            />
            <Toggle
              checked={packOptions.scriptLines}
              onChange={(next) => setPackOptions((prev) => ({ ...prev, scriptLines: next }))}
              label="台词本"
            />
            <Toggle
              checked={packOptions.edl}
              onChange={(next) => setPackOptions((prev) => ({ ...prev, edl: next }))}
              label="EDL 时间线"
            />
            <Toggle
              checked={packOptions.stems}
              onChange={(next) => setPackOptions((prev) => ({ ...prev, stems: next }))}
              label="分轨音频脚本"
            />
          </div>
          <div className="export-row">
            <span className="export-row__label">媒体处理</span>
            <Toggle
              checked={packOptions.selfContained}
              onChange={(next) => setPackOptions((prev) => ({ ...prev, selfContained: next }))}
              label="自带媒体（复制进包内 media/，整包可搬走）"
            />
          </div>
          <p className="sdnote sdnote--hint">
            工程包含时间线 JSON、SRT / ASS 字幕、素材清单与一键运行的 ffmpeg
            脚本；换台机器按清单放回素材即可出片。勾选「自带媒体」会把片段、配音、BGM
            与音效复制进包内，脚本改用包内相对路径，整包拷到别的电脑也能直接渲染。
          </p>
        </div>
      </section>
    </div>
  );
}

// ---------- 配音（spec §5.8.1） ----------

interface VoiceSectionProps {
  project: Project;
  projectPath: string | null;
  busy: boolean;
  onRegenerate: (id: string) => void;
}

function VoiceSection({ project, projectPath, busy, onRegenerate }: VoiceSectionProps) {
  const setPost = useAppStore((state) => state.setPost);
  const lines = project.post.voiceLines;

  const patch = (id: string, change: Partial<VoiceLine>): void =>
    setPost((post) => ({
      ...post,
      voiceLines: post.voiceLines.map((line) => (line.id === id ? { ...line, ...change } : line)),
    }));

  const speakerName = (line: VoiceLine): string => {
    if (line.isNarration) return "旁白";
    const character = project.assets.characters.find((item) => item.id === line.characterId);
    return character?.name ?? (line.characterId || "未指定角色");
  };

  return (
    <section className="subcard" data-testid="post-voice">
      <header className="subcard__head">
        <h3 className="subcard__title">配音（{lines.length} 句）</h3>
      </header>
      <div className="subcard__body">
        {lines.length === 0 ? (
          <p className="muted">
            还没有台词或旁白。先回第 4 步给镜头写台词，再点上面的「一键同步」。
          </p>
        ) : (
          lines.map((line) => (
            <article className="kf-card" key={line.id}>
              <header className="kf-card__head">
                <span className="kf-card__no">第 {line.shotNo} 镜</span>
                <span className="kf-card__meta">{speakerName(line)}</span>
                {line.audioPath ? (
                  <span className="prompt-card__flag">已生成</span>
                ) : (
                  <span className="prompt-card__flag--todo">待生成</span>
                )}
              </header>
              <p className="muted kf-card__desc">{line.text}</p>
              <div className="export-row">
                <span className="export-row__label">音色</span>
                <TextInput
                  value={line.voice}
                  placeholder="如 女声·清冷"
                  onChange={(voice) => patch(line.id, { voice })}
                />
                <span className="export-row__label">情绪</span>
                <TextInput
                  value={line.emotion}
                  placeholder="如 平静"
                  onChange={(emotion) => patch(line.id, { emotion })}
                />
                <span className="export-row__label">语速</span>
                <NumInput value={line.speed} onChange={(speed) => patch(line.id, { speed })} />
                <span className="export-row__label">停顿(ms)</span>
                <NumInput
                  value={line.pauseMs}
                  onChange={(pauseMs) => patch(line.id, { pauseMs })}
                />
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => onRegenerate(line.id)}
                >
                  重新生成
                </button>
              </div>
              {line.audioPath ? (
                <audio
                  className="post-audio"
                  controls
                  preload="metadata"
                  src={assetSrc(projectPath, line.audioPath)}
                />
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

// ---------- 对口型（spec §5.8.2） ----------

function LipsyncSection({ project }: { project: Project }) {
  const setPost = useAppStore((state) => state.setPost);
  const cues = project.post.lipsync;

  const toggle = (id: string, enabled: boolean): void =>
    setPost((post) => ({
      ...post,
      lipsync: post.lipsync.map((cue) => (cue.id === id ? { ...cue, enabled } : cue)),
    }));

  return (
    <section className="subcard" data-testid="post-lipsync">
      <header className="subcard__head">
        <h3 className="subcard__title">对口型（{cues.length} 条）</h3>
      </header>
      <div className="subcard__body">
        {cues.length === 0 ? (
          <p className="muted">
            暂无需要补口型的镜头。近景 / 特写里有人物对白、且该镜已有配音时才会出现在这里。
          </p>
        ) : (
          cues.map((cue) => (
            <div className="export-row" key={cue.id}>
              <span className="export-row__label">第 {cue.shotNo} 镜</span>
              <Toggle
                checked={cue.enabled}
                onChange={(enabled) => toggle(cue.id, enabled)}
                label="启用"
              />
              <span className="muted">
                {baseName(cue.clipPath)} + {baseName(cue.audioPath)}（{cue.reason}）
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ---------- 字幕（spec §5.8.3） ----------

function SubtitleSection({ project }: { project: Project }) {
  const setPost = useAppStore((state) => state.setPost);
  const style = project.post.subtitleStyle;
  const cues = project.post.subtitles;

  return (
    <section className="subcard" data-testid="post-subtitles">
      <header className="subcard__head">
        <h3 className="subcard__title">字幕（{cues.length} 条）</h3>
      </header>
      <div className="subcard__body">
        <div className="export-row">
          <span className="export-row__label">字号</span>
          <NumInput
            value={style.fontSize}
            onChange={(fontSize) =>
              setPost((post) => ({
                ...post,
                subtitleStyle: { ...post.subtitleStyle, fontSize },
              }))
            }
          />
          <span className="export-row__label">位置</span>
          <Select
            value={style.position}
            options={SUBTITLE_POSITIONS.map((value) => ({ value, label: POSITION_LABELS[value] }))}
            onChange={(position) =>
              setPost((post) => ({ ...post, subtitleStyle: { ...post.subtitleStyle, position } }))
            }
          />
          <span className="export-row__label">安全边距(%)</span>
          <NumInput
            value={style.safeMarginPercent}
            onChange={(safeMarginPercent) =>
              setPost((post) => ({
                ...post,
                subtitleStyle: { ...post.subtitleStyle, safeMarginPercent },
              }))
            }
          />
          <Toggle
            checked={style.burnIn}
            onChange={(burnIn) =>
              setPost((post) => ({ ...post, subtitleStyle: { ...post.subtitleStyle, burnIn } }))
            }
            label="烧进画面"
          />
        </div>

        {cues.length === 0 ? (
          <p className="muted">还没有字幕。点上面的「一键同步」由台词生成。</p>
        ) : (
          cues.map((cue) => (
            <div className="export-row" key={cue.id}>
              <span className="export-row__label">第 {cue.shotNo} 镜</span>
              <NumInput
                value={cue.startMs}
                onChange={(startMs) =>
                  setPost((post) => ({
                    ...post,
                    subtitles: post.subtitles.map((item) =>
                      item.id === cue.id ? { ...item, startMs } : item,
                    ),
                  }))
                }
              />
              <span className="muted">→</span>
              <NumInput
                value={cue.endMs}
                onChange={(endMs) =>
                  setPost((post) => ({
                    ...post,
                    subtitles: post.subtitles.map((item) =>
                      item.id === cue.id ? { ...item, endMs } : item,
                    ),
                  }))
                }
              />
              <TextInput
                value={cue.text}
                onChange={(text) =>
                  setPost((post) => ({
                    ...post,
                    subtitles: post.subtitles.map((item) =>
                      item.id === cue.id ? { ...item, text } : item,
                    ),
                  }))
                }
              />
              <Toggle
                checked={cue.enabled}
                onChange={(enabled) =>
                  setPost((post) => ({
                    ...post,
                    subtitles: post.subtitles.map((item) =>
                      item.id === cue.id ? { ...item, enabled } : item,
                    ),
                  }))
                }
                label="显示"
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ---------- BGM（spec §5.8.4） ----------

interface BgmSectionProps {
  project: Project;
  materials: Material[];
}

function BgmSection({ project, materials }: BgmSectionProps) {
  const setPost = useAppStore((state) => state.setPost);
  const bgm = project.post.bgm;
  const options = recommendBgmMaterials(project.meta.mood, materials);
  const materialOptions = [
    { value: "", label: options.length > 0 ? "选择 BGM…" : "素材库还没有音频" },
    ...options.map((material) => ({ value: material.id, label: material.name })),
  ];

  return (
    <section className="subcard" data-testid="post-bgm">
      <header className="subcard__head">
        <h3 className="subcard__title">背景音乐</h3>
        <div className="subcard__actions">
          <button
            type="button"
            className="link-btn"
            disabled={!bgm}
            onClick={() => setPost((post) => ({ ...post, bgm: null }))}
          >
            清除
          </button>
        </div>
      </header>
      <div className="subcard__body">
        <div className="export-row">
          <span className="export-row__label">曲目</span>
          <Select
            value={bgm?.materialId ?? ""}
            options={materialOptions}
            onChange={(id) => {
              const material = options.find((item) => item.id === id);
              if (material) setPost((post) => ({ ...post, bgm: makeBgmTrack(material) }));
            }}
          />
          <span className="muted">
            {bgm ? bgm.name : "未选（情绪基调：" + (project.meta.mood || "未填") + "）"}
          </span>
        </div>

        {bgm ? (
          <>
            <div className="export-row">
              <span className="export-row__label">音量</span>
              <NumInput
                value={bgm.volume}
                onChange={(volume) => setPost((post) => ({ ...post, bgm: { ...bgm, volume } }))}
              />
              <Toggle
                checked={bgm.ducking}
                onChange={(ducking) => setPost((post) => ({ ...post, bgm: { ...bgm, ducking } }))}
                label="对白时闪避"
              />
              <NumInput
                value={bgm.duckVolume}
                onChange={(duckVolume) =>
                  setPost((post) => ({ ...post, bgm: { ...bgm, duckVolume } }))
                }
              />
              <Toggle
                checked={bgm.looping}
                onChange={(looping) => setPost((post) => ({ ...post, bgm: { ...bgm, looping } }))}
                label="循环"
              />
            </div>
            <audio
              className="post-audio"
              controls
              preload="metadata"
              src={convertFileSrc(bgm.path)}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------- 音效（spec §5.8.4） ----------

function SfxSection({ project, materials }: { project: Project; materials: Material[] }) {
  const setPost = useAppStore((state) => state.setPost);
  const [picked, setPicked] = useState("");
  const suggestions = sfxSuggestions(project, project.post.timeline);
  const options = materials.filter((material) => material.kind === "audio");
  const materialOptions = [
    { value: "", label: options.length > 0 ? "选择音效…" : "素材库还没有音频" },
    ...options.map((material) => ({ value: material.id, label: material.name })),
  ];
  const chosen = options.find((material) => material.id === picked);

  const attached = (shotId: string): boolean =>
    project.post.sfx.some((cue) => cue.shotId === shotId);

  return (
    <section className="subcard" data-testid="post-sfx">
      <header className="subcard__head">
        <h3 className="subcard__title">音效（{project.post.sfx.length} 条）</h3>
        <div className="subcard__actions">
          <Select value={picked} options={materialOptions} onChange={setPicked} />
        </div>
      </header>
      <div className="subcard__body">
        {suggestions.length === 0 ? (
          <p className="muted">
            分镜里还没有填「音效提示」。回第 4 步给镜头补上，再点「一键同步」。
          </p>
        ) : (
          suggestions.map((suggestion) => (
            <div className="export-row" key={suggestion.shotId}>
              <span className="export-row__label">第 {suggestion.shotNo} 镜</span>
              <span className="muted">
                {suggestion.hint}（{seconds(suggestion.atMs)} 秒）
              </span>
              {attached(suggestion.shotId) ? (
                <span className="prompt-card__flag">已挂接</span>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  disabled={!chosen}
                  onClick={() =>
                    chosen &&
                    setPost((post) => ({
                      ...post,
                      sfx: [...post.sfx, makeSfxCue(suggestion, chosen)],
                    }))
                  }
                >
                  挂接
                </button>
              )}
            </div>
          ))
        )}

        {project.post.sfx.map((cue) => (
          <div className="export-row" key={cue.id}>
            <span className="export-row__label">第 {cue.shotNo} 镜</span>
            <span className="muted">
              {cue.hint} · {baseName(cue.path)} @ {seconds(cue.atMs)} 秒
            </span>
            <button
              type="button"
              className="link-btn link-btn--danger"
              onClick={() =>
                setPost((post) => ({ ...post, sfx: post.sfx.filter((item) => item.id !== cue.id) }))
              }
            >
              移除
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- 四轨时间线（spec §5.8.5） ----------

function TimelineSection({ project }: { project: Project }) {
  const timeline = project.post.timeline;
  const totalMs = timelineDurationMs(timeline);
  const targetMs = project.meta.episodeDurationMs;

  const sceneNames = new Map<string, string>();
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      sceneNames.set(
        scene.id,
        scene.location ? `第 ${scene.no} 场 · ${scene.location}` : `第 ${scene.no} 场`,
      );
    }
  }

  return (
    <section className="subcard" data-testid="post-timeline">
      <header className="subcard__head">
        <h3 className="subcard__title">四轨时间线（{timeline.length} 段）</h3>
        <div className="subcard__actions">
          <span className="muted">
            合计 {seconds(totalMs)} 秒 / 目标 {seconds(targetMs)} 秒
          </span>
        </div>
      </header>
      <div className="subcard__body">
        {timeline.length === 0 ? (
          <p className="muted">时间线为空。把已采用的片段交给「一键同步」来拼接。</p>
        ) : (
          timeline.map((clip) => (
            <div className="export-row" key={clip.id}>
              <span className="export-row__label">第 {clip.shotNo} 镜</span>
              <span className="muted">
                {sceneNames.get(clip.sceneId) ?? "—"} · {TRANSITION_LABELS[clip.transition]} ·{" "}
                {seconds(clip.startMs)}–{seconds(clip.startMs + clip.durationMs)} 秒 ·{" "}
                {baseName(clip.clipPath)}
              </span>
            </div>
          ))
        )}
        <p className="sdnote sdnote--hint">
          配音 / 字幕 / BGM 分别按各自的时间挂在这一条时间轴上，导出时由脚本合成。
        </p>
      </div>
    </section>
  );
}
