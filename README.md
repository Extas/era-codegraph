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

Era 语义测试位于 `__tests__/era.test.ts`，输入在 `__tests__/fixtures/era-game/`。上游研究材料保留在 `docs/benchmarks/`；下方保留原 README 的测量输入与结果，不作为保存、安装或使用门槛。

<details>
<summary>上游研究测量（原始输入与结果）</summary>

> **A note on cost:** CodeGraph's win on *every* codebase is precision — the agent stops crawling files and answers from the graph. On current models that precision is also a large direct saving: the 2026-08 re-measurement, on a harness that blocks the CLI in both arms, put it at **44% lower cost and 62% fewer tokens on average** across the seven benchmark repos, because a strong model *without* the graph burns its budget re-deriving structure. Cost tracks how much *discovery* a question demands more than raw repo size: 57–78% on questions the file-reading agent needed 28–43 tool calls to answer, near-even where it got there in 7.

> **A note on context:** the numbers above measure *throughput* — tokens processed, tools called, dollars spent to reach one answer. They don't measure what is still sitting in your context window afterward, and on that axis CodeGraph costs **more**, not less. Across the same seven repos in multi-turn sessions, CodeGraph's responses leave about **80% more retrieval context resident** at the end of a session than a file-reading agent's do — on VS Code, 67k tokens against 18k. The mechanism is the same one that makes it fast: CodeGraph returns one dense, verbatim payload that answers the question and then stays in the window, where a grep-and-read agent churns through many small results that get evicted. Fewer tokens *processed* and a larger persistent *footprint* are both real at once. If you run long sessions in a small window, budget for it. Measured per-repo: [`docs/benchmarks/residual-context-occupancy.md`](docs/benchmarks/residual-context-occupancy.md).

### Benchmark Results

Tested across **7 real-world open-source codebases** spanning 7 languages, comparing an agent (Claude Code, headless) answering one architecture question **with** and **without** CodeGraph, at the **median of 4 runs per arm**. _Re-measured 2026-08-05 on **Claude Opus 4.8** against the current build, on a harness that blocks the `codegraph` CLI in **both** arms — contamination row: 0 of 28 without-arm runs._

> **The universal win — every repo, every size: 88% fewer tool calls · 53% faster · 62% fewer tokens · 44% cheaper · file reads cut to zero on all seven repos.**

With the index available, the agent answers from one to four `codegraph_explore` calls and stops. Without it, the agent burns its budget on discovery — up to **43 tool calls and 19 file reads** re-deriving what the graph already knew. Every repo was faster with CodeGraph in this measurement — by 35% on the narrowest question, by 3.6× on the widest.

| Codebase | Language | Tool calls | Time | File reads | Tokens | Cost |
|----------|----------|------------|------|------------|--------|------|
| **VS Code** | TypeScript · ~11k files | **2 vs 28** | **2.2× faster** (58s vs 2m 10s) | **0** vs 12 | 77% fewer | 71% cheaper |
| **Excalidraw** | TypeScript · ~640 | **2 vs 43** | **3.6× faster** (45s vs 2m 42s) | **0** vs 18 | 84% fewer | 78% cheaper |
| **Django** | Python · ~3k | 3 vs 14 | 35% faster (54s vs 1m 23s) | **0** vs 8.5 | 41% fewer | 13% cheaper¹ |
| **Tokio** | Rust · ~790 | 3 vs 29 | **2.6× faster** (1m 3s vs 2m 43s) | **0** vs 19 | 65% fewer | 64% cheaper |
| **OkHttp** | Java · ~645 | 1 vs 6 | 43% faster (33s vs 58s) | **0** vs 2 | 54% fewer | 21% cheaper |
| **Gin** | Go · ~110 | 1 vs 7 | 39% faster (28s vs 46s) | **0** vs 4 | 52% fewer | ~even¹ |
| **Alamofire** | Swift · ~110 | 4 vs 33 | **2.6× faster** (54s vs 2m 22s) | **0** vs 16.5 | 59% fewer | 57% cheaper |

<sub>¹ Cost tracks how much *discovery* the question demanded, which is why it varies far more than the other columns: 57–78% on repos where the file-reading arm needed 28–43 tool calls, but only 13% on Django and even on Gin, where it got there in 14 and 7. The with-arm still answered in 3 and 1 calls with zero file reads. **File reads** = median files opened — the surgical-context win in one column: the agent never reads a file on any of the seven repos when CodeGraph is present.</sub>

<details>
<summary><strong>Per-repo breakdown — WITH vs WITHOUT (median of 4)</strong></summary>

| Codebase | Metric | WITH cg | WITHOUT cg |
|---|---|---|---|
| **VS Code** | Time / Tools / Tokens / Cost | 58s / 2 / 155k / $0.53 | 2m 10s / 28 / 670k / $1.80 |
| **Excalidraw** | Time / Tools / Tokens / Cost | 45s / 2 / 156k / $0.54 | 2m 42s / 43 / 991k / $2.43 |
| **Django** | Time / Tools / Tokens / Cost | 54s / 3 / 183k / $0.55 | 1m 23s / 14 / 309k / $0.63 |
| **Tokio** | Time / Tools / Tokens / Cost | 1m 3s / 3 / 201k / $0.66 | 2m 43s / 29 / 573k / $1.83 |
| **OkHttp** | Time / Tools / Tokens / Cost | 33s / 1 / 107k / $0.39 | 58s / 6 / 230k / $0.50 |
| **Gin** | Time / Tools / Tokens / Cost | 28s / 1 / 87k / $0.31 | 46s / 7 / 180k / $0.31 |
| **Alamofire** | Time / Tools / Tokens / Cost | 54s / 4 / 209k / $0.54 | 2m 22s / 33 / 505k / $1.27 |

</details>

<details>
<summary><strong>Full benchmark details</strong></summary>

**Methodology.** Each arm is `claude -p` (Claude Opus 4.8, `claude-opus-4-8`) run headlessly against the repo with `--strict-mcp-config`: **WITH** = CodeGraph's MCP server enabled, **WITHOUT** = an empty MCP config. Built-in Read/Grep/Bash stay available to both. Same question per repo, **4 runs per arm, median reported**. Cost = the run's `total_cost_usd`; Tokens = total tokens processed, summed per assistant turn (input incl. cache reads + cache creation + output); Time = wall-clock; Tool calls = every tool invocation, including those inside any sub-agents the model spawns. Repos cloned at `--depth 1` and indexed by the same CodeGraph build that served them. Re-measured 2026-08-05 on the current build.

**The `codegraph` CLI is blocked in both arms.** A sanitized `PATH` plus a `PreToolUse` hook denies any Bash invocation of the CLI, in the WITHOUT arm as well as the WITH arm. This matters: without that block the control arm is not a control. On an unblocked harness we measured the WITHOUT agent finding the CLI on `PATH` and reaching CodeGraph through Bash in **26 of 28 runs** — which distorts the comparison in both directions, since a CLI call is not counted as a tool call and its output still enters the window. Earlier published figures were produced without this block. In the run reported above, all 28 WITHOUT runs attempted the CLI and **all 28 were blocked — 0 contaminated**.

**Queries:**
| Codebase | Query |
|----------|-------|
| VS Code | "How does the extension host communicate with the main process?" |
| Excalidraw | "How does Excalidraw render and update canvas elements?" |
| Django | "How does Django's ORM build and execute a query from a QuerySet?" |
| Tokio | "How does tokio schedule and run async tasks on its runtime?" |
| OkHttp | "How does OkHttp process a request through its interceptor chain?" |
| Gin | "How does gin route requests through its middleware chain?" |
| Alamofire | "How does Alamofire build, send, and validate a request?" |

**Why CodeGraph wins:** with the index available, the agent answers directly — usually one `codegraph_explore` returns the relevant source — and stops, with zero file reads on every benchmark repo. Without it, the agent spends most of its budget on discovery (find/ls/grep) before reading the right code. CodeGraph only helps when queried *directly*, so its instructions steer agents to answer directly rather than delegate exploration to file-reading sub-agents — otherwise a sub-agent reads files regardless and CodeGraph becomes overhead.

</details>

---

## Built for speed — the Rust kernel

CodeGraph's parsing engine is a **native Rust kernel**: 20 languages — TypeScript, JavaScript, Java, Python, Go, C, C++, Rust, C#, Ruby, PHP, Swift, Kotlin, Scala, Dart, R, Lua, Luau (Metal and CUDA ride the C++ path) — parse in compiled code with one boundary crossing per file. Every language shipped only after its graphs proved **byte-for-byte identical** to the reference engine on real repositories, from small libraries up to the Linux kernel; platforms without a prebuilt binary and files with syntax errors fall back per-file automatically, same graph either way.

**And it scales itself to the machine it's on.** Worker pools, parallel resolution, and analysis caches are sized from what the system actually has — real core counts (container/cgroup-aware, so a VPS that grants 2 cores gets sized for 2, not the host's 64), honestly-measured available RAM on macOS and Linux, and the measured cost of *your* project's resolution work:

- **On a workstation:** the full parallel pipeline — native parse workers, a multi-worker resolver pool that engages the moment it pays for itself, memory-gated analysis caches. The Swift compiler repository (27k files of Swift and C++) fresh-indexes in about 100 seconds; a one-file edit re-syncs in ~4.
- **On a 2-core / 6GB VPS:** the same graph, from a pipeline tuned to *finish* — the Linux kernel (70k files, 2M symbols, 6.4M relationships) indexes to completion in under 12 minutes where RAM-first designs run out of memory before reaching 1%.
- **Every day after day one:** saving a file updates the graph in well under a second — the watcher fires 300ms after a lone save and syncs exactly what changed (~0.3s of work on a 4,400-file project, ~0.4s on the 27,000-file Swift compiler repo), never re-scanning the tree. Measured against the fastest competing indexer's re-index-on-change: 2–7× faster on medium and larger repos across a 31-repo, 30-language benchmark — and the gap widens with repo size, because their cost grows with the repository and ours grows with the change.

**Validated on real codebases** (small + medium + large for each bridge):

| Bridge | Small | Medium | Large |
|---|---|---|---|
| Swift ↔ ObjC | [Charts](https://github.com/danielgindi/Charts) | [realm-swift](https://github.com/realm/realm-swift) | [Wikipedia-iOS](https://github.com/wikimedia/wikipedia-ios) |
| RN legacy bridge | [AsyncStorage](https://github.com/react-native-async-storage/async-storage) | [react-native-svg](https://github.com/software-mansion/react-native-svg) | [react-native-firebase](https://github.com/invertase/react-native-firebase) |
| RN native → JS events | [RNGeolocation](https://github.com/Agontuk/react-native-geolocation-service) | — | react-native-firebase |
| Expo Modules | expo-haptics | expo-camera | expo SDK sweep (7 packages) |
| Fabric / Paper views | [react-native-segmented-control](https://github.com/react-native-segmented-control/segmented-control) | [react-native-screens](https://github.com/software-mansion/react-native-screens) | [react-native-skia](https://github.com/Shopify/react-native-skia) |

Every bridge hop says how it got into the graph. A hop matched by a bridge resolver carries `metadata.resolvedBy: 'framework'` and `metadata.framework` naming the resolver (`swift-objc-bridge`, `react-native-bridge`, `expo-modules-js`, `fabric-view`). A synthesized channel is tagged `provenance:'heuristic'` with `metadata.synthesizedBy` (`rn-event-channel`, `fabric-native-impl`).

## Measured cross-file coverage

Impact and blast-radius queries are only as good as the dependency graph behind them, so coverage is measured rather than asserted. **Fair coverage** = the share of symbol-bearing source files that have at least one *resolved cross-file dependent* — something that imports, calls, references, or (through a framework convention) routes to them — on a real-world benchmark repo per language. The residual is always a genuine static-analysis frontier (runtime dynamic dispatch, reflection / DI containers, framework-convention entry points, vendored third-party code), never hidden by gaming the denominator.

| Language | Benchmark repo | Coverage |
|---|---|---|
| TypeScript / JavaScript | this repo | 95.8% |
| Python | psf/requests | 100% |
| Go | gin-gonic/gin | 96.6% |
| Rust | BurntSushi/ripgrep | 86.7% |
| Java | google/gson | 93.3% |
| C# | jbogard/MediatR | 85.2% |
| PHP | guzzle/guzzle | 100% |
| Ruby | sidekiq/sidekiq | 100% |
| C | redis/redis | 92.2% |
| C++ | google/leveldb | 94.8% |
| Objective-C | SDWebImage | 91.6% |
| Swift | Alamofire | 95.3% |
| Kotlin | square/okhttp | 96.2% |
| Scala | gatling/gatling | 91.2% |
| Dart | flutter/packages | 92.4% |
| Svelte / SvelteKit | sveltejs/realworld | 100% |
| Vue / Nuxt | nuxt/movies | 93.5% |
| Astro | xingwangzhe/stalux | 93.0% |
| Lua | nvim-telescope/telescope.nvim | 84.2% |
| Luau | dphfox/Fusion | 92.2% |
| Liquid | Shopify/dawn | 73.8% |
| Pascal / Delphi | PascalCoin | 77.4% |

Framework routing is validated the same way, on a canonical app per framework: Express 100%, FastAPI 98%, Flask 100%, NestJS 96.8%, Gin 96.5%, Axum 100%, Rocket 93.8%, Vapor 100%, Laravel 92%, Rails 89.6%, React Router 100% — and the convention/reflection-heavy ones at their honest static-analysis ceiling: ASP.NET 83.9%, Spring 83.3%, Drupal 78.9%, Play 76.3%, Django 74.1%. SvelteKit, Vue/Nuxt, and Astro use file-based routing, so their page/endpoint coverage is the Svelte/SvelteKit (100%), Vue/Nuxt (93.5%), and Astro (93.0% — every `src/pages/` file maps to a route node on the two validation repos) figures in the table above.

</details>
