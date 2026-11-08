# Era CodeGraph

基于 [CodeGraph](https://github.com/colbymchenry/codegraph) 的个人 Era / Emuera 代码研究 fork。维护层为 `src/era/`、`scripts/era/`、Era 测试和 `src/era/index.ts` 列出的上游接口接缝；其余解析器、语法与构建产物沿用上游。

## Era 解析

- 识别游戏根目录 `ERB/` 下的 ERB/ERH、`CSV/` 根目录的引擎词汇表，以及 `CSV/` 任意深度的 Chara 表。
- 将名称和数字下标解析到同一 `ERA::SLOT`，保留变量读写、角色初值与原始下标链。
- 插值调用产生候选集，不把静态推断当成实际运行调用。ERB 脚本上限为 16 MB。
- 默认词汇来自 Emuera 1.824 EEv55；其他引擎可通过 `CODEGRAPH_ERA_PROFILE` 指向绝对路径的 JSON profile。

已有本地构建时，在游戏目录运行 `codegraph init` 建立索引；`codegraph explore "EXEC_COM"` 查询符号与调用关系，`codegraph serve --mcp` 提供 MCP 服务。通用 CLI 与库接口见[上游文档](https://colbymchenry.github.io/codegraph/)。

## 引擎词汇与本机构建

`node scripts/era/build-engine-profile.mjs --src <反编译源码目录> --engine <Emuera.exe> --id <profile-id> --out <profile.json>` 从引擎源码提取变量、CSV 绑定、指令、内置方法和角色表键。`--engine` 仅提供引擎名称；可用 `--fileVersion`、`--productVersion` 记录版本。输出直接覆盖目标，不读取或计算引擎二进制摘要。

`pwsh scripts/era/deploy.ps1 -InstallRoot <目标目录>` 使用已有 Node、npm、Cargo/MSVC 构建 Windows x64 版本并写入 `current/lib-era`。无需提交工作树，也不创建提交编号目录或暂存交付链。重复运行直接替换文件及启动器；占用、权限等操作系统错误原样失败。脚本不构建 viewer、不终止进程、不删除旧版本目录；`CARGO_TARGET_DIR` 可指定 Rust 构建目录。部署是显式操作，不是研究或编辑的前置步骤。

Era 语义测试位于 `__tests__/era.test.ts`，输入在 `__tests__/fixtures/era-game/`。按所改语义使用，不作为普通研究、保存或安装的前置。

## 上游研究资料

测量原件保留在 `docs/benchmarks/`；历史方法、输入与结果见[已发布的 README](https://github.com/Extas/era-codegraph/blob/cb00c7b62353dedf97e3a965011824f715ce9d84/README.md#benchmark-results)。这些是上游特定环境的结果，不是本机性能承诺。
