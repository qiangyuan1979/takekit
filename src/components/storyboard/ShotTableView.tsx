/**
 * 分镜 · 表格视图：像 Excel 一样横向铺开整集镜头，适合批量改。
 *
 * 两个取舍：
 * ① 行高固定 48px 并做虚拟滚动——两三百镜全量渲染会让每次按键都卡；
 * ② 勾选多镜后可批量设置景别 / 运镜 / 时长，这是"表格比卡片快"的唯一理由。
 * 景别与运镜一律走下拉（本步的硬约束），时长按秒录入、落盘仍是毫秒。
 */

import { useMemo, useState } from "react";
import {
  CAMERA_MOVE_OPTIONS,
  SHOT_SIZE_OPTIONS,
  TRANSITION_OPTIONS,
  clampDurationMs,
  toCameraMove,
  toShotSize,
} from "../../lib/shotOps";
import type { Character, Episode } from "../../lib/types";
import { useAppStore } from "../../state/store";
import { Select, TextInput } from "../controls";
import { CharacterPicker } from "./CharacterPicker";
import { useVirtualRows } from "./useVirtualRows";

const ROW_HEIGHT = 48;

export interface ShotTableViewProps {
  episode: Episode;
  characters: Character[];
}

export function ShotTableView({ episode, characters }: ShotTableViewProps) {
  const updateShot = useAppStore((state) => state.updateShot);
  const removeShot = useAppStore((state) => state.removeShot);
  const moveShot = useAppStore((state) => state.moveShot);
  const updateManyShots = useAppStore((state) => state.updateManyShots);

  const [selected, setSelected] = useState<string[]>([]);
  const [bulkSeconds, setBulkSeconds] = useState("3");

  const rows = useMemo(
    () =>
      episode.scenes.flatMap((scene) =>
        scene.shots.map((shot, index) => ({
          shot,
          scene,
          index,
          count: scene.shots.length,
        })),
      ),
    [episode],
  );

  const virtual = useVirtualRows(rows.length, ROW_HEIGHT);
  const visible = rows.slice(virtual.start, virtual.end);
  const allSelected = rows.length > 0 && selected.length === rows.length;

  const toggle = (shotId: string): void =>
    setSelected((prev) =>
      prev.includes(shotId) ? prev.filter((id) => id !== shotId) : [...prev, shotId],
    );

  const patch = (sceneId: string, shotId: string, next: Parameters<typeof updateShot>[3]): void =>
    updateShot(episode.id, sceneId, shotId, next);

  const applyBulk = (next: Parameters<typeof updateManyShots>[2]): void => {
    if (selected.length === 0) return;
    updateManyShots(episode.id, selected, next);
    setSelected([]);
  };

  if (rows.length === 0) {
    return (
      <p className="muted">
        这一集还没有镜头。用上方的「离线拆镜」按场先拆一版，或用「AI 拆镜」让模型给候选。
      </p>
    );
  }

  return (
    <div className="shot-table">
      {selected.length > 0 ? (
        <div className="shot-bulk">
          <span className="shot-bulk__count">已选 {selected.length} 镜</span>
          <Select<string>
            value=""
            options={[{ value: "", label: "批量设为景别…" }, ...SHOT_SIZE_OPTIONS]}
            onChange={(next) => {
              if (!next) return;
              applyBulk({ shotSize: toShotSize(next) });
            }}
          />
          <Select<string>
            value=""
            options={[{ value: "", label: "批量设为运镜…" }, ...CAMERA_MOVE_OPTIONS]}
            onChange={(next) => {
              if (!next) return;
              applyBulk({ cameraMove: toCameraMove(next) });
            }}
          />
          <label className="shot-bulk__num">
            每镜
            <input
              className="input"
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              value={bulkSeconds}
              onChange={(event) => setBulkSeconds(event.target.value)}
            />
            秒
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                const seconds = Number(bulkSeconds);
                if (!Number.isFinite(seconds) || seconds <= 0) return;
                applyBulk({ durationMs: clampDurationMs(seconds * 1000) });
              }}
            >
              应用
            </button>
          </label>
          <button type="button" className="icon-btn" onClick={() => setSelected([])}>
            取消选择
          </button>
        </div>
      ) : null}

      <div className="shot-table__grid" ref={virtual.ref} onScroll={virtual.onScroll}>
        <div className="shot-table__head">
          <div className="shot-table__row shot-table__row--head">
            <span className="shot-table__cell">
              <input
                type="checkbox"
                aria-label="全选"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.shot.id))}
              />
            </span>
            <span className="shot-table__cell">镜号</span>
            <span className="shot-table__cell">场</span>
            <span className="shot-table__cell">景别</span>
            <span className="shot-table__cell">运镜</span>
            <span className="shot-table__cell">时长</span>
            <span className="shot-table__cell">画面描述</span>
            <span className="shot-table__cell">出场角色</span>
            <span className="shot-table__cell">台词</span>
            <span className="shot-table__cell">旁白</span>
            <span className="shot-table__cell">转场</span>
            <span className="shot-table__cell">操作</span>
          </div>
        </div>

        <div className="shot-table__body">
          <div className="shot-table__spacer" style={{ height: virtual.totalHeight }}>
            <div
              className="shot-table__window"
              style={{ transform: `translateY(${virtual.offsetY}px)` }}
            >
              {visible.map(({ shot, scene, index, count }) => (
                <div className="shot-table__row" data-testid="shot-row" key={shot.id}>
                  <span className="shot-table__cell">
                    <input
                      type="checkbox"
                      aria-label={`选择第 ${shot.no} 镜`}
                      checked={selected.includes(shot.id)}
                      onChange={() => toggle(shot.id)}
                    />
                  </span>
                  <span className="shot-table__cell shot-table__no">{shot.no}</span>
                  <span className="shot-table__cell shot-table__muted">第 {scene.no} 场</span>
                  <span className="shot-table__cell">
                    <Select
                      value={shot.shotSize}
                      options={SHOT_SIZE_OPTIONS}
                      onChange={(next) => patch(scene.id, shot.id, { shotSize: next })}
                    />
                  </span>
                  <span className="shot-table__cell">
                    <Select
                      value={shot.cameraMove}
                      options={CAMERA_MOVE_OPTIONS}
                      onChange={(next) => patch(scene.id, shot.id, { cameraMove: next })}
                    />
                  </span>
                  <span className="shot-table__cell">
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
                  </span>
                  <span className="shot-table__cell">
                    <TextInput
                      value={shot.visualDesc}
                      placeholder="镜头里能看见什么"
                      onChange={(visualDesc) => patch(scene.id, shot.id, { visualDesc })}
                    />
                  </span>
                  <span className="shot-table__cell">
                    <CharacterPicker
                      characters={characters}
                      value={shot.characters}
                      onChange={(names) => patch(scene.id, shot.id, { characters: names })}
                    />
                  </span>
                  <span className="shot-table__cell">
                    <TextInput
                      value={shot.dialogue ?? ""}
                      placeholder="台词"
                      onChange={(text) => patch(scene.id, shot.id, { dialogue: text || null })}
                    />
                  </span>
                  <span className="shot-table__cell">
                    <TextInput
                      value={shot.narration ?? ""}
                      placeholder="旁白"
                      onChange={(text) => patch(scene.id, shot.id, { narration: text || null })}
                    />
                  </span>
                  <span className="shot-table__cell">
                    <Select
                      value={shot.transition}
                      options={TRANSITION_OPTIONS}
                      onChange={(next) => patch(scene.id, shot.id, { transition: next })}
                    />
                  </span>
                  <span className="shot-table__cell shot-table__ops">
                    <button
                      type="button"
                      className="icon-btn"
                      title="与上一镜交换位置"
                      disabled={index === 0}
                      onClick={() => moveShot(episode.id, scene.id, shot.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="与下一镜交换位置"
                      disabled={index === count - 1}
                      onClick={() => moveShot(episode.id, scene.id, shot.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      title="删除这一镜"
                      onClick={() => removeShot(episode.id, scene.id, shot.id)}
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
