/**
 * 通用模板选择器：下拉即套用，可选「存为模板」与删除我的模板。
 *
 * 四个套用面（立项 / 剧本 / 分镜+运镜 / 提示词）共用这一个组件，
 * 差异全部通过 props 表达：`kind` 决定列出哪类模板，`onApply` 决定怎么套用，
 * `capture` 决定能不能把当前内容反向存成模板。
 *
 * 组件本身不碰 store 之外的状态，套用后的校验一律交给 `lib/templateOps.ts`。
 */

import { useState } from "react";
import { templatesFor } from "../lib/templates";
import type { TemplateKind } from "../lib/types";
import { useAppStore } from "../state/store";
import { TextInput } from "./controls";

export function TemplatePicker({
  kind,
  label,
  onApply,
  capture,
}: {
  kind: TemplateKind;
  label: string;
  /** 套用回调：收到的是模板原始 `payload`，由调用方用 `templateOps` 校验后写回。 */
  onApply: (payload: Record<string, unknown>) => void;
  /** 存在时显示「存为模板」；返回 `null` 表示当前没有可存的内容。 */
  capture?: () => Record<string, unknown> | null;
}) {
  const templates = useAppStore((state) => state.templates) ?? [];
  const saveTemplate = useAppStore((state) => state.saveTemplate);
  const deleteTemplate = useAppStore((state) => state.deleteTemplate);

  const mine = templates.filter((item) => item.kind === kind);
  const options = templatesFor(kind, templates);

  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const handleApply = (id: string) => {
    const template = options.find((item) => item.id === id);
    if (!template) return;
    onApply(template.payload);
    setNote({ ok: true, text: `已套用「${template.name}」` });
  };

  const handleSave = async () => {
    if (!capture) return;
    const payload = capture();
    if (!payload) {
      setNote({ ok: false, text: "当前没有可存为模板的内容" });
      setNaming(false);
      return;
    }
    const name = draftName.trim() || label;
    const ok = await saveTemplate({
      id: "",
      kind,
      name,
      description: "",
      payload,
      createdAt: "",
      updatedAt: "",
    });
    setNote(ok ? { ok: true, text: `已存为「${name}」` } : { ok: false, text: "保存失败" });
    setNaming(false);
    setDraftName("");
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await deleteTemplate(id);
    setNote(ok ? { ok: true, text: `已删除「${name}」` } : { ok: false, text: "删除失败" });
  };

  return (
    <div className="tpl">
      <div className="tpl__row">
        <select
          className="input"
          value=""
          aria-label={label}
          onChange={(event) => handleApply(event.target.value)}
        >
          <option value="">{label}</option>
          <optgroup label="内置模板">
            {options
              .filter((item) => item.id.startsWith("builtin-"))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </optgroup>
          {mine.length > 0 ? (
            <optgroup label="我的模板">
              {mine.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>

        {capture ? (
          naming ? (
            <>
              <TextInput value={draftName} placeholder={`${label}名称`} onChange={setDraftName} />
              <button className="btn" type="button" onClick={handleSave}>
                确定
              </button>
              <button className="btn btn--ghost" type="button" onClick={() => setNaming(false)}>
                取消
              </button>
            </>
          ) : (
            <button className="btn btn--ghost" type="button" onClick={() => setNaming(true)}>
              存为模板
            </button>
          )
        ) : null}
      </div>

      {note ? (
        <p className={`sdnote ${note.ok ? "sdnote--ok" : "sdnote--error"}`}>{note.text}</p>
      ) : null}

      {mine.length > 0 ? (
        <details className="tpl__manage">
          <summary className="muted">管理我的模板（{mine.length}）</summary>
          <ul className="tpl__list">
            {mine.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <button
                  className="icon-btn icon-btn--danger"
                  type="button"
                  onClick={() => handleDelete(item.id, item.name)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
