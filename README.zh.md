# AI Spreadsheet · 中文使用与开发指南

[产品首页](README.md) · [English](README.en.md)

第一次使用？先看[工作台截图、预算改价示例和 120 万格实测](README.md)。配置好文件关联后，双击 `.aib` 就能开始编辑。外部模型和 CLI 可以直接处理同一个 UTF-8 JSON 工作簿。

| 任务 | 入口 |
| --- | --- |
| 打开并编辑预算表 | [快速上手](docs/guide/zh/aib-quickstart.html) |
| 工作台、CLI、npm 测试与打包 | [使用说明](docs/guide/zh/usage.html) |
| 安装、构建与排错 | [安装环境](docs/guide/zh/installation.html) |
| 模块依赖与写盘边界 | [架构](docs/guide/zh/architecture.html) |
| 交给模型的格式和转换指南 | [离线处理指南](skills/aib-workbook/references/zh/aib-offline.md) |

克隆后可直接在浏览器中打开 HTML 文档。

## 从源码运行

源码使用 Node.js 24.x 和 npm。Windows 便携包自带运行环境。

```sh
npm ci
npm run build
npm run aib -- open examples/budget.aib
```

## 与模型协作

```sh
npm run --silent aib -- --offline context examples/budget.aib
npm run --silent aib -- --offline read examples/budget.aib --sheet "预算" --range D5 --calculated
npm run --silent aib -- --offline draft examples/budget.aib --ops examples/change-budget.json
```

示例合计为 **14,100**。把草稿 ID 交给 `diff` 查看单价变动，运行 `draft-validate` 验证，再用 `apply` 应用。重新读取 D5，合计应为 **15,100**。直接写入可带 `batch --expected-hash` 核对版本。工作表 ID、公式、带前导零的编号和日期类型都有明确字段。

**格式** · 支持导入和导出 Microsoft Excel 工作簿（.xlsx、.xls），也支持 CSV 导入、单表 CSV 导出和离线 HTML 导出。转换前请核对损失报告。

**开发** · 完整检查使用 `npm run check`。Windows 浏览器测试使用 Edge，其他平台需先安装 Playwright Chromium。在 Windows 上运行 `npm run release:win`，在 macOS 上运行 `npm run release:mac`，即可生成对应平台的本地 ZIP。

**参与贡献** · 问题和功能建议可通过 Issue 提交。贡献代码时，在自己的 Fork 中从 `main` 创建分支，向本仓库的 `main` 发起 Pull Request，说明行为变化和测试方法。AIB CI 会在 Windows x64 和 macOS arm64 上测试并打包，各平台成功后可在当次 Actions 运行页下载对应的 ZIP。

**许可证** · AIB 自有代码采用 [MIT](LICENSE)。发行包的 `dependencies.json` 按组件索引 `licenses/` 中的第三方声明，Node.js 的声明见 `NODE-LICENSE.txt`。© 2026 AIB contributors.

AIB 是独立项目。Microsoft 和 Excel 是 Microsoft 集团公司的商标。
