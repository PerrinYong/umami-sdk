# Pystone Analytics SDK

这是位于产品代码与 Umami 之间的薄 SDK。它只解决每个产品都必须正确解决、且直接调用 Umami 很容易做错的部分：事件语义、Consent、伪名身份、隐私校验、异步队列、批量发送、有限重试和静默降级。

SDK 不复制 Umami 的 Dashboard、查询 API 或业务数据库，也不建立通用插件系统。当前没有运行时第三方依赖。

## 第一性原理

1. 产品的主流程比 Analytics 更重要；上报失败不能改变 UI、返回值、退出码或业务事务。
2. 默认不采集；只有 Consent 为 `granted` 才接受事件。
3. 只采集回答已定义问题所需的最少字段。
4. 事件在本机被验证；可疑数据不能依赖服务端事后清洗。
5. Website ID 是公开路由标识，不是 Secret；可信业务事实仍由后端发送。
6. 队列有界、重试有限、事件会过期；宁可丢弃 Analytics，也不无限占用宿主资源。

## 稳定接口

所有运行时保持相同的六个概念：

```text
track(eventName, properties)
identify(subjectId, properties)
page(properties)
setConsent(state)
flush()
disable()
```

`track`、`identify` 和 `page` 只做同步的本地校验与内存入队，不等待 DNS、TLS、HTTP、Umami 或磁盘。后台 Worker/微任务负责发送。网络超时、429、5xx、无响应和异常只影响 Analytics 队列。

`flush` 是显式的生命周期操作，可能等待配置的网络超时；不能在页面渲染、命令执行、保存、支付或其他业务热路径中调用。应用退出时可以尽力刷新，但必须接受超时和丢弃。`disable` 立即停止接收并清空内存身份与队列。

Node `close()`、Python `close()` 和 .NET `DisposeAsync()` 是终态操作；调用完成后 Client 不再接受新事件。生产应使用内置 Transport。测试用或自定义 Transport 即使不合作也不能拖住 Node/.NET 的等待截止时间；Python 的同步自定义 Transport 只能隔离在 daemon Worker 中，不能由 SDK 强制终止第三方代码。

Client 持有单一当前 Subject。Browser、Desktop、插件和 CLI 使用长寿命 Client；多用户后端不得在共享 Client 上交替 `identify()`。账户级可信事件应由后台任务按 Subject 使用隔离 Client。完整约束见 Agent 接入手册。

## 实现

| 产品形态 | 包 | 发送模型 | 离线持久化 |
| --- | --- | --- | --- |
| Browser | `@pystone/analytics/web` | Umami Tracker；始终先入队，下一微任务发送 | 无；刷新页面可丢弃 |
| Node/OpenCode | `@pystone/analytics/node` | 内存队列 + `/api/batch` | 当前无 |
| Windows Desktop | `Pystone.Analytics` | 后台 Task + `/api/batch` | 可选，原子替换 |
| Python CLI/Agent | `pystone-analytics` | 后台线程 + `/api/batch` | 可选，原子替换 |

持久化只建议用于允许分析、弱网且事件确有延迟价值的 Desktop/CLI。队列文件可能包含伪名行为数据，必须放在产品私有数据目录；撤回 Consent 会删除它。

安装身份由高熵随机 `installation_id` 按产品 SHA-256 派生。登录身份只在可信后端使用至少 32 字节的产品独立 HMAC Key 派生；Key 不得进入 Browser、Desktop、CLI 或插件产物。

## 单一 Schema

`schema/event-registry.json` 是事件注册表，`schema/privacy-policy.json` 是隐私规则。三种语言的嵌入常量由一个脚本生成，不手工维护副本：

```powershell
python tools/generate_policy.py
python tools/generate_policy.py --check
python tests/validate_schema.py
python tests/validate_docs.py
```

新增事件必须先回答 `purpose` 和 `decision`，再列出最小 required/optional 属性。语义变化提升事件版本；禁止字段不能通过自定义事件绕过。

## 本地验证

```powershell
Push-Location typescript
npm ci
npm test
Pop-Location

$env:DOTNET_ROLL_FORWARD='Major' # 仅本机没有 .NET 8 runtime 时需要
dotnet run --project dotnet/Pystone.Analytics.Tests/Pystone.Analytics.Tests.csproj -c Release

$env:PYTHONPATH=(Resolve-Path 'python/src').Path
python -m unittest discover -s python/tests -v
```

测试覆盖 Consent、字段 allowlist、敏感值阻断、身份派生、批量发送、重试、持久队列恢复/撤回删除，以及网络阻塞时业务调用先返回。

完整构建还会在隔离临时目录中实际安装 npm、NuGet 和 wheel 制品，验证消费者导入与编译。生产故障模型、资源硬上限、跨运行时测试矩阵及仍需由产品完成的 Staging 门禁见 [`docs/production-readiness.md`](docs/production-readiness.md)。

## 版本与发布

当前版本为 `0.1.0`。在真实 Staging 产品完成断网、慢网、退出、升级和 Consent 验收前，只从本仓库固定 commit 构建，不发布浮动版本。发布包必须同时固定 SDK 版本、事件 Schema 版本和 Policy Version。

在 SDK 根目录统一生成三种安装制品：

```powershell
.\tools\build-sdk.ps1
```

输出位于忽略 Git 的 `artifacts/sdk/`，脚本会先执行 Schema 与全部运行时测试，并打印每个制品的 SHA-256。产品应固定安装这里生成的 `.tgz`、`.nupkg` 或 `.whl`，不要直接依赖移动中的源码目录。

详细设计见 [`docs/architecture.md`](docs/architecture.md)，事件、身份和隐私规范见 [`docs/analytics-spec.md`](docs/analytics-spec.md)。人工使用与后台分析见 [`docs/product-integration.md`](docs/product-integration.md)；产品研发 Agent 应使用 [`docs/integration-guide.md`](docs/integration-guide.md)，并填写 [`docs/product-integration-template.md`](docs/product-integration-template.md)。
