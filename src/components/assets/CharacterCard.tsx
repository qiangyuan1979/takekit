/**
 * 角色卡：一个人在整部片子里的视觉基准。
 *
 * 「外貌」六个字段 + 服装套装，会被 `buildCharacterPrompt` 拼进定妆照提示词；
 * `portrait` 则是这张卡的基准图——后续分镜都以它为脸部锚点。
 */

import { useState } from "react";
import { makeCostume } from "../../lib/assetOps";
import type { Appearance, Character, Costume } from "../../lib/types";
import { generateAssetImage, removeAsset } from "../../state/assetImages";
import { useAppStore } from "../../state/store";
import { TextArea, TextInput, joinList, splitList } from "../controls";
import { FieldRow } from "../FieldRow";
import { ImageStrip } from "./ImageStrip";

const APPEARANCE_FIELDS: readonly { key: keyof Appearance; label: string; why: string }[] = [
  { key: "faceShape", label: "脸型", why: "如「鹅蛋脸」「方圆脸」，是辨脸的第一特征" },
  { key: "hair", label: "发型", why: "如「齐肩直发」「短碎盖」，别写「换个发型」这种模糊描述" },
  { key: "hairColor", label: "发色", why: "如「自然黑」「栗棕」，跨镜头最容易跑的就是发色" },
  { key: "eyeColor", label: "眼睛", why: "如「丹凤眼」「大眼双眼皮」，写清眼型与眼色" },
  { key: "height", label: "身高体型", why: "如「170cm 偏瘦」，决定同框时的比例" },
  { key: "body", label: "其他体貌", why: "疤痕、气质等能一眼区分开两个角色的特征" },
];

export function CharacterCard({ character }: { character: Character }) {
  const updateCharacter = useAppStore((state) => state.updateCharacter);
  const setCharacterPortrait = useAppStore((state) => state.setCharacterPortrait);
  const hasImageKey = useAppStore((state) => state.settings.image.apiKey.trim().length > 0);

  const [activeCostumeId, setActiveCostumeId] = useState<string | null>(
    character.costumes[0]?.id ?? null,
  );

  const activeCostume =
    character.costumes.find((costume) => costume.id === activeCostumeId) ?? null;

  const patchCostume = (costumeId: string, patch: Partial<Costume>) =>
    updateCharacter(character.id, {
      costumes: character.costumes.map((costume) =>
        costume.id === costumeId ? { ...costume, ...patch } : costume,
      ),
    });

  const addCostume = () => {
    const costume = makeCostume();
    updateCharacter(character.id, { costumes: [...character.costumes, costume] });
    setActiveCostumeId(costume.id);
  };

  const removeCostume = (costumeId: string) => {
    updateCharacter(character.id, {
      costumes: character.costumes.filter((costume) => costume.id !== costumeId),
    });
    if (activeCostumeId === costumeId) setActiveCostumeId(null);
  };

  return (
    <section className="subcard">
      <header className="subcard__head">
        <span className="subcard__title">{character.name || "未命名角色"}</span>
        <div className="subcard__actions">
          {activeCostume ? (
            <span className="field__source">定妆照用「{activeCostume.name || "未命名套装"}」</span>
          ) : null}
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            title="删除这张角色卡（不会改动剧本里的名字）"
            onClick={() => void removeAsset("character", character.id)}
          >
            删除
          </button>
        </div>
      </header>

      <div className="subcard__body">
        <FieldRow label="角色名" why="要和剧本 C 段里写的名字一致，第 3 步才能对上号">
          <TextInput
            value={character.name}
            placeholder="例如：林晚"
            onChange={(name) => updateCharacter(character.id, { name })}
          />
        </FieldRow>

        <FieldRow label="别名" why="剧本里用到的其他称呼，逗号分隔；填了就不会被判成「待补角色」">
          <TextInput
            value={joinList(character.aliases)}
            placeholder="例如：晚晚，林总"
            onChange={(text) => updateCharacter(character.id, { aliases: splitList(text) })}
          />
        </FieldRow>

        <FieldRow label="年龄 / 性别" why="影响五官与体态，也影响配音选型">
          <div className="pair">
            <TextInput
              value={character.age}
              placeholder="年龄，如 28"
              onChange={(age) => updateCharacter(character.id, { age })}
            />
            <TextInput
              value={character.gender}
              placeholder="性别，如 女"
              onChange={(gender) => updateCharacter(character.id, { gender })}
            />
          </div>
        </FieldRow>

        {APPEARANCE_FIELDS.map(({ key, label, why }) => (
          <FieldRow key={key} label={label} why={why}>
            <TextInput
              value={character.appearance[key]}
              onChange={(value) =>
                updateCharacter(character.id, {
                  appearance: { ...character.appearance, [key]: value },
                })
              }
            />
          </FieldRow>
        ))}

        <FieldRow label="性格" why="给 AI 写台词用；越具体，人物越不像模板">
          <TextArea
            rows={2}
            value={character.personality}
            placeholder="例如：外冷内热，被戳到痛处会先沉默再反击"
            onChange={(personality) => updateCharacter(character.id, { personality })}
          />
        </FieldRow>

        <FieldRow label="说话风格" why="口头禅、语速、用词习惯，AI 生成台词时会照这个来">
          <TextInput
            value={character.speechStyle}
            placeholder="例如：话少，句子短，习惯用反问"
            onChange={(speechStyle) => updateCharacter(character.id, { speechStyle })}
          />
        </FieldRow>

        <FieldRow label="配音参考" why="第 8 步后期配音的选型依据，先记一句形容">
          <TextInput
            value={character.voice}
            placeholder="例如：女声·清冷偏低"
            onChange={(voice) => updateCharacter(character.id, { voice })}
          />
        </FieldRow>

        <FieldRow label="定妆照" why="生成或上传人物基准图；有基准后，后续每一镜才不会换脸">
          <ImageStrip
            kind="character"
            ownerId={character.id}
            paths={character.refImages}
            primary={character.portrait}
            onSetPrimary={(path) => setCharacterPortrait(character.id, path)}
            onGenerate={() =>
              generateAssetImage({
                kind: "character",
                ownerId: character.id,
                costume: activeCostume ?? undefined,
              })
            }
            generateLabel="生成定妆照（4 张）"
            generateDisabledReason={
              hasImageKey ? undefined : "还没配图片模型：去顶栏「设置」填即梦 API Key"
            }
            emptyHint="还没有定妆照。生成 4 张候选，挑一张「设为基准」。"
          />
        </FieldRow>

        <FieldRow label="服装套装" why="选中一套会写进定妆照提示词；同一角色换装不必重建卡">
          <div className="costumes">
            {character.costumes.length === 0 ? (
              <p className="muted">还没有服装套装。加一套，定妆照就会带上这套衣服。</p>
            ) : null}
            {character.costumes.map((costume) => (
              <div className="costume" key={costume.id}>
                <label className="costume__pick" title="生成定妆照时使用这套服装">
                  <input
                    type="radio"
                    name={`costume-${character.id}`}
                    checked={activeCostumeId === costume.id}
                    onChange={() => setActiveCostumeId(costume.id)}
                  />
                  使用
                </label>
                <TextInput
                  value={costume.name}
                  placeholder="套装名，如「灰西装」"
                  onChange={(name) => patchCostume(costume.id, { name })}
                />
                <TextInput
                  value={costume.description}
                  placeholder="一句话描述：如「灰色三件套 + 白衬衫」"
                  onChange={(description) => patchCostume(costume.id, { description })}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  title="删除这套服装"
                  onClick={() => removeCostume(costume.id)}
                >
                  删除
                </button>
              </div>
            ))}
            <div className="scenelist__foot">
              <button type="button" className="btn" onClick={addCostume}>
                ＋ 新增服装套装
              </button>
            </div>
          </div>
        </FieldRow>
      </div>
    </section>
  );
}
