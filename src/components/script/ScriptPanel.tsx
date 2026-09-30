/**
 * 第 2 步「剧本」右栏：A 创意核 / B 大纲 / C 正文（按场）/ D 一致性引用。
 *
 * 右栏是唯一真相源：所有控件受控，写回只走 store 的剧本动作；
 * AI 的产出也只能经由那些动作落进来，所以"字段锁"只需要在一个地方生效。
 */

import { BEATS_LOCK_KEY, SCRIPT_FIELDS, structuresFor } from "../../lib/scriptTemplates";
import { collectCharacterRefs, undefinedCharacterRefs } from "../../lib/scriptOps";
import { scriptPatchFrom, scriptPayloadFrom } from "../../lib/templateOps";
import type { Script } from "../../lib/types";
import { useAppStore } from "../../state/store";
import { CollapsibleCard } from "../CollapsibleCard";
import { Select, TextArea, TextInput } from "../controls";
import { FieldRow } from "../FieldRow";
import { TemplatePicker } from "../TemplatePicker";
import { FieldActions } from "./FieldActions";
import { SceneList } from "./SceneList";

/** 节拍存成字符串数组，编辑时一行一条。 */
function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ScriptPanel() {
  const project = useAppStore((state) => state.project);
  const updateScript = useAppStore((state) => state.updateScript);
  const applyScriptPatch = useAppStore((state) => state.applyScriptPatch);
  const updateEpisode = useAppStore((state) => state.updateEpisode);
  const addEpisode = useAppStore((state) => state.addEpisode);
  const removeEpisode = useAppStore((state) => state.removeEpisode);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;

  const { meta, script, episodes } = project;
  const locked = new Set(script.lockedFields);
  const structures = structuresFor(meta.kind);
  const characterRefs = collectCharacterRefs(project);
  const pendingRefs = undefinedCharacterRefs(project);

  const episodeLabel = (no: number): string =>
    meta.kind === "short_video" ? "主片" : `第 ${no} 集`;

  return (
    <div className="panel">
      <TemplatePicker
        kind="script"
        label="套用题材模板"
        onApply={(payload) => {
          const patch = scriptPatchFrom(payload);
          const structure = patch.structure;
          delete patch.structure;
          // A 段字段经 applyScriptPatch 写回，字段锁在这里自动生效。
          applyScriptPatch(patch);
          if (structure && structures.some((item) => item.id === structure)) {
            updateScript({ structure });
          }
        }}
        capture={() => {
          const payload = scriptPayloadFrom(script);
          return Object.keys(payload).length > 0 ? payload : null;
        }}
      />

      <CollapsibleCard step="A" title="创意核" hint="先把故事钉死，后面每一场都从这六句长出来">
        {SCRIPT_FIELDS.map(({ key, label, why }) => (
          <FieldRow key={key} label={label} why={why}>
            <TextArea
              rows={2}
              value={script[key]}
              onChange={(value) => {
                const patch: Partial<Script> = {};
                patch[key] = value;
                updateScript(patch);
              }}
            />
            <FieldActions
              scope={{ kind: "creativeCore" }}
              lock={{ field: key, locked: locked.has(key) }}
            />
          </FieldRow>
        ))}
      </CollapsibleCard>

      <CollapsibleCard step="B" title="大纲" hint="用结构模板把每一集的节拍排好，再到 C 段填正文">
        <FieldRow label="结构模板" why="选错结构最省事的补救就是这步换一个，再点「按结构模板重写」">
          <Select
            value={script.structure || structures[0].id}
            options={structures.map((structure) => ({
              value: structure.id,
              label: `${structure.label} · ${structure.summary}`,
            }))}
            onChange={(structure) => updateScript({ structure })}
          />
        </FieldRow>

        {episodes.length === 0 ? (
          <p className="muted">还没有集。点下面「＋ 新增一集」起步。</p>
        ) : null}

        {episodes.map((episode) => (
          <section className="subcard" key={episode.id}>
            <header className="subcard__head">
              <span className="subcard__title">{episodeLabel(episode.no)}</span>
              <div className="subcard__actions">
                <FieldActions
                  scope={{ kind: "outline", episodeId: episode.id }}
                  lock={{ field: BEATS_LOCK_KEY, locked: locked.has(BEATS_LOCK_KEY) }}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  title="删除这一集"
                  onClick={() => removeEpisode(episode.id)}
                >
                  删除
                </button>
              </div>
            </header>

            <div className="subcard__body">
              <FieldRow label="本集标题" why="给这一集起个能一眼看懂的名字">
                <TextInput
                  value={episode.title}
                  placeholder="例如：被当众赶出家门"
                  onChange={(title) => updateEpisode(episode.id, { title })}
                />
              </FieldRow>

              <FieldRow label="本集梗概" why="2-3 句说清这一集从哪开始、到哪结束">
                <TextArea
                  rows={2}
                  value={episode.summary}
                  placeholder="只交代因果与转折，不写台词"
                  onChange={(summary) => updateEpisode(episode.id, { summary })}
                />
              </FieldRow>

              <FieldRow
                label="节拍"
                why="一行一个节拍，顺序就是这一集的推进顺序"
                source={locked.has(BEATS_LOCK_KEY) ? "已锁定" : undefined}
              >
                <TextArea
                  rows={4}
                  value={episode.beats.join("\n")}
                  placeholder="铺垫：……"
                  onChange={(text) => updateEpisode(episode.id, { beats: splitLines(text) })}
                />
              </FieldRow>
            </div>
          </section>
        ))}

        <div className="scenelist__foot">
          <button type="button" className="btn" onClick={addEpisode}>
            ＋ 新增一集
          </button>
        </div>
      </CollapsibleCard>

      <CollapsibleCard step="C" title="剧本正文" hint="一场一卡：把每个场写到能直接开拍">
        {episodes.length === 0 ? (
          <p className="muted">先在上面加一集，正文才有地方放。</p>
        ) : (
          episodes.map((episode) => (
            <div className="episodeblock" key={episode.id}>
              <p className="episodeblock__title">{episodeLabel(episode.no)}</p>
              <SceneList episode={episode} />
            </div>
          ))
        )}
      </CollapsibleCard>

      <CollapsibleCard
        step="D"
        title="一致性引用"
        hint="从台词与出场角色里自动收集，第 3 步按它建角色卡"
      >
        <FieldRow label="出场角色" why="这些名字会被第 3 步变成真正的角色卡，脸部才会一致">
          {characterRefs.length > 0 ? (
            <p className="refs">{characterRefs.join("、")}</p>
          ) : (
            <p className="muted">C 段还没写出场角色。</p>
          )}
        </FieldRow>

        <FieldRow
          label="待补角色"
          why="这里列出的名字还没有对应的角色卡，去第 3 步补上"
          source="→ 第 3 步资产"
        >
          {pendingRefs.length > 0 ? (
            <ul className="refs refs--warn">
              {pendingRefs.map((ref) => (
                <li key={ref}>{ref}</li>
              ))}
            </ul>
          ) : (
            <p className="refs refs--ok">
              {characterRefs.length > 0 ? "全部角色都已建档。" : "暂无待办。"}
            </p>
          )}
        </FieldRow>
      </CollapsibleCard>
    </div>
  );
}
