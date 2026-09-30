/**
 * 设置弹层：三个 provider（文本 / 图片 / 视频）的连接参数 + LLM 生成参数。
 *
 * 弹层只在打开时挂载，草稿用 useState 从当前设置初始化——关闭即丢弃未保存的改动，
 * 避免"改了一半又关掉"把设置弄脏。
 */

import { useState } from "react";
import { useAppStore } from "../state/store";
import type { AppSettings, ProviderConfig } from "../lib/types";
import { FONT_PRESETS, materialFontToken, resolveUiFont } from "../lib/uiFont";
import { Select, TextInput } from "./controls";

interface ProviderFormProps {
  title: string;
  hint: string;
  value: ProviderConfig;
  placeholderBaseUrl: string;
  placeholderModel: string;
  onChange: (next: ProviderConfig) => void;
}

function ProviderForm({
  title,
  hint,
  value,
  placeholderBaseUrl,
  placeholderModel,
  onChange,
}: ProviderFormProps) {
  return (
    <section className="providerform">
      <p className="providerform__title">
        {title}
        <span className="providerform__hint">{hint}</span>
      </p>
      <label className="providerform__row">
        <span className="providerform__label">Base URL</span>
        <TextInput
          value={value.baseUrl}
          placeholder={placeholderBaseUrl}
          onChange={(baseUrl) => onChange({ ...value, baseUrl })}
        />
      </label>
      <label className="providerform__row">
        <span className="providerform__label">API Key</span>
        <input
          className="input"
          type="password"
          value={value.apiKey}
          placeholder="只存本机密钥库，不写进项目文件"
          onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
        />
      </label>
      <label className="providerform__row">
        <span className="providerform__label">模型</span>
        <TextInput
          value={value.model}
          placeholder={placeholderModel}
          onChange={(model) => onChange({ ...value, model })}
        />
      </label>
    </section>
  );
}

export interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useAppStore((state) => state.settings);
  const materials = useAppStore((state) => state.materials);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [draft, setDraft] = useState<AppSettings>(settings);

  // 素材库里的字体作为可选项；已被删掉的令牌会回落成「默认」，不会选中一个不存在的项。
  const fontMaterials = materials.filter((material) => material.kind === "font");
  const fontIds = fontMaterials.map((material) => material.id);
  const fontOptions = [
    ...FONT_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    ...fontMaterials.map((material) => ({
      value: materialFontToken(material.id),
      label: `素材库 · ${material.name}`,
    })),
  ];
  const fontValue = FONT_PRESETS.some((preset) => preset.id === draft.uiFont)
    ? draft.uiFont
    : resolveUiFont(draft.uiFont, fontIds).materialId
      ? draft.uiFont
      : "";

  const handleSave = async (): Promise<void> => {
    await updateSettings(draft);
    onClose();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="设置">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">设置</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal__body">
          <ProviderForm
            title="文本模型（LLM）"
            hint="剧本、大纲与提示词的生成都走它"
            value={draft.llm}
            placeholderBaseUrl="https://api.openai.com/v1"
            placeholderModel="例如：gpt-4o-mini"
            onChange={(llm) => setDraft({ ...draft, llm })}
          />

          <section className="providerform">
            <p className="providerform__title">
              LLM 生成参数
              <span className="providerform__hint">不知道该填什么就保持默认</span>
            </p>
            <label className="providerform__row">
              <span className="providerform__label">温度</span>
              <input
                className="input"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.llmOptions.temperature}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    llmOptions: {
                      ...draft.llmOptions,
                      temperature: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="providerform__row">
              <span className="providerform__label">最大长度</span>
              <input
                className="input"
                type="number"
                min={1}
                step={128}
                value={draft.llmOptions.maxTokens}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    llmOptions: {
                      ...draft.llmOptions,
                      maxTokens: Number(event.target.value) || 0,
                    },
                  })
                }
              />
            </label>
          </section>

          <ProviderForm
            title="图片模型"
            hint="关键帧与角色定妆照使用（第 3、5 步）"
            value={draft.image}
            placeholderBaseUrl="例如：https://ark.cn-beijing.volces.com/api/v3"
            placeholderModel="例如：即梦 / Seedream 的模型名"
            onChange={(image) => setDraft({ ...draft, image })}
          />

          <ProviderForm
            title="视频模型"
            hint="出片使用（第 7 步）"
            value={draft.video}
            placeholderBaseUrl="例如：可灵 OpenAPI 的 Base URL"
            placeholderModel="例如：kling-v1"
            onChange={(video) => setDraft({ ...draft, video })}
          />

          <section className="providerform">
            <p className="providerform__title">
              界面
              <span className="providerform__hint">只影响你看到的界面，不影响生成内容</span>
            </p>
            <label className="providerform__row">
              <span className="providerform__label">界面语言</span>
              <Select
                value={draft.language}
                options={[{ value: "zh-CN", label: "简体中文" }]}
                onChange={(language) => setDraft({ ...draft, language })}
              />
            </label>
            <p className="providerform__note">v1 只提供简体中文，更多语言在后续版本加入。</p>
            <label className="providerform__row">
              <span className="providerform__label">界面字体</span>
              <Select
                value={fontValue}
                options={fontOptions}
                onChange={(uiFont) => setDraft({ ...draft, uiFont })}
              />
            </label>
            <p className="providerform__note">
              {fontMaterials.length > 0
                ? "「素材库 · …」是你在素材库里导入的字体，保存后立即生效。"
                : "想用自己的字体？先在顶栏「素材库」里导入字体，这里就会出现。"}
            </p>
          </section>

          <section className="providerform">
            <p className="providerform__title">
              新手引导
              <span className="providerform__hint">关闭后每一步不再显示「这步干什么」引导卡</span>
            </p>
            <label className="providerform__row">
              <span className="providerform__label">显示引导</span>
              <input
                type="checkbox"
                checked={draft.onboardingEnabled}
                onChange={(event) =>
                  setDraft({ ...draft, onboardingEnabled: event.target.checked })
                }
              />
            </label>
          </section>
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleSave()}>
            保存并关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
