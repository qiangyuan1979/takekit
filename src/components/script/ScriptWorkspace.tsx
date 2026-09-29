/**
 * 第 2 步「剧本」的工作区：顶部一条操作带 + 左栏 AI 共创 / 右栏结构化字段。
 *
 * 顶部那条带子承担"没有 Key 也能把流程走完"的兜底：离线模板填充。
 */

import { useAppStore } from "../../state/store";
import { ChatPanel } from "./ChatPanel";
import { ScriptPanel } from "./ScriptPanel";

export function ScriptWorkspace() {
  const fillFromTemplate = useAppStore((state) => state.fillFromTemplate);
  const hasKey = useAppStore((state) => state.settings.llm.apiKey.trim().length > 0);

  return (
    <div className="workspace">
      <div className="scriptbar">
        <button
          type="button"
          className="btn"
          title="用立项参数生成一份带【占位符】的草稿，之后照着改就行"
          onClick={fillFromTemplate}
        >
          模板填充（离线可用）
        </button>
        <p className="scriptbar__hint">
          {hasKey
            ? "已经配置好 LLM：在右栏字段旁点「生成 / 续写 / 重写」，结果只会落进右栏。"
            : "还没填 LLM API Key：先用「模板填充」把骨架搭起来；要 AI 帮忙，去顶栏「设置」里配置。"}
        </p>
      </div>

      <div className="split">
        <ChatPanel />
        <section className="split__col split__col--form">
          <div className="split__scroll">
            <ScriptPanel />
          </div>
        </section>
      </div>
    </div>
  );
}
