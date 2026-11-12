# 对应源代码与重建说明

本目录不是日常启动所需环境，普通用户不用解压或编译。随包提供它们，是为了保留二进制运行时及GPL组件的对应源码。

## Node.js 22.23.5

`node-v22.23.5.tar.xz` 是与 `runtime/` 官方二进制相同版本的Node完整源代码归档。来源 https://nodejs.org/dist/v22.23.5/ ，校验值记录在 `runtime/provenance.json`。

解压后遵循其中 `BUILDING.md` 和 `LICENSE`。Unix/macOS常用 `./configure && make -jN`；Windows使用源码中的 `vcbuild.bat`，编译器/SDK等要求以该版本 `BUILDING.md` 为准。重建需要的开发工具不属于运行本应用的要求。本应用未修改Node，不提供额外专有补丁或安装密钥。

## @andresaya/edge-tts 1.9.1

`edge-tts-v1.9.1-source.tar.gz` 来自上游固定提交 `93f6dbc5905293402ebf4b6dc162d31f7e61136e`，https://github.com/andresayac/edge-tts 。GPL-3.0-only，原LICENSE、TypeScript源码、tsconfig和构建脚本均在归档中。

解压进入源码目录，按其package.json安装开发依赖后执行 `npm run build`（调用TypeScript编译器）。该上游还提供 Bun 的二进制与浏览器打包脚本，分别为 `bun scripts/build.ts`、`bun scripts/build-browser.ts`；本应用只引入 `dist/index.js` 及其模块，不要求运行浏览器/CLI产物。安装开发依赖需要联网，正常使用本便携包不需要重建。

## 应用源码、协议库与其他组件

根目录 `*.mjs`、`scenes/`、`lib/`、`public/` 是本应用可修改源码，启动无需编译。`node_modules/` 保留本次使用的JavaScript产物及包许可证；精确依赖来自根目录lock文件。第三方模块需要重建时，请按其原package.json操作，不能仅复制二进制而丢弃对应源码和许可。

包内Live2D SDK/角色素材不是GPL代码，遵循单独许可。`lib/douyin-danma/webmssdk.js` 等第三方混淆实现的完整上游权利范围仍需发布者向来源核实，详见根目录许可清单。
