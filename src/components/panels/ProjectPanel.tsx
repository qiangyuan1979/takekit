/**
 * 第 1 步「立项」面板：4 张卡，把模糊喜好收敛成下游能用的硬参数。
 *
 * 所有控件都是受控的，写回路径只有一条：store.updateMeta。
 * 表单里不出现任何"三态 AI 改写"控件——那要等到 M2 有真实模型可调用时再加，
 * 现在放上去就是假 UI。
 */

import { ASPECT_RATIOS, type AspectRatio, type WorkKind } from "../../lib/types";
import { useAppStore } from "../../state/store";
import { CollapsibleCard } from "../CollapsibleCard";
import { FieldRow } from "../FieldRow";

// ---------- 下拉字典（新手可选项，避免自由填写踩坑） ----------

const GENRES = [
  "都市逆袭",
  "霸总甜宠",
  "复仇爽剧",
  "悬疑反转",
  "古风言情",
  "战争热血",
  "家庭伦理",
  "玄幻脑洞",
  "乡村生活",
];

const PLATFORMS = ["抖音", "快手", "视频号", "小红书", "B站", "YouTube Shorts", "TikTok"];

const RESOLUTIONS = ["1080x1920", "720x1280", "1920x1080", "1080x1080", "2160x3840"];

const FPS_OPTIONS = [24, 25, 30, 60];

/** 单集时长候选项（毫秒）。 */
const DURATIONS = [
  { label: "30 秒", value: 30_000 },
  { label: "60 秒（1 分钟）", value: 60_000 },
  { label: "90 秒", value: 90_000 },
  { label: "120 秒（2 分钟）", value: 120_000 },
  { label: "180 秒（3 分钟）", value: 180_000 },
];

const LANGUAGES = ["zh-CN", "zh-TW", "en-US"];

const VISUAL_STYLES = [
  "实拍写实感",
  "电影质感",
  "日系清爽",
  "国潮插画",
  "3D 渲染",
  "复古胶片",
  "赛博霓虹",
  "水墨国风",
];

const MOODS = ["爽", "虐", "甜", "悬", "燃", "暖", "冷", "笑"];

const VIDEO_MODELS = [
  { value: "kling", label: "可灵 Kling" },
  { value: "seedance", label: "即梦 Seedance" },
];

const IMAGE_MODELS = [
  { value: "jimeng", label: "即梦" },
  { value: "seedream", label: "Seedream" },
];

const LLMS = [{ value: "openai-compat", label: "OpenAI 兼容（通用）" }];

const VOICES = ["女声·清冷", "女声·温柔", "女声·御姐", "男声·沉稳", "男声·少年", "旁白·纪实"];

const PRESETS = ["标准", "稳妥（少抽卡）", "大胆（强运动）"];

// ---------- 控件 ----------

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="input"
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Select<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      className="input"
      value={value}
      onChange={(event) => {
        const raw = event.target.value;
        const matched = options.find((option) => String(option.value) === raw);
        if (matched) onChange(matched.value);
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 字符串数组 → 逗号分隔文本（存的时候再拆回来）。 */
function joinList(values: string[]): string {
  return values.join("，");
}

function splitList(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---------- 面板 ----------

export function ProjectPanel() {
  const meta = useAppStore((state) => state.project?.meta);
  const updateMeta = useAppStore((state) => state.updateMeta);

  if (!meta) return <p className="muted">请先新建或打开一个项目。</p>;

  const toOptions = (items: string[]) => items.map((item) => ({ value: item, label: item }));
  const isDrama = meta.kind === "short_drama";

  return (
    <div className="panel">
      <CollapsibleCard step="卡1" title="作品定位" hint="决定后面所有提示词的用词与节奏">
        <FieldRow label="作品名" why="用于文件命名与导出成片的标题">
          <TextInput
            value={meta.title}
            placeholder="例如：重生之我在都市当龙王"
            onChange={(title) => updateMeta({ title })}
          />
        </FieldRow>

        <FieldRow label="作品类型" why="短剧按「集」组织，短视频只有一条主线">
          <Select<WorkKind>
            value={meta.kind}
            onChange={(kind) => updateMeta({ kind })}
            options={[
              { value: "short_drama", label: "短剧（分集）" },
              { value: "short_video", label: "短视频（单条）" },
            ]}
          />
        </FieldRow>

        <FieldRow label="赛道题材" why="题材决定钩子写法与前期铺垫的力度">
          <Select
            value={meta.genre}
            onChange={(genre) => updateMeta({ genre })}
            options={toOptions(GENRES)}
          />
        </FieldRow>

        <FieldRow label="目标平台" why="平台决定竖屏比例、可接受的时长与开篇节奏">
          <Select
            value={meta.platform}
            onChange={(platform) => updateMeta({ platform })}
            options={toOptions(PLATFORMS)}
          />
        </FieldRow>

        <FieldRow label="目标受众" why="写给谁看，直接影响人物台词的分寸，可留空">
          <TextInput
            value={meta.audience}
            placeholder="例如：25-40 岁、喜欢爽感反转的男性用户"
            onChange={(audience) => updateMeta({ audience })}
          />
        </FieldRow>
      </CollapsibleCard>

      <CollapsibleCard step="卡2" title="规格参数" hint="会被自动注入到后面每一镜的生成参数">
        <FieldRow
          label="画面比例"
          why="竖屏平台选 9:16；同一项目中途改动会导致已生成的片段不可用"
          source="→ 第 6 步视频参数"
        >
          <Select<AspectRatio>
            value={meta.aspectRatio}
            onChange={(aspectRatio) => updateMeta({ aspectRatio })}
            options={[...ASPECT_RATIOS].map((ratio) => ({ value: ratio, label: ratio }))}
          />
        </FieldRow>

        <FieldRow label="分辨率" why="影响清晰度与生成耗时，新手建议直接用平台推荐值">
          <Select
            value={meta.resolution}
            onChange={(resolution) => updateMeta({ resolution })}
            options={toOptions(RESOLUTIONS)}
          />
        </FieldRow>

        <FieldRow label="帧率" why="电影感常用 24，通用流畅选 30">
          <Select<number>
            value={meta.fps}
            onChange={(fps) => updateMeta({ fps })}
            options={FPS_OPTIONS.map((fps) => ({ value: fps, label: `${fps} fps` }))}
          />
        </FieldRow>

        <FieldRow
          label="单集时长"
          why="分镜总时长不能超过它——第 4 步会按这个值卡你"
          source="→ 第 4 步时长校验"
        >
          <Select<number>
            value={meta.episodeDurationMs}
            onChange={(episodeDurationMs) => updateMeta({ episodeDurationMs })}
            options={DURATIONS}
          />
        </FieldRow>

        {isDrama ? (
          <FieldRow
            label="总集数"
            why="只对短剧生效，用于规划整季的角色与场景复用"
            source="短剧专属"
          >
            <input
              className="input"
              type="number"
              min={1}
              value={meta.episodeCount}
              onChange={(event) => updateMeta({ episodeCount: Number(event.target.value) || 0 })}
            />
          </FieldRow>
        ) : null}

        <FieldRow label="台词语言" why="决定剧本生成与配音的语言">
          <Select
            value={meta.language}
            onChange={(language) => updateMeta({ language })}
            options={toOptions(LANGUAGES)}
          />
        </FieldRow>

        <FieldRow label="字幕语言" why="可与台词不同，方便做双语出海">
          <Select
            value={meta.subtitleLanguage}
            onChange={(subtitleLanguage) => updateMeta({ subtitleLanguage })}
            options={toOptions(LANGUAGES)}
          />
        </FieldRow>
      </CollapsibleCard>

      <CollapsibleCard
        step="卡3"
        title="风格锚点"
        hint="整套作品只锁定一种风格，避免剪辑时画面打架"
      >
        <FieldRow
          label="视觉风格"
          why="一句话定调，会拼进每一条提示词的风格段"
          source="→ 第 6 步提示词"
        >
          <Select
            value={meta.visualStyle}
            onChange={(visualStyle) => updateMeta({ visualStyle })}
            options={toOptions(VISUAL_STYLES)}
          />
        </FieldRow>

        <FieldRow label="情绪基调" why="决定光线与配乐的冷暖">
          <Select
            value={meta.mood}
            onChange={(mood) => updateMeta({ mood })}
            options={toOptions(MOODS)}
          />
        </FieldRow>

        <FieldRow label="风格关键词" why="用逗号分隔，会作为附加词追加到提示词末尾，可留空">
          <input
            className="input"
            type="text"
            value={joinList(meta.styleKeywords)}
            placeholder="例如：高对比，浅景深，胶片颗粒"
            onChange={(event) => updateMeta({ styleKeywords: splitList(event.target.value) })}
          />
        </FieldRow>
      </CollapsibleCard>

      <CollapsibleCard
        step="卡4"
        title="生成默认配置"
        hint="每镜都可以单独改，这里只是省事的默认值"
      >
        <FieldRow label="默认视频模型" why="决定出片用哪家：可灵质感稳，即梦运动强">
          <Select
            value={meta.defaultVideoModel}
            onChange={(defaultVideoModel) => updateMeta({ defaultVideoModel })}
            options={VIDEO_MODELS}
          />
        </FieldRow>

        <FieldRow label="默认图片模型" why="关键帧与资产定妆照使用">
          <Select
            value={meta.defaultImageModel}
            onChange={(defaultImageModel) => updateMeta({ defaultImageModel })}
            options={IMAGE_MODELS}
          />
        </FieldRow>

        <FieldRow label="默认文本模型" why="剧本、分镜与提示词的改写都走它">
          <Select
            value={meta.defaultLlm}
            onChange={(defaultLlm) => updateMeta({ defaultLlm })}
            options={LLMS}
          />
        </FieldRow>

        <FieldRow label="默认音色" why="用于后期配音，可先选一个再在第 8 步微调">
          <Select
            value={meta.defaultVoice}
            onChange={(defaultVoice) => updateMeta({ defaultVoice })}
            options={toOptions(VOICES)}
          />
        </FieldRow>

        <FieldRow label="参数预设" why="省事优先选「标准」；抽卡太久选「稳妥」，画面太闷选「大胆」">
          <Select
            value={meta.paramPreset}
            onChange={(paramPreset) => updateMeta({ paramPreset })}
            options={toOptions(PRESETS)}
          />
        </FieldRow>
      </CollapsibleCard>
    </div>
  );
}
