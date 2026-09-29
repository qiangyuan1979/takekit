import { defaultMeta, type Meta, type Project } from "../../src/lib/types";

/** 测试用最小可用项目；`meta` 用于覆盖立项字段，`patch` 覆盖项目级字段。 */
export function makeProject(meta: Partial<Meta> = {}, patch: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    id: "p-1",
    name: "测试项目",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    meta: { ...defaultMeta(), ...meta },
    episodes: [],
    assets: {
      characters: [],
      scenes: [],
      props: [],
      styleLock: { promptTemplate: "", refImages: [], seed: null },
    },
    tasks: [],
    templateRefs: [],
    exports: [],
    ...patch,
  };
}
