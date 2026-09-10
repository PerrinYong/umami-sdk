# Umami SDK 生产就绪验证

本文记录 Umami Analytics SDK 的生产故障模型、自动化验证范围和上线门禁。验证基线为 SDK `0.1.1`、Schema `1`、Policy `1`，并已对照 Umami submodule `de474a1da915d4666768cad0af0bed5b3449d661` 的 `/api/send`、`/api/batch` 和 Web Tracker 实现。

## 1. 核心保证

SDK 对宿主承诺：

- `track`、`identify`、`page` 只做内存中的同步校验和有界入队，不等待 DNS、TLS、HTTP 或磁盘；
- 分析服务断网、超时、429、5xx、异常响应、部分失败和重试耗尽不会改变宿主返回值、UI、事务或退出码；
- 诊断回调抛异常会被吞掉；后台 Worker 的非预期异常不会传播到宿主线程；
- 队列、Batch、重试、响应体和持久队列文件都有硬上限；
- 初始 Consent、Endpoint、canonical RFC 4122 Website ID 和可靠性参数在构造时校验；错误配置不会以“静默无数据”方式进入生产；
- Consent 拒绝或撤回与并发上报互斥，调用返回后不保留待发事件或 Subject；
- `disable`、Node `close`、Python `close` 和 .NET `DisposeAsync` 后 Client 是终态，不再接受事件；
- 持久队列恢复时重新执行结构、Website、Schema、Identity 和隐私校验，篡改或损坏文件会被删除而不是上传；
- Web `beforeSend` 会再次验证全局 Tracker 请求，阻止 `window.umami` 或 `data-umami-event` 绕过中央事件注册表和 Identify allowlist。

Analytics 是 best-effort：进程崩溃、页面关闭、队列溢出、截止时间耗尽或长期离线时允许丢失数据。该取舍是宿主稳定性的组成部分。

## 2. 资源边界

| 资源 | 默认值 | 硬上限/行为 |
| --- | ---: | --- |
| Browser 队列 | 100 | 最大 10,000；满时丢最旧事件 |
| Node/.NET/Python 队列 | 1,000 | 最大 10,000；满时丢最旧事件 |
| Batch | 25 | 最大 100；低于 Umami 当前 500 上限 |
| 单次网络超时 | 3 秒 | 配置最大 60 秒 |
| 重试 | 3 | 最大 10；指数退避和抖动 |
| 事件年龄 | 24 小时 | 配置最大 30 天；过期丢弃 |
| Node/.NET/Python 成功响应体 | — | 最多读取 64 KiB；畸形/超大 2xx 仍按已接收处理，避免重复发送 |
| .NET/Python 持久队列 | 可选 | 文件最大 64 MiB；恢复时重新验证 |

非法的 `NaN`、无穷值、负数、小数型容量和超上限配置在 Client 构造时失败，不允许悄悄形成无界资源使用。

## 3. 自动化故障矩阵

| 场景 | Web/Node | .NET | Python | 预期 |
| --- | --- | --- | --- | --- |
| Consent unknown/withdrawn/disabled | 已测 | 已测 | 已测 | 无发送、队列清空 |
| 合法、未注册、缺属性、未知属性、敏感值 | 已测 | 已测 | 已测 | 本地接受或拒绝 |
| 1 万次突发上报 | 已测 | 已测 | 已测 | 队列保持上限，调用不抛异常 |
| Transport 抛异常/永不返回 | 已测 | 已测 | 已测 | 热路径立即返回；关闭有截止时间 |
| 自定义 Transport 在返回异步句柄前同步阻塞 | 不适用 | 已测 | Python daemon 隔离 | .NET 关闭截止时间仍有效；Python 返回后放弃 daemon Worker |
| 408/429/5xx/4xx | 已测 | 已测 | 已测 | 可重试/永久失败分类正确 |
| 畸形和超大 2xx 响应 | 已测 | 已测 | 已测 | 不崩溃、不错误重发 |
| 重试、耗尽、永久失败、事件过期 | 已测 | 已测 | 已测 | 有限保留后丢弃 |
| 诊断回调抛异常 | 已测 | 已测 | 已测 | 不影响宿主 |
| Track 与 Consent 撤回并发 | 单线程模型 | 已测 | 已测 | 撤回后无待发事件 |
| Subject 切换与 Session Cache 重置 | 已测 | 已测 | 已测 | 旧队列不继承 |
| 持久队列恢复、撤回、损坏、篡改 | 不适用 | 已测 | 已测 | 仅恢复仍符合当前策略的数据 |
| Web Tracker 加载失败后重试 | 已测 | 不适用 | 不适用 | 失败隔离，下一事件可重试 |
| 全局 Web Tracker 旁路 | 已测 | 不适用 | 不适用 | 未注册事件和非法 Identify 被阻断 |
| 发布包真实安装 | npm | NuGet | wheel | 隔离目录安装；npm JS 真实上报/类型编译、NuGet 消费者编译与 Client 构造、wheel Client 构造成功 |

运行完整门禁：

```powershell
.\tools\build-sdk.ps1
```

该命令执行生成文件一致性、Schema、文档契约、三端测试、构建打包、SHA-256 和三个制品的隔离安装冒烟。npm 冒烟不只检查导出名，还从打出的 tarball 创建真实 Node/Web Client、发送受控事件，并用包内 `.d.ts` 编译独立 TypeScript 消费者。CI 使用同一入口，避免本地与流水线出现两套标准。

## 4. Umami 兼容性结论

当前 submodule 的 `/api/batch`：

- 接受最多 500 个请求；SDK 最大 Batch 为 100；
- 每项复用 `/api/send` 校验，响应提供 `processed`、`errors`、`details` 和 `cache`；
- SDK 在 `errors > 0` 时移除该批并记录永久失败诊断，因为 Umami 不返回可安全重试的逐项成功 Payload；
- 事件、Identify、Distinct ID、秒级 timestamp 和 `x-umami-cache` 映射与当前源码一致；
- 2xx 响应体损坏时不重发，避免服务端已经写入后因响应解析失败产生重复事件。

升级 Umami submodule 时必须重新检查这组语义并运行完整门禁。

## 5. 生产使用边界

- 生产默认使用 SDK 内置 Transport。自定义 Transport 是测试/特殊集成扩展，必须自行保证线程安全、无副作用和截止时间；Node 与 .NET Client 会额外施加等待上限，Python 对不合作的同步自定义 Transport 只能让后台 daemon 线程退出宿主关键路径，无法强制终止第三方代码。
- Browser 接入 SDK 后，业务事件只能调用 `analytics.track()`；直接调用 `window.umami` 或声明 `data-umami-event` 缺少 SDK 公共上下文，会被 `beforeSend` 拒绝。这是中央策略防旁路行为，不是 Tracker 故障。
- `flush` 只允许在测试或受控关闭阶段调用。业务热路径永远不等待 Analytics。
- 网络超时只能限制 SDK 等待时间，不能撤回已经到达服务端的请求；Consent 撤回会阻止新请求并清理队列，但不能“取消”已经被 Umami 接收的事件。
- SDK 自动测试不能替代产品级 Staging 验收。每个产品仍需验证真实 Website ID、区域、CSP/代理、Consent UI、身份切换、Funnel、Retention 和实际宿主生命周期。

## 6. 上线门禁

SDK 制品可进入产品 Staging 的条件：完整门禁通过、工作区生成文件一致、制品 SHA-256 已固定。产品进入 Production 前还必须完成：

1. 使用 Staging Website 执行完整合成旅程；
2. 在目标 Browser、Windows/.NET、Python 或 OpenCode/Bun 真实运行时执行断网、慢网、退出和升级测试；
3. 确认 Analytics 停机不改变业务结果和性能等级；
4. 抽样检查 Umami 中没有禁止字段、自由文本或错误身份；
5. 填写 `docs/product-integration-template.md` 并给出明确 `approved` 结论。

未完成产品级 Staging 验收时，只能称为“SDK 自动化门禁通过”，不能宣称具体产品已经生产验收。
