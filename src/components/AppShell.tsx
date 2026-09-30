/**
 * 应用外壳：顶栏 + 步骤条 + 环节内容 + 底部导航。
 *
 * 没有项目时先给一个"欢迎 + 最近项目"页——新手第一次打开不应该看到
 * 一堆禁用控件，而应该只看到两个动作：新建 或 打开。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { SAVE_LABELS, describeError } from "../i18n";
import { checkStep, stepById, STEPS, type StepId } from "../state/steps";
import { useAppStore } from "../state/store";
import { ErrorBoundary } from "./ErrorBoundary";
import { AssetsWorkspace } from "./assets/AssetsWorkspace";
import { ProjectPanel } from "./panels/ProjectPanel";
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
    bootstrap,
    createProject,
    openProject,
    closeProject,
    setStep,
    save,
    clearError,
  } = useAppStore();

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const step = stepById(currentStep);
  const guard = useMemo(() => checkStep(currentStep, project), [currentStep, project]);

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
                <li key={item.path}>
                  <button
                    type="button"
                    className="recent__item"
                    title={item.path}
                    onClick={() => void openProject(item.path)}
                  >
                    <span className="recent__name">{item.name}</span>
                    <span className="recent__path">{item.path}</span>
                  </button>
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
            onClick={() => setSettingsOpen(true)}
            title="配置模型服务与 API Key"
          >
            设置
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
            <p className="stage__goal">{step.goal}</p>
          </div>

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
    </div>
  );
}
