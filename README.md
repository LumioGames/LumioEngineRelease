# LumioEngineRelease

Lumio 引擎的编译产物。这里没有一行引擎源码；内容由引擎的发布流程生成并推送，不接受人工提交。

*Compiled binaries of the Lumio engine, published by the engine release pipeline. No engine source lives here and no manual commits are accepted. Each tag `vX.Y.Z` is one complete, immutable engine set.*

## 一个 tag 就是一整套引擎

每个 tag（`v0.0.1`、`v0.0.2`……）是同一次构建产出的全部部件，部件之间不混版本。tag 只增不改：发出去的 tag 不重打、不删除；有问题就发下一个版本。

| 路径 | 内容 |
| --- | --- |
| `manifest.json` | 版本号、所含平台、各源码仓的提交号、Platform 镜像摘要、每个文件的 sha256 |
| `sdk/Lumio.Engine.SDK.<版本>.nupkg` | 编译玩法代码用的 SDK 包（作本地包源） |
| `server/<rid>/` | 专用服务器的引擎那一半：`lumio-ds`、`Application/`、`SDK/Managed/`、`SDK/Native/<rid>/` |
| `bot/<rid>/` | 无渲染的机器人客户端宿主（`dotnet Lumio.Client.Bot.Host.dll`），`native/` 下是同平台的 Native 库 |
| `web/` | 旁观页共享零件：`*.mjs` 平铺、体素模块 `lumio_voxel_wasm.wasm`、`replica/netstandard2.1/` 下浏览器副本的三个程序集（`Lumio.Client.Gameplay.ECS.dll`、`Lumio.Client.Log.dll`、`Lumio.Client.Spectator.dll`） |
| `tools/` | 运行编排脚本：`process-tools.mjs`、`verify-release.mjs` |
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

逐个核对 `manifest.json` 记的 sha256、SDK 包版本与 manifest 是否一致、当前平台是否在列。不符时以 `sdk_version_mismatch` 失败（退出码 1）；发布物不在或当前平台不在列时以 `BLOCKED_ENV` 失败（退出码 2）。

## 前置条件

git、.NET SDK（按游戏仓的 `global.json`）、Node.js 22、Docker（本地起 Platform 用）。

## 许可

本仓内容是 Lumio 引擎的分发物，按 [Business Source License 1.1](LICENSE) 授权；Additional Use Grant 允许开发、发行与商业运营基于它的游戏。游戏仓的 README 需要写清两层许可：游戏仓自己的代码按游戏仓的许可，`Engine/` 下是 BUSL-1.1 的引擎二进制。
