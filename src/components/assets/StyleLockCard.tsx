/**
 * 画风锁定：整部片子共享的色调 / 质感 / 光线基准。
 *
 * 它不是一张"卡"而是唯一的全局设置，所以没有删除，也不属于角色 / 场景 / 道具列表。
 * 提示词模板与风格锚会拼进每一张资产图，跨图风格才统一。
 */

import { STYLE_OWNER_ID } from "../../lib/assetOps";
import { generateAssetImage } from "../../state/assetImages";
import { useAppStore } from "../../state/store";
import { TextArea, joinList } from "../controls";
import { FieldRow } from "../FieldRow";
import { ImageStrip } from "./ImageStrip";

export function StyleLockCard() {
  const styleLock = useAppStore((state) => state.project?.assets.styleLock ?? null);
  const meta = useAppStore((state) => state.project?.meta ?? null);
  const updateStyleLock = useAppStore((state) => state.updateStyleLock);
  const hasImageKey = useAppStore((state) => state.settings.image.apiKey.trim().length > 0);

  if (!styleLock || !meta) return null;

  const anchor = [joinList(meta.styleKeywords), meta.visualStyle].filter(Boolean).join("；");

  return (
    <section className="subcard">
      <div className="subcard__body">
        <FieldRow label="画风模板" why="一句话锁定全片质感，会被拼进每一张资产图的提示词">
          <TextArea
            rows={2}
            value={styleLock.promptTemplate}
            placeholder="例如：电影感实拍，低饱和冷调，浅景深，胶片颗粒"
            onChange={(promptTemplate) => updateStyleLock({ promptTemplate })}
          />
        </FieldRow>

        <FieldRow
          label="继承自立项的风格"
          why="来自第 1 步卡 3；想改就去第 1 步改，避免两处打架"
          source="→ 第 1 步立项"
        >
          <p className={anchor ? "refs" : "muted"}>
            {anchor || "第 1 步还没填风格关键词与视觉风格。"}
          </p>
        </FieldRow>

        <FieldRow label="随机种子" why="固定同一个种子，重出时风格更连续；留空即每次随机">
          <input
            className="input"
            type="number"
            value={styleLock.seed ?? ""}
            placeholder="留空即随机"
            onChange={(event) => {
              const raw = event.target.value.trim();
              const parsed = Number(raw);
              updateStyleLock({ seed: raw && Number.isFinite(parsed) ? parsed : null });
            }}
          />
        </FieldRow>

        <FieldRow label="画风参考图" why="出图时作为风格锚；没有也行，但有了更稳">
          <ImageStrip
            kind="style"
            ownerId={STYLE_OWNER_ID}
            paths={styleLock.refImages}
            onGenerate={() => generateAssetImage({ kind: "style", ownerId: STYLE_OWNER_ID })}
            generateLabel="生成画风图（4 张）"
            generateDisabledReason={
              hasImageKey ? undefined : "还没配图片模型：去顶栏「设置」填即梦 API Key"
            }
            emptyHint="还没有画风参考图。生成或上传一张作为全片风格基准。"
          />
        </FieldRow>
      </div>
    </section>
  );
}
