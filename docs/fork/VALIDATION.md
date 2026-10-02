# 验证记录（2026-10-02）

## 环境与基线

- 新克隆分支：`refactor/miao-clean-upstream`。
- 上游基线：`d9988b3e1fa0c47d1032c67303e972ef47d5eb1c`。
- Windows，Node.js `v24.21.0`，npm `11.19.0`。
- 依赖安装：`npm ci --ignore-scripts`；基线构建和基线完整验证已执行。

## 最终结果

| 检查 | 结果 |
|---|---|
| `npm run build` | 成功，`lib/client.js` 由源码生成 |
| `npm run verify:all` | **退出码 0**，包含 build、verify、verify:docs、smoke |
| 新增功能测试 | **21 个通过，0 失败**；已接入 verify 链，不是只单独跑过 |
| 上游界面、schema、类型、包发布范围、路由索引等硬检查 | 完整 verify 链执行成功 |
| 原有轮换、live、资源释放、异步身份与字体集 smoke | 完整 smoke 链执行成功 |
| `git diff --check` | 通过；未将 CRLF 差异当成功能变更 |

21 个新增测试还在隔离的 Linux 暂存环境执行通过。该环境不是完整 checkout，不能用其结果替代 Windows 完整验证。

## 必须保留的告警与未覆盖项

1. **上游 warn-only 死声明检查仍报告 1 项**：`test/verify-scene-live.mjs:1552` 的 `tabBodyOf` 未引用。该文件对基线 `HEAD` 无差异，相关判据与 `warn-only` 策略未修改。完整链允许它告警后继续；不能描述为“所有守卫零告警”。
2. 媒体桥二进制未 provision，上游已有 `--allow-skip` 明示跳过该端到端段；本次没有为了测试下载安装媒体桥。
3. Windows 无法覆盖 POSIX 专属测试分支，输出明确标注 platform-skipped，不计入通过。
4. 没有在正在运行的 DSH NEXT 内做实际插件安装、长视频播放、Edge 解码、真实拖动或输入区节点重建验收。

## 安全与变更边界

- 只写新克隆的源码、测试、生成产物和说明文档；未向 GitHub 推送。
- 原 fork 检查时仍为 `9518dac` 且工作树干净。
- 未改运行中的应用、用户插件配置或上传库；未重启服务、安装插件或开放调试端口。
- 流式上传测试使用随机临时目录和仅回环监听的临时 HTTP 服务，测试结束清理；扫描测试不执行个人 Steam 发现。
- 这是待用户同步及集成验收的源码，不是已部署版本。使用方式和同步注意事项见 [REBUILD.md](REBUILD.md)。
