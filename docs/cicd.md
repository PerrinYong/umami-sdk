# CI/CD 与 npm 发布

## 发布目标

- npm 包：`@perrin-yong/umami-sdk`
- Registry：`https://registry.npmjs.org/`
- 可见性：public
- 源码仓库：`PerrinYong/umami-sdk`
- 版本：SemVer；npm 已发布版本不可覆盖
- 发布触发：GitHub Release 的 `published` 事件

npm 只分发 Browser/Node TypeScript 包。CI 仍会构建和测试 .NET、Python 制品，确保跨运行时 Schema 与可靠性行为一致；NuGet/PyPI 发布应在出现真实分发需求后分别设计，不能假装 npm 能原生管理 `.nupkg` 或 `.whl`。

## 工作流

### `.github/workflows/ci.yml`

在 Pull Request 和 `main` Push 时执行：

1. 校验 `VERSION`、三语言版本和 npm 发布元数据；
2. 校验事件 Schema、Privacy Policy 和文档链接；
3. 执行 TypeScript 24 项、Python 14 项和 .NET 场景测试；
4. 生成 npm、NuGet、wheel；
5. 在隔离临时目录实际安装三个制品并冒烟；
6. 确认生成器与构建没有留下未提交文件。

CI 只有 `contents: read` 权限，不读取 npm Token，不发布任何包。

### `.github/workflows/npm-release.yml`

只有发布 GitHub Release 时执行：

1. Checkout Release Tag 对应的不可变提交；
2. 验证 Tag 必须等于 `v<VERSION>`；
3. 验证该提交属于 `main`；
4. 重新执行完整测试和制品隔离安装；
5. 拒绝覆盖 npm 上已经存在的版本；
6. 发布已经通过安装测试的 `.tgz`，并生成 provenance；
7. 从 npm Registry 回读并核对版本。

发布 Job 使用 GitHub-hosted Ubuntu、Node 24、npm 11.8.0，并只授予 `contents: read` 与 `id-token: write`。

## Token 配置

首次发布使用 GitHub Repository Secret `NPM_TOKEN`。Token 必须是有权发布 `@perrin-yong` Scope 的 npm Granular Access Token，并允许 CI 发布所需的 2FA 行为。

Token 只从私有文件写入 GitHub Secret，不能写入 `.npmrc`、Workflow、Shell 历史或 Git：

```powershell
Get-Content -Raw <NPM_TOKEN_FILE> |
  gh secret set NPM_TOKEN --repo PerrinYong/umami-sdk

gh secret list --repo PerrinYong/umami-sdk
```

GitHub 只允许查看 Secret 名称，不能回读值。Token 轮换后重复执行同一命令。

## 首次发布

1. 确认 npm 用户拥有 `@perrin-yong` Scope；
2. 确认 `NPM_TOKEN` Secret 已配置；
3. 在本地执行完整验证：

```powershell
python tools/check_version.py
.\tools\build-sdk.ps1
```

4. Push `main` 并等待 CI 通过；
5. 创建与 `VERSION` 一致的 GitHub Release，例如：

```powershell
gh release create v0.1.0 `
  --repo PerrinYong/umami-sdk `
  --target main `
  --generate-notes `
  --verify-tag
```

如果 Tag 尚不存在，移除 `--verify-tag`，由 GitHub 在 `main` 当前提交创建 Tag。发布 Release 是外部不可逆操作，执行前必须确认版本和提交。

6. 查看 Workflow：

```powershell
gh run list --repo PerrinYong/umami-sdk --workflow npm-release.yml
```

7. 验证消费者安装：

```bash
npm view @perrin-yong/umami-sdk@0.1.0 version
npm install @perrin-yong/umami-sdk@0.1.0
```

## 后续版本

每次发布必须同步更新：

- 根目录 `VERSION`；
- `typescript/package.json` 与 `package-lock.json`；
- `python/pyproject.toml`；
- `.NET` 项目版本；
- 三个运行时上报的默认 `sdk_version`；
- 标明当前 SDK 版本的文档。

`python tools/check_version.py` 会阻止核心版本和发布元数据不一致。发布流程：修改版本 → 全量测试 → 合并 `main` → 创建 `vX.Y.Z` Release。不要直接在本机运行 `npm publish`，不要发布移动分支或未经过 Release Tag 固定的工作树。

npm 版本不可覆盖。错误版本应立即停止推广并发布修复版本；是否 deprecate 旧版本需人工判断，不能由 CI 自动 unpublish。

## 迁移到 Trusted Publishing

首次 Token 发布成功后，建议在 npm 包 Settings → Trusted Publisher 配置：

```text
GitHub user: PerrinYong
Repository:  umami-sdk
Workflow:    npm-release.yml
Allowed:     npm publish
```

当前 Workflow 已配置 `id-token: write`，Node/npm 版本也满足 OIDC 要求。Trusted Publisher 生效后，npm CLI 会优先使用短期 OIDC 身份；验证成功后应删除 GitHub 的 `NPM_TOKEN` 并撤销长期发布 Token。

参考：

- [npm：发布 scoped public package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm：Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm：Provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [GitHub：发布 Node.js package](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)
