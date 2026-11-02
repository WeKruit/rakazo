> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

> **后端与内容补齐增补**：[后端变更方案](../backend/BACKEND-CHANGE-PROPOSAL.md)、[逐字段数据映射](../backend/DATA-FIELD-MAP.md)、[Profile媒体与图标](PROFILE-ASSETS.md)。Worth Talking优先使用已有评分排序；头像/组织logo复用现有组件，并核对保存、投影与页面接线。

# 组件级 PRD / UIUX 交付入口

本次补充包含 **99 个实测页面状态：Juicebox 44 个，Metix 55 个**。交付对象是这几个功能的复刻规格与设计证据，未修改 Headhunter 产品代码。

## 直接查看

- [可点选组件查看器](inspector.html)：在截图上点击组件，或搜索 E / T 索引，查看原始 x/y/宽高、padding、gap、字号、颜色、边框、圆角、层级与滚动关系。需通过 HTTP 打开；当前本机服务为 <LOCAL_HTTP_SERVER> 。
- [Juicebox 逐页尺寸与样式标注](JUICEBOX-DESIGN-ANNOTATIONS.md)
- [Metix 逐页尺寸与样式标注](METIX-DESIGN-ANNOTATIONS.md)
- [组件互动契约](COMPONENT-INTERACTIONS.md)：展示状态、触发、反馈、关闭、焦点、滚动与数据影响。
- [窗口、页面高度与响应式矩阵](RESPONSIVE-LAYOUT.md)
- [功能 PRD 总入口](../PRD.md) / [精简导航方案](../NAVIGATION-SPEC.md) / [导航演示](../navigation.html)
- 原始全量采样附录：[Juicebox](JUICEBOX-DESIGN-RAW.md)、[Metix](METIX-DESIGN-RAW.md)、[测量索引](manifest.json)。

## 如何把标注用于复刻

1. 从功能 PRD 明确入口、对象、状态和完成条件；从导航方案确定全局与职位作用域。
2. 在逐页标注中找到默认状态和展开状态，按 E 索引到查看器定位实际组件。T 索引给出内部文字与 SVG 的独立样式。
3. 以布局关系、容器约束和滚动责任实现页面；x/y 是该次视口的验收坐标，不能把所有坐标写死。
4. 对照互动契约连接筛选、选择、抽屉、菜单、编辑器、列表详情与排期步骤；数据写入与发送边界独立验收。
5. 在相同 CSS 视口和相同数据状态下核对布局，再检查其他已测视口和短窗口。

## 测量口径与边界

全部长度使用 CSS px，坐标原点是内容视口左上角。innerWidth/innerHeight 是网页可用视口；outerWidth/outerHeight 是浏览器报告的外窗尺寸，不能据此反推真实屏幕或物理设备。截图与 JSON 配对，不把截图缩放后的显示尺寸当设计值。

页面高度分三层：视口高度、document/body 高度、独立容器的 clientHeight/scrollHeight。表格行数、邮件长度和已加载数据会改变内容高度，不能为整类页面定义一个固定总高度。

E 采集结构与语义组件；重复表格每组仅取前四行。T 是文字/SVG 样本，最多 1400 条。它不是源代码的完整组件树。inViewport 只表示矩形与视口相交；中心遮挡是单点检测，不等同于完整可见性。早期状态缺少部分文本或逐边框补充，查看器显示“未采集”。CSS transition 声明不代表该动作动画已实际回放。

为保留原始证据，没有改名覆盖旧截图。索引标注了三个文件名误导项：1023px guard 实际无阻挡、sequence-empty-390 实际新建上下文表单、schedule-step2-390 实际切换宽度后的手机日历。Profile 进入动画帧与稳定帧分别保留，以 stable 状态验收。

未打开的 Business 页面、无数据的非空 Shortlist、未执行的发送/发布/付费操作不作为已验证功能。现有 REA 静态分析为历史资源快照，不能覆盖当前登录态实测结果；其覆盖范围见原始 REA 报告。

## 外部状态记录

为查看邮件编辑器，Metix 的 Continue to emails 自动创建了 **UI inspection draft — Backend Python Engineer sequence** 草稿，0 收件人；未点 Publish，未发送邮件或邀请。其 URL 与实际状态保留在 sequence-editor 的 JSON / AX。该草稿尚未删除。

## 本地打开与检查

从本资料根目录运行 `python3 -m http.server 8768 --bind 127.0.0.1`，打开 `/design-details/inspector.html`。运行 `python3 design-details/verify.py` 检查索引、截图、几何与本地链接。压缩包包含同一套本地资源。
