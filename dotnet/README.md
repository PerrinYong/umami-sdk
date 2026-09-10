# .NET SDK

目标为 .NET 8，无运行时第三方依赖。`Track`、`Identify` 和 `Page` 是同步的本地入队操作；后台 Task 批量调用 Umami。

当前包不在 NuGet.org 发布。使用 SDK 固定 Tag/Commit 的 `tools/build-sdk.ps1` 生成 `.nupkg`，记录 SHA-256，并从产品私有制品目录安装 `Pystone.Analytics` 精确版本。

```csharp
using Pystone.Analytics;

await using var analytics = new AnalyticsClient(new AnalyticsOptions
{
    Endpoint = new Uri("https://umami.pystone.net"),
    WebsiteId = Guid.Parse("<WEBSITE_ID>"),
    Hostname = "desktop.local",
    Product = "my-product",
    Environment = "production",
    Surface = "desktop",
    ProductVersion = "1.0.0",
    UserAgent = "MyProduct/1.0.0 UmamiSdk/0.1.1",
    InitialConsent = ConsentState.Unknown,
    PersistentQueuePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MyProduct", "analytics-queue.json"),
});

analytics.SetConsent(ConsentState.Granted);
analytics.Track("operation_completed", new Dictionary<string, object?>
{
    ["feature"] = "scan",
    ["duration_bucket"] = "1_3s",
});
```

不要对 `Track` 使用 `Task.Run`，SDK 已经完成异步隔离。正常业务路径也不要调用 `FlushAsync`。应用受控退出时，使用带截止时间的 Token 尝试刷新：

```csharp
using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
try { await analytics.FlushAsync(deadline.Token); }
catch (OperationCanceledException) { /* Analytics 可以丢弃。 */ }
```

用户撤回 Consent 时调用 `SetConsent(ConsentState.Withdrawn)`；SDK 会清空队列并删除配置的队列文件，宿主还必须删除自己保存的原始 `installation_id`。

`await using`/`DisposeAsync()` 是终态关闭；关闭后调用返回 `disabled`，重新启用必须创建新 Client。初始化配置错误会快速失败；初始化成功后的网络、Umami、持久队列和诊断回调故障不会传播到 `Track/Identify/Page`。

## 构建

```powershell
dotnet build Pystone.Analytics/Pystone.Analytics.csproj -c Release
dotnet run --project Pystone.Analytics.Tests/Pystone.Analytics.Tests.csproj -c Release
dotnet pack Pystone.Analytics/Pystone.Analytics.csproj -c Release
```
