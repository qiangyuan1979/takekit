/**
 * C 段「剧本正文」：一集之下的场列表，每场一卡。
 *
 * 场号由 store 的增删动作自动重排（`renumberScenes`），所以这里只显示、不手改，
 * 避免出现"第 3 场排在第 1 场前面"这种下游拆镜会踩的坑。
 */

import { useState } from "react";
import { makeDialogue, parseScenesFromText, renumberScenes } from "../../lib/scriptOps";
import type { Dialogue, Episode, Scene } from "../../lib/types";
import { useAppStore } from "../../state/store";
import { Select, TextArea, TextInput, joinList, splitList } from "../controls";
import { FieldRow } from "../FieldRow";
import { FieldActions } from "./FieldActions";

/** 常用时间词，允许改成任意文本（导入解析的结果可能不在此列）。 */
const TIME_PLACEHOLDER = "例如：日 / 夜 / 黄昏";

const INTERIOR_OPTIONS = [
  { value: "内", label: "内景" },
  { value: "外", label: "外景" },
];

const IMPORT_HINT = [
  "把剧本粘进来，按【空行】分场，每块第一行当场头（可写「第 1 场 外景 街道 黄昏」），",
  "其余行形如「角色：台词」的算对白，其它行并进动作描述。",
].join("");

interface DialogueRowProps {
  dialogue: Dialogue;
  onChange: (next: Dialogue) => void;
  onRemove: () => void;
}

function DialogueRow({ dialogue, onChange, onRemove }: DialogueRowProps) {
  return (
    <div className="dialogue">
      <TextInput
        value={dialogue.characterId}
        placeholder="角色名"
        onChange={(characterId) => onChange({ ...dialogue, characterId })}
      />
      <TextArea
        rows={1}
        value={dialogue.text}
        placeholder="台词"
        onChange={(text) => onChange({ ...dialogue, text })}
      />
      <label className="dialogue__narration" title="勾上表示这句是旁白 / 画外音，不占角色位">
        <input
          type="checkbox"
          checked={dialogue.isNarration}
          onChange={(event) => onChange({ ...dialogue, isNarration: event.target.checked })}
        />
        旁白
      </label>
      <button type="button" className="icon-btn icon-btn--danger" onClick={onRemove}>
        删除
      </button>
    </div>
  );
}

export interface SceneListProps {
  episode: Episode;
}

export function SceneList({ episode }: SceneListProps) {
  const updateScene = useAppStore((state) => state.updateScene);
  const addScene = useAppStore((state) => state.addScene);
  const removeScene = useAppStore((state) => state.removeScene);
  const moveScene = useAppStore((state) => state.moveScene);
  const updateEpisode = useAppStore((state) => state.updateEpisode);

  const [importText, setImportText] = useState("");

  const handleImport = (): void => {
    const imported = parseScenesFromText(importText);
    if (imported.length === 0) return;
    updateEpisode(episode.id, {
      scenes: renumberScenes([...episode.scenes, ...imported]),
    });
    setImportText("");
  };

  const patchScene = (sceneId: string, patch: Partial<Scene>): void =>
    updateScene(episode.id, sceneId, patch);

  return (
    <div className="scenelist">
      {episode.scenes.length === 0 ? (
        <p className="muted">还没有场。先「＋ 新增一场」，或从下面粘贴一整段剧本导入。</p>
      ) : null}

      {episode.scenes.map((scene, index) => (
        <section className="subcard" key={scene.id}>
          <header className="subcard__head">
            <span className="subcard__title">第 {scene.no} 场</span>
            <div className="subcard__actions">
              <button
                type="button"
                className="icon-btn"
                disabled={index === 0}
                title="与上一场交换位置"
                onClick={() => moveScene(episode.id, scene.id, -1)}
              >
                上移
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={index === episode.scenes.length - 1}
                title="与下一场交换位置"
                onClick={() => moveScene(episode.id, scene.id, 1)}
              >
                下移
              </button>
              <FieldActions scope={{ kind: "scene", episodeId: episode.id, sceneId: scene.id }} />
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="删除这一场"
                onClick={() => removeScene(episode.id, scene.id)}
              >
                删除
              </button>
            </div>
          </header>

          <div className="subcard__body">
            <FieldRow label="内 / 外景" why="室内外用光完全不同，会写进提示词">
              <Select
                value={scene.interior ? "内" : "外"}
                options={INTERIOR_OPTIONS}
                onChange={(value) => patchScene(scene.id, { interior: value === "内" })}
              />
            </FieldRow>

            <FieldRow label="地点" why="同一个地点要复用同一张场景卡，画面才不漂移">
              <TextInput
                value={scene.location}
                placeholder="例如：旧城区出租屋"
                onChange={(location) => patchScene(scene.id, { location })}
              />
            </FieldRow>

            <FieldRow label="时间" why="白天与夜晚的光线基调不同">
              <TextInput
                value={scene.timeOfDay}
                placeholder={TIME_PLACEHOLDER}
                onChange={(timeOfDay) => patchScene(scene.id, { timeOfDay })}
              />
            </FieldRow>

            <FieldRow
              label="出场角色"
              why="用逗号分隔；第 3 步会按这些名字建角色卡"
              source="→ 第 3 步资产"
            >
              <TextInput
                value={joinList(scene.characters)}
                placeholder="例如：林晚， 张德海"
                onChange={(text) => patchScene(scene.id, { characters: splitList(text) })}
              />
            </FieldRow>

            <FieldRow label="动作描述" why="写清这一场发生了什么——第 4 步按它拆镜">
              <TextArea
                rows={4}
                value={scene.actionDesc}
                placeholder="只写能拍出来的画面与动作，不要写心理活动"
                onChange={(actionDesc) => patchScene(scene.id, { actionDesc })}
              />
            </FieldRow>

            <FieldRow label="对白" why="按顺序排列，配音与字幕直接读这一列">
              <div className="dialogues">
                {scene.dialogues.map((dialogue, dialogueIndex) => (
                  <DialogueRow
                    // 对白没有独立 id，用场内的位置作 key 即可。
                    key={dialogueIndex}
                    dialogue={dialogue}
                    onChange={(next) =>
                      patchScene(scene.id, {
                        dialogues: scene.dialogues.map((item, i) =>
                          i === dialogueIndex ? next : item,
                        ),
                      })
                    }
                    onRemove={() =>
                      patchScene(scene.id, {
                        dialogues: scene.dialogues.filter((_, i) => i !== dialogueIndex),
                      })
                    }
                  />
                ))}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() =>
                    patchScene(scene.id, { dialogues: [...scene.dialogues, makeDialogue()] })
                  }
                >
                  ＋ 添加一句台词
                </button>
              </div>
            </FieldRow>
          </div>
        </section>
      ))}

      <div className="scenelist__foot">
        <button type="button" className="btn" onClick={() => addScene(episode.id)}>
          ＋ 新增一场
        </button>
      </div>

      <details className="import">
        <summary className="import__summary">粘贴纯文本导入多场</summary>
        <p className="import__hint">{IMPORT_HINT}</p>
        <textarea
          className="input input--area"
          rows={6}
          value={importText}
          placeholder={
            "第 1 场 内景 出租屋 夜\n林晚：这房租，我不能交。\n\n第 2 场 外景 街道 黄昏\n林晚：拦下那辆车。"
          }
          onChange={(event) => setImportText(event.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={importText.trim().length === 0}
          onClick={handleImport}
        >
          追加导入
        </button>
      </details>
    </div>
  );
}
