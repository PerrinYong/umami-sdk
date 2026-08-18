# TypeScript SDK

同一包提供 Browser 与 Node 两个入口，运行时依赖为零。

## Browser

SDK 只会在 Consent 为 `granted` 后加载 Umami Tracker。普通调用同步返回；Tracker 在下一微任务异步执行。

```ts
import { createWebAnalytics } from '@pystone/analytics/web';

const analytics = createWebAnalytics({
  endpoint: 'https://umami.pystone.net',
  websiteId: '<WEBSITE_ID>',
  hostname: 'product.example.com',
  product: 'my-product',
  environment: 'production',
  surface: 'web',
  productVersion: '1.0.0',
  initialConsent: 'unknown',
  domains: ['product.example.com'],
});

analytics.setConsent('granted');
analytics.track('download_clicked', {
  artifact_type: 'windows_x64',
  channel: 'website',
});

// 撤回时立即停发并清空身份与待发事件。
analytics.setConsent('withdrawn');
```

登录后调用 `identify()`，退出后应撤回账户身份并按产品规则建立新的匿名/安装身份。不要把 Email 或裸数据库主键作为 ID。

## Node / OpenCode / 后端

```ts
import { createNodeAnalytics } from '@pystone/analytics/node';

const analytics = createNodeAnalytics({
  endpoint: 'https://umami.pystone.net',
  websiteId: '<WEBSITE_ID>',
  hostname: 'worker.example.com',
  product: 'my-product',
  environment: 'production',
  surface: 'node',
  productVersion: '1.0.0',
  userAgent: 'MyProduct/1.0.0 PystoneAnalytics/0.1.0',
  initialConsent: 'granted',
});

analytics.track('operation_completed', {
  feature: 'agent_run',
  duration_bucket: '10_30s',
});

// 仅在受控关闭阶段尽力刷新，不要在请求/命令热路径 await。
await analytics.close();
```

插件不得采集 Prompt、回复、代码、路径、终端命令或 Tool 参数。付款、退款、订阅和许可证事实只由可信后端发送。

## 构建

```powershell
npm ci
npm test
npm pack --dry-run
```
