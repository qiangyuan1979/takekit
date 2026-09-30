/**
 * 出题 · 一镜一张卡：六段结构化提示词 + 中英成品 + 生成参数 + 各家请求体预览。
 *
 * 右栏字段是唯一真相源，这一页只做"把字段拼成提示词"这件确定性的事：
 * 用户改的每一处都直接写回 `shot.promptBundle`，不缓存本地副本。
 */

import { useState } from "react";
import {
  PROMPT_SECTIONS,
  bundleToJson,
  checkPromptHealth,
  composeZh,
  glossaryFor,
} from "../../lib/promptOps";
import { ASPECT_RATIOS, type Scene, type Shot, type UnifiedPrompt } from "../../lib/types";
import { clampDurationMs } from "../../lib/shotOps";
import {
  clearShotPrompt,
  generateShotPrompt,
  previewProviderBodies,
  updateShotParams,
} from "../../state/prompts";
import { useAppStore } from "../../state/store";
import { Select, TextArea, TextInput } from "../controls";

/** provider 名 → 展示名。 */
const PROVIDER_LABELS: Record<string, string> = { kling: "可灵", jimeng: "即梦" };

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 复制到剪贴板；环境不支持时静默失败（不打断流程）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface ShotPromptCardProps {
  episodeId: string;
  scene: Scene;
  shot: Shot;
  /** 当前支持的视频厂商（来自后端）。 */
  providers: string[];
}

export function ShotPromptCard({ episodeId, scene, shot, providers }: ShotPromptCardProps) {
  const updatePrompt = useAppStore((state) => state.updateShotPrompt);
  const [working, setWorking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const bundle = shot.promptBundle;
  const issues = bundle ? checkPromptHealth(bundle) : [];

  const setSection = (key: keyof UnifiedPrompt, value: string): void => {
    updatePrompt(episodeId, scene.id, shot.id, (current) => {
      const unified = { ...current.unified, [key]: value };
      // 六段是 zh 的来源，改一段就重算一次中文成品。
      return { ...current, unified, zh: composeZh(unified) };
    });
  };

  const doCopy = async (key: string, text: string): Promise<void> => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(key);
  };

  const setZh = (next: string): void => {
    updatePrompt(episodeId, scene.id, shot.id, (current) => ({ ...current, zh: next }));
  };

  const setEn = (next: string): void => {
    updatePrompt(episodeId, scene.id, shot.id, (current) => ({ ...current, en: next }));
  };

  const preview = async (provider: string): Promise<void> => {
    setWorking(provider);
    try {
      await previewProviderBodies(episodeId, scene.id, shot.id, [provider]);
    } finally {
      setWorking(null);
    }
  };

  return (
    <article className="prompt-card" data-testid="prompt-card">
      <header className="prompt-card__head">
        <span className="prompt-card__no">第 {shot.no} 镜</span>
        {bundle ? (
          <span className="prompt-card__flag">已出题</span>
        ) : (
          <span className="prompt-card__flag prompt-card__flag--todo">未出题</span>
        )}
        <span className="prompt-card__count">{bundle ? `提示词 ${bundle.zh.length} 字` : ""}</span>
      </header>

      {shot.visualDesc.trim() ? (
        <p className="prompt-card__desc">{shot.visualDesc.trim()}</p>
      ) : (
        <p className="muted prompt-card__desc">
          这一镜还没写画面描述，先回第 4 步补一句，主体段会准很多。
        </p>
      )}

      {!bundle ? (
        <div className="prompt-card__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => generateShotPrompt(episodeId, scene.id, shot.id)}
          >
            生成提示词
          </button>
          <span className="muted">按前面的字段自动拼一版，再在这里微调。</span>
        </div>
      ) : (
        <>
          {issues.length > 0 ? (
            <ul className="prompt-issues" data-testid="prompt-issues">
              {issues.map((issue) => (
                <li className="prompt-issue" key={`${issue.rule}-${issue.message}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}

          <section className="prompt-block">
            <h4 className="prompt-block__title">六段结构化提示词</h4>
            <div className="prompt-sections" data-testid="prompt-sections">
              {PROMPT_SECTIONS.map(({ key, label }) => (
                <label className="prompt-section" key={key}>
                  <span className="prompt-section__label" title={glossaryFor(key)?.why ?? ""}>
                    {label}
                  </span>
                  <TextArea
                    value={bundle.unified[key]}
                    rows={2}
                    onChange={(next) => setSection(key, next)}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="prompt-block">
            <h4 className="prompt-block__title">
              中文成品
              <button
                type="button"
                className="link-btn"
                onClick={() => void doCopy("zh", bundle.zh)}
              >
                {copied === "zh" ? "已复制" : "复制"}
              </button>
            </h4>
            <TextArea value={bundle.zh} rows={3} onChange={(next) => setZh(next)} />

            <h4 className="prompt-block__title">
              英文成品
              <button
                type="button"
                className="link-btn"
                onClick={() => void doCopy("en", bundle.en)}
              >
                {copied === "en" ? "已复制" : "复制"}
              </button>
            </h4>
            <TextArea value={bundle.en} rows={3} onChange={(next) => setEn(next)} />
            <p className="muted prompt-hint">
              英文按受控词汇（景别 / 运镜 /
              画质）拼装，自由描述沿用原文；改中文段不会自动改英文，可点「重出」重新同步。
            </p>
          </section>

          <section className="prompt-block">
            <h4 className="prompt-block__title">生成参数</h4>
            <div className="prompt-params">
              <label className="prompt-param">
                <span className="prompt-param__label">时长（秒）</span>
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={round1(bundle.params.durationMs / 1000)}
                  onChange={(event) =>
                    updateShotParams(episodeId, scene.id, shot.id, {
                      durationMs: clampDurationMs(Number(event.target.value) * 1000),
                    })
                  }
                />
              </label>

              <label className="prompt-param">
                <span className="prompt-param__label">画幅</span>
                <Select
                  value={bundle.params.aspectRatio}
                  options={ASPECT_RATIOS.map((value) => ({ value, label: value }))}
                  onChange={(next) =>
                    updateShotParams(episodeId, scene.id, shot.id, { aspectRatio: next })
                  }
                />
              </label>

              <label className="prompt-param">
                <span className="prompt-param__label">分辨率</span>
                <TextInput
                  value={bundle.params.resolution}
                  onChange={(next) =>
                    updateShotParams(episodeId, scene.id, shot.id, { resolution: next })
                  }
                />
              </label>

              <label className="prompt-param">
                <span className="prompt-param__label">帧率</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={bundle.params.fps}
                  onChange={(event) =>
                    updateShotParams(episodeId, scene.id, shot.id, {
                      fps: Math.max(1, Math.round(Number(event.target.value) || 0)),
                    })
                  }
                />
              </label>

              <label className="prompt-param">
                <span className="prompt-param__label">运动幅度</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={bundle.params.motionStrength}
                  onChange={(event) =>
                    updateShotParams(episodeId, scene.id, shot.id, {
                      motionStrength: Number(event.target.value),
                    })
                  }
                />
              </label>

              <label className="prompt-param">
                <span className="prompt-param__label">随机种子</span>
                <TextInput
                  value={bundle.params.seed === null ? "" : String(bundle.params.seed)}
                  placeholder="留空即随机"
                  onChange={(next) => {
                    const trimmed = next.trim();
                    updateShotParams(episodeId, scene.id, shot.id, {
                      seed: trimmed === "" ? null : Number(trimmed),
                    });
                  }}
                />
              </label>
            </div>

            <label className="prompt-section">
              <span className="prompt-section__label">负向提示词</span>
              <TextArea
                value={bundle.params.negativePrompt}
                rows={2}
                onChange={(next) =>
                  updateShotParams(episodeId, scene.id, shot.id, { negativePrompt: next })
                }
              />
            </label>

            <p className="muted prompt-hint">
              首帧：{bundle.params.firstFrame ?? "未定稿"}；尾帧：{bundle.params.lastFrame ?? "无"}
              。{bundle.params.firstFrame ? "" : "回第 5 步定稿首帧后重出，这里会带上。"}
            </p>
          </section>

          <section className="prompt-block">
            <h4 className="prompt-block__title">各家请求体预览</h4>
            <p className="muted prompt-hint">
              只做翻译预览，不校验密钥、不发请求——看清同一套提示词换成各家会变成什么样子。
            </p>
            <div className="prompt-providers">
              {providers.map((provider) => (
                <div className="prompt-provider" key={provider}>
                  <button
                    type="button"
                    className="btn"
                    disabled={working !== null}
                    onClick={() => void preview(provider)}
                  >
                    {working === provider ? "翻译中…" : `预览 ${providerLabel(provider)} 请求体`}
                  </button>
                  {bundle.perProvider[provider] !== undefined ? (
                    <pre className="prompt-body" data-testid={`provider-${provider}`}>
                      {JSON.stringify(bundle.perProvider[provider], null, 2)}
                    </pre>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <div className="prompt-card__actions">
            <button
              type="button"
              className="btn"
              onClick={() => generateShotPrompt(episodeId, scene.id, shot.id)}
            >
              重出（按最新字段）
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => void doCopy("json", bundleToJson(bundle))}
            >
              {copied === "json" ? "已复制完整 JSON" : "复制完整 JSON"}
            </button>
            <button
              type="button"
              className="link-btn link-btn--danger"
              onClick={() => clearShotPrompt(episodeId, scene.id, shot.id)}
            >
              清空重来
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/** 秒数保留一位小数，避免 `3.0000000000000004` 这类浮点噪声进输入框。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
