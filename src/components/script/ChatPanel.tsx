/**
 * 左栏「AI 共创」面板：消息流 + 本次补充要求。
 *
 * 这里不负责发起请求——发起在右栏字段旁的三个按钮上（`FieldActions`），
 * 因为"AI 改哪一块"这件事只能在右栏看得见。左栏只做两件事：
 * 显示 AI 每一步改了什么，以及收集用户想追加的要求。
 */

import { useEffect, useRef } from "react";
import { useAiChat } from "../../state/aiChat";

/** 新手最常想追加的几句话，点一下就填进输入框。 */
const QUICK_REQUESTS = ["更口语化", "节奏再快一点", "控制在 3 句以内", "结尾加一个反转"];

export function ChatPanel() {
  const messages = useAiChat((state) => state.messages);
  const busy = useAiChat((state) => state.busy);
  const instruction = useAiChat((state) => state.instruction);
  const setInstruction = useAiChat((state) => state.setInstruction);
  const clear = useAiChat((state) => state.clear);

  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  return (
    <section className="split__col chat">
      <header className="chat__head">
        <span className="chat__title">AI 共创</span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={clear}
          disabled={messages.length === 0 || busy}
        >
          清空记录
        </button>
      </header>

      <div className="chat__log" ref={logRef}>
        {messages.length === 0 ? (
          <p className="chat__empty">
            先去右栏把字段写一写；然后点字段旁边的「生成 / 续写 / 重写」，AI
            的每一步都会出现在这里。
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`bubble bubble--${message.role}${
                message.state === "error" ? " bubble--error" : ""
              }`}
            >
              <p className="bubble__title">
                {message.title}
                {message.state === "streaming" ? (
                  <span className="bubble__state">生成中…</span>
                ) : null}
              </p>
              <pre className="bubble__body">{message.body}</pre>
            </div>
          ))
        )}
      </div>

      <footer className="chat__foot">
        <div className="chat__chips">
          {QUICK_REQUESTS.map((quick) => (
            <button
              key={quick}
              type="button"
              className="chip"
              onClick={() => setInstruction(instruction ? `${instruction}；${quick}` : quick)}
            >
              {quick}
            </button>
          ))}
        </div>
        <textarea
          className="input input--area"
          rows={2}
          value={instruction}
          placeholder="补充要求（可留空）：例如「别写心理活动，只写能拍出来的画面」"
          onChange={(event) => setInstruction(event.target.value)}
        />
        <p className="chat__hint">写好后，点右栏字段旁的按钮生效。</p>
      </footer>
    </section>
  );
}
