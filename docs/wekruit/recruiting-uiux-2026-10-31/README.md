# 招聘工作区 PRD、UIUX 与后端变更设计

本PR提供功能、设计和数据契约的可评审基线，用于统一 Sequence、Shortlist、Contacts、Analytics、Interview、Inbox、Profile 和精简导航的实现。它不修改应用代码，不执行数据库迁移、部署、付费研究或外发操作。

## 阅读顺序

1. [PRD](PRD.md)：功能范围、流程、对象、已观察行为与未知项。
2. [Juicebox PRD](JUICEBOX-PRD.md) / [Metix PRD](METIX-PRD.md) / [Metix 验收](METIX-ACCEPTANCE.md)。
3. [精简导航](NAVIGATION-SPEC.md) / [导航演示](navigation.html) / [UIUX 总规格](UIUX-SPEC.md)。
4. [组件级设计入口](design-details/README.md)：99组匿名化几何/样式，桌面、窄屏、手机、短窗口与各种展开状态。
5. [组件查看器](design-details/inspector.html) / [133项互动契约](design-details/COMPONENT-INTERACTIONS.md) / [响应式与页面高度](design-details/RESPONSIVE-LAYOUT.md)。
6. [Profile 媒体规格](design-details/PROFILE-ASSETS.md) / [通用图标](design-details/assets/gallery.html)。
7. [后端变更](backend/BACKEND-CHANGE-PROPOSAL.md) / [字段补齐清单](backend/DATA-FIELD-MAP.md) / **[当前 stage 基线增量](backend/CURRENT-BASELINE-DELTA.md)**。
8. [QA与并行边界](QA-PARALLEL-PLAN.md) / [Claude App实际协调反馈](QA-COORDINATION.md) / [原始证据的公开范围](PRIVATE-EVIDENCE.md)。

## 公开内容与证据性质

本仓库公开。所有私有人名、账户、候选人资料、邮件内容和来源标识均须留在单独的研究包。这里发布全部规格章节、匿名化实测几何/样式与通用UI图标。原始登录态截图和AX不发布；公开布局图由DOM测量生成，**不是截图、不是产品实现、不是业务验收**。

测量保留CSS像素、层级、排版、边框、滚动容器和视口数据；内容槽匿名化。每个状态的manifest保留私有原图哈希供授权评审比对。REA历史静态分析只有部分覆盖，现场测量也不证明未执行的保存/发布/发送操作。

## 本地查看与验证

从本目录启动 `python3 -m http.server 8768 --bind 127.0.0.1`，通过本机HTTP打开 `index.html`。直接用file协议不能读取查看器JSON。

运行 `python3 verify.py` 验证本地链接、状态几何、布局图尺寸、索引一致性、隐私边界与查看器JS语法。该检查是文档/设计证据验证，不代替产品测试和生产数据库验证。
