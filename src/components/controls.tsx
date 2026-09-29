/**
 * 表单基础控件：单行输入 / 多行输入 / 下拉。
 *
 * 立项与剧本两个面板共用同一套外观、以及"数组 ↔ 逗号分隔文本"的转换约定，
 * 抽出来是为了让两处的填写手感一致，不必各自维护一份。
 */

export function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="input"
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="input input--area"
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      className="input"
      value={value}
      onChange={(event) => {
        const raw = event.target.value;
        const matched = options.find((option) => String(option.value) === raw);
        if (matched) onChange(matched.value);
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 字符串数组 → 逗号分隔文本（存的时候再拆回来）。 */
export function joinList(values: string[]): string {
  return values.join("，");
}

export function splitList(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
