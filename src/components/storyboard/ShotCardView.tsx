/**
 * 分镜 · 卡片视图：一场一组、一镜一大卡，适合逐镜抠画面。
 *
 * 与表格视图的分工：表格省地方、擅长批量；卡片有地方放画面描述与音效备注，
 * 所以音效提示与备注只在这里出现——它们是"配音 / 拟音"才用得上的字段。
 */

import {
  CAMERA_MOVE_OPTIONS,
  SHOT_SIZE_OPTIONS,
  TRANSITION_OPTIONS,
  clampDurationMs,
} from "../../lib/shotOps";
import type { Character, Episode } from "../../lib/types";
import { removeShotWithFrames } from "../../state/keyframes";
import { useAppStore } from "../../state/store";
import { Select, TextArea, TextInput } from "../controls";
import { FieldRow } from "../FieldRow";
import { CharacterPicker } from "./CharacterPicker";

export interface ShotCardViewProps {
  episode: Episode;
  characters: Character[];
}

export function ShotCardView({ episode, characters }: ShotCardViewProps) {
  const addShot = useAppStore((state) => state.addShot);
  const updateShot = useAppStore((state) => state.updateShot);
  const moveShot = useAppStore((state) => state.moveShot);

  const patch = (sceneId: string, shotId: string, next: Parameters<typeof updateShot>[3]): void =>
    updateShot(episode.id, sceneId, shotId, next);

  return (
    <div className="shot-cards">
      {episode.scenes.map((scene) => (
        <section className="shot-group" key={scene.id}>
          <header className="shot-group__head">
            <span className="shot-group__title">
              第 {scene.no} 场{scene.location ? ` · ${scene.location}` : ""}
            </span>
            <span className="shot-group__count">{scene.shots.length} 镜</span>
          </header>

          {scene.shots.length === 0 ? <p className="muted">这一场还没拆镜。</p> : null}

          {scene.shots.map((shot, index) => (
            <article className="shot-card" data-testid="shot-card" key={shot.id}>
              <header className="shot-card__head">
                <span className="shot-card__no">第 {shot.no} 镜</span>
                <div className="shot-card__actions">
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={index === 0}
                    title="与上一镜交换位置"
                    onClick={() => moveShot(episode.id, scene.id, shot.id, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={index === scene.shots.length - 1}
                    title="与下一镜交换位置"
                    onClick={() => moveShot(episode.id, scene.id, shot.id, 1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    title="删除这一镜"
                    onClick={() => void removeShotWithFrames(episode.id, scene.id, shot.id)}
                  >
                    删除
                  </button>
                </div>
              </header>

              <div className="shot-card__body">
                <div className="shot-card__thumb">
                  <span>关键帧</span>
                  <span>留给第 5 步</span>
                </div>

                <div className="shot-card__fields">
                  <FieldRow label="景别" why="决定观众离角色多近，是情绪强弱的开关">
                    <Select
                      value={shot.shotSize}
                      options={SHOT_SIZE_OPTIONS}
                      onChange={(next) => patch(scene.id, shot.id, { shotSize: next })}
                    />
                  </FieldRow>

                  <FieldRow label="运镜" why="镜头怎么动，决定这一镜是稳还是躁">
                    <Select
                      value={shot.cameraMove}
                      options={CAMERA_MOVE_OPTIONS}
                      onChange={(next) => patch(scene.id, shot.id, { cameraMove: next })}
                    />
                  </FieldRow>

                  <FieldRow label="时长（秒）" why="所有镜头加起来不能超过单集时长">
                    <input
                      className="input"
                      type="number"
                      min={0.5}
                      max={20}
                      step={0.5}
                      value={shot.durationMs / 1000}
                      onChange={(event) => {
                        const seconds = Number(event.target.value);
                        if (!Number.isFinite(seconds) || seconds <= 0) return;
                        patch(scene.id, shot.id, { durationMs: clampDurationMs(seconds * 1000) });
                      }}
                    />
                  </FieldRow>

                  <FieldRow label="画面描述" why="写清镜头里能看见什么，第 5、6 步直接读它">
                    <TextArea
                      rows={2}
                      value={shot.visualDesc}
                      placeholder="只写画面与动作，不写心理活动"
                      onChange={(visualDesc) => patch(scene.id, shot.id, { visualDesc })}
                    />
                  </FieldRow>

                  <FieldRow label="出场角色" why="点选角色卡，第 5 步才能自动带上参考图">
                    <CharacterPicker
                      characters={characters}
                      value={shot.characters}
                      onChange={(names) => patch(scene.id, shot.id, { characters: names })}
                    />
                  </FieldRow>

                  <FieldRow label="台词" why="配音与字幕直接读这一句">
                    <TextArea
                      rows={1}
                      value={shot.dialogue ?? ""}
                      placeholder="这一镜里说的那句话"
                      onChange={(text) => patch(scene.id, shot.id, { dialogue: text || null })}
                    />
                  </FieldRow>

                  <FieldRow label="旁白" why="画外音，与台词分开，方便后期分轨">
                    <TextArea
                      rows={1}
                      value={shot.narration ?? ""}
                      placeholder="这一镜的旁白"
                      onChange={(text) => patch(scene.id, shot.id, { narration: text || null })}
                    />
                  </FieldRow>

                  <FieldRow label="音效提示" why="给配音 / 拟音的提示，如「脚步回声」">
                    <TextInput
                      value={shot.sfxHint}
                      placeholder="例如：玻璃碎裂声"
                      onChange={(sfxHint) => patch(scene.id, shot.id, { sfxHint })}
                    />
                  </FieldRow>

                  <FieldRow label="转场" why="这一镜怎么进入下一镜">
                    <Select
                      value={shot.transition}
                      options={TRANSITION_OPTIONS}
                      onChange={(next) => patch(scene.id, shot.id, { transition: next })}
                    />
                  </FieldRow>

                  <FieldRow label="备注" why="给自己或协作者留的话，不进提示词">
                    <TextInput
                      value={shot.note}
                      placeholder="例如：这条要拍慢动作"
                      onChange={(note) => patch(scene.id, shot.id, { note })}
                    />
                  </FieldRow>
                </div>
              </div>
            </article>
          ))}

          <div className="shot-group__foot">
            <button
              type="button"
              className="icon-btn"
              onClick={() => addShot(episode.id, scene.id)}
            >
              ＋ 加一个镜头
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
