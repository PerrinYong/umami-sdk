# Analytics Schema

`event-registry.json` 和 `privacy-policy.json` 是所有语言 SDK 的唯一策略真源。

修改流程：

1. 修改 JSON；
2. 在 SDK 根目录运行 `python tools/generate_policy.py`；
3. 运行 `python tools/generate_policy.py --check`；
4. 运行全部 SDK 测试；
5. 语义变化时提升事件 `version` 或 `policy_version`。

生成文件不得手工修改。生成器把同一份规范嵌入 TypeScript、Python 和 .NET 包，使已发布包不依赖仓库外部文件。
