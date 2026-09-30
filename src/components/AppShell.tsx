/**
 * 应用外壳：顶栏 + 步骤条 + 环节内容 + 底部导航。
 *
 * 没有项目时先给一个"欢迎 + 最近项目"页——新手第一次打开不应该看到
 * 一堆禁用控件，而应该只看到两个动作：新建 或 打开。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { SAVE_LABELS, describeError } from "../i18n";
import { materialFontFaceCss, resolveUiFont } from "../lib/uiFont";
import { checkStep, stepById, STEPS, type StepId } from "../state/steps";
import { useAppStore } from "../state/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { AssetsWorkspace } from "./assets/AssetsWorkspace";
import { GenerateWorkspace } from "./generate/GenerateWorkspace";
import { KeyframesWorkspace } from "./keyframes/KeyframesWorkspace";
import { MaterialLibrary } from "./MaterialLibrary";
import { OnboardingCard } from "./OnboardingCard";
import { ProjectPanel } from "./panels/ProjectPanel";
import { PromptsWorkspace } from "./prompts/PromptsWorkspace";
import { ScriptWorkspace } from "./script/ScriptWorkspace";
import { SettingsPanel } from "./SettingsPanel";
import { StepGuard } from "./StepGuard";
import { StepRail } from "./StepRail";
import { StoryboardWorkspace } from "./storyboard/StoryboardWorkspace";

/** 把用户选中的保存路径拆成「父目录 + 项目名」。 */
function splitProjectPath(path: string): { parentDir: string; name: string } {
  const trimmed = path.trim().replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut > 0) return { parentDir: trimmed.slice(0, cut), name: trimmed.slice(cut + 1) };
  return { parentDir: trimmed, name: trimmed };
}

function StepPlaceholder({ stepId }: { stepId: StepId }) {
  const step = stepById(stepId);
  return (
    <div className="panel">
      <section className="card">
        <div className="card__body">
          <p className="placeholder__title">
            第 {step.no} 步 · {step.label}
            <span className="placeholder__badge">将在后续版本提供</span>
          </p>
          <p className="placeholder__goal">{step.goal}</p>
          <p className="field__why">常见坑：{step.tip}</p>
        </div>
      </section>
    </div>
  );
}

export function AppShell() {
  const {
    ready,
    project,
    projectPath,
    currentStep,
    saveState,
    error,
    recent,
    settings,
    materials,
    bootstrap,
    createProject,
    openProject,
    duplicateProject,
    archiveProject,
    closeProject,
    setStep,
    save,
    clearError,
  } = useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  // 本次会话里被「跳过」的步骤：只隐藏对应那一步的引导，设置里的总开关仍可一次关掉全部。
  const [skippedSteps, setSkippedSteps] = useState<ReadonlySet<StepId>>(() => new Set());

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 界面字体：改 CSS 变量；选了素材库字体时额外挂一条 @font-face。
  useEffect(() => {
    const fonts = materials.filter((material) => material.kind === "font");
    const { family, materialId } = resolveUiFont(
      settings.uiFont,
      fonts.map((material) => material.id),
    );
    document.documentElement.style.setProperty("--ui-font", family);

    const styleId = "takekit-ui-font";
    const existing = document.getElementById(styleId);
    const chosen = materialId ? fonts.find((material) => material.id === materialId) : undefined;
    if (!chosen) {
      existing?.remove();
      return;
    }
    const style = existing ?? document.createElement("style");
    style.id = styleId;
    style.textContent = materialFontFaceCss(convertFileSrc(chosen.path));
    if (!existing) document.head.appendChild(style);
  }, [settings.uiFont, materials]);

  const step = stepById(currentStep);
  const guard = useMemo(() => checkStep(currentStep, project), [currentStep, project]);
  const onboardingVisible = settings.onboardingEnabled && !skippedSteps.has(step.id);

  const prevStep = step.no > 1 ? STEPS[step.no - 2] : undefined;
  const nextStep = STEPS[step.no];

  const handleCreate = useCallback(async () => {
    const chosen = await saveDialog({
      title: "选择新项目的保存位置",
      defaultPath: `TakeKit项目-${new Date().toISOString().slice(0, 10)}`,
    });
    if (!chosen) return;
    const { parentDir, name } = splitProjectPath(chosen);
    await createProject(parentDir, name);
  }, [createProject]);

  const handleOpen = useCallback(async () => {
    const chosen = await openDialog({ title: "打开 TakeKit 项目文件夹", directory: true });
    if (typeof chosen !== "string") return;
    await openProject(chosen);
  }, [openProject]);

  // 复制：先让用户确认副本的位置与名字（默认「原名 副本」），目录整份带过去。
  const handleDuplicate = useCallback(
    async (path: string, name: string) => {
      const { parentDir } = splitProjectPath(path);
      const chosen = await saveDialog({
        title: "选择副本的保存位置",
        defaultPath: `${parentDir}${parentDir.includes("\\") ? "\\" : "/"}${name} 副本`,
      });
      if (!chosen) return;
      const dest = splitProjectPath(chosen);
      await duplicateProject(path, dest.parentDir, dest.name);
    },
    [duplicateProject],
  );

  const handleArchive = useCallback(
    async (path: string) => {
      await archiveProject(path);
    },
    [archiveProject],
  );

  if (!ready) {
    return <div className="boot">正在启动 TakeKit…</div>;
  }

  if (!project) {
    return (
      <div className="boot">
        <h1 className="boot__brand">TakeKit</h1>
        <p className="boot__slogan">跟着流程走一遍，你就知道短视频该怎么做了</p>
        <div className="boot__actions">
          <button type="button" className="btn btn--primary" onClick={() => void handleCreate()}>
            新建项目
          </button>
          <button type="button" className="btn" onClick={() => void handleOpen()}>
            打开已有项目
          </button>
        </div>

        {recent.length > 0 ? (
          <div className="recent">
            <p className="recent__title">最近打开</p>
            <ul className="recent__list">
              {recent.map((item) => (
                <li key={item.path} className="recent__row">
                  <button
                    type="button"
                    className="recent__item"
                    title={item.path}
                    onClick={() => void openProject(item.path)}
                  >
                    <span className="recent__name">{item.name}</span>
                    <span className="recent__path">{item.path}</span>
                  </button>
                  <div className="recent__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--tiny"
                      title="整份复制成新项目"
                      onClick={() => void handleDuplicate(item.path, item.name)}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--tiny"
                      title="从「最近打开」移出，磁盘上的项目文件会保留"
                      onClick={() => void handleArchive(item.path)}
                    >
                      归档
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <div className="banner banner--error" role="alert">
            <span>{describeError(error)}</span>
            <button type="button" className="banner__close" onClick={clearError}>
              关闭
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__left">
          <span className="topbar__brand">TakeKit</span>
          <span className="topbar__project" title={projectPath ?? undefined}>
            {project.name}
          </span>
        </div>
        <div className="topbar__right">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setMaterialsOpen(true)}
            title="管理跨项目复用的参考图 / 音频 / 字体"
          >
            素材库
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setSettingsOpen(true)}
            title="配置模型服务与 API Key"
          >
            设置
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              if (projectPath) void handleDuplicate(projectPath, project.name);
            }}
            title="整份复制成新项目，原项目不受影响"
          >
            复制项目
          </button>
          <button
            type="button"
            className={`save save--${saveState}`}
            onClick={() => void save()}
            disabled={saveState === "saving"}
            title="点击立即保存"
          >
            {SAVE_LABELS[saveState]}
          </button>
          <button type="button" className="btn btn--ghost" onClick={closeProject}>
            关闭项目
          </button>
        </div>
      </header>

      {error ? (
        <div className="banner banner--error" role="alert">
          <span>{describeError(error)}</span>
          <button type="button" className="banner__close" onClick={clearError}>
            关闭
          </button>
        </div>
      ) : null}

      <div className="shell__body">
        <StepRail current={currentStep} project={project} onSelect={setStep} />

        <main className="stage">
          <div className="stage__head">
            <h2 className="stage__title">
              第 {step.no} 步 · {step.label}
            </h2>
            {onboardingVisible ? null : <p className="stage__goal">{step.goal}</p>}
          </div>

          {onboardingVisible ? (
            <OnboardingCard
              step={step}
              onSkip={() => setSkippedSteps((prev) => new Set(prev).add(step.id))}
            />
          ) : null}

          <div className="stage__content">
            <ErrorBoundary>
              {step.id === "project" ? (
                <ProjectPanel />
              ) : step.id === "script" ? (
                <ScriptWorkspace />
              ) : step.id === "assets" ? (
                <AssetsWorkspace />
              ) : step.id === "storyboard" ? (
                <StoryboardWorkspace />
              ) : step.id === "keyframes" ? (
                <KeyframesWorkspace />
              ) : step.id === "prompt" ? (
                <PromptsWorkspace />
              ) : step.id === "generate" ? (
                <GenerateWorkspace />
              ) : (
                <StepPlaceholder stepId={step.id} />
              )}
            </ErrorBoundary>
          </div>

          <footer className="stage__foot">
            <StepGuard result={guard} />
            <div className="stage__nav">
              <button
                type="button"
                className="btn"
                disabled={!prevStep}
                onClick={() => prevStep && setStep(prevStep.id)}
              >
                上一步
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!nextStep || nextStep.disabled || !guard.ok}
                onClick={() => nextStep && setStep(nextStep.id)}
              >
                下一步
              </button>
            </div>
          </footer>
        </main>
      </div>

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      {materialsOpen ? <MaterialLibrary onClose={() => setMaterialsOpen(false)} /> : null}
    </div>
  );
}
