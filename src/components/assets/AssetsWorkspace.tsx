/**
 * 第 3 步「资产」工作区：角色卡 / 场景卡 / 道具卡 / 画风锁定。
 *
 * 顶部那条带子承担两件事：把剧本 C 段的「待补角色」一键变成角色卡，
 * 以及在没有图片模型时明确告诉新手"生成按钮为什么点不动"。
 */

import { undefinedCharacterRefs } from "../../lib/scriptOps";
import { useAppStore } from "../../state/store";
import { CollapsibleCard } from "../CollapsibleCard";
import { CharacterCard } from "./CharacterCard";
import { PropCard } from "./PropCard";
import { SceneCard } from "./SceneCard";
import { StyleLockCard } from "./StyleLockCard";

export function AssetsWorkspace() {
  const project = useAppStore((state) => state.project);
  const hasImageKey = useAppStore((state) => state.settings.image.apiKey.trim().length > 0);
  const addCharacter = useAppStore((state) => state.addCharacter);
  const addSceneAsset = useAppStore((state) => state.addSceneAsset);
  const addProp = useAppStore((state) => state.addProp);
  const fillCharactersFromScript = useAppStore((state) => state.fillCharactersFromScript);

  if (!project) return <p className="muted">请先新建或打开一个项目。</p>;

  const { characters, scenes, props } = project.assets;
  const pending = undefinedCharacterRefs(project);

  return (
    <div className="workspace">
      <div className="assetbar">
        {pending.length > 0 ? (
          <>
            <button
              type="button"
              className="btn"
              title="把剧本里还没建档的角色一次建成角色卡，之后填外貌即可"
              onClick={fillCharactersFromScript}
            >
              一键建档（{pending.length}）
            </button>
            <p className="assetbar__hint assetbar__hint--warn">
              剧本里这些名字还没有角色卡：{pending.join("、")}
            </p>
          </>
        ) : (
          <p className="assetbar__hint">剧本里的角色都已建档，接下来把外貌与定妆照补上。</p>
        )}
        {hasImageKey ? null : (
          <p className="assetbar__hint">
            还没配图片模型：上传图片照旧可用，想用「生成」请去顶栏「设置」填即梦 API Key。
          </p>
        )}
        <div className="assetbar__add">
          <button type="button" className="icon-btn" onClick={() => addCharacter("")}>
            ＋ 角色
          </button>
          <button type="button" className="icon-btn" onClick={() => addSceneAsset("")}>
            ＋ 场景
          </button>
          <button type="button" className="icon-btn" onClick={() => addProp("")}>
            ＋ 道具
          </button>
        </div>
      </div>

      <div className="asset__scroll">
        <div className="panel">
          <CollapsibleCard title="角色卡" hint={`${characters.length} 个角色 · 一致性成败的关键`}>
            {characters.length === 0 ? (
              <p className="muted">
                还没有角色卡。点顶部「＋ 角色」，或先把剧本写完再回来一键建档。
              </p>
            ) : (
              characters.map((character) => (
                <CharacterCard key={character.id} character={character} />
              ))
            )}
          </CollapsibleCard>

          <CollapsibleCard title="场景卡" hint={`${scenes.length} 个场景 · 同场景别换布景`}>
            {scenes.length === 0 ? (
              <p className="muted">还没有场景卡。把剧本里的主要地点建成场景，环境才稳定。</p>
            ) : (
              scenes.map((scene) => <SceneCard key={scene.id} scene={scene} />)
            )}
          </CollapsibleCard>

          <CollapsibleCard
            title="道具卡"
            hint={`${props.length} 个道具 · 会反复出现才值得建`}
            defaultOpen={false}
          >
            {props.length === 0 ? (
              <p className="muted">还没有道具卡。只给会反复出现的关键物件建档。</p>
            ) : (
              props.map((prop) => <PropCard key={prop.id} prop={prop} />)
            )}
          </CollapsibleCard>

          <CollapsibleCard title="画风锁定" hint="全片共享：色调、质感、光线" defaultOpen={false}>
            <StyleLockCard />
          </CollapsibleCard>
        </div>
      </div>
    </div>
  );
}
