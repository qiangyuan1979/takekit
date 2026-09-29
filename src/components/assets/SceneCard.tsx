/**
 * 场景卡：一个地点在整部片子里的视觉基准。
 *
 * 字段会被 `buildScenePrompt` 拼成"无人空镜"参考图，供后续分镜当环境锚点。
 */

import type { SceneAsset } from "../../lib/types";
import { generateAssetImage, removeAsset } from "../../state/assetImages";
import { useAppStore } from "../../state/store";
import { Select, TextArea, TextInput } from "../controls";
import { FieldRow } from "../FieldRow";
import { ImageStrip } from "./ImageStrip";

const PLACEMENT_OPTIONS = [
  { value: "interior", label: "内景" },
  { value: "exterior", label: "外景" },
] as const;

export function SceneCard({ scene }: { scene: SceneAsset }) {
  const updateSceneAsset = useAppStore((state) => state.updateSceneAsset);
  const hasImageKey = useAppStore((state) => state.settings.image.apiKey.trim().length > 0);

  return (
    <section className="subcard">
      <header className="subcard__head">
        <span className="subcard__title">{scene.name || "未命名场景"}</span>
        <div className="subcard__actions">
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            title="删除这张场景卡"
            onClick={() => void removeAsset("scene", scene.id)}
          >
            删除
          </button>
        </div>
      </header>

      <div className="subcard__body">
        <FieldRow label="场景名" why="剧本里「地点」写的就是它，同名才能自动引用同一套环境">
          <TextInput
            value={scene.name}
            placeholder="例如：老宅客厅"
            onChange={(name) => updateSceneAsset(scene.id, { name })}
          />
        </FieldRow>

        <FieldRow label="内景 / 外景" why="决定打光与背景层次，是场景最先要定的一件">
          <Select
            value={scene.interior ? "interior" : "exterior"}
            options={PLACEMENT_OPTIONS}
            onChange={(value) => updateSceneAsset(scene.id, { interior: value === "interior" })}
          />
        </FieldRow>

        <FieldRow label="时间" why="如「清晨」「深夜」，同一地点的不同时间算两个场景">
          <TextInput
            value={scene.timeOfDay}
            placeholder="例如：雨夜"
            onChange={(timeOfDay) => updateSceneAsset(scene.id, { timeOfDay })}
          />
        </FieldRow>

        <FieldRow label="天气" why="影响光线与氛围，外景尤其重要">
          <TextInput
            value={scene.weather}
            placeholder="例如：小雨"
            onChange={(weather) => updateSceneAsset(scene.id, { weather })}
          />
        </FieldRow>

        <FieldRow label="场景描述" why="写清空间布局与陈设，跨镜头才认得是同一个地方">
          <TextArea
            rows={2}
            value={scene.description}
            placeholder="例如：挑高客厅，深色木质家具，落地窗外可见庭院"
            onChange={(description) => updateSceneAsset(scene.id, { description })}
          />
        </FieldRow>

        <FieldRow label="光线" why="如「侧逆光」「冷暖对撞」，是场景氛围的一半">
          <TextInput
            value={scene.lighting}
            placeholder="例如：暖黄吊灯 + 窗外冷蓝月光"
            onChange={(lighting) => updateSceneAsset(scene.id, { lighting })}
          />
        </FieldRow>

        <FieldRow label="场景参考图" why="锁定环境基准；后续镜头带上它，同场景不会换布景">
          <ImageStrip
            kind="scene"
            ownerId={scene.id}
            paths={scene.refImages}
            onGenerate={() => generateAssetImage({ kind: "scene", ownerId: scene.id })}
            generateLabel="生成场景图（4 张）"
            generateDisabledReason={
              hasImageKey ? undefined : "还没配图片模型：去顶栏「设置」填即梦 API Key"
            }
            emptyHint="还没有场景参考图。生成或上传一张，作为环境基准。"
          />
        </FieldRow>
      </div>
    </section>
  );
}
