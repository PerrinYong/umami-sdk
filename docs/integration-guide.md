# Umami SDK 产品接入与使用手册

本文是 Pystone 产品研发 Agent 接入自有 Umami SDK 的执行规范。目标是让负责网站、Desktop、OpenCode 插件、Node 服务或 Python CLI/Agent 的 LLM Agent，在不猜测接口、不复制 Umami Payload、不读取生产 Secret 的前提下，独立完成接入、测试和交付。

当前 SDK 版本：`0.1.1`。事件 Schema 版本：`1`；Privacy Policy 版本：`1`。

## 1. Agent 的任务边界

接入 Agent 应完成：

1. 确认产品、环境、区域 Endpoint 和 Website ID；
2. 安装对应运行时的固定版本 SDK 制品；
3. 建立产品内唯一的 Analytics Client；
4. 接入 Consent、匿名/安装/账户身份生命周期；
5. 只使用中央注册表中已有的事件和属性；
6. 在真正完成业务事实的位置埋点；
7. 增加单元测试、故障隔离测试和 Staging 合成事件验收；
8. 更新产品自己的隐私说明和事件清单。

接入 Agent 不应：

- 修改 Umami 核心源码；
- 在产品代码中直接构造 `/api/send` 或 `/api/batch` Payload；
- 把管理 Token、数据库密码、HMAC Key 或其他 Secret 放进客户端；
- 为未注册事件临时绕过 SDK；
- 为了“多采一点”发送自由文本、原始错误、路径、命令或用户内容；
- 在业务热路径等待 `flush()`、HTTP 或重试；
- 自动把中国大陆事件故障转移到海外实例，反之亦然；
- 把 Analytics 成功作为订单、权限、许可证或业务成功的判断条件。

## 2. 开始前必须取得的输入

接入前在产品仓库或任务上下文中确认以下信息。`Website ID` 可以进入客户端配置，但管理 Token 和 HMAC Key 不可以。

```yaml
analytics_integration:
  sdk_version: 0.1.1
  policy_version: 1
  product: controlled-product-slug
  environment: staging             # staging 或 production
  surface: web                     # web/desktop/node/opencode_plugin/cli/agent/backend
  product_version_source: package-or-build-version
  deployment_region: global        # cn 或 global
  endpoint: https://umami.pystone.net
  website_id: 00000000-0000-0000-0000-000000000000
  hostname: product.example.com
  activation_event: product_activated
  meaningful_active_events:
    - feature_used
    - operation_completed
  conversion_events:
    - signup_completed
  consent_storage: product-defined-private-setting
  installation_id_storage: product-defined-private-setting
```

缺少 `product`、`environment`、`surface`、Endpoint 或 Website ID 时，不要用占位值提交可发布代码。可以先完成 Adapter 结构和测试，但必须把缺失项明确报告为上线阻塞项。

### 2.1 区域选择

区域按产品部署归属固定选择，不按终端用户 IP、语言或所在地动态切换：

| 产品部署归属 | Endpoint |
| --- | --- |
| 中国大陆 ECS 上部署的产品 | `https://umami-cn.pystone.net` |
| 中国大陆以外部署的产品 | `https://umami.pystone.net` |

每个 Endpoint 使用自己实例中创建的 Website ID。中国大陆和海外实例不共享 Website、Session 或账户。

### 2.2 Website 边界

- 一个独立产品一个 Website；
- Production 与 Staging 必须是不同 Website ID；
- 同一产品的官网、Desktop、插件需要原生统一分析时可以共用 Website，并用 `surface` 区分；
- 无业务关系的产品不要共用 Website；
- Website ID 是公开路由标识，不是认证 Secret。

如果 Website 尚未建立：登录目标区域 Umami 后台，进入 Websites，创建名称清晰的 Staging/Production Website，保存生成的 Website ID。详细后台步骤见[产品接入总手册](product-integration.md)。

## 3. SDK 选择与安装

| 产品形态 | 制品 | 导入入口 | 最低运行时 |
| --- | --- | --- | --- |
| Browser、SPA、SSR 的客户端部分 | npm | `@perrin-yong/umami-sdk/web` | 现代 ES2022 Browser |
| Node 服务、OpenCode/Bun 插件 | npm | `@perrin-yong/umami-sdk/node` | Node 18.18+；Bun 先做兼容验收 |
| Windows Desktop | NuGet `.nupkg` | `Pystone.Analytics` | .NET 8 |
| Python CLI、Agent、服务 | Python `.whl` | `pystone_analytics` | Python 3.10+ |

TypeScript 包已经公开发布到 npm，产品直接固定精确版本：

```powershell
npm install --save-exact @perrin-yong/umami-sdk@0.1.1
```

.NET 和 Python 当前没有发布到 NuGet.org/PyPI。只为这两个运行时，或需要归档全部制品时，在 umami-sdk 仓库的固定 Tag/Commit 上生成制品：

```powershell
.\tools\build-sdk.ps1
```

制品位于 `artifacts/sdk/`。记录 SHA-256，将 `.nupkg`/`.whl` 复制到产品的私有制品位置，然后安装：

```powershell
dotnet add package Pystone.Analytics --version 0.1.1 --source <ARTIFACT_DIR>
python -m pip install <ARTIFACT_DIR>\pystone_analytics-0.1.1-py3-none-any.whl
```

产品必须提交 npm lockfile；.NET/Python 产品必须固定版本和制品校验值。不要从移动分支在线安装，也不要把 `typescript/`、`dotnet/` 或 `python/src/` 当作产品依赖。npm 只包含 Browser/Node；不要假定它能安装 .NET/Python。

## 4. 运行时契约：宿主优先

所有运行时只有六个业务概念：

```text
track(eventName, properties)
identify(subjectId, properties)
page(properties)
setConsent(state)
flush()
disable()
```

必须按以下语义使用：

| 方法 | 行为 | 能否在业务热路径调用 |
| --- | --- | --- |
| `track` | 本地校验并放入有界内存队列 | 可以；同步返回，不等待网络/磁盘 |
| `identify` | 校验伪名 ID 和 Session Properties 后入队 | 可以；同步返回 |
| `page` | 规范化页面路径后入队 | 可以；主要用于 Web |
| `setConsent` | 本地改变采集状态；拒绝/撤回时清队列和身份 | 可以 |
| `flush` | 尝试发送待发队列 | 只用于测试或受控退出 |
| `disable` | 永久禁用当前 Client，并清空状态 | 可以；重新启用需创建新 Client |

真实方法名按语言映射：

| 概念 | TypeScript | .NET | Python |
| --- | --- | --- | --- |
| `track` | `track()` | `Track()` | `track()` |
| `identify` | `identify()` | `Identify()` | `identify()` |
| `page` | `page()` | `Page()` | `page()` |
| `setConsent` | `setConsent()` | `SetConsent()` | `set_consent()` |
| `flush` | `flush()` | `FlushAsync()` | `flush()` |
| `disable` | `disable()` | `Disable()` | `disable()` |
| 终态关闭 | Node `close()`；Web `disable()` | `DisposeAsync()` / `await using` | `close()` / context manager |

`accepted=true` 只表示事件通过本地规则并进入队列，不表示 Umami 已收到。DNS、TLS、超时、断网、429、5xx、Umami 停机、队列溢出和重试耗尽均不得改变宿主功能、业务返回值、UI 或退出码。

`track()` 的返回对象包含：

```text
accepted: 是否通过本地校验并入队
code: accepted 或具体拒绝原因
eventId: 可选的本地队列/诊断 ID；不会上传到 Umami
```

`onDiagnostic` 只在拒绝、丢弃或传输异常等诊断场景触发，不能把它当成“服务端已接收”回调。配置错误会在创建 Client 时快速失败，必须阻止错误配置发布。

不要再把 SDK 包在 `Task.Run`、额外线程或额外 Promise 中。SDK 已完成异步隔离。初始化配置错误会抛出并阻止启动，这属于应在构建/Staging 修复的部署错误；初始化成功后的网络、Umami、后台持久化和诊断回调故障才属于静默降级范围。

## 5. 公共配置

所有运行时都需要以下配置：

| 配置 | 含义 | 规则 |
| --- | --- | --- |
| `endpoint` / `Endpoint` | 区域 Umami 根地址 | HTTPS；不能带 Path、Query、Fragment 或用户凭据 |
| `websiteId` / `WebsiteId` | 当前产品环境的 Website UUID | Production/Staging 分开 |
| `hostname` / `Hostname` | 分析中的逻辑 Host | 只允许字母、数字、点、连字符；不能带 URL Path |
| `product` / `Product` | 产品 slug | 小写字母、数字、`_`、`-`，最长 64 |
| `environment` / `Environment` | 环境 | 推荐 `staging` 或 `production` |
| `surface` / `Surface` | 产品界面 | 推荐 `web`、`desktop`、`node`、`opencode_plugin`、`cli`、`agent`、`backend` |
| `productVersion` / `ProductVersion` | 产品版本 | 受控版本值，最长 64 |
| `initialConsent` / `InitialConsent` | 启动时已恢复的 Consent | 默认 `unknown` |
| `platform`、`architecture`、`locale`、`channel` | 可选公共分析维度 | 只能是受控值，最长 64 |
| `onDiagnostic` / `OnDiagnostic` | 可选诊断回调 | 只处理诊断码；不得记录原始事件或用户内容 |

公共属性由 SDK 自动注入，业务调用不得重复传入：

```text
event_version, product, environment, surface, product_version
sdk_version, platform, architecture, locale, consent_state, policy_version
```

`channel` 可以是公共配置，也可以是某些事件的必填属性。事件注册表要求 `channel` 时，调用 `track()` 仍必须显式提供事件自己的 `channel`。

### 5.1 默认可靠性参数

| 参数 | Browser | Node | .NET / Python |
| --- | ---: | ---: | ---: |
| 内存队列 | 100 | 1000 | 1000 |
| Batch Size | Tracker 管理 | 25 | 25 |
| Flush Interval | 下一微任务 | 5 秒 | 5 秒/事件唤醒 |
| 单次网络超时 | 3 秒 | 3 秒 | 3 秒 |
| 最大重试 | 不持久重试 | 3 | 3 |
| 最大事件年龄 | 页面生命周期 | 24 小时 | 24 小时 |
| 磁盘队列 | 无 | 无 | 可选 |

硬边界：所有运行时队列容量最大 `10,000`；Node/.NET/Python 的 Batch 最大 `100`、重试最大 `10`、单次超时最大 `60` 秒、事件年龄最大 `30` 天，成功响应最多读取 `64 KiB`；.NET/Python 持久队列最大 `64 MiB`。Browser 发送仍由当前固定 Umami Tracker 执行。非法、`NaN`、无穷或超上限配置会在构造 Client 时失败。

Browser 和 Node 的内存事件在页面关闭或进程崩溃时可以丢失。Desktop/CLI 只有在延迟事件有明确价值时才配置持久队列。

## 6. Consent 生命周期

状态转换：

```text
unknown -> granted / denied
granted -> withdrawn
denied -> granted
withdrawn -> granted
```

| 状态 | SDK 行为 | 宿主责任 |
| --- | --- | --- |
| `unknown` | 不接受事件，不加载 Web Tracker | 不创建安装分析 ID，不发送 |
| `granted` | 接受并异步发送允许的数据 | 保存 Consent 状态和 Policy Version |
| `denied` | 清队列和身份；Node/.NET/Python 同时清 Session Cache | 不影响基本功能；Web 账户场景随后整页重载 |
| `withdrawn` | 清队列和身份；Node/.NET/Python 清 Session Cache/SDK 队列文件 | 删除宿主保存的原始 `installation_id`；Web 随后整页重载 |

正确初始化顺序：

1. 从产品自己的设置存储读取 Consent 和对应 Policy Version；
2. Policy Version 不匹配或没有记录时按 `unknown`；
3. 用恢复出的状态创建唯一 Client；
4. 如果是 `granted`，加载或创建安装 ID，再调用 `identify()`；
5. 用户撤回时先调用 `setConsent(withdrawn)`，再删除宿主持有的安装 ID；
6. 用户以后重新同意时生成新的安装 ID，不能恢复已删除 ID。

Desktop/Python 若配置持久队列，应在构造 Client 前恢复 Consent。以 `unknown` 构造会主动删除以前的持久队列，这是隐私保护行为。

## 7. 身份模型

### 7.1 匿名网站访客

未登录网站默认不调用 `identify()`，使用 Umami 无 Cookie Session。不要为了追求“稳定 UV”创建浏览器长期设备指纹。

### 7.2 Desktop、插件、CLI 安装身份

只在 Consent 为 `granted` 后：

1. 生成高熵随机 `installation_id`；
2. 原值只保存在产品私有配置目录；
3. 发送按产品派生的 Subject ID：

```text
subject_id = Base64URL(SHA-256(product_scope + NUL + installation_id))
```

TypeScript/Node：

```ts
import {
  createInstallationId,
  deriveInstallationSubjectId,
} from '@perrin-yong/umami-sdk/node';

const installationId = loadInstallationId() ?? createInstallationId();
saveInstallationId(installationId);
const subjectId = deriveInstallationSubjectId('my-product', installationId);
analytics.identify(subjectId);
```

.NET：

```csharp
var installationId = LoadInstallationId() ?? AnalyticsIdentity.CreateInstallationId();
SaveInstallationId(installationId);
var subjectId = AnalyticsIdentity.DeriveInstallationSubjectId("my-product", installationId);
analytics.Identify(subjectId);
```

Python：

```python
from pystone_analytics import create_installation_id, derive_installation_subject_id

installation_id = load_installation_id() or create_installation_id()
save_installation_id(installation_id)
subject_id = derive_installation_subject_id("my-product", installation_id)
analytics.identify(subject_id)
```

重装、清除产品数据或撤回 Consent 会产生新身份。因此 New Installations 是分析身份数，不是绝对设备数或自然人数。

### 7.3 登录账户身份

登录身份必须由可信后端使用产品独立、至少 32 字节的 HMAC Key 派生：

```text
subject_id = Base64URL(HMAC-SHA256(product_key, internal_user_id))
```

Key 只存在于可信后端。Browser、Desktop、CLI、Agent 和插件只接收派生后的 43 字符 ID。禁止发送 Email、手机号、姓名或裸数据库主键。

Node 后端示例：

```ts
import { deriveUserSubjectId } from '@perrin-yong/umami-sdk/node';

const subjectId = deriveUserSubjectId(productKeyBuffer, internalUserId);
```

`identify()` 只允许以下 Session Properties：

```text
plan, role_category, channel, account_age_bucket, license_category
```

示例：

```ts
analytics.identify(subjectId, {
  plan: 'free',
  role_category: 'owner',
  channel: 'organic',
});
```

Node/.NET/Python 在已识别 Subject 改变时会丢弃旧身份的待发队列并重置 `x-umami-cache`。Web Tracker 的内部 Session Cache 无公开重置接口；网站退出或切换账户后必须停止账户事件、完成整页重载，再按 Consent 初始化新的 Client。

注册表中的 Identity Scope 是语义约束，SDK 无法判断一个 43 字符 ID 是安装身份还是账户身份。接入 Agent 必须保证 Session 事件、Installation 事件和 Account 事件使用正确的当前身份。

## 8. 各产品形态接入

Browser、Desktop、插件和 CLI 等单 Subject 产品应使用应用级单例或与应用生命周期一致的长寿命 Client。多用户后端是例外，见 8.2.1；不要在共享 Client 上交替设置多个账户身份。

### 8.1 Browser / SPA

```ts
import { createWebAnalytics } from '@perrin-yong/umami-sdk/web';

export const analytics = createWebAnalytics({
  endpoint: 'https://umami.pystone.net',
  websiteId: '<WEBSITE_ID>',
  hostname: 'www.example.com',
  product: 'my-product',
  environment: 'production',
  surface: 'web',
  productVersion: '1.2.0',
  initialConsent: 'unknown',
  domains: ['example.com', 'www.example.com'],
  allowUtm: true,
  performance: true,
  autoTrack: true,
  onDiagnostic: diagnostic => {
    incrementAnalyticsDiagnostic(diagnostic.code);
  },
});
```

行为说明：

- Consent `granted` 前不会动态加载 Umami Tracker；
- `domains` 防止 localhost/Staging 污染 Production；
- `allowUtm=false` 时删除全部 Query；启用时只保留五个标准 UTM；
- Fragment 永远不上传；
- `performance=true` 只用于真实网站；
- `autoTrack=true` 时不要再手动记录相同路由 Pageview；
- SSR 阶段不要访问 Client；只在 Browser 客户端模块初始化。

手动 SPA Pageview：

```ts
// 仅在 autoTrack=false 时，在路由和标题稳定后调用。
analytics.page({
  path: window.location.pathname,
  title: document.title,
});
```

业务事件：

```ts
const result = analytics.track('download_clicked', {
  artifact_type: 'windows_x64',
  channel: 'homepage',
});

if (!result.accepted) {
  incrementAnalyticsDiagnostic(result.code);
}
```

不要 `await analytics.track()`。它不是 Promise。

### 8.2 Node 服务

```ts
import { createNodeAnalytics } from '@perrin-yong/umami-sdk/node';

export const analytics = createNodeAnalytics({
  endpoint: process.env.ANALYTICS_ENDPOINT!,
  websiteId: process.env.ANALYTICS_WEBSITE_ID!,
  hostname: 'api.my-product.invalid',
  product: 'my-product',
  environment: process.env.APP_ENV === 'production' ? 'production' : 'staging',
  surface: 'backend',
  productVersion: process.env.APP_VERSION!,
  userAgent: `MyProduct/${process.env.APP_VERSION} PystoneAnalytics/0.1.1`,
  initialConsent: 'granted',
  onDiagnostic: diagnostic => incrementAnalyticsDiagnostic(diagnostic.code),
});

analytics.track('operation_completed', {
  feature: 'agent_run',
  duration_bucket: '10_30s',
});

// 仅在进程的受控关闭阶段：
await analytics.close();
```

后端关键业务事件必须在数据库事务或支付回调已经确认事实后发送。Analytics 失败不能回滚业务事务。

#### 8.2.1 多用户后端身份隔离

Node/.NET/Python Client 都保存当前 Subject。以下代码禁止出现在并发后端：

```ts
// 错误：共享 Client 的 Subject 会变化，切换时还会丢弃旧身份队列。
sharedAnalytics.identify(request.user.subjectId);
sharedAnalytics.track('purchase_completed', properties);
```

当前 `0.1.1` 的正确边界：

- 不需要账户身份的系统级事件可以使用共享 Client；
- 需要 Account Identity 的低频可信事件，先把最小、受控的分析事实放入产品自己的后台任务队列；
- 后台 Worker 为单个 Subject 创建隔离 Client，连续调用 `identify()`、`track()`、`close()`；
- HTTP 请求、付款回调或业务事务不等待该 Analytics Worker；
- 队列任务不能保存 Email、订单整行、请求体或其他禁止数据；
- 事件量明显增长时，应先在本 SDK 增加经过评审的无状态后端发送能力，而不是在各产品复制 Umami Payload。

低频后台 Worker 示例：

```ts
async function sendTrustedAccountEvent(job: TrustedAnalyticsJob) {
  const isolated = createNodeAnalytics({
    ...trustedAnalyticsConfig,
    initialConsent: 'granted',
  });

  isolated.identify(job.subjectId, { plan: job.plan });
  isolated.track(job.eventName, job.properties);
  await isolated.close();
}
```

`TrustedAnalyticsJob` 必须是中央事件注册表的受控联合类型，不能是任意 `string + object`。如果产品没有已有的可靠后台任务机制，Analytics 任务允许丢失，不要为了 Analytics 在业务请求中引入新的强一致事务。

### 8.3 OpenCode / Bun 插件

优先复用 Node 入口，`surface='opencode_plugin'`。在目标 OpenCode/Bun 版本上先验证：模块加载、原生 `fetch`、`node:crypto`、断网、关闭和宿主升级。

```ts
const analytics = createNodeAnalytics({
  endpoint,
  websiteId,
  hostname: 'opencode.my-plugin.invalid',
  product: 'my-plugin',
  environment,
  surface: 'opencode_plugin',
  productVersion: pluginVersion,
  userAgent: `MyPlugin/${pluginVersion} PystoneAnalytics/0.1.1`,
  initialConsent: restoredConsent,
});

analytics.track('feature_used', { feature: 'command_run' });
```

Hook 中禁止 `await fetch()` 或 `await flush()`。高频 Hook 应只记录最终结果、Session 汇总或经评审的采样事件。绝不采集 Prompt、回复、代码、路径、项目名、命令和 Tool 参数。

### 8.4 Windows Desktop / .NET

```csharp
using Pystone.Analytics;
using System.Runtime.InteropServices;

await using var analytics = new AnalyticsClient(new AnalyticsOptions
{
    Endpoint = new Uri("https://umami.pystone.net"),
    WebsiteId = Guid.Parse("<WEBSITE_ID>"),
    Hostname = "desktop.my-product.invalid",
    Product = "my-product",
    Environment = "production",
    Surface = "desktop",
    ProductVersion = ProductVersion.Current,
    UserAgent = $"MyProduct/{ProductVersion.Current} PystoneAnalytics/0.1.1",
    InitialConsent = restoredConsent,
    Platform = "windows",
    Architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
    PersistentQueuePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MyProduct", "analytics-queue.json"),
    OnDiagnostic = diagnostic => IncrementAnalyticsDiagnostic(diagnostic.Code),
});

analytics.Track("product_started");
analytics.Track("operation_completed", new Dictionary<string, object?>
{
    ["feature"] = "scan",
    ["duration_bucket"] = "1_3s",
});
```

不要把 `Track` 放入 `Task.Run`。受控退出时可以尝试短时刷新：

```csharp
using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
try { await analytics.FlushAsync(deadline.Token); }
catch (OperationCanceledException) { /* Analytics 可以丢弃。 */ }
```

持久队列路径必须位于当前用户的产品私有数据目录，不能放工作目录、安装目录、共享目录或 Git 仓库。

### 8.5 Python CLI / Agent

```python
from pathlib import Path
from pystone_analytics import AnalyticsClient, AnalyticsConfig, ConsentState

analytics = AnalyticsClient(AnalyticsConfig(
    endpoint="https://umami.pystone.net",
    website_id="<WEBSITE_ID>",
    hostname="cli.my-product.invalid",
    product="my-product",
    environment="production",
    surface="cli",
    product_version=PRODUCT_VERSION,
    user_agent=f"MyProduct/{PRODUCT_VERSION} PystoneAnalytics/0.1.1",
    initial_consent=restored_consent,
    platform="windows",
    persistent_queue_path=Path(product_private_data_dir) / "analytics-queue.json",
    on_diagnostic=lambda diagnostic: increment_analytics_diagnostic(diagnostic.code),
))

analytics.track("product_started")
analytics.track("operation_completed", {
    "feature": "scan",
    "duration_bucket": "1_3s",
})

# 只在受控退出阶段调用。
analytics.close()
```

Analytics 不得改变 CLI 的 stdout、stderr、退出码或主要任务时延。诊断默认不输出给最终用户。

## 9. 页面、事件和身份的使用规则

### 9.1 `track`

只在业务事实已经发生后调用：

```ts
const result = analytics.track('operation_failed', {
  feature: 'scan',
  error_category: 'network_unavailable',
  duration_bucket: '1_3s',
});
```

不要发送 `error.message`、异常堆栈、请求体或日志。先在产品代码中映射为稳定的 `error_category`。

### 9.2 `identify`

只传伪名 Subject ID 与五个允许的 Session Properties。`identify()` 不是账户数据库更新接口，不上传 Email 或账户资料。

### 9.3 `page`

Web 只传规范化 Path 和可选 Title。不要传 `location.href`。Desktop、CLI、插件采用 Event-first，不为了使用 Pageview 而伪造页面。

### 9.4 `flush` 和关闭

- Browser：正常事件会在下一微任务发送；不要在按钮事件中手动 `flush()`；
- Node：受控关闭时 `await close()`，内部等待有上限；
- .NET：使用带 CancellationToken 的 `FlushAsync()`；
- Python：只在退出阶段 `close()`；
- 崩溃、强杀或超时后允许丢失 Analytics。

Node `close()`、Python `close()` 和 .NET `DisposeAsync()` 完成后 Client 已终止，后续调用返回 `disabled`；需要重新启用时创建新 Client。产品不要注入自定义 Transport，除非已有独立测试证明其线程安全、超时和副作用边界。

`.NET` 的 `await using` 会在作用域结束时调用 `DisposeAsync()`；不要再对同一实例并发执行新的业务上报。Node/Python 的 `close()` 可以重复调用，但产品生命周期仍应只登记一次关闭处理器。

## 10. 中央事件注册表

调用未注册事件、漏掉必填属性或增加未知属性时，SDK 会拒绝并返回诊断码。公共上下文不列入下表，因为由 SDK 自动注入。

| Event | Identity | 必填属性 | 可选属性 | 推荐发送方 |
| --- | --- | --- | --- | --- |
| `contact_requested` | Session | `contact_type` | — | Web |
| `download_clicked` | Session | `artifact_type`, `channel` | — | Web |
| `feature_used` | Installation | `feature` | `result` | 客户端 |
| `feedback_submitted` | Installation | `feedback_type` | — | 客户端；不含反馈正文 |
| `license_activated` | Account | `license_category` | `channel` | 可信后端 |
| `operation_cancelled` | Installation | `feature` | `duration_bucket` | 客户端 |
| `operation_completed` | Installation | `feature`, `duration_bucket` | `result` | 客户端/后端 |
| `operation_failed` | Installation | `feature`, `error_category` | `duration_bucket` | 客户端/后端 |
| `operation_started` | Installation | `feature` | — | 客户端 |
| `outbound_link_clicked` | Session | `target_domain`, `link_category` | — | Web |
| `product_activated` | Installation | `activation_type` | — | 客户端/后端 |
| `product_started` | Installation | — | — | 客户端 |
| `purchase_completed` | Account | `revenue`, `currency` | `sku`, `transaction_id`, `plan` | 可信后端 |
| `refund_completed` | Account | `revenue`, `currency` | `sku`, `transaction_id`, `plan` | 可信后端 |
| `signup_completed` | Account | `method_category` | `channel` | 可信后端优先 |
| `signup_started` | Session | `entry_point` | `channel` | Web/客户端 |
| `subscription_started` | Account | `plan`, `revenue`, `currency` | `sku`, `transaction_id`, `channel` | 可信后端 |
| `update_installed` | Installation | `from_version`, `to_version` | — | 客户端 |
| `user_logged_in` | Account | `method_category` | — | 登录成功后 |

属性值必须是产品定义的受控枚举。例如：

```yaml
feature: [scan, agent_run, workspace_create]
duration_bucket: [under_1s, 1_3s, 3_10s, 10_30s, over_30s]
result: [success, partial]
error_category: [validation, network_unavailable, provider_error, timeout, unknown]
method_category: [password, oauth, license]
```

这只是值设计示例，不会自动扩展中央 Schema。接入产品应在自己的文档或测试中固定实际枚举，不能把用户输入、错误消息或动态对象 ID作为枚举值。

### 10.1 新增事件

产品需要新事件时，不得通过类型断言、直接 HTTP 或修改构建产物绕过：

1. 在 SDK 的 `schema/event-registry.json` 增加定义；
2. 写明 purpose、decision、identity scope、required/optional 属性；
3. 完成隐私评审；
4. 运行 `python tools/generate_policy.py`；
5. 运行 `.\tools\build-sdk.ps1`；
6. 提升并发布 SDK 版本；
7. 产品升级固定制品并先在 Staging 验证。

同名事件或属性不能改变语义。语义变化必须提升事件 `version`。

## 11. 数据限制和隐私过滤

| 项目 | SDK 限制 |
| --- | ---: |
| Event Name | 最长 50；小写 `snake_case` |
| 事件总属性数 | 最多 40，包含 SDK 公共属性 |
| 属性名 | 最长 64；小写 `snake_case` |
| 字符串值 | 最长 200 |
| 数字绝对值 | 不超过 `1,000,000,000,000` |
| 数字小数位 | 最多 4 |
| Subject ID | 最长 50；Base64URL 安全字符 |
| Page Path | 最长 300 |
| Page Title | 最长 120 |

属性只允许字符串、数字、布尔值或 `null`。不允许对象、数组、自由文本或任意 JSON。

永久禁止采集：

```text
Prompt、模型回复、聊天正文、用户输入
源代码、文件内容、文件名、完整路径
终端命令、参数、环境变量
API Key、Token、Cookie、密码、Authorization Header
Email、手机号、姓名、精确地址
剪贴板、屏幕内容、文档正文
异常堆栈、原始日志、HTTP 请求体/Header
精确地理位置和敏感个人特征
```

SDK 会按字段 allowlist 和敏感值模式阻断，但产品代码仍必须在调用前只构造允许数据。不要把 SDK 当作可以安全接收任意对象的脱敏器。

## 12. 诊断码及处理

诊断只用于开发、测试和聚合计数。不要把原始 properties 拼进日志。

| Code | 含义 | 产品处理 |
| --- | --- | --- |
| `accepted` | 已通过本地校验并入队 | 无操作 |
| `consent_not_granted` | Consent 非 granted | 正常静默忽略 |
| `disabled` | 当前 Client 已永久禁用 | 正常静默忽略 |
| `invalid_config` | Endpoint、Website ID 或上下文错误 | 阻止发布，修配置 |
| `invalid_event_name` | 事件名格式错误 | 修代码 |
| `unregistered_event` | 中央注册表没有事件 | 走新增事件流程 |
| `missing_property` | 缺少必填属性 | 修埋点 |
| `unknown_property` | 传入未允许属性 | 删除或更新中央 Schema |
| `invalid_property` | 类型、长度、数值或数量非法 | 修映射 |
| `sensitive_key` / `sensitive_value` | 命中隐私阻断 | 作为隐私缺陷处理 |
| `invalid_subject_id` | Subject ID 格式非法 | 修身份派生 |
| `invalid_page` | Page Path/Title 非法 | 修 URL 规范化 |
| `queue_full` | 队列已丢弃最旧事件 | 降低事件量或评估容量 |
| `event_expired` | 事件超过保留时间 | 正常丢弃；检查长期离线 |
| `retry_exhausted` | 有限重试耗尽 | 正常丢弃；检查服务健康 |
| `transport_permanent_failure` | 4xx 或批量部分失败 | 修 Schema/配置 |
| `transport_retryable_failure` | 网络、429、5xx 或超时 | 静默降级；监控趋势 |
| `tracker_load_failed` | Browser Tracker 加载失败 | 检查 CSP、广告拦截和 Endpoint |

诊断回调自身不得抛异常、执行网络请求或做重 IO。推荐只增加内存计数，再由现有技术监控系统汇总；不要把 Analytics SDK 的诊断重新发送给同一个 Analytics 服务。

## 13. 产品内建议结构

保持薄封装，不再建设第二套通用遥测框架：

```text
product-repository/
├── analytics/
│   ├── client.*              # 唯一 SDK 实例和配置
│   ├── consent.*             # 状态与 Policy Version
│   ├── identity.*            # 安装 ID 存储/后端 Subject 获取
│   ├── events.*              # 产品枚举和语义化小函数
│   └── analytics.test.*      # 隐私、Consent、故障隔离测试
└── docs/analytics.md         # 产品指标、事件位置和枚举
```

允许增加语义化薄函数：

```ts
export function trackScanCompleted(durationBucket: DurationBucket) {
  return analytics.track('operation_completed', {
    feature: 'scan',
    duration_bucket: durationBucket,
  });
}
```

不要增加 Provider SPI、DI 框架、自动反射、全量 Click 捕获或任意 `track(string, object)` 转发层。

## 14. LLM Agent 实施步骤

负责产品研发的 Agent 按以下顺序执行：

1. 阅读产品仓库的 `AGENTS.md`、构建方式和生命周期入口；
2. 搜索已有 Analytics、Telemetry、Consent、Privacy 和 User ID 代码，避免重复实现；
3. 填写第 2 节输入清单，确定区域和 Staging Website；
4. 安装固定 SDK 制品，不改 SDK 源码；
5. 创建应用级唯一 Client，并把 Endpoint/Website ID 通过环境配置注入；
6. 接入 Consent 恢复、同意、拒绝、撤回和重新同意；
7. 实现安装 ID 私有存储或从后端获取登录 Subject ID；
8. 定义 `activation_event`、`meaningful_active_events`、`conversion_events`；
9. 只选择能回答这些指标的中央事件；
10. 在业务事实完成后埋点，错误先映射为受控类别；
11. 添加下面的自动测试；
12. 在 Staging 发固定合成事件并到 Umami 验证；
13. 检查构建产物、日志、URL 和事件样本中没有禁止数据；
14. 更新产品 `docs/analytics.md`，报告改动、测试、Website 和剩余风险。

不要因为某个业务位置不清楚而随意埋在 UI Click 上。应先找到真正代表事实的业务成功/失败边界。

## 15. 自动测试要求

产品仓库至少增加以下测试：

### 15.1 Consent

- `unknown` 时 `track` 返回 `consent_not_granted` 且没有网络；
- `denied/withdrawn` 时清除队列和宿主安装 ID；
- 重新同意产生新的安装 ID；
- Consent Policy Version 不匹配时回到 `unknown`。

### 15.2 Schema 与隐私

- 一个合法事件被接受；
- 未注册事件被拒绝；
- 缺少必填属性被拒绝；
- 未知属性被拒绝；
- Email、Token、路径、错误堆栈等样本被拒绝；
- 产品枚举不会来自用户自由文本。

### 15.3 异步隔离

- 模拟 Transport 永不返回时，业务方法仍立即返回；
- 模拟超时、429、5xx 和断网时，业务结果与退出码不变；
- 队列满时丢弃 Analytics，不阻塞宿主；
- 正常业务测试不依赖 Umami 在线。
- 诊断回调抛异常时，业务方法仍返回且宿主不崩溃；
- `disable()` 和终态关闭后，新事件返回 `disabled`；重复关闭不抛异常；
- 如果启用持久队列，目录只读、磁盘满、文件损坏或文件被篡改时宿主继续运行；
- 配置一个会阻塞或抛异常的测试 Transport，证明 `track/identify/page` 不会进入它；
- Node/.NET 的关闭截止时间在不合作 Transport 下仍有效；Python `close()` 返回后允许放弃 daemon Worker。

### 15.4 身份

- 产品相同安装 ID 派生稳定 Subject；
- 不同产品 Scope 派生不同 Subject；
- Subject 最长不超过 50；
- 账户 A 切换到账户 B 后不继承旧待发队列/Session Cache；
- Web 退出后整页重载并建立新 Client。

## 16. Staging 合成事件验收

在 Staging Website 执行一次完整旅程：

```text
Consent unknown：确认没有 Tracker/API 请求
-> Consent granted
-> page /landing（仅 Web）
-> download_clicked
-> product_started
-> operation_started
-> product_activated
-> feature_used
-> operation_completed
-> 次日同 Subject 再次发送 meaningful active event
-> 登录 identify(account subject)
-> 账户切换/退出
-> Consent withdrawn
```

在 Umami 中验证：

- Realtime 能看到合成事件；
- Events 中名称和属性与注册表一致；
- 没有 `product` 等重复业务属性，也没有本地 `event_id`；
- Sessions 中只能看到伪名 Distinct ID 和允许的 Session Properties；
- 下载/注册/激活 Funnel 顺序和人数正确；
- Retention 使用的身份范围与指标说明一致；
- Staging 没有进入 Production Website；
- 抽样数据没有任何禁止字段或自由文本。

然后模拟断网、慢网、429、5xx 和 Umami 停机，确认宿主继续正常工作。只有以上项目通过后，才替换 Production Website ID 并发送少量固定合成事件。

产品验收必须使用浏览器 Network、测试 Transport 或入口日志证明“无请求/主流程不变”，不能只凭 `accepted=true` 推断服务端已经收到。SDK 自动测试通过也不等于某个产品已完成真实 CSP、代理、Bun/.NET/Python 版本和生命周期验收。

## 17. 完成标准

接入 Agent 只有在以下条件全部满足时才能报告完成：

- 使用正确区域、环境和固定 SDK 版本；
- Analytics Client 是应用级长寿命实例；
- Consent `unknown` 默认不发送；
- `track/identify/page` 不等待网络或磁盘；
- 安装 ID、账户 ID、退出和切换流程已实现；
- 没有 Secret 或真实身份进入客户端与事件；
- 事件全部来自中央注册表，属性与枚举受控；
- Activation、Meaningful Active 和 Conversion 定义已写入产品文档；
- 自动测试和 Staging 合成事件通过；
- Analytics 故障不影响宿主业务；
- 产品隐私说明包含采集目的、数据类别、保存期限和关闭方式。

Agent 最终报告应包含：

```text
SDK version / artifact
Region / endpoint / staging website
Changed files
Consent and identity implementation
Events and exact trigger locations
Tests executed and results
Staging dashboard verification
Known limitations or blockers
Confirmation that no secrets or forbidden fields were added
```

## 18. 相关真源

- SDK 总览：[`../README.md`](../README.md)
- 事件注册表：[`../schema/event-registry.json`](../schema/event-registry.json)
- 隐私策略：[`../schema/privacy-policy.json`](../schema/privacy-policy.json)
- 产品分析规范：[`analytics-spec.md`](analytics-spec.md)
- Umami 后台与分析功能：[`product-integration.md`](product-integration.md)
- SDK 架构决策：[`architecture.md`](architecture.md)
- SDK 生产就绪验证：[`production-readiness.md`](production-readiness.md)

当本文与运行时代码不一致时，以当前固定 SDK 版本、事件注册表和隐私策略为准，并在 umami-sdk 仓库修正文档；不要在单个产品中自行发明兼容行为。
