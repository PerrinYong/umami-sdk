# SDK 配置与运行指南

本文是 `@perrin-yong/umami-sdk` 的配置参考。事件、身份和隐私语义以 [`analytics-spec.md`](analytics-spec.md) 为准；完整产品接入流程见 [`integration-guide.md`](integration-guide.md)。

## 1. 安装与入口

```bash
npm install --save-exact @perrin-yong/umami-sdk@0.1.0
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
| `websiteId` | 是 | Umami Website UUID；每个产品/环境独立。 |
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
| `initialConsent` | 否 | 默认 `unknown`，即不发送。宿主读取已保存的有效同意状态后再设置。 |
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
  userAgent: `MyProduct/${APP_VERSION} PystoneAnalytics/0.1.0`,
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

Node 版当前只使用有界内存队列。进程退出时可以尽力关闭，但必须接受超时和数据丢失：

```ts
try {
  await analytics.close();
} catch {
  // Analytics 不能改变宿主退出码。
}
```

## 6. Identity

- 匿名网站访客：不要主动设置长期 ID，使用 Umami 无 Cookie Session。
- Desktop/CLI/插件：同意后生成本地随机安装 ID；原值只保存在产品私有数据目录，发送 `deriveInstallationSubjectId(product, installationId)`。
- 登录用户：只在可信后端使用 `deriveUserSubjectId(productKey, internalUserId)`；`productKey` 至少 32 字节且不能进入前端、Desktop、CLI 或插件。
- 退出或切换账户：撤销旧 Subject，清空队列并重新建立匿名/安装身份。不要在共享 Node Client 上交替处理多个账户。

`identify()` 属性只允许 `plan`、`role_category`、`channel`、`account_age_bucket`、`license_category` 等当前 Schema 定义的受控属性。禁止 Email、姓名、手机号和裸数据库主键。

## 7. 事件与诊断

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

## 8. 上线门禁

- Staging 与 Production Website ID 已隔离。
- `unknown`、`denied`、`withdrawn` 状态下没有请求。
- 断网、慢网、429、5xx 和 Umami 停机不改变业务结果或退出码。
- URL 没有 Query Secret、Email、用户 ID、Token 或动态路径标识。
- 登录、退出、切换账户和重装身份行为符合产品设计。
- 固定 SDK 版本，不依赖 `latest` 做不可控升级。
- 真实产品完成 [`product-integration-template.md`](product-integration-template.md) 的验收记录。
