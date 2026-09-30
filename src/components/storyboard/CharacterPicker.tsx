/**
 * 出场角色选择器：有角色卡时点选，没建档时退回手填。
 *
 * 之所以优先给"点选"：第 3 步建好的角色卡才是下游一致性的锚点，
 * 手打的名字一旦与卡名差一个字，第 5 步就引用不到参考图。
 * 但没建档也不能把人卡死，所以保留手填兜底（与剧本字段同一套约定）。
 */

import type { Character } from "../../lib/types";
import { TextInput, joinList, splitList } from "../controls";

export interface CharacterPickerProps {
  characters: Character[];
  value: string[];
  onChange: (next: string[]) => void;
}

export function CharacterPicker({ characters, value, onChange }: CharacterPickerProps) {
  const named = characters.filter((character) => character.name.trim());

  if (named.length === 0) {
    return (
      <TextInput
        value={joinList(value)}
        placeholder="例如：林晚， 张德海"
        onChange={(text) => onChange(splitList(text))}
      />
    );
  }

  const names = named.map((character) => character.name);
  // 卡被删掉后残留的名字仍然显示为可移除的标签，不让它静默消失。
  const extras = value.filter((name) => !names.includes(name));

  const toggle = (name: string): void => {
    onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  };

  return (
    <div className="charchips">
      {named.map((character) => {
        const active = value.includes(character.name);
        return (
          <button
            key={character.id}
            type="button"
            className={`chip${active ? " chip--on" : ""}`}
            aria-pressed={active}
            title={active ? "点击移出本镜" : "点击加入本镜"}
            onClick={() => toggle(character.name)}
          >
            {character.name}
          </button>
        );
      })}
      {extras.map((name) => (
        <button
          key={name}
          type="button"
          className="chip chip--unknown"
          aria-pressed
          title="这个名字没有对应的角色卡，点击移除"
          onClick={() => onChange(value.filter((item) => item !== name))}
        >
          {name} ×
        </button>
      ))}
    </div>
  );
}
