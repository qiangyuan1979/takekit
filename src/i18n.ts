/**
 * 文案与错误翻译。
 *
 * Rust 侧错误 message 是英文（日志用），用户可见文案在这里按 `code` 翻译，
 * `args` 用 `{name}` 占位符替换。
 */

import type { ApiError } from "./lib/ipc";

const ERROR_TEMPLATES: Record<string, string> = {
  io: "读写文件失败：{detail}",
  serde: "项目数据格式不正确：{detail}",
  validation: "「{field}」填写有误：{detail}",
  not_found: "找不到路径：{path}",
  conflict: "该位置已存在同名文件夹：{path}",
  schema_too_new:
    "项目文件版本（v{found}）高于当前 TakeKit 支持的版本（v{supported}），请升级后再打开。",
  network: "网络异常：{detail}",
  auth: "鉴权失败，请检查 API Key：{detail}",
  provider: "「{provider}」返回错误：{detail}",
  timeout: "等待模型响应超时：{detail}",
  rate_limit: "请求太频繁，被服务商限流：{detail}",
  internal: "内部错误：{detail}",
  /** 合成码（非 Rust 产出）：上次退出时还在排队的任务，重启后被标记为中断。 */
  interrupted: "上次生成没跑完就中断了，可以一键重试。",
  unknown: "{message}",
};

/** 把错误对象翻译成一句可直接展示给新手的中文。 */
export function describeError(error: ApiError): string {
  const template = ERROR_TEMPLATES[error.code] ?? ERROR_TEMPLATES.unknown;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = error.args?.[key];
    return value ?? (key === "message" ? error.message : whole);
  });
}

export const SAVE_LABELS = {
  idle: "未改动",
  dirty: "有未保存的改动",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
} as const;
