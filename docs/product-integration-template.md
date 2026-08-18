# 产品 Analytics 接入记录模板

> 将本文件复制到产品仓库的 `docs/analytics.md`，由负责接入的研发 Agent 填写。不得记录密码、管理 Token、HMAC Key 或其他 Secret。

## 1. 基本信息

```yaml
status: planned                         # planned / staging_verified / production
sdk_version: 0.1.0
schema_version: 1
policy_version: 1
product: <controlled-slug>
environment: <staging|production>
surface: <web|desktop|node|opencode_plugin|cli|agent|backend>
deployment_region: <cn|global>
endpoint: <https://umami-cn.pystone.net|https://umami.pystone.net>
website_name: <product-environment>
website_id_source: <environment-variable-name>
hostname: <logical-hostname>
owner: <team-or-role>
```

Website ID 本身不是 Secret，但本文只记录它的配置来源，避免同一文档被错误复制到另一个环境。

## 2. 指标定义

```yaml
activation_event: product_activated
activation_window: <duration>
meaningful_active_events:
  - feature_used
  - operation_completed
conversion_events:
  - <event>
identity_scope_for_dau: <installation|account>
retention_identity_scope: <installation|account>
retention_window: <D1/D7/D30 definition>
```

## 3. Consent

```yaml
consent_default: unknown
consent_storage: <private-setting-location>
stored_policy_version: 1
grant_entry: <UI/command/API location>
deny_entry: <UI/command/API location>
withdraw_entry: <UI/command/API location>
regrant_behavior: create-new-installation-id
```

说明拒绝或撤回不会影响哪些基本功能：

```text
<description>
```

## 4. 身份

```yaml
anonymous_web: <yes|no>
installation_id_storage: <private-product-data-location|not-applicable>
installation_product_scope: <slug|not-applicable>
account_subject_source: <trusted-backend-endpoint|not-applicable>
logout_behavior: <new-installation-subject/full-page-reload/not-applicable>
account_switch_test: <test-name>
```

确认：

- [ ] 客户端没有 HMAC Key；
- [ ] 不发送 Email、手机号、姓名或裸数据库 ID；
- [ ] 撤回 Consent 会删除宿主持有的安装 ID；
- [ ] 账户切换不会继承旧待发队列或 Session Cache。

## 5. 事件与触发位置

| Event | 真实业务事实 | 代码位置/函数 | 发送方 | 必填属性映射 | 受控枚举 | 决策用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `<event>` | `<fact>` | `<file/function>` | `<client/backend>` | `<mapping>` | `<enum source>` | `<decision>` |

每个事件确认：

- [ ] 事件发生在业务事实完成处，不只是 UI Click；
- [ ] 没有自由文本、原始错误、路径、命令或内容；
- [ ] 属性完全符合中央注册表；
- [ ] 付款、退款、订阅和许可证事实来自可信后端；
- [ ] `cancelled` 与 `failed` 分开；
- [ ] `product_started` 不作为唯一 Meaningful Active Event。

## 6. 枚举

```yaml
feature:
  - <controlled-value>
duration_bucket:
  - under_1s
  - 1_3s
  - 3_10s
  - 10_30s
  - over_30s
error_category:
  - <controlled-value>
channel:
  - <controlled-value>
```

枚举新增或改义必须经过指标和隐私审查，不得直接使用用户输入。

## 7. 生命周期

```yaml
client_creation: <application-singleton-location>
client_shutdown: <controlled-shutdown-location>
flush_deadline: <duration>
persistent_queue: <path-and-reason|disabled>
remote_disable_source: <trusted-product-config|not-applicable>
```

## 8. 自动测试

| 测试 | 文件/名称 | 结果 |
| --- | --- | --- |
| unknown Consent 无网络 | `<test>` | `<pass/fail>` |
| 合法事件入队 | `<test>` | `<pass/fail>` |
| 未注册/未知属性拒绝 | `<test>` | `<pass/fail>` |
| 敏感字段和值拒绝 | `<test>` | `<pass/fail>` |
| 阻塞网络不阻塞业务 | `<test>` | `<pass/fail>` |
| 429/5xx/断网不改变业务结果 | `<test>` | `<pass/fail>` |
| 撤回清理身份与队列 | `<test>` | `<pass/fail>` |
| 账户切换隔离 | `<test>` | `<pass/fail>` |

## 9. Staging 验收

```yaml
verified_at_utc: <timestamp>
website: <staging-website-name>
synthetic_subject: <non-secret-label>
realtime: <pass/fail>
events_and_properties: <pass/fail>
session_identity: <pass/fail>
funnel: <pass/fail>
retention_setup: <pass/fail>
consent_network_check: <pass/fail>
offline_and_slow_network: <pass/fail>
forbidden_field_sample: <pass/fail>
production_isolation: <pass/fail>
```

验收证据只记录结果和必要截图位置，不复制真实事件 Payload 或用户数据。

## 10. 发布结论

```yaml
decision: <approved|blocked>
blockers:
  - <blocker-or-none>
known_limitations:
  - <limitation-or-none>
rollback: <disable-config-or-release-rollback>
```

最终确认：

- [ ] 固定 SDK 制品和版本；
- [ ] Production/Staging Website ID 隔离；
- [ ] 没有 Secret 进入代码、日志、测试或文档；
- [ ] 没有禁止字段进入事件；
- [ ] Analytics 失败不影响产品；
- [ ] 隐私政策与关闭入口已更新。
