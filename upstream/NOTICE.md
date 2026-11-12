# 来源和分发边界

本项目代码采用 MIT。内置 Live2D 舞台复用了 InariNGT-Ofiicial/jingyu-live2d-agent 的开源组件，不能将这些组件宣称为本项目独立原创。上游快照 b5a64a1ab5c6d3f6806795c353158dc006dd1be7，来源清单见 backend/avatar/upstream/source.json。

- driver-pipeline.mjs 原样保留，motion-sampling.mjs 从 engine.mjs 提取采样函数；MIT 版权声明见 backend/avatar/licenses/jingyu-MIT.txt。
- PixiJS 6.5.10、pixi-live2d-display 0.4 及上游修正后的 cubism4.colors.min.js：随包保留 MIT 许可证；CubismWebFramework 许可另见 backend/avatar/licenses/CubismWebFramework-LICENSE.txt。
- Cubism Core 是另行许可的 Live2D SDK，必须由使用者提供，**没有内置或重新授权**。模型、贴图、动作、游戏数据、账号凭据、个人记忆不随包分发。
- 鲸语桌宠、触摸行为、关键词情绪映射、独立服务和规划器未移植。blivedm、模型和游戏客户端遵守各自上游许可。

感谢鲸语作者和各模型作者。本项目的 MIT 许可证不覆盖第三方的独立许可或用户加载的素材。
