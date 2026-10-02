# 验证记录（2026-10-02）

## 环境与基线

- 分支：`refactor/miao-clean-upstream`，上游基线：`d9988b3e1fa0c47d1032c67303e972ef47d5eb1c`。
- Windows，Node.js `v24.21.0`，npm `11.19.0`。
- 依赖安装：`npm ci --ignore-scripts`；基线构建和基线完整验证已执行。

## 最终源码检查（含桌面联调发现的布局修复）

| 检查 | 结果 |
|---|---|
| `npm run build` | 成功，`lib/client.js` 由源码生成 |
| `npm run verify:all` | **退出码 0**，包含 build、verify、verify:docs、smoke |
| 新增功能测试 | **25 个通过，0 失败**；已接入 verify 链 |
| 上游界面、schema、类型、包发布范围、路由索引等硬检查 | 完整 verify 链执行成功 |
| 原有轮换、live、资源释放、异步身份与字体集 smoke | 完整 smoke 链执行成功 |
| `git diff --check` | 通过 |

25 个新增测试也在隔离的 Linux 暂存环境通过。该环境不是完整 checkout，不能替代 Windows 完整验证。包含拖动面板高度、默认项覆盖历史选择、迷你播放器收起/关闭/分批列表与材质回退。

## 告警与未覆盖项

1. **上游 warn-only 死声明检查仍报告 1 项**：`test/verify-scene-live.mjs:1552` 的 `tabBodyOf` 未引用。该文件未改动，判据和既有 warn-only 策略未修改；不能描述为“所有守卫零告警”。
2. 媒体桥二进制未 provision，上游已有 `--allow-skip` 明示跳过对应端到端段；未为测试下载安装媒体桥。
3. Windows 无法覆盖 POSIX 专属分支，输出明确标注 platform-skipped，不计入通过。
4. 用户后续授权了 DSH NEXT 实机安装与联调，最新默认壁纸/迷你播放器结果见 [MINI-PLAYER.md](MINI-PLAYER.md)，首次安装历史见 [DESKTOP-TEST.md](DESKTOP-TEST.md)。短 MP4 实播通过不等于长视频、Edge、媒体桥转码和所有窗口尺寸验收。

## 变更边界

- 源码只在新克隆分支修改，未向 GitHub 推送，未覆盖原 fork。
- 最初源码阶段没有安装；后续按用户新授权，使用已安装桌面端的官方 CLI 将本地打包产物加入 `desktop` profile。
- 桌面测试前备份 profile 配置，修改壁纸测试设置前另备份插件配置；仅清理本次生成的媒体。
- Node 流式路由测试仍使用隔离临时目录，与桌面集成测试分开记录。
- 使用及同步注意事项见 [REBUILD.md](REBUILD.md)。
