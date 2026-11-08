# Era CodeGraph

基于 [CodeGraph](https://github.com/colbymchenry/codegraph) 的个人 Era / Emuera 代码研究 fork。维护层为 `src/era/`、`scripts/era/`、Era 测试和 `src/era/index.ts` 列出的上游接口接缝；其余解析器、语法与构建产物沿用上游。

## Era 解析

- 识别游戏根目录 `ERB/` 下的 ERB/ERH、`CSV/` 根目录的引擎词汇表，以及 `CSV/` 任意深度的 Chara 表。
- 将名称和数字下标解析到同一 `ERA::SLOT`，保留变量读写、角色初值与原始下标链。
- 插值调用产生候选集，不把静态推断当成实际运行调用。ERB 脚本上限为 16 MB。
- 默认词汇来自 Emuera 1.824 EEv55；其他引擎可通过 `CODEGRAPH_ERA_PROFILE` 指向绝对路径的 JSON profile。
- 解码由同一入口供索引、源码展示和新鲜度哈希使用：严格 UTF-8，非法字节回退到严格 CP932（Shift-JIS）；UTF-8 BOM 固定选择 UTF-8，不以解析错误触发回退。CSV/profile 更新使同实例 sync 重解析受影响 Era 文件。
- CSV 数字下标取最后一行；最终槽位重名时，名称查找取最小数字下标。名称保留原始空白，冲突行、行号和重复下标警告仍留在图中，不增设 trim 别名。

已有本地构建时，在游戏目录运行 `codegraph init` 建立索引；`codegraph explore "EXEC_COM"` 查询符号与调用关系，`codegraph serve --mcp` 提供 MCP 服务。通用 CLI 与库接口见[上游文档](https://colbymchenry.github.io/codegraph/)。

## 引擎词汇与本机构建

`node scripts/era/build-engine-profile.mjs --src <反编译源码目录> --engine <Emuera.exe> --id <profile-id> --out <profile.json>` 从引擎源码提取变量、CSV 绑定、指令、内置方法和角色表键。`--engine` 仅提供引擎名称；可用 `--fileVersion`、`--productVersion` 记录版本。输出直接覆盖目标，不读取或计算引擎二进制摘要。

`pwsh scripts/era/deploy.ps1 -InstallRoot <目标目录>` 使用已有 Node、npm、Cargo/MSVC 构建 Windows x64 版本并写入 `current/lib-era`。无需提交工作树，也不创建提交编号目录或暂存交付链。重复运行直接替换文件及启动器；占用、权限等操作系统错误原样失败。脚本不构建 viewer、不终止进程、不删除旧版本目录；`CARGO_TARGET_DIR` 可指定 Rust 构建目录。部署是显式操作，不是研究或编辑的前置步骤。

运行要求为 Node `>=22.13.0 <25.0.0`，最低版本依据 [Node SQLite 文档](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) 的免实验开关接口。源码入口是本仓库 `src/`；编译 CLI 入口为 `dist/bin/codegraph.js`，源码改动不会自动更新它；部署入口是目标目录 `current/bin/codegraph.cmd`（或同名 shell launcher），调用 `current/node.exe` 和 `current/lib-era/dist/bin/codegraph.js`，不使用系统 Node。

本机命令解析未找到 PATH 上的 `codegraph`；当前系统 `node` 是 `D:/ProgramData/scoop/apps/nodejs-lts/current/node.exe`（26.13.0），不在本 fork 目前声明的系列内。已有独立运行时 `D:/ProgramData/scoop/apps/nodejs-lts/24.22.1/node.exe` 可显式选择；无需安装第三份 Node 或修改全局 PATH。部署脚本的 `-NodePath` 同时决定构建子进程和 bundled runtime，并在退出时还原进程 PATH。例如需部署时使用 `pwsh scripts/era/deploy.ps1 -NodePath D:/ProgramData/scoop/apps/nodejs-lts/24.22.1/node.exe`；这不是本次编辑已执行的操作。

`install.ps1`、`install.sh` 及上游自动升级面向上游发行版，不是此 Era fork 的更新入口，不应用其覆盖 `lib-era`。

本轮 CSV/解码依据直接来自原游戏 `Emuera.exe` 内 `Emuera.dll` 的只读提取副本：`ConstantData.loadDataTo` 覆盖数字行，随后按数字升序构建 `nameToIntDics`；`EncodingHandler.DetectEncoding` 验证 UTF-8 后选择 CP932，`GetEncoding(932)` 使用异常回退。原 EXE SHA-256 为 `b88278c40bc5f7f7e30e654cce79b3a42f8ecaa20c29b2909a9a782aec1b389f`。未重写游戏源码或二进制。

Era 语义测试位于 `__tests__/era.test.ts`，输入在 `__tests__/fixtures/era-game/`。按所改语义使用，不作为普通研究、保存或安装的前置。

本轮已用显式 Node 24.22.1 编译 TypeScript，并运行 Era、Node 版本提示、SQLite 打开错误、bounded source、MCP freshness 和 stale-source 六组回归（共 65 个用例，失败修正后相关组通过）。Era 用例实际比较同实例 sync/fresh、交错项目、profile 更新、CP932/UTF-8 原文与哈希，以及 17 MB ERB 的拒绝读取。新构建 `dist/bin/codegraph.js` 在 Temp CP932 游戏副本执行 `init`、`explore`、`node` 与真实 stdio MCP `initialize`/`tools/call`；CLI/MCP 均返回原文 `SIF ABL:能力 > 0`。未部署到真实安装或原游戏。

当前本地 `node_modules` 为旧 Vitest 2.1.9 且缺少根配置导入的 Svelte plugin，因此标准测试配置不能启动；上述针对 engine 的检查使用临时配置保留 home sandbox 和 lazy-engine/frameworks aliases，未因此安装或升级依赖。临时配置与游戏副本在检查后删除。

## 上游研究资料

测量原件保留在 `docs/benchmarks/`；历史方法、输入与结果见[已发布的 README](https://github.com/Extas/era-codegraph/blob/cb00c7b62353dedf97e3a965011824f715ce9d84/README.md#benchmark-results)。这些是上游特定环境的结果，不是本机性能承诺。
