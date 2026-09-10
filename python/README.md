# Python SDK

支持 Python 3.10+，无运行时第三方依赖。普通上报只做本地入队；守护线程负责网络发送。

当前包不在 PyPI 发布。使用 SDK 固定 Tag/Commit 的 `tools/build-sdk.ps1` 生成 wheel，记录 SHA-256，并从产品私有制品目录安装精确版本。

```python
from pathlib import Path
from pystone_analytics import AnalyticsClient, AnalyticsConfig, ConsentState

analytics = AnalyticsClient(AnalyticsConfig(
    endpoint="https://umami.pystone.net",
    website_id="<WEBSITE_ID>",
    hostname="cli.local",
    product="my-product",
    environment="production",
    surface="cli",
    product_version="1.0.0",
    user_agent="MyProduct/1.0.0 UmamiSdk/0.1.1",
    initial_consent=ConsentState.GRANTED,
    # 使用宿主已确定的私有数据目录，不要使用当前工作目录。
    persistent_queue_path=Path(product_private_data_dir) / "analytics-queue.json",
))

analytics.track("operation_completed", {
    "feature": "agent_run",
    "duration_bucket": "10_30s",
})

# 只在受控退出阶段调用；普通命令执行路径不调用 flush()。
analytics.close()
```

`accepted=True` 只表示已通过本地校验并入队，不代表服务端已经接收。进程崩溃、队列超限、事件过期或重试耗尽时允许丢弃。

用户撤回 Consent 时调用 `set_consent(ConsentState.WITHDRAWN)`；宿主同时删除自己的原始安装 ID。

`close()` 是终态且可以重复调用；关闭后调用返回 `disabled`，重新启用必须创建新 Client。初始化配置错误会快速失败；初始化成功后的网络、Umami、持久队列和普通诊断回调故障不会传播到 `track/identify/page`。

## 构建

```powershell
$env:PYTHONPATH='src'
python -m unittest discover -s tests -v
python -m pip wheel . --no-deps
```
