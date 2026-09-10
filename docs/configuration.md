# SDK 配置与运行指南

本文是 `@perrin-yong/umami-sdk` 的配置参考。事件、身份和隐私语义以 [`analytics-spec.md`](analytics-spec.md) 为准；完整产品接入流程见 [`integration-guide.md`](integration-guide.md)。

## 1. 安装与入口

当前分发状态不是三种语言都在公共包管理器发布：

| 运行时 | 安装来源 | 安装命令 |
| --- | --- | --- |
| Browser / Node / OpenCode | 公共 npm | `npm install --save-exact @perrin-yong/umami-sdk@0.1.1` |
| .NET 8 Desktop / 服务 | SDK Release 构建出的私有 `.nupkg` | `dotnet add package Pystone.Analytics --version 0.1.1 --source <ARTIFACT_DIR>` |
| Python 3.10+ CLI / Agent | SDK Release 构建出的私有 `.whl` | `python -m pip install <ARTIFACT_DIR>/pystone_analytics-0.1.1-py3-none-any.whl` |

不要尝试从 npm 安装 .NET/Python，也不要假装 `Pystone.Analytics` 已发布到 NuGet.org 或 `pystone-analytics` 已发布到 PyPI。生成内部制品时，在固定 SDK Tag/Commit 上运行 `./tools/build-sdk.ps1`，记录脚本输出的 SHA-256，再把制品复制到产品的私有制品位置。

```bash
npm install --save-exact @perrin-yong/umami-sdk@0.1.1
```

包只提供显式子路径，不提供根入口：

```ts
import { createWebAnalytics } from '@perrin-yong/umami-sdk/web';
import {
  createInstallationId,
  createNodeAnalytics,
  deriveInstallationSubjectId,
  deriveUserSubjectId,
} from '@perrin-yong/umami-sdk/node';
```

- `/web`：Browser、SPA 和 SSR 的客户端部分；只在 Consent 为 `granted` 后加载 Umami Tracker。
- `/node`：Node 服务、CLI、Agent 和经过兼容验证的 OpenCode/Bun 插件；后台批量调用 `/api/batch`。
- `/core`：共享类型和策略组件。普通产品不应直接用它构造 Umami Payload。

包是 ESM、目标 ES2022，要求 Node.js `18.18+`。运行时第三方依赖为零。

### 1.1 六个概念在各语言中的真实名称

| 概念 | TypeScript Web | TypeScript Node | .NET | Python |
| --- | --- | --- | --- | --- |
| Track | `track()` | `track()` | `Track()` | `track()` |
| Identify | `identify()` | `identify()` | `Identify()` | `identify()` |
| Page | `page()` | `page()` | `Page()` | `page()` |
| Consent | `setConsent()` | `setConsent()` | `SetConsent()` | `set_consent()` |
| Flush | `flush()` | `flush()` | `FlushAsync()` | `flush()` |
| Disable | `disable()` | `disable()` | `Disable()` | `disable()` |
| 终态关闭 | `disable()` | `close()` | `DisposeAsync()` / `await using` | `close()` / context manager |

`close()`/`DisposeAsync()` 是生命周期扩展，不是第七种业务埋点能力。终态关闭或 `disable()` 后必须创建新 Client，不能复用旧实例。

## 2. 配置来源

Endpoint 与 Website ID 必须由产品环境配置注入，不写死在业务模块：

```text
产品部署在中国大陆 ECS  → https://umami-cn.pystone.net
产品部署在海外 VPS       → https://umami.pystone.net
```

路由按产品部署归属固定，不按终端用户 IP 动态切换。Production 与 Staging 使用不同 Website ID；Website ID 不是 Secret，但不能跨产品或环境误用。

建议的宿主环境变量：

```dotenv
ANALYTICS_ENABLED=true
ANALYTICS_ENDPOINT=https://umami.pystone.net
ANALYTICS_WEBSITE_ID=00000000-0000-4000-8000-000000000000
ANALYTICS_ENVIRONMENT=production
ANALYTICS_CHANNEL=direct
```

Browser 构建工具会把公开前缀的环境变量打入前端包。这里只能放 Endpoint、Website ID 和受控上下文，不能放 HMAC Key、npm Token 或任何业务 Secret。

## 3. 公共配置

| 字段 | 必填 | 规则与建议 |
| --- | --- | --- |
| `endpoint` | 是 | 只接受 HTTPS Origin，例如 `https://umami.pystone.net`；不能带路径、Query、Fragment 或凭据。仅显式开启时允许本机 HTTP。 |
| `websiteId` | 是 | Umami 生成的 canonical RFC 4122 Website UUID；Nil/占位 UUID 无效；每个产品/环境独立。 |
| `hostname` | 是 | 稳定的受控主机名，不放用户、Workspace 或设备信息。Desktop/CLI 可用 `desktop.local`、`cli.local`。 |
| `product` | 是 | 最长 64 字符的小写受控 slug，例如 `my-product`。 |
| `environment` | 是 | 受控 slug，例如 `production`、`staging`。 |
| `surface` | 是 | 受控 slug，例如 `web`、`desktop`、`node`、`cli`、`opencode`。 |
| `productVersion` | 是 | 产品版本，不等同于 SDK 版本。 |
| `sdkVersion` | 否 | 默认使用当前 SDK 版本；只有包装 SDK 时才显式覆盖。 |
| `platform` | 否 | 例如 `windows`、`linux`、`web`。 |
| `architecture` | 否 | 例如 `x64`、`arm64`。 |
| `locale` | 否 | 例如 `zh-CN`；不发送更细粒度的用户位置。 |
| `channel` | 否 | 受控获客/分发渠道，例如 `direct`、`github`、`website`。 |
| `policyVersion` | 否 | 必须与 SDK 内置 Policy 相同，当前为 `1`。 |
| `initialConsent` | 否 | 默认 `unknown`，即不发送；只接受四个已定义状态。宿主读取同一 Policy Version 的有效同意状态后再设置。 |
| `allowInsecureLocalhost` | 否 | 仅本机 Staging/测试可用；不能放宽非 localhost HTTP。 |
| `onDiagnostic` | 否 | 只处理受控诊断码。回调异常会被隔离；不得在其中记录原始事件或敏感值。 |

`product`、`environment` 和 `surface` 只允许字母、数字、`_`、`-`；其他上下文字段只允许受控短值。配置错误在 Client 初始化时快速失败，因为这属于开发/部署错误，不属于可静默忽略的网络故障。

## 4. Browser 配置

```ts
import { createWebAnalytics } from '@perrin-yong/umami-sdk/web';

export const analytics = createWebAnalytics({
  endpoint: import.meta.env.VITE_ANALYTICS_ENDPOINT,
  websiteId: import.meta.env.VITE_ANALYTICS_WEBSITE_ID,
  hostname: window.location.hostname,
  product: 'my-product',
  environment: import.meta.env.MODE === 'production' ? 'production' : 'staging',
  surface: 'web',
  productVersion: __APP_VERSION__,
  initialConsent: 'unknown',
  domains: [window.location.hostname],
  autoTrack: true,
  allowUtm: true,
  performance: false,
  queueCapacity: 100,
  timeoutMs: 3000,
  onDiagnostic: diagnostic => {
    if (import.meta.env.DEV) console.debug('[analytics]', diagnostic.code);
  },
});
```

| Browser 选项 | 默认值 | 边界 |
| --- | --- | --- |
| `domains` | `[hostname]` | 最多 100 个合法主机名。 |
| `autoTrack` | `true` | 是否由 Umami Tracker 自动记录页面访问。 |
| `allowUtm` | `false` | 开启后也只保留 Policy allowlist 中的 UTM 参数；Fragment 永远移除。 |
| `performance` | `false` | 仅确有性能分析需求时开启。 |
| `queueCapacity` | `100` | `1..10000`；满时丢弃最旧事件。 |
| `timeoutMs` | `3000` | `250..60000`；只约束 Analytics，不传播到业务流程。 |
| `tracker` | 自动加载 | 测试时可注入兼容 Tracker；生产通常不覆盖。 |

Consent 生命周期必须由产品 UI 驱动：

```ts
// 用户明确同意后才开始加载 Tracker 和发送。
analytics.setConsent('granted');

analytics.page({ path: '/pricing', title: 'Pricing' });
analytics.track('signup_started', { entry_point: 'pricing' });

// 拒绝或撤回会立即停发、清空待发队列和当前身份。
analytics.setConsent('withdrawn');
```

不要在页面导航、点击或渲染热路径 `await analytics.flush()`。`track()`、`page()`、`identify()` 的返回值只表示本地校验/入队结果，不表示 Umami 已持久化。

## 5. Node、CLI、Agent 与插件配置

```ts
import {
  createInstallationId,
  createNodeAnalytics,
  deriveInstallationSubjectId,
} from '@perrin-yong/umami-sdk/node';

const installationId = loadInstallationId() ?? createInstallationId();
saveInstallationIdPrivately(installationId);

const analytics = createNodeAnalytics({
  endpoint: process.env.ANALYTICS_ENDPOINT!,
  websiteId: process.env.ANALYTICS_WEBSITE_ID!,
  hostname: 'cli.local',
  product: 'my-product',
  environment: process.env.ANALYTICS_ENVIRONMENT ?? 'production',
  surface: 'cli',
  productVersion: APP_VERSION,
  userAgent: `MyProduct/${APP_VERSION} UmamiSdk/0.1.1`,
  initialConsent: loadAnalyticsConsent(),
  platform: process.platform,
  architecture: process.arch,
  queueCapacity: 1000,
  batchSize: 25,
  flushIntervalMs: 5000,
  timeoutMs: 3000,
  maxRetries: 3,
  maxEventAgeMs: 86_400_000,
  retryBaseMs: 500,
});

if (loadAnalyticsConsent() === 'granted') {
  analytics.identify(
    deriveInstallationSubjectId('my-product', installationId),
    { channel: 'direct' },
  );
}
```

| Node 选项 | 默认值 | 边界 |
| --- | --- | --- |
| `userAgent` | 必填 | 1–200 字符，不能包含 CR/LF；Umami 服务端事件需要有效 User-Agent。 |
| `queueCapacity` | `1000` | `1..10000`。 |
| `batchSize` | `25` | `1..100`。 |
| `flushIntervalMs` | `5000` | 最小 250 ms。高频 Hook 应先在业务层聚合/采样。 |
| `timeoutMs` | `3000` | `250..60000`；同时约束关闭等待。 |
| `maxRetries` | `3` | `0..10`，只重试可重试结果。 |
| `maxEventAgeMs` | 24 小时 | 最小 1 秒；过期事件直接丢弃。 |
| `retryBaseMs` | `500` | 最小 100 ms；SDK 使用退避与随机抖动。 |

`flushIntervalMs` 最大 24 小时，`maxEventAgeMs` 最大 30 天，`retryBaseMs` 最大 24 小时；超限、`NaN`、无穷值和非整数型容量在构造时失败。

Node 版当前只使用有界内存队列。进程退出时可以尽力关闭，但必须接受超时和数据丢失：

```ts
try {
  await analytics.close();
} catch {
  // Analytics 不能改变宿主退出码。
}
```

## 6. .NET 8 / Windows Desktop 配置

`.nupkg` 安装后直接引用 `Pystone.Analytics`：

```csharp
using Pystone.Analytics;
using System.Runtime.InteropServices;

await using var analytics = new AnalyticsClient(new AnalyticsOptions
{
    Endpoint = new Uri(endpoint),
    WebsiteId = Guid.Parse(websiteId),
    Hostname = "desktop.my-product.invalid",
    Product = "my-product",
    Environment = "production",
    Surface = "desktop",
    ProductVersion = ProductVersion.Current,
    UserAgent = $"MyProduct/{ProductVersion.Current} UmamiSdk/0.1.1",
    InitialConsent = restoredConsent,
    Platform = "windows",
    Architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
    PersistentQueuePath = Path.Combine(productPrivateDataDirectory, "analytics-queue.json"),
});
```

| 选项 | 默认值 | 硬边界/说明 |
| --- | ---: | --- |
| `QueueCapacity` | `1000` | `1..10000` |
| `BatchSize` | `25` | `1..100` |
| `FlushInterval` | 5 秒 | 大于 0，最大 24 小时 |
| `Timeout` | 3 秒 | 大于 0，最大 60 秒；关闭阶段的总等待截止时间 |
| `MaxRetries` | `3` | `0..10` |
| `MaxEventAge` | 24 小时 | 大于 0，最大 30 天 |
| `RetryBase` | 500 ms | 大于 0，最大 24 小时 |
| `PersistentQueuePath` | 关闭 | 产品私有数据目录；恢复文件最大 64 MiB |

`Track/Identify/Page` 不访问网络或磁盘。持久化由后台 Task 执行；构造 Client 时若启用持久队列，会在启动阶段读取并重新验证文件。退出时优先使用 `await using`；若产品自己调用 `FlushAsync()`，必须提供截止时间，且不能放进保存、付款、UI 或命令主路径。

## 7. Python 3.10+ CLI / Agent 配置

```python
from pathlib import Path
from pystone_analytics import AnalyticsClient, AnalyticsConfig, ConsentState

analytics = AnalyticsClient(AnalyticsConfig(
    endpoint=endpoint,
    website_id=website_id,
    hostname="cli.my-product.invalid",
    product="my-product",
    environment="production",
    surface="cli",
    product_version=PRODUCT_VERSION,
    user_agent=f"MyProduct/{PRODUCT_VERSION} UmamiSdk/0.1.1",
    initial_consent=restored_consent,
    platform="windows",
    persistent_queue_path=Path(product_private_data_dir) / "analytics-queue.json",
))
```

| 选项 | 默认值 | 硬边界/说明 |
| --- | ---: | --- |
| `queue_capacity` | `1000` | `1..10000` |
| `batch_size` | `25` | `1..100` |
| `flush_interval_seconds` | `5` | `0.001..86400` |
| `timeout_seconds` | `3` | `0.001..60`；内置 HTTP 和 `close()` 截止时间 |
| `max_retries` | `3` | `0..10` |
| `max_event_age_seconds` | 24 小时 | `0.001..2592000`（30 天） |
| `retry_base_seconds` | `0.5` | `0.001..86400` |
| `persistent_queue_path` | 关闭 | 产品私有数据目录；恢复文件最大 64 MiB |

`track/identify/page` 只在调用线程做本地校验和内存入队；守护线程做网络和磁盘。正常命令路径不调用 `flush()`。受控退出调用 `close()`；即使自定义同步 Transport 永不返回，`close()` 也只等待配置的截止时间，但 Python 无法杀死第三方阻塞代码所在的 daemon 线程，因此生产默认使用内置 Transport。

## 8. Identity

- 匿名网站访客：不要主动设置长期 ID，使用 Umami 无 Cookie Session。
- Desktop/CLI/插件：同意后生成本地随机安装 ID；原值只保存在产品私有数据目录，发送 `deriveInstallationSubjectId(product, installationId)`。
- 登录用户：只在可信后端使用 `deriveUserSubjectId(productKey, internalUserId)`；`productKey` 接受标准 `Uint8Array`（Node `Buffer` 兼容）、至少 32 字节，且不能进入前端、Desktop、CLI 或插件。
- 退出或切换账户：撤销旧 Subject，清空队列并重新建立匿名/安装身份。不要在共享 Node Client 上交替处理多个账户。

`identify()` 属性只允许 `plan`、`role_category`、`channel`、`account_age_bucket`、`license_category` 等当前 Schema 定义的受控属性。禁止 Email、姓名、手机号和裸数据库主键。

## 9. 事件与诊断

事件必须先注册在 `schema/event-registry.json`。例如：

```ts
const result = analytics.track('operation_completed', {
  feature: 'agent_run',
  duration_bucket: '10_30s',
});

if (!result.accepted && process.env.NODE_ENV !== 'production') {
  console.debug(result.code);
}
```

常见拒绝码：

| 诊断码 | 含义 |
| --- | --- |
| `consent_not_granted` | Consent 尚未允许；这是正常状态。 |
| `unregistered_event` / `unknown_property` | 事件或属性没有进入 Schema。 |
| `sensitive_key` / `sensitive_value` | 隐私过滤器阻断。不要记录被拒绝原值。 |
| `queue_full` / `event_expired` | 有界资源策略主动丢弃。 |
| `transport_retryable_failure` | 网络、429 或服务端暂时异常；不影响业务。 |
| `transport_permanent_failure` | 请求被永久拒绝；检查 Endpoint、Website ID 和 Payload 兼容性。 |

生产诊断只按 `code` 聚合计数。禁止把 `detail`、事件属性或异常对象直接转发到日志/Analytics。

## 10. 上线门禁

- Staging 与 Production Website ID 已隔离。
- `unknown`、`denied`、`withdrawn` 状态下没有请求。
- 断网、慢网、429、5xx 和 Umami 停机不改变业务结果或退出码。
- URL 没有 Query Secret、Email、用户 ID、Token 或动态路径标识。
- 登录、退出、切换账户和重装身份行为符合产品设计。
- 固定 SDK 版本，不依赖 `latest` 做不可控升级。
- 真实产品完成 [`product-integration-template.md`](product-integration-template.md) 的验收记录。
