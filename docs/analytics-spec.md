# 产品分析接入规范

## 1. Adapter 契约

业务代码只调用稳定接口：

```text
track(eventName, properties)
identify(subjectId, properties)
page(properties)
setConsent(state)
flush()
disable()
```

SDK 负责 Schema 校验、公共上下文、身份、Consent、字段 allowlist、敏感内容阻断、批处理、短超时、有限重试、容量上限、过期丢弃和 Umami Payload 映射。`track`、`identify`、`page` 只进行同步的本地校验和内存入队；网络与可选持久化由后台执行。Analytics 不可达时静默降级，不能阻塞或改变业务结果。

队列、重试、响应体和持久文件同时有默认值与不可突破的硬上限。持久队列恢复时必须重新验证 Website、Payload 结构、当前 Schema、身份和隐私策略；损坏或被篡改的数据直接删除，不能因为“来自本机队列”而绕过 allowlist。完整故障模型与测试证据见 [`production-readiness.md`](production-readiness.md)。

Endpoint 与 Website ID 由产品环境注入：国内 ECS 产品使用 `umami-cn.pystone.net`，海外 VPS 产品使用 `umami.pystone.net`。客户端不得在两个区域之间自动故障转移。

建议结构：

```text
umami-sdk/
├── schema/       # 单一事件注册表与隐私策略源
├── typescript/   # Browser 与 Node/OpenCode SDK
├── dotnet/       # Windows Desktop SDK
├── python/       # CLI / Agent SDK
├── tools/        # 多语言策略生成器
└── tests/        # Schema 一致性测试
```

## 2. 统一事件结构

```yaml
event_name: operation_completed
event_version: 1
occurred_at: ISO-8601-UTC
context:
  product: controlled-slug
  environment: production
  surface: desktop
  product_version: 1.2.0
  sdk_version: 0.1.1
  platform: windows
  architecture: x64
  locale: zh-CN
identity:
  scope: installation
  subject_id: pseudonymous-id
consent:
  analytics: granted
  policy_version: 1
properties:
  feature: agent_run
  result: success
  duration_bucket: 10_30s
```

- 时间统一为 UTC。
- SDK 会生成本地 `event_id` 用于队列和诊断，但不上传到 Umami，也不能把它当作服务端去重保证。
- 事件名为小写 `snake_case`，描述已经发生的业务事实。
- 当前 Umami 约束按事件名 50 字符、Event Data 字符串 500 字符、对象 50 个属性执行；Adapter 可以使用更严格上限。
- 属性优先使用枚举、数字、布尔值和区间，不发送自由文本。
- 同名属性不改变含义或单位；语义变化提升 `event_version`。

## 3. Website 与身份

### Website 划分

- 一个独立产品一个 Website；Production 与 Staging 分开。
- 同一产品多个客户端确需原生统一看板时可以共用 Website，并用 `surface` 区分。
- Website 是产品、区域和隐私边界，不简单等于域名或仓库。
- 同一产品在两个 Umami 实例中的 Website ID 必须不同。

### 匿名网站访客

使用 Umami 默认无 Cookie Session，不主动设置长期 Distinct ID。Visitors 用于趋势而非稳定自然人数；匿名留存受网络、设备和隐私环境影响。

### Desktop、插件与 CLI

Consent 获得后生成高熵随机 `installation_id`，原值只保存在本机：

```text
subject_id = SHA-256(product_scope || installation_id)
```

不生成跨产品或跨宿主的全局设备 ID。撤回同意时停止发送、清空队列并删除本地分析 ID。重装或清除配置会产生新 ID，因此安装身份不等于绝对设备或自然人。

### 登录用户

由可信后端按产品派生：

```text
subject_id = HMAC-SHA256(product_key, internal_user_id)
```

HMAC Key 只存在于后端。Distinct ID 控制在 50 字符内；不发送 Email、手机号、姓名或裸数据库主键。登录后 `identify()` 仅附加 `plan`、`role_category`、`channel` 等受控属性；退出或切换账户后不得继承上一用户 ID。

## 4. 客户端规则

### 网站

Umami Web Tracker 负责页面和来源，Adapter 负责下载、注册、联系、付费入口等显式业务事件。不自动采集所有 Click、Input、DOM 或文本；URL 删除 Query、Fragment、Token 和动态标识。

### Windows Desktop

使用 `HttpClient` 调用 `/api/send` 或 `/api/batch`。请求必须携带有效 `User-Agent`。事件进入有界队列后台发送，短超时、指数退避加随机抖动，超过保留期限丢弃；失败不弹窗、不阻塞启动。

### OpenCode、CLI 与 Agent

优先使用运行时原生 `fetch()` 或目标语言 HTTP Client。`@umami/node` 仅在运行时兼容性验证后使用。高频 Hook 按 Session 汇总、采样或只记录结果。不得采集 Prompt、模型回复、代码、路径、项目名、命令或 Tool 参数。

### 后端

支付、订阅、退款、许可证和后台业务完成状态由可信后端确认后发送。Analytics 不能作为订单、权益或许可证判断依据，也不能复制业务数据库整行。

## 5. 事件注册表

基础事件：

| 事件 | 关键属性 | 用途 |
| --- | --- | --- |
| `product_started` | `product_version`, `platform` | 活跃与版本分布 |
| `product_activated` | `activation_type` | 首次价值达成 |
| `user_logged_in` | `method_category` | 登录采用 |
| `feature_used` | `feature` | 功能采用 |
| `operation_started` | `feature` | 操作漏斗起点 |
| `operation_completed` | `feature`, `duration_bucket` | 成功采用 |
| `operation_failed` | `feature`, `error_category` | 失败率 |
| `update_installed` | `from_version`, `to_version` | 版本迁移 |
| `feedback_submitted` | `feedback_type` | 反馈采用 |

网站补充事件：`outbound_link_clicked`、`download_clicked`、`signup_started`、`signup_completed`、`contact_requested`。

公共属性：`event_version`、`product`、`environment`、`surface`、`product_version`、`sdk_version`、`platform`、`architecture`、`locale`、`channel`、`consent_state`、`policy_version`。

每个注册项至少记录目的、将支持的决策、身份范围、必选/可选/禁止属性和保留类别。流程为：分析问题 → 指标 → 事件 → 隐私审查 → Staging 合成事件 → Dashboard 验证 → Production。

## 6. 指标口径

每个产品必须定义：

```text
activation_event
meaningful_active_events
conversion_events
```

- Activation Rate：规定窗口内完成激活的安装数 / New Installations。
- DAU/WAU/MAU：发生 meaningful active event 的安装或账户去重数。
- D1/D7/D30 Retention：激活 Cohort 在目标窗口再次有效活跃的比例。
- Feature Adoption：活跃用户中使用目标功能的比例。
- Operation Success Rate：Completed / (Completed + Failed)，Cancelled 单列。
- Version Health：按版本比较激活、成功率、错误类别和留存。

不能仅用 `product_started` 代表有效活跃。跨区域指标不可直接把 Visitors 相加后宣称是全局唯一自然人数。

## 7. 隐私与 Consent

默认允许受控的产品、版本、平台、架构、语言、粗粒度地区、功能枚举、结果、计数、布尔值、时长区间、来源域名、UTM 和规范化路径。

错误只允许 `error_code/error_category`；URL 必须规范化；Workspace、Team、交易 ID 必须按产品伪名化；Revenue 只记录金额、货币、SKU 与伪名交易 ID。

永久禁止：Prompt、模型回复、聊天和用户输入；代码、文件内容、文件名和完整路径；命令、工具参数和环境变量；Key、Token、Cookie、密码与授权 Header；Email、手机号、姓名和精确地址；剪贴板、屏幕或文档正文；异常堆栈、原始日志与请求体；精确位置以及敏感或受保护特征。

客户端执行字段 allowlist 与内容模式双重阻断，入口再次限制 Body 和频率。拒绝事件只记录类别与计数，不记录原值。

Consent 状态：

```text
unknown → granted / denied
granted → withdrawn
denied → granted
```

`unknown` 不发送；`granted` 只发送当前 Policy Version 允许的数据；`denied/withdrawn` 立即停止、清空队列并删除本地身份。不因拒绝非必要 Analytics 禁用基本功能。

## 8. 上线验收

- 合成用户完成访问、下载、安装、激活与再次活跃，Funnel 和 Retention 符合预期。
- Production、Staging、Bot、内部访问和健康检查不污染指标。
- 国内与海外产品只向配置的固定实例发送，不自动跨区回退。
- 拒绝、撤回、退出和账户切换行为正确；抽样事件没有禁止字段。
- Analytics 断网、超时、5xx 时产品继续工作，队列不会无限增长。
- 数据定位、导出、删除、备份和恢复生命周期已演练。
- 每个 Dashboard 标注指标定义、身份范围、区域、时间窗口和限制。
