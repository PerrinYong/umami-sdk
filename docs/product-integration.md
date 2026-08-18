# Umami 使用与产品接入手册

本文是本工程的主要使用文档，适用于当前固定的 Umami `3.3.0` Fork，覆盖：

- 在 Umami 后台创建产品数据空间；
- 为产品选择中国大陆或海外实例；
- 接入网站、Node.js 后端、OpenCode 插件、Windows Desktop 和 Python CLI；
- 调用页面、事件、Identify、Session Properties、批量发送、Revenue 和 Performance 等能力；
- 在后台建立 Goal、Funnel、Journey、Retention、Attribution 和 Board；
- 按本工程规则处理身份、Consent、隐私、失败降级和上线验收。

> Umami 后台把一个分析项目称为 **Website**。本文中的“项目”“数据空间”和“Website”指同一个 Umami 对象，不表示代码仓库，也不要求接入对象一定是真实网站。

如果接入工作由产品研发 LLM Agent 执行，应把 [`integration-guide.md`](integration-guide.md) 作为主执行规范，并在产品仓库填写 [`product-integration-template.md`](product-integration-template.md)。本文继续作为 Umami 后台创建、原生 API 和 Dashboard 功能参考。

## 1. 先理解四个对象

| 对象 | 在本工程中的含义 | 示例 |
| --- | --- | --- |
| Umami 实例 | 数据实际写入的区域服务 | `https://umami-cn.pystone.net` |
| Website | 一个产品、环境、身份和隐私边界 | `my-product-production` |
| Session | Umami 根据 Website、IP、User-Agent 等生成的无 Cookie 会话 | 一次网站访问或产品运行期 |
| Distinct ID | 产品主动提供的伪名用户/安装标识 | HMAC 或 SHA-256 派生值 |

一个产品接入前必须先回答：

```text
product
environment
surface
endpoint
website_id
activation_event
meaningful_active_events
conversion_events
policy_version
```

建议将公开配置写进产品的环境配置，将密钥留在可信环境：

```dotenv
UMAMI_ENDPOINT=https://umami.pystone.net
UMAMI_WEBSITE_ID=<WEBSITE_ID>
ANALYTICS_PRODUCT=my-product
ANALYTICS_ENVIRONMENT=production
ANALYTICS_SURFACE=web
ANALYTICS_POLICY_VERSION=1
```

`UMAMI_ENDPOINT` 和 `UMAMI_WEBSITE_ID` 不是 Secret，可以进入客户端构建产物。管理员密码、管理 API Token、HMAC Key 和数据库凭据是 Secret，不得进入客户端或 Git。

## 2. 选择实例和 Website 边界

### 2.1 双区域路由

| 产品部署归属 | Endpoint | 后台地址 |
| --- | --- | --- |
| 中国大陆 ECS | `https://umami-cn.pystone.net` | [中国大陆 Umami](https://umami-cn.pystone.net) |
| 海外 VPS | `https://umami.pystone.net` | [海外 Umami](https://umami.pystone.net) |

路由规则：

- 按产品的服务部署归属固定选择实例，不按终端用户 IP 动态选择；
- 一个产品环境固定使用一个 Endpoint 和一个 Website ID；
- 不因当前实例超时而把同一队列跨区发送；
- 两个实例的 Website ID、Session、Distinct ID、管理员和数据库互不相通；
- 同一产品确实同时在国内、海外独立部署时，在两个实例分别创建 Website，并通过 API 或离线报表做跨区汇总。

### 2.2 Website 划分

默认命名：

```text
{product}-production
{product}-staging
```

例如：

```text
my-editor-production
my-editor-staging
```

边界规则：

- 不同产品使用不同 Website；
- Production 和 Staging 必须使用不同 Website；
- 同一产品的官网、Desktop、CLI 和插件需要原生统一分析时可以共用 Website，用 `surface` 区分；
- 如果各端用户体系、Consent 或数据权限不同，应拆成不同 Website；
- Website 表示产品和隐私边界，不简单等于域名或代码仓库。

## 3. 在后台创建一个项目

### 3.1 创建 Production Website

1. 打开目标区域的 Umami 后台并使用自己的管理员账号登录。
2. 在左侧进入 **Websites**。
3. 点击右上角 **Add website**。
4. 填写：

   - **Name**：建议 `{product}-production`，例如 `my-editor-production`；
   - **Domain**：网站填写真实主域名，不包含协议、路径和尾部斜杠，例如 `www.example.com`；Desktop/CLI 等无域名产品填写稳定的虚拟域名，例如 `desktop.my-editor.invalid`。

5. 点击 **Save**。
6. 打开该 Website 的 **Settings**，复制 **Website ID**。
7. 在 **Tracking code** 区域确认生成的脚本地址属于当前区域。

Domain 用于识别当前站点并过滤自引荐，不是数据发送地址。Desktop、CLI 和后端的事件仍应在 Payload 中提供稳定的 `hostname`。

### 3.2 创建 Staging Website

按同样方式创建 `{product}-staging`。建议使用实际测试域名；没有测试域名时使用稳定虚拟域名：

```text
staging.example.com
staging.desktop.my-editor.invalid
```

不要把 Production Website ID 配进开发、单元测试、E2E、健康检查或本地调试环境。

### 3.3 保存项目登记信息

每个 Website 至少登记：

```yaml
name: my-editor-production
endpoint: https://umami.pystone.net
website_id: 00000000-0000-0000-0000-000000000000
product: my-editor
environment: production
surfaces: [web, desktop, backend]
policy_version: 1
activation_event: product_activated
meaningful_active_events: [feature_used, operation_completed]
conversion_events: [download_clicked, signup_completed, subscription_started]
owner: product-owner
```

Website ID 可提交到产品配置；管理员 Token、身份派生 Key 等只能保存在 `.local/`、Secret Manager 或服务器环境变量。

### 3.4 可选：通过管理 API 自动创建

批量初始化多个产品时，可信管理脚本可先调用 `POST /api/auth/login` 获取 Bearer Token，再调用 `POST /api/websites`：

```http
POST /api/websites
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "name": "my-editor-production",
  "domain": "www.example.com"
}
```

管理 Token 只能用于本机运维脚本或可信服务端。产品埋点不需要也不得携带它。

## 4. 统一 Adapter：业务代码只用六个方法

业务层不要直接构造 Umami Payload。本仓库在 `typescript/`、`dotnet/` 和 `python/` 提供 Browser/Node、.NET 和 Python 薄 SDK，各语言暴露同一组语义：

```text
track(eventName, properties)
identify(subjectId, properties)
page(properties)
setConsent(state)
flush()
disable()
```

| 方法 | 业务语义 | Umami 映射 |
| --- | --- | --- |
| `track` | 记录已经发生的业务事实 | Web `umami.track(name, data)` 或 `POST /api/send` |
| `identify` | 设置伪名 Distinct ID 和受控 Session Properties | Web `umami.identify()` 或 `type=identify` |
| `page` | 记录规范化页面访问 | Tracker 自动 Pageview 或无 `name` 的 `type=event` |
| `setConsent` | 切换 Analytics 同意状态 | 本工程 Adapter 能力，不是 Umami 原生方法 |
| `flush` | 尝试发送有界队列 | 本工程 Adapter 能力；可映射 `/api/batch` |
| `disable` | 停止发送、清队列、清身份 | 本工程 Adapter 能力 |

SDK 的返回值只表示本地是否接受，不表示 Umami 已接收：

```ts
export type ConsentState = 'unknown' | 'granted' | 'denied' | 'withdrawn';
export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsProperties = Record<string, AnalyticsValue>;

export interface AnalyticsClient {
  track(name: string, properties?: AnalyticsProperties): TrackResult;
  identify(subjectId: string, properties?: AnalyticsProperties): TrackResult;
  page(properties?: { path?: string; title?: string }): TrackResult;
  setConsent(state: ConsentState): void;
  flush(): Promise<void>;
  disable(): void;
}
```

`track`、`identify`、`page` 只执行同步的本地校验和有界内存入队，不等待网络或磁盘。Web 在下一微任务调用 Tracker；Node/.NET/Python 由后台 Worker 批量发送。DNS、TLS、超时、429、5xx 和 Umami 停机只影响 Analytics 队列，不得改变页面、命令退出码、业务返回值或事务。

`flush` 只用于测试或受控退出，并受短截止时间约束；不能在渲染、保存、命令执行、支付或其他业务热路径中等待。队列超限、重试耗尽、事件过期或进程突然终止时允许丢弃 Analytics。

Adapter 必须统一注入：

```text
event_version, product, environment, surface, product_version
sdk_version, platform, architecture, locale, channel
consent_state, policy_version
```

产品业务代码只提供事件特有属性，例如 `feature`、`result`、`error_category` 和 `duration_bucket`。

SDK 根目录运行 `.\tools\build-sdk.ps1` 后，产品从 `artifacts/sdk/` 安装固定版本制品：

```powershell
npm install <PATH_TO_ARTIFACTS>\pystone-analytics-0.1.0.tgz
dotnet add package Pystone.Analytics --version 0.1.0 --source <PATH_TO_ARTIFACTS>
python -m pip install <PATH_TO_ARTIFACTS>\pystone_analytics-0.1.0-py3-none-any.whl
```

不要把根工程的移动分支作为产品构建时的在线依赖。升级 SDK 时同时审阅事件 Schema/Policy 变化并先在 Staging 验证。

## 5. Consent 生命周期

```text
unknown ──► granted ──► withdrawn
   └──────► denied ───────► granted
```

行为要求：

| 状态 | 行为 |
| --- | --- |
| `unknown` | 不加载 Tracker、不创建安装分析 ID、不发送 |
| `granted` | 加载 Tracker 或启用队列，只发当前 Policy Version 允许的数据 |
| `denied` | 不发送，不影响产品基本功能 |
| `withdrawn` | 立即停止、清空队列、删除本地分析 ID 和本产品保存的分析状态 |

`disable()` 必须是本地立即生效操作，不能依赖 Umami 服务可达。重新同意后，Desktop/CLI 应生成新的安装分析 ID。

## 6. 网站接入 Web Tracker

### 6.1 推荐：同意后动态加载

不要在 HTML 初始内容中无条件加载 Tracker。创建 SDK 实例时保持 `unknown`；只有用户同意后才加载脚本：

```ts
import { createWebAnalytics } from '@pystone/analytics/web';

export const analytics = createWebAnalytics({
  endpoint: 'https://umami.pystone.net',
  websiteId: '<PRODUCTION_WEBSITE_ID>',
  hostname: 'www.example.com',
  product: 'my-product',
  environment: 'production',
  surface: 'web',
  productVersion: '1.2.0',
  initialConsent: 'unknown',
  domains: ['example.com', 'www.example.com'],
  performance: true,
  allowUtm: true,
});

// Consent UI 确认后调用；此前不会加载 Tracker 或发送请求。
analytics.setConsent('granted');
```

SDK 会配置 Tracker 的 `domains`、DNT、Query/Fragment 清洗和 `beforeSend` 二次过滤。默认 `allowUtm=false` 会阻止整个 Query 入库；需要 Campaign 分析时只保留五个标准 UTM 字段。不要为了 UTM 保存任意 Query，因为其中经常出现 Token、Email、搜索词和业务 ID。

### 6.2 静态 HTML 最小接入

仅当页面加载前已经获得有效同意时使用：

```html
<script
  defer
  src="https://umami.pystone.net/script.js"
  data-website-id="<WEBSITE_ID>"
  data-host-url="https://umami.pystone.net"
  data-domains="example.com,www.example.com"
  data-exclude-search="true"
  data-exclude-hash="true"
  data-do-not-track="true"
  data-performance="true">
</script>
```

中国大陆产品把两个 `umami.pystone.net` 地址替换为 `umami-cn.pystone.net`。

### 6.3 Pageview 与 SPA

Tracker 默认在首次加载及常见 SPA 路由变化时记录 Pageview。需要完全手动控制时设置：

```html
data-auto-track="false"
```

然后在路由完成、标题更新且 Consent 为 `granted` 后调用：

```ts
analytics.page({
  path: window.location.pathname,
  title: document.title,
});
```

不要发送 `location.href`，也不要把 Token、Email、订单号或用户 ID 放进 URL Path。

Next.js 应在客户端组件中加载脚本，并在 Consent 确认后启用。不要在服务端渲染阶段访问 `window.umami`。

## 7. Web 事件调用

### 7.1 JavaScript 事件

```ts
analytics.track('download_clicked', {
  artifact_type: 'windows_installer',
  channel: 'homepage',
});
```

事件名使用小写 `snake_case`，描述已经发生的事实。SDK 使用比 Umami 服务端更严格的本地上限和字段 allowlist，并自动注入公共上下文。调用同步返回，不要 `await`。

### 7.2 HTML 声明式事件

简单点击可用 `data-umami-event`：

```html
<button
  data-umami-event="download_clicked"
  data-umami-event-artifact_type="windows_installer"
  data-umami-event-channel="homepage">
  下载 Windows 版
</button>
```

声明式附加属性都会保存为字符串，也不容易统一注入 Schema 与隐私过滤。只建议用于少量固定枚举；动态值、数字、布尔值和重要转化使用 Adapter/JavaScript。

### 7.3 常用网站事件

| 事件 | 必要属性 | 决策用途 |
| --- | --- | --- |
| `outbound_link_clicked` | `target_domain`, `link_category` | 外链价值 |
| `download_clicked` | `artifact_type`, `channel` | 下载转化 |
| `signup_started` | `entry_point` | 注册漏斗起点 |
| `signup_completed` | `method_category` | 注册转化 |
| `contact_requested` | `contact_type` | 线索转化 |

不要自动采集所有 Click、Input、DOM 文本。事件必须先对应一个分析问题和产品决策。

## 8. Identify、Distinct ID 与 Session Properties

### 8.1 登录用户

可信后端按产品派生伪名 ID：

```text
subject_id = Base64URL(HMAC-SHA256(product_key, internal_user_id))
```

Node.js 可信后端使用 SDK 身份工具和至少 32 字节的产品独立 Key：

```ts
import { deriveUserSubjectId } from '@pystone/analytics/node';

export function analyticsSubjectId(productKey: Buffer, internalUserId: string) {
  return deriveUserSubjectId(productKey, internalUserId);
}
```

SHA-256 的无 Padding Base64URL 结果为 43 字符，满足 Distinct ID 最长 50 字符的限制。浏览器只接收派生后的 ID：

```ts
analytics.identify('<PSEUDONYMOUS_ID>', {
  plan: 'free',
  role_category: 'owner',
  channel: 'organic',
});
```

Umami 会把同一 Website 内相同 Distinct ID 的多个 Session 展示到关联时间线，但不会把这些 Session 合并成一个 Session，也不会跨 Website 自动建立统一画像。

官方接口技术上允许任意 Session Data；本工程明确禁止发送 Email、姓名、手机号和裸数据库 ID。

### 8.2 安装级身份

Desktop、插件和 CLI 在 Consent `granted` 后首次运行生成高熵随机 `installation_id`，原值只留在本机：

```text
subject_id = Base64URL(SHA-256(product_scope || installation_id))
```

不同产品使用不同 `product_scope`。重装、清除配置或撤回同意后会产生新 ID，因此安装分析身份不等于绝对设备数或自然人数。

### 8.3 退出和切换账户

浏览器 Tracker 没有文档化的 `logout()` 或 `resetIdentity()`。登录后，当前页面生命周期内后续事件会继续附加该身份。因此：

- 退出后停止发送账户事件；
- 清空产品 Adapter 中保存的账户 ID 和待发队列；
- 网站在退出完成后进行整页重载，再按 Consent 状态重新初始化 Tracker；
- Desktop/CLI 切回新的安装级身份；
- Node/.NET/Python SDK 在已识别 Subject 切换或 Consent 撤回时会丢弃旧身份的待发队列并清除 `x-umami-cache`；Web Tracker 的内部缓存必须通过整页重载重建；
- 上线前实测“账户 A → 退出 → 账户 B”和多设备场景；
- 对身份隔离要求极高的共享设备场景，应评估不在浏览器端调用 Identify，仅由可信后端发送账户级事实。

## 9. Node.js 后端接入

默认使用本工程 SDK；它比直接调用官方 Node Client 多了统一 Schema、隐私检查、Consent 和后台队列。先在根工程固定 commit 上构建，再把版本化制品放入产品自己的私有依赖源或制品目录：

```powershell
.\tools\build-sdk.ps1
npm install <PATH_TO_ARTIFACTS>\pystone-analytics-0.1.0.tgz
```

初始化一次，业务路径不 `await track()`：

```ts
import { createNodeAnalytics } from '@pystone/analytics/node';

const analytics = createNodeAnalytics({
  endpoint: process.env.UMAMI_ENDPOINT!,
  websiteId: process.env.UMAMI_WEBSITE_ID!,
  hostname: 'api.my-product.invalid',
  product: 'my-product',
  environment: 'production',
  surface: 'backend',
  productVersion: '1.2.0',
  userAgent: 'MyProduct/1.2.0 PystoneAnalytics/0.1.0',
  initialConsent: 'granted',
});
```

发送产品事件：

```ts
analytics.track('operation_completed', {
  feature: 'agent_run',
  result: 'success',
  duration_bucket: '10_30s',
});
```

支付、订阅、退款、许可证激活等事实必须由可信后端在业务数据库确认后发送。Analytics 失败不能回滚订单，也不能作为权益判断依据。

当前 SDK Client 持有单一 Subject。多用户后端不得在共享 Client 上交替调用 `identify()`；账户级事件应进入不阻塞业务请求的后台任务，并按 Subject 使用隔离 Client。完整实现边界见 [`integration-guide.md`](integration-guide.md) 的“多用户后端身份隔离”。

## 10. 通用 HTTP API

通用 HTTP API 是不支持本工程 SDK 的语言、协议排障和可信服务端的后备入口。正式产品优先使用薄 SDK，不要复制下面的 Payload 拼装代码：

```http
POST /api/send
Content-Type: application/json
User-Agent: MyProduct/1.2.0 Analytics/0.1.0
```

完整事件示例：

```json
{
  "type": "event",
  "payload": {
    "website": "<WEBSITE_ID>",
    "hostname": "desktop.my-product.invalid",
    "url": "/events/operation",
    "name": "operation_completed",
    "id": "<PSEUDONYMOUS_SUBJECT_ID>",
    "data": {
      "event_version": 1,
      "product": "my-product",
      "environment": "production",
      "surface": "desktop",
      "product_version": "1.2.0",
      "sdk_version": "0.1.0",
      "platform": "windows",
      "architecture": "x64",
      "feature": "agent_run",
      "result": "success",
      "duration_bucket": "10_30s",
      "consent_state": "granted",
      "policy_version": 1
    }
  }
}
```

规则：

- 请求必须带有效 `User-Agent`，否则不会正常登记；
- `/api/send` 不需要认证 Token，Website ID 不是 Secret；
- `type` 可为 `event`、`identify` 或 `performance`；
- `name` 存在时是自定义事件，不存在时是 Pageview；非 Web 产品采用 Event-first，不伪造 Pageview；
- 离线补发可用 `payload.timestamp` 传 Unix 秒，但不要无限期回灌过期事件；
- 响应中的 `cache` 可在同一客户端运行 Session 的后续请求中通过 `x-umami-cache` 传回；不要跨用户或长期持久化该值。

Identify 的 HTTP 形式：

```json
{
  "type": "identify",
  "payload": {
    "website": "<WEBSITE_ID>",
    "id": "<PSEUDONYMOUS_SUBJECT_ID>",
    "data": {
      "plan": "free",
      "role_category": "owner",
      "channel": "organic"
    }
  }
}
```

### 10.1 批量发送

`POST /api/batch` 的 Body 是 `/api/send` 对象数组：

```json
[
  {
    "type": "event",
    "payload": {
      "website": "<WEBSITE_ID>",
      "hostname": "cli.my-product.invalid",
      "url": "/events/start",
      "name": "operation_started"
    }
  },
  {
    "type": "event",
    "payload": {
      "website": "<WEBSITE_ID>",
      "hostname": "cli.my-product.invalid",
      "url": "/events/complete",
      "name": "operation_completed"
    }
  }
]
```

建议每批 10–50 个，并同时满足入口服务的 Body 上限。检查响应中的 `processed`、`errors` 和 `details`。当前薄 SDK 对 HTTP 200 中的部分失败记录受控诊断并丢弃失败项，不重试整个批次，以免重复已成功事件；4xx Schema 错误也不重试。

## 11. OpenCode 插件和 Bun

插件优先试用 `@pystone/analytics/node`；它只依赖运行时内置的 `fetch`、Web Crypto/Node Crypto 和计时器。每次 OpenCode/Bun 升级都在 Staging 做加载、断网和退出测试。业务 Hook 只同步入队：

```ts
import { createNodeAnalytics } from '@pystone/analytics/node';

const analytics = createNodeAnalytics({
  endpoint,
  websiteId,
  hostname: 'opencode.my-plugin.invalid',
  product: 'my-plugin',
  environment,
  surface: 'opencode_plugin',
  productVersion: pluginVersion,
  userAgent: `MyPlugin/${pluginVersion} PystoneAnalytics/0.1.0`,
});

analytics.setConsent('granted');
analytics.identify(pseudonymousInstallationId);
analytics.track('feature_used', { feature: 'command_run' });
```

如果目标 Bun 版本未通过兼容测试，使用第 10 节 HTTP 协议实现同样的有界后台队列；不得在 Hook 中直接 `await fetch()`。

只记录插件加载、命令类别、Hook 类别、功能、结果、版本和耗时区间。禁止发送 Prompt、模型回复、代码、路径、项目名、终端命令和 Tool 参数。高频 Hook 应按 Session 汇总、采样或只记录最终结果。

## 12. Windows Desktop (.NET)

```csharp
using Pystone.Analytics;

await using var analytics = new AnalyticsClient(new AnalyticsOptions
{
    Endpoint = new Uri(endpoint),
    WebsiteId = Guid.Parse(websiteId),
    Hostname = "desktop.my-product.invalid",
    Product = "my-product",
    Environment = "production",
    Surface = "desktop",
    ProductVersion = "1.2.0",
    UserAgent = "MyProduct/1.2.0 PystoneAnalytics/0.1.0",
    PersistentQueuePath = Path.Combine(productPrivateDataDirectory, "analytics-queue.json"),
});

analytics.SetConsent(ConsentState.Granted);
analytics.Identify(pseudonymousSubjectId);
analytics.Track("feature_used", new Dictionary<string, object?>
{
    ["feature"] = "workspace_create",
});
```

本工程 .NET SDK 已实现：

- 单独的后台 Task，不阻塞启动和 UI；
- 内存队列和有容量上限的本地 Buffer；
- 指数退避加随机抖动；
- 最大尝试次数、最大事件年龄和超限丢弃；
- 应用关闭时可用带截止时间的 `FlushAsync()`，超时后直接退出；
- 本地 `disable()`；远程关闭由宿主读取自己的受信配置后调用它；
- `denied/withdrawn` 时立即清 SDK 队列；宿主同时删除自己保存的安装分析 ID。

## 13. Python CLI / Agent

```python
from pystone_analytics import AnalyticsClient, AnalyticsConfig, ConsentState

analytics = AnalyticsClient(AnalyticsConfig(
    endpoint=endpoint,
    website_id=website_id,
    hostname="cli.my-product.invalid",
    product="my-cli",
    environment="production",
    surface="cli",
    product_version="1.2.0",
    user_agent="MyCli/1.2.0 PystoneAnalytics/0.1.0",
    initial_consent=ConsentState.GRANTED,
    persistent_queue_path=product_private_data_dir / "analytics-queue.json",
))
analytics.identify(pseudonymous_subject_id)
analytics.track("operation_completed", {
    "feature": "scan",
    "result": "success",
    "duration_bucket": "1_3s",
})
```

CLI 默认不因为 Analytics 等待网络。守护线程批量发送；受控退出时调用 `close()`，默认 Transport 的每次网络请求受短超时限制。操作主路径不要调用 `flush()`。

## 14. 后台分析功能如何使用

只有先采对数据，后台功能才有意义：

| Umami 功能 | 所需数据 | 使用方法 | 适合回答 |
| --- | --- | --- | --- |
| Overview | Pageview 或 Event | 打开 Website，选择日期并用过滤器细分 | 流量、来源、页面、设备、地区、版本 |
| Realtime | 新鲜 Pageview/Event | Website → Realtime | 部署后事件是否立刻到达 |
| Events | 有 `name` 的事件 | Website → Events，查看 Properties | 功能次数、用户数、结果分布 |
| Sessions | 默认 Session；可选 Distinct ID/Identify | Website → Sessions / Properties | 单次访问、伪名用户时间线、计划或渠道分群 |
| Goals | 指定页面或事件 | Reports → Goals → Add Goal | 日期范围内目标用户占比 |
| Funnels | 至少两个有序页面/事件 | Reports → Funnels → Add Funnel，设置步骤间 Window | 转化和逐步流失 |
| Journeys | Pageview/Event 路径 | Reports → Journeys，设置 3–7 步及可选起终点 | 用户常走路径和中途去向 |
| Retention | 可稳定识别的回访者 | Reports → Retention，选择月份 | 首次访问 Cohort 的按日回访 |
| UTM | 入口 URL 中受控 UTM 参数 | Reports → UTM | Campaign/Source/Medium 效果 |
| Revenue | Event Data 中的 `revenue`、`currency` | Reports → Revenue，选择货币 | 收入、订单与来源 |
| Attribution | 转化页面/事件及历史来源/UTM | Reports → Attribution，选择 First/Last Click | 哪个渠道带来转化 |
| Performance | Web Tracker `data-performance=true` | Website → Performance，查看 p50/p75/p95 | LCP/INP/CLS/FCP/TTFB |
| Tags | Tracker 的 `data-tag` | Overview 中按 Tag 过滤 | A/B 版本或事件分组 |
| Boards | 已有 Website/Goal/Funnel/Revenue 等 | Boards → Add Board → Design | 组合业务看板 |

### 14.1 Goal

Goal 选择一个 **Viewed page** 或 **Triggered event**。例如：

```text
Goal: 官网下载转化
Action: Triggered event
Condition: download_clicked
```

Goal 的分母是所选日期范围内的用户，不等同于“进入某个漏斗起点的人”。需要明确起点时使用 Funnel。

### 14.2 Funnel

示例一：网站获客漏斗。

```text
Viewed page: /pricing
Triggered event: download_clicked
Triggered event: signup_completed
```

示例二：产品激活漏斗。

```text
product_started
operation_started
product_activated
```

步骤必须按顺序发生；用户可以在步骤之间访问其他页面或触发其他事件。Window 是相邻步骤允许的最长分钟数，应按真实用户行为设置，不要为了得到好看的数字随意放宽。

### 14.3 Journey

Journey 用于探索用户路径，不要求预先规定每个中间步骤。设置 3–7 步，可选起点或终点，例如固定终点 `signup_completed`，查看用户此前常见页面和事件。

### 14.4 Retention

Umami 原生 Retention 按“首次访问日”建立 Cohort，并观察之后每日是否返回。它不是可自由选择 `activation_event` 的高级 Cohort 引擎。

因此：

- 网站可用它观察访客回访；
- Event-first 产品的首次有效事件会形成首次访问，但应保证 `product_started` 不是唯一活跃定义；
- 要严格计算“激活后的 D1/D7/D30”时，使用 Umami API/导出数据按 Distinct ID 和事件时间计算，并在指标说明中写明身份范围与窗口。

### 14.5 Revenue

Revenue 事件必须包含数值 `revenue` 和 ISO 4217 `currency`：

```ts
backendAnalytics.track('purchase_completed', {
  revenue: 19.99,
  currency: 'USD',
  sku: 'pro_monthly',
  transaction_id: '<PSEUDONYMOUS_TRANSACTION_ID>',
});
```

正式付款完成事件应由支付回调后的可信后端发送。Umami 用于行为与归因分析，账务金额仍以产品数据库和支付平台为准。

### 14.6 Performance

Performance 只适用于真实网页体验。在取得 Consent 后启用 `data-performance="true"`，后台查看 LCP、INP、CLS、FCP、TTFB 及 p50/p75/p95。Desktop/CLI 不要伪造 Web Vitals。

### 14.7 Board

1. 左侧进入 **Boards**，点击 **Add board**。
2. 填写名称、说明和类型。单产品看板选 Website；跨产品经营概览可选 Mixed。
3. 保存后进入 **Design**。
4. 添加 Row/Column，再添加 Metrics、Visitors、Events、Goal、Funnel、UTM、Revenue、Realtime 等组件。
5. 保存并用统一日期范围验证组件口径。

建议每个产品至少建立：

- Acquisition：来源、Landing、下载/注册 Goal；
- Activation：新安装、激活 Funnel、Activation Rate；
- Engagement：DAU/MAU、Feature Adoption、Meaningful Active Events；
- Reliability：Completed/Failed、Error Category、Duration Bucket；
- Version Health：版本分布、激活率、成功率和留存。

不要公开分享包含产品内部行为、收入或伪名用户维度的 Board。

### 14.8 Links 与 Pixels（按需）

- **Links**：左侧进入 Links → Add link，填写目标地址后使用 Umami 生成的 `/l/...` 跳转链接，适合营销活动、社交媒体和邮件链接点击统计。
- **Pixels**：左侧进入 Pixels → Add pixel，把生成的像素代码用于不支持 JavaScript 的页面或邮件打开统计。

这两项会引入额外的重定向或邮件追踪。只有在隐私政策、Consent、邮件合规和业务价值明确后启用；产品内部功能事件仍使用 Website Event，不用 Link/Pixel 代替。

### 14.9 查询 API 与跨区域汇总

内部报表服务可用管理登录获得的 Bearer Token 查询：

```http
GET /api/websites/<WEBSITE_ID>/stats?startAt=<UNIX_MS>&endAt=<UNIX_MS>
Authorization: Bearer <ADMIN_TOKEN>
```

常用查询还包括 `pageviews`、`events/series`、`metrics` 和 `metrics/expanded`。查询时间参数是 Unix **毫秒**，而采集 Payload 的 `timestamp` 是 Unix **秒**，不要混用。

跨区域报表必须分别请求中国大陆和海外实例，再按相同指标口径汇总。管理员 Token 只放在可信报表服务；浏览器、Desktop、CLI 和插件不能获得它。统计 API 的结果适合分析和展示，不替代订单、订阅、许可证等业务数据库事实。

## 15. 推荐事件字典

| 事件 | 关键属性 | 发送方 |
| --- | --- | --- |
| `product_started` | `product_version`, `platform` | 客户端 |
| `product_activated` | `activation_type` | 客户端或可信后端 |
| `user_logged_in` | `method_category` | 客户端；成功事实可由后端 |
| `feature_used` | `feature` | 客户端 |
| `operation_started` | `feature` | 客户端 |
| `operation_completed` | `feature`, `duration_bucket` | 客户端或后端 |
| `operation_failed` | `feature`, `error_category` | 客户端或后端 |
| `update_installed` | `from_version`, `to_version` | 客户端 |
| `feedback_submitted` | `feedback_type` | 客户端；不含正文 |
| `subscription_started` | `plan`, `revenue`, `currency` | 可信后端 |
| `refund_completed` | `plan`, `revenue`, `currency` | 可信后端 |
| `license_activated` | `license_category` | 可信后端 |

错误只发送稳定的 `error_code` 或 `error_category`。时长优先使用 `under_1s`、`1_3s`、`3_10s`、`10_30s`、`over_30s` 等区间，避免高基数和敏感细节。

## 16. 功能采用率和成功率的事件组合

每个产品必须定义：

```yaml
activation_event: product_activated
meaningful_active_events:
  - feature_used
  - operation_completed
conversion_events:
  - download_clicked
  - signup_completed
  - subscription_started
```

指标示例：

```text
Activation Rate = 窗口内触发 product_activated 的新安装 / New Installations
Feature Adoption = 触发目标 feature_used 的活跃 Subject / Meaningful Active Subjects
Operation Success Rate = Completed / (Completed + Failed)
```

`Cancelled` 单独统计，不能合并到 Failed。仅打开产品的 `product_started` 不等于完成有价值行为。

## 17. 隐私和禁止数据

### 默认允许

```text
产品、版本、平台、架构、语言、粗粒度地区
功能类别、结果、错误类别、计数、布尔值、时长区间
规范化页面路径、来源域名、受控 UTM
订阅档位、货币、金额区间或已确认金额
```

### 永久禁止

```text
Prompt、模型回复、聊天内容和用户自由文本
源代码、文件内容、文件名和完整路径
终端命令、Tool 参数和环境变量
API Key、Token、Cookie、密码和 Authorization Header
Email、手机号、姓名和精确地址
剪贴板、屏幕内容和文档正文
异常堆栈、原始日志和 HTTP 请求体
精确地理位置和敏感个人特征
```

当前 Umami 版本具备 Session Replay 和 Heatmap 配置，但本工程默认禁用。Replay 会涉及屏幕/DOM 内容，违反当前禁采边界；Heatmap 也必须先完成单独的隐私、采样、选择器和 Consent 评审，不能为了“功能完整”直接开启。

## 18. 上线验收：合成用户完整走一遍

先在 Staging Website 执行：

1. Consent 为 `unknown`，确认没有 `/script.js`、`/api/send` 或 `/api/batch` 请求。
2. 切换为 `granted`，确认 Tracker 加载且 Realtime 出现 Pageview/Event。
3. 依次触发：

   ```text
   landing page
   download_clicked
   product_started
   product_activated
   feature_used
   operation_started
   operation_completed
   ```

4. 登录后 Identify，确认 Sessions 中可见伪名 Distinct ID 和允许的 Properties。
5. 退出并切换测试账户，确认不会继续附加上一账户 ID。
6. 建立下载 Goal 和激活 Funnel，确认顺序、人数和时间窗口符合预期。
7. 次日用同一测试安装 ID 发送 Meaningful Active Event，检查 Retention 口径。
8. 模拟超时、429、5xx 和断网，确认产品功能、UI 和 Exit Code 不受影响。
9. 撤回 Consent，确认立即停止、清队列并删除本地安装分析 ID。
10. 抽样检查 Event Data、URL、日志和请求 Header 中没有禁止字段。

通过 Staging 后替换为 Production Website ID，只做少量固定合成事件，再开放真实流量。

## 19. 常见故障排查

### Tracker 没有请求

依次检查：

1. Consent 是否为 `granted`；
2. 浏览器开发者工具 Network 中 `script.js` 是否成功；
3. 广告拦截器或浏览器隐私扩展是否拦截；
4. `data-domains` 是否包含当前 `window.location.hostname`；
5. `data-do-not-track` 是否因浏览器 DNT 停止；
6. `data-before-send` 是否返回了 `false`；
7. Endpoint 与 Website ID 是否属于同一个区域实例。

### `/api/send` 返回成功但后台没有普通事件

- 检查 `User-Agent` 是否有效且未被 Bot 检测过滤；
- 检查 `type` 是否为 `event`；
- 检查 `payload.name` 是否存在；没有 `name` 会按 Pageview 处理；
- 检查后台日期范围、时区、过滤器和 Website；
- 检查 Production/Staging 是否用反；
- 在 Realtime 后再到 Events 查看，允许后台查询有短暂延迟。

### 4xx

视为配置或 Schema 错误，不无限重试。重点检查 Website UUID、事件名、URL、属性数量/长度和 JSON 类型。

### 429 或 5xx

使用指数退避和随机抖动有限重试；达到最大次数或最大年龄后丢弃。不要跨区回退，不阻塞业务主流程。

### 数据重复

SDK 的本地 `event_id` 只用于队列和诊断，不上传到 Umami，也不能假定 Umami 自动去重。队列应使用明确的发送状态并限制重试；关键业务金额和订单仍由业务数据库去重和核算。

## 20. 官方资料

- [添加 Website](https://docs.umami.is/docs/add-a-website)
- [收集数据](https://docs.umami.is/docs/collect-data)
- [Tracker 配置](https://docs.umami.is/docs/tracker-configuration)
- [Tracker Functions](https://docs.umami.is/docs/tracker-functions)
- [Track Events](https://docs.umami.is/docs/track-events)
- [Distinct IDs](https://docs.umami.is/docs/distinct-ids)
- [登录用户识别](https://docs.umami.is/docs/guides/identify-logged-in-users)
- [Sending Stats API](https://docs.umami.is/docs/api/sending-stats)
- [Node Client](https://docs.umami.is/docs/api/node-client)
- [后端事件](https://docs.umami.is/docs/guides/send-server-side-events)
- [Sessions](https://docs.umami.is/docs/sessions)
- [Goals](https://docs.umami.is/docs/goals)
- [Funnel](https://docs.umami.is/docs/funnel)
- [Journey](https://docs.umami.is/docs/journey)
- [Retention](https://docs.umami.is/docs/retention)
- [Revenue](https://docs.umami.is/docs/revenue)
- [Attribution](https://docs.umami.is/docs/attribution)
- [Performance](https://docs.umami.is/docs/performance)
- [Boards](https://docs.umami.is/docs/using-boards)
- [Links](https://docs.umami.is/docs/links)
- [Pixels](https://docs.umami.is/docs/pixels)
- [Website Statistics API](https://docs.umami.is/docs/api/website-stats)

更严格的事件、身份、Consent 和隐私规则见 [`analytics-spec.md`](analytics-spec.md)。Umami 服务部署和升级由宿主基础设施工程负责，不属于 SDK 仓库职责。
