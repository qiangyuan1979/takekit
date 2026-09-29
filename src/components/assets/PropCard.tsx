/**
 * 道具卡：会反复出现的关键物件（手机、戒指、合同……）。
 *
 * 数据模型上道具只有一张基准图，因此这里只提供上传 / 替换，不做多候选生成。
 */

import type { Prop } from "../../lib/types";
import { removeAsset } from "../../state/assetImages";
import { useAppStore } from "../../state/store";
import { TextArea, TextInput } from "../controls";
import { FieldRow } from "../FieldRow";
import { ImageStrip } from "./ImageStrip";

export function PropCard({ prop }: { prop: Prop }) {
  const updateProp = useAppStore((state) => state.updateProp);

  return (
    <section className="subcard">
      <header className="subcard__head">
        <span className="subcard__title">{prop.name || "未命名道具"}</span>
        <div className="subcard__actions">
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            title="删除这张道具卡"
            onClick={() => void removeAsset("prop", prop.id)}
          >
            删除
          </button>
        </div>
      </header>

      <div className="subcard__body">
        <FieldRow label="道具名" why="剧本里提到的关键物件名，写一致才方便对应">
          <TextInput
            value={prop.name}
            placeholder="例如：母亲的银戒指"
            onChange={(name) => updateProp(prop.id, { name })}
          />
        </FieldRow>

        <FieldRow label="说明" why="外观与它在剧情里的意义，写清才能保持前后一致">
          <TextArea
            rows={2}
            value={prop.description}
            placeholder="例如：素圈银戒，内侧刻着一个「安」字"
            onChange={(description) => updateProp(prop.id, { description })}
          />
        </FieldRow>

        <FieldRow label="道具参考图" why="只保留一张：需要时上传或直接替换">
          <ImageStrip
            kind="prop"
            ownerId={prop.id}
            paths={prop.refImage ? [prop.refImage] : []}
            multiple={false}
            emptyHint="还没有道具图。上传一张作为外观基准。"
          />
        </FieldRow>
      </div>
    </section>
  );
}
