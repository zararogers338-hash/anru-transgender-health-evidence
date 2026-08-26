# Anru 安若

Anru 是一个基于 Pi Agent Core 的 Windows 跨性别与性别多样化健康循证工作台。它先查询随包 SQLite/FTS5 文献库，再由用户配置的第三方模型进行多步综合和独立事实审计。

## 主要能力

- 来自于Pubmed，Web of science平台的10162篇高质量跨性别保护文章作为基石。
- Crossref 题录与 PubMed 主题检索合并；DOI/PMID 去重，作者、期刊、标识符、来源和采集批次采用关系表保存。
- 离线 FTS5 检索；联网、拖拽附件、聊天记录、思考强度、多步 Agent 和独立医学审计。
- 仅连接用户配置的 OpenAI-compatible 第三方接口，密钥由 Windows `safeStorage` 加密。
- 电脑能力默认关闭；有状态操作均需在应用内逐次批准。

## 数据边界

期刊主页只是来源登记，不进行受限正文批量抓取。构建器优先使用 Crossref 与 PubMed 公共接口，不绕过登录、付费墙或 robots。当前随包数据库是 release-safe 快照：包含 9,873 条题录、10,451 条来源记录，以及 161 篇许可明确的可检索摘要；未确认再分发许可的摘要不会进入安装器。

## 开发

需要 Node.js 22+ 与 Windows 10/11 x64：

```powershell
npm ci
npm test
npm run dev
```

应用启动无需 Python；Python 只在重建文献库时使用。

## 安装器运行要求

- Windows 10/11 x64；Electron、SQLite 与 Pi 运行时已随包提供，不要求另装 Node.js、Python 或浏览器运行时。
- 预留约 650 MiB 磁盘空间。
- 离线检索可直接使用；聊天综合需要用户自己的第三方 OpenAI-compatible API 地址、模型名和密钥，实时核验还需要互联网连接。
- 当前 0.1.0 构建未做商业代码签名，Windows 可能显示未知发布者；请用发布页给出的 SHA-256 校验安装器。

## 重建文献库

```powershell
python scripts/build-transgender-corpus.py --pubmed-max 8000 --crossref-max 1000
```

可设置 `ANRU_CRAWLER_EMAIL` 以便上游接口识别联系信息。安全发行示例：

```powershell
python scripts/build-transgender-corpus.py --pubmed-max 8000 --crossref-max 1000 --release-safe
```

数据文件位于 `resources/anru/data/anru_evidence.db`。完整长版陪伴规范保存在 Skill 参考目录，不会每轮全部注入模型上下文。

已有开发快照可用 `python scripts/make-release-safe-corpus.py <开发数据库> <发行数据库>` 派生公开发行版本；`scripts/audit-corpus.py --require-release-safe` 与安装器分阶段脚本都会拒绝不安全的数据库。

## 打包

```powershell
npm run build
npm run build:installer
```

自定义安装器还需要 `C:\Program Files\7-Zip` 和 Windows 自带的 .NET Framework x64 C# 编译器。

## 医疗声明

Anru 用于文献检索、科研和教学，不替代医生诊断或个体化治疗。不要输入可识别患者身份的信息；高风险症状、自伤或暴力风险应及时转入当地线下医疗或危机支持。
