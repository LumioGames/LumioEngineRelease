# LumioEngineRelease

Lumio 引擎的编译产物。这里没有一行引擎源码；内容由引擎的发布流程生成并推送，不接受人工提交。

*Compiled binaries of the Lumio engine, published by the engine release pipeline. No engine source lives here and no manual commits are accepted. Each tag `vX.Y.Z` is one complete, immutable engine set.*

## 一个 tag 就是一整套引擎

每个 tag（`v0.0.1`、`v0.0.2`……）是同一次构建产出的全部部件，部件之间不混版本。tag 只增不改：发出去的 tag 不重打、不删除；有问题就发下一个版本。

| 路径 | 内容 |
| --- | --- |
| `manifest.json` | 版本号、所含平台、七仓提交、固定 Config 提交、作者工具 metadata、Platform 镜像摘要与每个文件的 sha256 |
| `sdk/Lumio.Engine.SDK.<版本>.nupkg` | 编译玩法代码用的 SDK 包（作本地包源） |
| `server/<rid>/` | 专用服务器的引擎那一半：`lumio-ds`、`Application/`、`SDK/Managed/`、`SDK/Native/<rid>/` |
| `bot/<rid>/` | 无渲染的机器人客户端宿主（`dotnet Lumio.Client.Bot.Host.dll`），`native/` 下是同平台的 Native 库 |
| `web/` | 旁观页共享零件：`*.mjs` 平铺、体素模块 `lumio_voxel_wasm.wasm`、`replica/netstandard2.1/` 下浏览器副本的三个程序集（`Lumio.Client.Gameplay.ECS.dll`、`Lumio.Client.Log.dll`、`Lumio.Client.Spectator.dll`） |
| `tools/` | 运行编排、预测 Capture 离线分析/组装与作者脚本，以及 `authoring/<rid>/` 工具闭包 |
| `platform/docker-compose.yml` | 本地开发用的账号与大厅服务，按版本号引用公开镜像 |

`<rid>` 目前取 `win-x64`、`linux-x64`（macOS 暂不发布）；某个 tag 缺哪个平台，`manifest.json` 就如实不列，不拿别的平台凑。SDK 包里只带 `win-x64` 与 `linux-x64` 的 Native，并带 `lib/net10.0`（服务端与 Bot 的玩法构建）与 `lib/netstandard2.1`（浏览器玩法构建）两档托管程序集。发布物里没有任何源码文件。

## 在游戏仓里引用

```bash
git submodule add https://github.com/LumioGames/LumioEngineRelease Engine
git config -f .gitmodules submodule.Engine.shallow true
git -C Engine checkout v0.0.1
git add .gitmodules Engine
git commit -m "engine: pin v0.0.1"
```

- 子模块是只读的：不要在 `Engine/` 里改文件或提交，子模块指针始终停在某个正式 tag 上。
- 别人 clone 游戏仓时用 `git clone --recursive`；漏了就运行 `git submodule update --init --depth 1 Engine`。
- 编译只认 `Engine/sdk/` 作本地包源，SDK 版本读 `Engine/manifest.json` 的 `version`；运行时服务器、机器人、旁观页和脚本都从 `Engine/` 取。

## 升级

在游戏仓运行它自己的更新命令（切到新 tag、校验 `manifest.json`、再由你提交），或手动：

```bash
git -C Engine fetch --depth 1 origin tag v0.0.2
git -C Engine checkout v0.0.2
node Engine/tools/verify-release.mjs --root Engine
git add Engine && git commit -m "engine: v0.0.2"
```

引擎不承诺跨大版本兼容；升级后编不过的玩法代码由游戏自己改。每个游戏仓各钉各的 tag，互不影响。

## 校验

```bash
node Engine/tools/verify-release.mjs --root Engine [--rid <rid>]
```

逐个核对文件集合及 sha256、SDK 三处版本与当前 RID；格式 2 还检查两个作者工具的全部运行文件、许可证、固定来源与构建身份。不符时以 `sdk_version_mismatch` 失败（退出码 1）；发布物不在或当前平台不在列时以 `BLOCKED_ENV` 失败（退出码 2）。

## 改地图与配表

格式 2 发布物提供两个作者入口，仅支持 `win-x64` 和 `linux-x64`。只从当前发布物的 RID 目录运行；缺文件、额外文件、工具或依赖被改动、来源/RID 不符、许可证缺失时拒绝执行，原工具的参数、退出码和诊断直接传出。

```bash
node Engine/tools/capture-voxel.mjs --width 32 --depth 32 --out maps/sample.voxel --verify-restore
node Engine/tools/capture-voxel.mjs --cells maps/sample.cells.json --catalog maps/catalog.json --out maps/sample.voxel --verify-restore
node Engine/tools/config-compiler.mjs export --root Config --client-out Client/Config --server-out Server/Config --csharp-out Gameplay/Generated
```

`--root` 显式指向游戏源表目录；输出目录由游戏作者指定。Capture 只在作者修改地图时运行，地图快照应随游戏资产提交；服务器启动只 Restore 已生成的地图。两个入口均不需要安装 Python/Cargo，也不读取 provider/Config 源码或从 PATH 搜工具。

`manifest.json` 的 `authoring.configSourceCommit` 是完整 Config 提交，七仓 `sources` 保持原键。每个 RID 的 `capture/`、`config/` 下都有 `authoring-tool.json`，记录工具版本、RID、提交、runtime/toolchain、精确依赖、许可证和全部闭包文件哈希；Capture 的 `providers.nativeCore/voxelEngine` 对应发行 manifest 的 provider 提交。Linux Capture 使用 musl 静态链接，Windows Capture 使用 MSVC 静态 CRT；Config 的固定 Python 3.11.9/PyInstaller 6.11.1 运行闭包随包提供，Linux 仍需支持构建平台 glibc ABI 的操作系统。

校验器继续读取格式 1 历史发布物；格式 1 不提供作者闭环，新作者入口要求格式 2。macOS 本地开发回归可以保持格式 1，无法作为 Windows/Linux 作者验收证据。离线跨 RID 校验只说明文件完整，实际运行必须分别在目标平台完成。

## 预测 Capture 离线分析

新发行物在 `tools/` 提供 `prediction-capture.mjs`、`prediction-capture-cli.mjs`、`prediction-capture-assemble.mjs` 及 `entry-guard.mjs` 导入闭包。只需要 Node.js；从游戏仓或任意独立目录运行包内入口：

```bash
node Engine/tools/verify-release.mjs --root Engine --rid any
node Engine/tools/prediction-capture-cli.mjs capture/manifest.json capture/limits.json
node Engine/tools/prediction-capture-assemble.mjs client/manifest.json authority/manifest.json new-capture limits.json association.json
```

`limits.json` 必须显式提供全部七个正整数预算：`maxManifestBytes`、`maxFiles`、`maxFileBytes`、`maxTotalBytes`、`maxLineBytes`、`maxRecords`、`maxWork`。组装入口读取已经关闭、不可变的 Client/authority 归档，输出目录必须是新的；`association.json` 可选，关联必须来自真实证据。缺关联或覆盖不足按原分析器报告 `Incomplete/Unknown`，不能作为预测通过。

代码消费方可从 `Engine/tools/prediction-capture.mjs` 导入 `analyzeCapture` 与 `loadCaptureLimits`。这些工具校验和分析已有证据，真实 MineAbility、Native Capture 与网络场景仍由实际 Host 运行取证。

## 初始化顺序

安装 BindingPolicy 应处于世界尚未开始玩法、且没有暂存 mutation 的安全窗口。先按 Host 的已有装配顺序完成配置、地图 Restore、实体装配与 pending mutation 排空，再安装绑定策略并开放输入；首启与恢复均需检查返回结果。配置预算、catalog 或 mutation 前置不满足时明确报错，不通过推迟到不确定的帧或忽略返回值来继续启动。

## 前置条件

git、.NET SDK（按游戏仓的 `global.json`）、Node.js 22、Docker（本地起 Platform 用）。

## 许可

本仓内容是 Lumio 引擎的分发物，按 [Business Source License 1.1](LICENSE) 授权；Additional Use Grant 允许开发、发行与商业运营基于它的游戏。游戏仓的 README 需要写清两层许可：游戏仓自己的代码按游戏仓的许可，`Engine/` 下是 BUSL-1.1 的引擎二进制。

使用说明、示例与排障见 [Lumio-DevKit 帮助手册](https://github.com/LumioGames/Lumio-DevKit)。
