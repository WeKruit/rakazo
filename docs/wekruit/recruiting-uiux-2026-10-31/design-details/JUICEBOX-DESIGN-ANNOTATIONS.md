> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Juicebox 设计精确标注

本文件按页面先给开发可直接使用的关键组件尺寸、留白、字体和样式，再说明滚动、窗口高度与实际responsive行为。完整逐节点与文字/SVG采样见 [RAW附录](JUICEBOX-DESIGN-RAW.md)，所有原始数值见 [states](states) 中对应JSON；功能与状态语义见 [PRD](../JUICEBOX-PRD.md)。

## 1. 测量口径

- 单位为CSS px。`x/y/w/h`来自getBoundingClientRect，是视口border box；documentRect只另加window scrollX/Y，不再加内部scrollTop。截图与JSON的window字段为真实采集依据，文件名不是尺寸证明。
- 窗口分inner视口和outer外框；document与body分client尺寸和scroll尺寸；每个内部滚动容器又各有自己的client/scroll/offset。页面“一屏高”不能只看根document。
- `E编号`定位对应JSON的elements[index]；selector、classes、scrollParent、完整computed均保留。下列主表只使用与viewport相交、中心未遮挡、opacity非0、非1px辅助输入的可见候选；单点检测不能证明每个像素都未被祖先clip。
- 控件表字体为size/lineHeight/weight，padding/margin/gap均是computed原值。颜色保留rgb/lab原串，不捏造hex。边框shorthand为空可能代表四边不一致，不可擅自视作无边框。
- 后期状态有boxDetails，只有selector唯一匹配matched=1才用于四边/四角/transition补充。早期没有extras或不唯一的项，四边与四角标明未独立采样。
- 每个row group仅采前4行，最多2000个eligible元素。文本/SVG采样是另一层测量且未提供同等occlusion；RAW明确标记而不称所有样本同时可见。固定窗口模拟与100%页面缩放不是浏览器200%zoom测试，本次没有据它宣称200%原站通过。

## 2. 窗口、页面高度与responsive实测

### 2.1 已验证的尺寸和屏障

Sequence实测1806×1067、1440×900、1024×768；1440×600专门检查编辑器和enrollment矮窗口。小屏768×1024与390×844真实显示整页屏障“Switch to a larger screen to start sourcing.”，不是窄版业务UI。屏障下层DOM虽仍排KPI与列表，当前被遮挡，不把它写成可见mobile设计。

Outreach做了相邻宽度复核：[1000×768](states/juicebox-outreach-width-1000.json)正常显示业务，[999×768](states/juicebox-outreach-width-999.json)显示屏障，屏障zIndex10001。因而这次已在相邻两个整数CSS宽度确认了该路由的1000px显示界限。1023stable正常。名为`juicebox-guard-1023`的早期文件实际是可见Insights内容，不按命名当guard。此界限不自动推广为每个路由的全部CSS断点。

### 2.2 Sequence关键responsive差异

| viewport | 侧栏/主区域 | KPI实际grid | Overview/动作布局 | 表格和页面 |
|---|---|---|---|---|
| [1806×1067](states/juicebox-sequence-1806.json) | 240 / 1566 | 223.656px 223.672px 223.672px 223.656px 223.672px 223.672px; h94 | H1 327 / 78 / 90.08 / 24；中心遮挡=False | 0个采到的scroll容器；可见业务 |
| [1440×900](states/juicebox-sequence-1440.json) | 240 / 1200 | 183.656px 183.672px 183.672px 183.656px 183.672px 183.672px; h94 | H1 264 / 78 / 90.08 / 24；中心遮挡=False | 2个采到的scroll容器；可见业务 |
| [1024×768](states/juicebox-sequence-1024.json) | 240 / 769 | 233.656px 233.672px 233.672px; h198 | H1 264 / 78 / 90.08 / 24；中心遮挡=False | 3个采到的scroll容器；可见业务 |
| [768×1024](states/juicebox-sequence-768.json) | 240 / 513 | 227.5px 227.5px; h302 | H1 264 / 76 / 90.08 / 24；中心遮挡=True | 3个采到的scroll容器；只作为被遮挡底层测量 |
| [390×844](states/juicebox-sequence-390.json) | 240 / 135 | 103px; h758 | H1 256 / 72 / 90.08 / 24；中心遮挡=True | 3个采到的scroll容器；只作为被遮挡底层测量 |

大屏主内容使用居中最大宽1440，内侧padding24；因此1806时业务左起327，1440/1024时左起264。1440宽为六KPI，1024宽为三列两行；768/390底层DOM虽分别两列/一列，因屏障遮挡，不作为原站可操作responsive布局。相邻1000/999的真实截图才是屏障边界证据。

### 2.3 数据动态高度不等于断点

Contacts下滚会加载更多数据：测到内层scrollHeight3207不是999人全部总高度；不同状态table自身高1617/更多值并存，可能是数据加载/虚拟列表结果。不要把scrollHeight变化归因为宽度断点。Shortlist分页40条时高度较稳定；Board的Contacted列7811高来自92人样本，不能硬编码为列样式高度。

## 3. 固定侧栏与主框架

基准width240，内部Main sidebar239，右侧边界另占1。sidebar固定，普通主内容从x240开始。顶部48px header以padding0 16px排breadcrumb；常规列表toolbar56px；多个列表使用底层容器滚动而window scrollY仍0。

侧栏视觉行、字体、hover/图标的每项值可查RAW中对应状态E3–E100。后期Outreach boxDetails唯一命中E3显示右边框1px rgb(229,229,229)，其余三边0；width transition0.3s ease是computed样式记录，不等于已录到整段折叠动画。

## 4. Sequence 总览

[截图（匿名布局图）](diagrams/juicebox-sequence-1440.svg) · [完整JSON](states/juicebox-sequence-1440.json) · [AX](states/juicebox-sequence-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集276/276节点，truncated=False。

**布局与互动**：内容不是全宽铺满大屏：1806时主容器居中示例候选人1440，内部左右24，内容1392；1440时侧栏外可用1200，内部左右24，内容1152。KPI grid gap10，卡高94；Schedule高304，之后留出独立区段再到序列表。表头和body有独立横向scroll容器。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E3 布局节点（语义见匿名化测量） | 0 / 0 / 240 / 900 | 0px | 0px | normal | flex / fixed / 1200 |
| E103 布局节点（语义见匿名化测量） | 240 / 0 / 1200 / 48 | 0px 16px | 0px | 12px | flex / static / auto |
| E109 布局节点（语义见匿名化测量） | 240 / 48 / 1200 / 84 | 24px | 0px | 12px | flex / static / auto |
| E111 布局节点（语义见匿名化测量） | 264 / 78 / 90.08 / 24 | 0px | 0px | normal | block / static / auto |
| E112 布局节点（语义见匿名化测量） | 370.08 / 74 / 126.97 / 32 | 6px 8px 6px 10px | 0px 0px 0px 8px | 8px | flex / static / auto |
| E117 布局节点（语义见匿名化测量） | 1150.86 / 72 / 138.45 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E119 布局节点（语义见匿名化测量） | 1297.31 / 72 / 118.69 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E124 布局节点（语义见匿名化测量） | 264 / 132 / 1152 / 94 | 0px | 0px | 10px | grid / static / auto |
| E125 布局节点（语义见匿名化测量） | 264 / 132 / 183.66 / 94 | 16px | 0px | 8px | flex / static / auto |
| E143 布局节点（语义见匿名化测量） | 264 / 250 / 1152 / 304 | 16px 0px | 0px 0px 4px | 0px | flex / static / auto |
| E144 布局节点（语义见匿名化测量） | 264 / 266 / 1152 / 56 | 8px 24px 16px | 0px | 12px 16px | flex / static / auto |
| E157 布局节点（语义见匿名化测量） | 264 / 582 / 1152 / 145.5 | 24px 0px 0px | 0px | normal | block / sticky / 20 |
| E159 布局节点（语义见匿名化测量） | 281 / 623 / 320 / 36 | 0px | 0px | normal | flex / relative / auto |
| E162 布局节点（语义见匿名化测量） | 306 / 623 / 294 / 36 | 4px 10px 4px 6px | 0px | normal | block / static / auto |
| E163 布局节点（语义见匿名化测量） | 609 / 623 / 134.89 / 36 | 8px 8px 8px 10px | 0px | 8px | flex / static / auto |
| E169 布局节点（语义见匿名化测量） | 751.89 / 623 / 224 / 36 | 0px 10px | 0px | 8px | flex / static / auto |
| E171 布局节点（语义见匿名化测量） | 1318.3 / 633 / 80.7 / 16 | 0px | 0px 0px 0px 334.406px | normal | block / static / auto |
| E172 布局节点（语义见匿名化测量） | 264 / 675 / 1152 / 52.5 | 0px | 0px | normal | block / static / auto |
| E208 布局节点（语义见匿名化测量） | 265 / 727.5 / 1158 / 128 | 0px | 0px | normal | table / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E3 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(23, 23, 23) / rgb(250, 250, 250) | `''` | 0px |
| E103 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E109 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E111 布局节点（语义见匿名化测量） | 20px / 24px / 600 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E112 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E117 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E119 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E124 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E125 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(98.26 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E143 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E144 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 14px 14px 0px 0px |
| E157 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E159 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E162 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E163 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E169 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E171 布局节点（语义见匿名化测量） | 12px / 16px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E172 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E208 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E172 | 264 / 675 / 1152 / 52.5 | 1152×38 | 1160×38 | 0 / 0 | auto / auto |
| S1 E207 | 264 / 727.5 / 1152 / 144 | 1152×129 | 1160×129 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 5. 单 Sequence：统计、Schedule、run列表

[截图（匿名布局图）](diagrams/juicebox-sequence-detail-1440.svg) · [完整JSON](states/juicebox-sequence-detail-1440.json) · [AX](states/juicebox-sequence-detail-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集321/321节点，truncated=False。

**布局与互动**：标题在该宽度换成两行，高48；右侧动作保持36高。七个KPI是role button；run表头区域sticky，body真实布局高3200.5，因此不能以root document900断言页面只有一屏。界面可滚长内容由内部容器承载。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E103 布局节点（语义见匿名化测量） | 240 / 0 / 1200 / 48 | 0px 16px | 0px | 12px | flex / static / auto |
| E112 布局节点（语义见匿名化测量） | 240 / 48 / 1200 / 852 | 0px | 0px | normal | flex / static / auto |
| E114 布局节点（语义见匿名化测量） | 264 / 48 / 1137 / 72 | 24px 0px 0px | 0px 0px 24px | 16px | flex / static / auto |
| E115 布局节点（语义见匿名化测量） | 264 / 72 / 882.69 / 48 | 0px | 0px | normal | block / static / auto |
| E117 布局节点（语义见匿名化测量） | 1162.69 / 78 / 121.16 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E118 布局节点（语义见匿名化测量） | 1291.84 / 78 / 109.16 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E119 布局节点（语义见匿名化测量） | 264 / 144 / 1137 / 93 | 0px 0px 4px | 0px | 10px | flex / static / auto |
| E120 布局节点（语义见匿名化测量） | 264 / 144 / 153.84 / 89 | 16px 24px | 0px | 8px | flex / static / auto |
| E124 布局节点（语义见匿名化测量） | 591.7 / 144 / 153.86 / 89 | 16px 24px | 0px | 8px | flex / static / auto |
| E128 布局节点（语义见匿名化测量） | 919.42 / 144 / 153.86 / 89 | 16px 24px | 0px | 8px | flex / static / auto |
| E134 布局节点（语义见匿名化测量） | 264 / 261 / 1137 / 304 | 16px 0px | 0px 0px 4px | 0px | flex / static / auto |
| E137 布局节点（语义见匿名化测量） | 366.22 / 285 / 121.7 / 32 | 6px 8px 6px 10px | 0px | 8px | flex / static / auto |
| E144 布局节点（语义见匿名化测量） | 288 / 349 / 1089 / 200 | 0px | 0px | normal | flex / static / auto |
| E148 布局节点（语义见匿名化测量） | 264 / 569 / 1137 / 126.5 | 24px 0px 0px | 0px | normal | block / sticky / 20 |
| E150 布局节点（语义见匿名化测量） | 265 / 594 / 1135 / 100.5 | 0px | 0px | normal | table / static / auto |
| E158 布局节点（语义见匿名化测量） | 306 / 608 / 294 / 36 | 4px 10px 4px 6px | 0px | normal | block / static / auto |
| E160 布局节点（语义见匿名化测量） | 609 / 608 / 100.7 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E175 布局节点（语义见匿名化测量） | 265 / 695.5 / 1135 / 3200.5 | 0px | 0px | normal | table / static / auto |
| E189 布局节点（语义见匿名化测量） | 804 / 711.25 / 152 / 32 | 0px 8px | 0px | 4px | inline-flex / static / auto |
| E207 布局节点（语义见匿名化测量） | 1300 / 715.25 / 24 / 24 | 0px | 0px | normal | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E103 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E112 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E114 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E115 布局节点（语义见匿名化测量） | 20px / 24px / 600 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E117 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E118 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E119 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E120 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(98.26 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E124 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(98.26 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E128 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(98.26 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E134 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E137 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E144 布局节点（语义见匿名化测量） | 12px / 16px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E148 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E150 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E158 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E160 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E175 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E189 布局节点（语义见匿名化测量） | 14px / 20px / 400 | oklab(0.145 -0.00000143796 0.00000340492 / 0.85) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E207 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E112 | 240 / 48 / 1200 / 852 | 1185×852 | 1185×3873 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 6. Run 筛选弹层

[截图（匿名布局图）](diagrams/juicebox-run-filter-1440.svg) · [完整JSON](states/juicebox-run-filter-1440.json) · [AX](states/juicebox-run-filter-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集342/342节点，truncated=False。

**布局与互动**：Add filter触发后菜单在按钮下方，menu宽192、高200；此坐标对应截图当前滚动位置，不是全站固定top。菜单层覆盖底层表格，其遮挡底层节点只在RAW中列为occluded。Sequence status/Response status等子菜单的逻辑见PRD。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E148 布局节点（语义见匿名化测量） | 264 / 569 / 1137 / 126.5 | 24px 0px 0px | 0px | normal | block / sticky / 20 |
| E158 布局节点（语义见匿名化测量） | 306 / 608 / 294 / 36 | 4px 10px 4px 6px | 0px | normal | block / static / auto |
| E328 布局节点（语义见匿名化测量） | 609 / 648 / 192 / 200 | 4px | 0px | normal | block / static / 50 |
| E329 布局节点（语义见匿名化测量） | 613 / 652 / 184 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E330 布局节点（语义见匿名化测量） | 773 / 660 / 16 / 16 | 0px | 0px 0px 0px 36.5312px | normal | block / static / auto |
| E331 布局节点（语义见匿名化测量） | 613 / 684 / 184 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E332 布局节点（语义见匿名化测量） | 773 / 692 / 16 / 16 | 0px | 0px 0px 0px 37.5469px | normal | block / static / auto |
| E333 布局节点（语义见匿名化测量） | 613 / 716 / 184 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E334 布局节点（语义见匿名化测量） | 773 / 724 / 16 / 16 | 0px | 0px 0px 0px 83.4688px | normal | block / static / auto |
| E335 布局节点（语义见匿名化测量） | 613 / 748 / 184 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E336 布局节点（语义见匿名化测量） | 773 / 756 / 16 / 16 | 0px | 0px 0px 0px 32.4688px | normal | block / static / auto |
| E337 布局节点（语义见匿名化测量） | 613 / 780 / 184 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E338 布局节点（语义见匿名化测量） | 773 / 788 / 16 / 16 | 0px | 0px 0px 0px 62.8594px | normal | block / static / auto |
| E339 布局节点（语义见匿名化测量） | 613 / 812 / 184 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E340 布局节点（语义见匿名化测量） | 773 / 820 / 16 / 16 | 0px | 0px 0px 0px 82.9531px | normal | block / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E148 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E158 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E328 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E329 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E330 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E331 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E332 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E333 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E334 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E335 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E336 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E337 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E338 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E339 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E340 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E112 | 240 / 48 / 1200 / 852 | 1185×852 | 1185×3873 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 7. Sequence 编辑器：Composer、索引、正文

[截图（匿名布局图）](diagrams/juicebox-editor-1440.svg) · [完整JSON](states/juicebox-editor-1440.json) · [AX](states/juicebox-editor-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集619/619节点，truncated=False。

**布局与互动**：编辑器与viewport四边各24，1392×852；Composer宽373，右区宽1017（边框/分隔另计）。正文画布和聊天各有独立overflow。1024时Composer缩到300；1440×600时外层变1392×552而不是把内容同比缩小。步骤索引在1440下只有88宽，这是当前紧凑布局实测，不能照旧1806截图估250宽。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E324 布局节点（语义见匿名化测量） | 24 / 24 / 1392 / 852 | 0px | 0px | 0px | flex / fixed / 1205 |
| E328 布局节点（语义见匿名化测量） | 24 / 24 / 373 / 852 | 0px | 0px | normal | block / relative / 20 |
| E331 布局节点（语义见匿名化测量） | 24 / 24 / 372 / 64 | 16px 20px | 0px | normal | flex / static / auto |
| E335 布局节点（语义见匿名化测量） | 344 / 40 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E337 布局节点（语义见匿名化测量） | 24 / 88 / 372 / 658 | 0px 24px | 0px | normal | block / static / auto |
| E339 布局节点（语义见匿名化测量） | 36 / 758 / 348 / 106 | 12px | 0px | 12px | flex / static / auto |
| E340 布局节点（语义见匿名化测量） | 49 / 771 / 322 / 36 | 0px | 0px | normal | flex / static / auto |
| E346 布局节点（语义见匿名化测量） | 343 / 821 / 28 / 28 | 0px | 0px | normal | flex / static / auto |
| E348 布局节点（语义见匿名化测量） | 391 / 24 / 12 / 852 | 0px | 0px | normal | block / absolute / 30 |
| E349 布局节点（语义见匿名化测量） | 398 / 25 / 1017 / 101 | 0px | 0px | normal | flex / absolute / 10 |
| E354 布局节点（语义见匿名化测量） | 422 / 51 / 744.77 / 27 | 0px | 0px | normal | block / static / auto |
| E359 布局节点（语义见匿名化测量） | 1334.77 / 51 / 56.23 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E361 布局节点（语义见匿名化测量） | 414 / 126 / 112 / 749 | 16px 12px | 0px | normal | block / relative / auto |
| E364 布局节点（语义见匿名化测量） | 426 / 144 / 88 / 46 | 0px | 0px | normal | block / relative / auto |
| E378 布局节点（语义见匿名化测量） | 426 / 252 / 88 / 32 | 0px 10px | 8px 0px 0px | 4px | inline-flex / static / auto |
| E380 布局节点（语义见匿名化测量） | 510 / 126 / 905 / 749 | 0px | 0px | normal | block / static / auto |
| E387 布局节点（语义见匿名化测量） | 894.06 / 142 / 146.88 / 36 | 6px 16px | 0px | normal | flex / static / auto |
| E389 布局节点（语义见匿名化测量） | 623.5 / 228 / 688 / 968 | 0px 8px 8px | 0px | normal | flex / relative / auto |
| E417 布局节点（语义见匿名化测量） | 713.42 / 339.5 / 482.09 / 24 | 0px | 0px | normal | block / relative / auto |
| E485 布局节点（语义见匿名化测量） | 648.5 / 526 / 638 / 561 | 16px 0px 12px | 0px | normal | block / relative / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E324 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 18px |
| E328 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E331 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E335 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E337 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E339 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid oklab(0.921998 -0.00000908971 0.0000215769 / 0.6)'` | 20px |
| E340 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E346 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid rgba(0, 0, 0, 0)'` | 3.35544e+07px |
| E348 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E349 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E354 布局节点（语义见匿名化测量） | 18px / 27px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E359 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E361 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E364 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E378 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(8.30603 0.618205 -2.16572) / lab(96.1634 0.0993311 -0.364041) | `'1px solid rgba(0, 0, 0, 0)'` | 10px |
| E380 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E387 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 3.35544e+07px |
| E389 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px 16px 16px |
| E417 布局节点（语义见匿名化测量） | 14px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E485 布局节点（语义见匿名化测量） | 13px / 19.5px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`；`Geist, "Geist Fallback", sans-serif`；`Arial, sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E112 | 240 / 48 / 1200 / 852 | 1185×852 | 1185×3873 | 0 / 0 | auto / auto |
| S1 E380 | 510 / 126 / 905 / 749 | 890×749 | 890×1845 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 8. 步骤定时 Popover

[截图（匿名布局图）](diagrams/juicebox-editor-timing-popover-1440.svg) · [完整JSON](states/juicebox-editor-timing-popover-1440.json) · [AX](states/juicebox-editor-timing-popover-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集633/633节点，truncated=False。

**布局与互动**：等待条已滚到y482，再打开popover：x824/y522，288×152，padding16。三行分别Delay、Send at、Timezone；popover与触发条间4px。背景编辑器仍在当前滚动位置；不能把它当第二个全屏dialog。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E512 布局节点（语义见匿名化测量） | 810.02 / 482 / 314.97 / 36 | 6px 16px | 0px | normal | flex / static / auto |
| E520 布局节点（语义见匿名化测量） | 631.5 / 580 / 89.2 / 24 | 2px 8px | 0px | 6px | flex / static / auto |
| E622 布局节点（语义见匿名化测量） | 824 / 522 / 288 / 152 | 16px | 0px | 12px | flex / static / 50 |
| E623 布局节点（语义见匿名化测量） | 840 / 538 / 256 / 32 | 0px | 0px | 12px | flex / static / auto |
| E624 布局节点（语义见匿名化测量） | 956.05 / 538 / 139.95 / 32 | 0px | 0px | 4px | flex / static / auto |
| E625 布局节点（语义见匿名化测量） | 956.05 / 538 / 30.06 / 32 | 0px 10px | 0px | normal | flex / static / auto |
| E626 布局节点（语义见匿名化测量） | 990.11 / 538 / 105.89 / 32 | 0px 10px | 0px | normal | flex / static / auto |
| E627 布局节点（语义见匿名化测量） | 840 / 582 / 256 / 32 | 0px | 0px | 12px | flex / static / auto |
| E628 布局节点（语义见匿名化测量） | 1025.23 / 582 / 70.77 / 32 | 0px 10px | 0px | normal | flex / static / auto |
| E629 布局节点（语义见匿名化测量） | 840 / 626 / 256 / 32 | 0px | 0px | 12px | flex / static / auto |
| E630 布局节点（语义见匿名化测量） | 945.05 / 626 / 150.95 / 32 | 0px 10px | 0px | normal | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E512 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'1px solid lab(90.952 0 -0.0000119209)'` | 3.35544e+07px |
| E520 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(27.036 0 0) / rgba(0, 0, 0, 0) | `'0px solid rgba(0, 0, 0, 0)'` | 8px |
| E622 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E623 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E624 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E625 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E626 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E627 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E628 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E629 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E630 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E112 | 240 / 48 / 1200 / 852 | 1185×852 | 1185×3873 | 0 / 0 | auto / auto |
| S1 E380 | 510 / 126 / 905 / 749 | 890×749 | 890×1845 | 0 / 764 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 9. Email Preview 弹窗

[截图（匿名布局图）](diagrams/juicebox-editor-preview-1440.svg) · [完整JSON](states/juicebox-editor-preview-1440.json) · [AX](states/juicebox-editor-preview-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集644/644节点，truncated=False。

**布局与互动**：Preview是真实850×740的dialog，1440×900中x295/y80；示例候选人-width/示例候选人-height为calc(100% - 32px)。header64，footer131；邮件正文中间独立滚动。footer包含Test email address和Send Test；本次没有测试发信。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E622 布局节点（语义见匿名化测量） | 295 / 80 / 850 / 740 | 0px | 16px | normal | flex / relative / auto |
| E624 布局节点（语义见匿名化测量） | 295 / 80 / 850 / 64 | 16px 24px | 0px | 16px | flex / static / auto |
| E627 布局节点（语义见匿名化测量） | 345 / 100 / 103.84 / 24 | 0px | 0px | normal | block / static / auto |
| E628 布局节点（语义见匿名化测量） | 1089 / 96 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E629 布局节点（语义见匿名化测量） | 1097 / 104 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E630 布局节点（语义见匿名化测量） | 295 / 144 / 850 / 545 | 16px 24px 24px | 0px | normal | block / static / auto |
| E631 布局节点（语义见匿名化测量） | 319 / 160 / 787 / 758 | 0px | 0px | normal | block / static / auto |
| E632 布局节点（语义见匿名化测量） | 320 / 161 / 785 / 48 | 8px 20px | 0px | 16px | flex / static / auto |
| E633 布局节点（语义见匿名化测量） | 320 / 209 / 785 / 49 | 8px 20px | 0px | 16px | flex / static / auto |
| E634 布局节点（语义见匿名化测量） | 412 / 217 / 160 / 32 | 4px 32px 4px 12px | 0px | normal | inline-block / static / auto |
| E636 布局节点（语义见匿名化测量） | 320 / 258 / 785 / 48 | 8px 20px | 0px | 16px | flex / static / auto |
| E637 布局节点（语义见匿名化测量） | 340 / 326 / 172.69 / 28 | 6px 12px | 0px 0px 16px | 8px | flex / static / auto |
| E638 布局节点（语义见匿名化测量） | 350.13 / 331.13 / 17.74 / 17.74 | 0px | 0px | normal | block / static / auto |
| E639 布局节点（语义见匿名化测量） | 295 / 689 / 850 / 131 | 24px 28px | 0px | 6px 16px | grid / static / auto |
| E640 布局节点（语义见匿名化测量） | 797 / 716 / 320 / 36 | 4px 10px | 0px | normal | block / static / auto |
| E642 布局节点（语义见匿名化测量） | 1006.16 / 760 / 110.84 / 36 | 0px 12px | 0px | 6px | inline-flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E622 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 16px |
| E624 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E627 布局节点（语义见匿名化测量） | 16px / 24px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E628 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 3.35544e+07px |
| E629 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E630 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E631 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E632 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E633 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E634 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(96.1634 0.0993311 -0.364041) | `'0px solid lab(90.952 0 -0.0000119209)'` | 3.35544e+07px |
| E636 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E637 布局节点（语义见匿名化测量） | 12px / 16px / 400 | lab(33.6991 63.6233 -75.7861) / oklab(0.470993 0.122982 -0.213022 / 0.05) | `'0px solid lab(90.952 0 -0.0000119209)'` | 3.35544e+07px |
| E638 布局节点（语义见匿名化测量） | 12px / 16px / 400 | lab(33.6991 63.6233 -75.7861) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E639 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E640 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 10px |
| E642 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid rgba(0, 0, 0, 0)'` | 10px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`；`Geist, "Geist Fallback", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E112 | 240 / 48 / 1200 / 852 | 1185×852 | 1185×3873 | 0 / 0 | auto / auto |
| S1 E380 | 510 / 126 / 905 / 749 | 890×749 | 890×1845 | 0 / 0 | auto / auto |
| S2 E630 | 295 / 144 / 850 / 545 | 835×545 | 835×798 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 10. Add to Sequence 配置弹窗

[截图（匿名布局图）](diagrams/juicebox-enrollment-1440.svg) · [完整JSON](states/juicebox-enrollment-1440.json) · [AX](states/juicebox-enrollment-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集336/336节点，truncated=False。

**布局与互动**：标准状态居中514×570，x463/y165；内容宽450即左右32。1024宽时同宽居中x255/y99。1440×600时最大高度536=600-64，内部产生scroll，高度不足时外框宽529包含15px滚动条，内容仍514。不能把529误作另一个宽屏断点。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E303 布局节点（语义见匿名化测量） | 463 / 165 / 514 / 570 | 0px | 32px | normal | flex / relative / auto |
| E304 布局节点（语义见匿名化测量） | 463 / 165 / 514 / 570 | 0px | 0px | normal | block / static / auto |
| E305 布局节点（语义见匿名化测量） | 463 / 165 / 514 / 570 | 0px | 0px | normal | flex / static / auto |
| E306 布局节点（语义见匿名化测量） | 463 / 165 / 514 / 570 | 0px | 0px | normal | flex / static / auto |
| E307 布局节点（语义见匿名化测量） | 463 / 165 / 514 / 570 | 32px | 0px | 24px | flex / static / auto |
| E308 布局节点（语义见匿名化测量） | 495 / 197 / 219.64 / 16 | 0px | 0px | normal | block / static / auto |
| E309 布局节点（语义见匿名化测量） | 495 / 237 / 450 / 68 | 12px 16px | 0px | 2px 10px | grid / relative / auto |
| E312 布局节点（语义见匿名化测量） | 495 / 355 / 450 / 40 | 0px 12px | 0px | 8px | flex / static / auto |
| E317 布局节点（语义见匿名化测量） | 820.7 / 422 / 14 / 14 | 0px | 0px | normal | flex / static / auto |
| E319 布局节点（语义见匿名化测量） | 495 / 445 / 450 / 40 | 8px 12px | 0px | 8px | flex / static / auto |
| E324 布局节点（语义见匿名化测量） | 495 / 535 / 450 / 40 | 0px 12px | 0px | 8px | flex / static / auto |
| E330 布局节点（语义见匿名化测量） | 836.28 / 621 / 108.72 / 22 | 0px 6px 0px 0px | 0px | 2px | flex / static / auto |
| E331 布局节点（语义见匿名化测量） | 922 / 624 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E333 布局节点（语义见匿名化测量） | 733.67 / 667 / 67.58 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E334 布局节点（语义见匿名化测量） | 809.25 / 667 / 135.75 / 36 | 0px 8px 0px 10px | 0px | 6px | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E303 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E304 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E305 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E306 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E307 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E308 布局节点（语义见匿名化测量） | 16px / 16px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E309 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(97.8202 1.49742 15.5161) | `'1px solid lab(88.566 5.4653 31.9582)'` | 10px |
| E312 布局节点（语义见匿名化测量） | 14px / 20px / 400 | rgb(0, 0, 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E317 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E319 布局节点（语义见匿名化测量） | 14px / 20px / 400 | rgb(0, 0, 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E324 布局节点（语义见匿名化测量） | 14px / 20px / 400 | rgb(0, 0, 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E330 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(33.6991 63.6233 -75.7861) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E331 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(33.6991 63.6233 -75.7861) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E333 布局节点（语义见匿名化测量） | 14px / 20px / 500 | rgb(0, 0, 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E334 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E120 | 240 / 104 / 1200 / 796 | 1185×796 | 1185×3207 | 0 / 0 | auto / auto |
| S1 E121 | 240 / 104 / 1185 / 3207 | 1185×3192 | 2475×3192 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 11. Request Review 弹窗

[截图（匿名布局图）](diagrams/juicebox-review-modal-1440.svg) · [完整JSON](states/juicebox-review-modal-1440.json) · [AX](states/juicebox-review-modal-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集379/379节点，truncated=False。

**布局与互动**：Review固定宽512、575高，x464/y162.5；padding32，纵向gap24。标题下有分隔。Reviewer选择器340×36，不是整内容448宽；note更宽。未选reviewer时提交disabled。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E362 布局节点（语义见匿名化测量） | 464 / 162.5 / 512 / 575 | 32px | 0px | 24px | grid / fixed / 1205 |
| E363 布局节点（语义见匿名化测量） | 496 / 194.5 / 448 / 108 | 0px | 0px | 16px | flex / static / auto |
| E364 布局节点（语义见匿名化测量） | 496 / 194.5 / 448 / 31 | 0px 0px 16px | 0px | normal | block / static / auto |
| E365 布局节点（语义见匿名化测量） | 496 / 326.5 / 448 / 318 | 0px | 0px | 20px | flex / static / auto |
| E366 布局节点（语义见匿名化测量） | 496 / 326.5 / 448 / 52 | 0px | 0px | 4px | flex / static / auto |
| E367 布局节点（语义见匿名化测量） | 496 / 398.5 / 448 / 64 | 0px | 0px | 8px | flex / static / auto |
| E368 布局节点（语义见匿名化测量） | 496 / 426.5 / 340 / 36 | 8px 8px 8px 10px | 0px | 6px | flex / static / auto |
| E369 布局节点（语义见匿名化测量） | 811 / 436.5 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E370 布局节点（语义见匿名化测量） | 496 / 482.5 / 448 / 162 | 0px | 0px | 8px | flex / static / auto |
| E371 布局节点（语义见匿名化测量） | 496 / 482.5 / 448 / 42 | 0px | 0px | 2px | flex / static / auto |
| E372 布局节点（语义见匿名化测量） | 496 / 532.5 / 448 / 112 | 8px 10px | 0px | normal | flex / static / auto |
| E373 布局节点（语义见匿名化测量） | 496 / 668.5 / 448 / 37 | 0px | 0px | 8px | flex / static / auto |
| E374 布局节点（语义见匿名化测量） | 745.33 / 669.5 / 67.58 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E375 布局节点（语义见匿名化测量） | 820.91 / 669.5 / 123.09 / 36 | 0px 10px | 0px | 6px | flex / static / auto |
| E376 布局节点（语义见匿名化测量） | 928 / 178.5 / 32 / 32 | 0px | 0px | normal | flex / absolute / 20 |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E362 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E363 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E364 布局节点（语义见匿名化测量） | 14px / 14px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E365 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E366 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E367 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E368 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E369 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E370 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E371 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E372 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E373 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E374 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E375 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E376 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E133 | 240 / 104 / 1200 / 743 | 1185×743 | 1185×1575 | 0 / 0 | auto / auto |
| S1 E134 | 240 / 104 / 1185 / 1575 | 1185×1560 | 1266×1560 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 12. Contacts 全局表格

[截图（匿名布局图）](diagrams/juicebox-contacts-1440.svg) · [完整JSON](states/juicebox-contacts-1440.json) · [AX](states/juicebox-contacts-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集296/296节点，truncated=False。

**布局与互动**：侧栏后主体1200宽，breadcrumb48，工具条56，表格从y104开始。可视表格宽1185（右滚动条15），真实列总宽2475，数据行45px。上下滚动和左右滚动是不同容器；横滚不应使toolbar移走。表格高度依加载数据变化，不是responsive断点。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 240 / 0 / 1200 / 48 | 0px 16px | 0px | 4px | flex / static / auto |
| E109 布局节点（语义见匿名化测量） | 373.92 / 7.5 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E111 布局节点（语义见匿名化测量） | 240 / 48 / 1200 / 56 | 12px 20px | 0px | 8px | flex / static / auto |
| E113 布局节点（语义见匿名化测量） | 260 / 60 / 300 / 32 | 4px 32px | 0px | normal | inline-block / static / auto |
| E114 布局节点（语义见匿名化测量） | 568 / 60 / 72.58 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E117 布局节点（语义见匿名化测量） | 1332 / 60 / 88 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E118 布局节点（语义见匿名化测量） | 1395 / 69 / 14 / 14 | 0px | 0px | normal | block / static / auto |
| E119 布局节点（语义见匿名化测量） | 240 / 104 / 1200 / 796 | 0px | 0px | normal | flex / static / auto |
| E120 布局节点（语义见匿名化测量） | 240 / 104 / 1200 / 796 | 0px | 0px | normal | block / static / auto |
| E121 布局节点（语义见匿名化测量） | 240 / 104 / 1185 / 1632 | 0px | 0px | normal | block / relative / auto |
| E122 布局节点（语义见匿名化测量） | 240 / 104 / 2475 / 1617 | 0px | 0px | normal | table / static / auto |
| E123 布局节点（语义见匿名化测量） | 240 / 104 / 2475 / 42 | 0px | 0px | normal | table-header-group / sticky / 20 |
| E124 布局节点（语义见匿名化测量） | 240 / 104 / 2475 / 42 | 0px | 0px | normal | table-row / static / auto |
| E126 布局节点（语义见匿名化测量） | 248 / 117 / 42 / 16 | 0px | 0px | normal | flex / static / auto |
| E130 布局节点（语义见匿名化测量） | 302 / 115.22 / 78 / 18.56 | 0px | 0px | 4px | flex / static / auto |
| E154 布局节点（语义见匿名化测量） | 248 / 160.5 / 41 / 16 | 0px | 0px | normal | flex / static / auto |
| E170 布局节点（语义见匿名化测量） | 627 / 156 / 103.86 / 24 | 0px 8px | 0px | normal | flex / relative / auto |
| E173 布局节点（语义见匿名化测量） | 827 / 156 / 72 / 24 | 0px 8px | 0px | normal | flex / relative / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E109 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E111 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E113 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E114 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E117 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E118 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E119 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E120 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E121 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E122 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E123 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E124 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E126 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E130 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E154 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E170 布局节点（语义见匿名化测量） | 13px / 22.75px / 500 | rgb(0, 0, 0) / rgba(0, 0, 0, 0.02) | `'0px none rgba(0, 0, 0, 0.063)'` | 4px |
| E173 布局节点（语义见匿名化测量） | 13px / 22.75px / 500 | rgba(0, 0, 0, 0.376) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.376)'` | 4px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E120 | 240 / 104 / 1200 / 796 | 1185×796 | 1185×1632 | 0 / 0 | auto / auto |
| S1 E121 | 240 / 104 / 1185 / 1632 | 1185×1617 | 2475×1617 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 13. Contacts Filter 菜单

[截图（匿名布局图）](diagrams/juicebox-contact-filter-1440.svg) · [完整JSON](states/juicebox-contact-filter-1440.json) · [AX](states/juicebox-contact-filter-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集347/347节点，truncated=False。

**布局与互动**：Filter在x568/y60；菜单x568/y96，300×680，padding4，maxHeight799。菜单与按钮底边相隔4px。弹层覆盖原表格，不能把遮挡列当当前可操作区。完整21个字段见PRD，逐项几何查RAW。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E303 布局节点（语义见匿名化测量） | 568 / 96 / 300 / 680 | 4px | 0px | normal | block / static / 50 |
| E304 布局节点（语义见匿名化测量） | 572 / 100 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E305 布局节点（语义见匿名化测量） | 580 / 108 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E306 布局节点（语义见匿名化测量） | 572 / 132 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E307 布局节点（语义见匿名化测量） | 580 / 140 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E308 布局节点（语义见匿名化测量） | 572 / 164 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E309 布局节点（语义见匿名化测量） | 580 / 172 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E310 布局节点（语义见匿名化测量） | 572 / 196 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E311 布局节点（语义见匿名化测量） | 580 / 204 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E312 布局节点（语义见匿名化测量） | 572 / 228 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E313 布局节点（语义见匿名化测量） | 580 / 236 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E314 布局节点（语义见匿名化测量） | 572 / 260 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E315 布局节点（语义见匿名化测量） | 580 / 268 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E316 布局节点（语义见匿名化测量） | 572 / 292 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E317 布局节点（语义见匿名化测量） | 580 / 300 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E318 布局节点（语义见匿名化测量） | 572 / 324 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E319 布局节点（语义见匿名化测量） | 580 / 332 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E320 布局节点（语义见匿名化测量） | 572 / 356 / 292 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E303 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E304 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E305 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E306 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E307 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E308 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E309 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E310 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E311 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E312 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E313 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E314 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E315 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E316 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E317 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E318 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E319 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E320 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E124 | 240 / 104 / 1200 / 796 | 1185×796 | 1185×1632 | 0 / 0 | auto / auto |
| S1 E125 | 240 / 104 / 1185 / 1632 | 1185×1617 | 2475×1617 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 14. Contacts Actions 菜单

[截图（匿名布局图）](diagrams/juicebox-contact-actions-1440.svg) · [完整JSON](states/juicebox-contact-actions-1440.json) · [AX](states/juicebox-contact-actions-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集318/318节点，truncated=False。

**布局与互动**：右对齐Actions展开：menu x1196/y96，224×200，padding4。菜单右边1420与Actions右边一致；距离viewport右边20。Import/Export快捷键属于行内次级文本，不应做第二个按钮。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E304 布局节点（语义见匿名化测量） | 0 / 0 / 1440 / 900 | 0px | 0px | normal | block / fixed / auto |
| E305 布局节点（语义见匿名化测量） | 1196 / 96 / 224 / 200 | 0px | 0px | normal | block / absolute / 50 |
| E307 布局节点（语义见匿名化测量） | 1196 / 96 / 224 / 200 | 4px | 0px | normal | block / static / 50 |
| E308 布局节点（语义见匿名化测量） | 1200 / 100 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E309 布局节点（语义见匿名化测量） | 1200 / 132 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E310 布局节点（语义见匿名化测量） | 1200 / 164 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E311 布局节点（语义见匿名化测量） | 1394 / 173 / 14 / 14 | 0px | 0px 0px 0px 126.172px | normal | block / static / auto |
| E312 布局节点（语义见匿名化测量） | 1200 / 196 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E313 布局节点（语义见匿名化测量） | 1394 / 205 / 14 / 14 | 0px | 0px 0px 0px 59.5312px | normal | block / static / auto |
| E314 布局节点（语义见匿名化测量） | 1200 / 228 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E315 布局节点（语义见匿名化测量） | 1200 / 260 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E316 布局节点（语义见匿名化测量） | 1394 / 269 / 14 / 14 | 0px | 0px 0px 0px 102.766px | normal | block / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E304 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E305 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E307 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E308 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E309 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E310 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E311 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E312 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E313 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E314 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E315 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E316 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E124 | 240 / 104 / 1200 / 796 | 1185×796 | 1185×3207 | 0 / 0 | auto / auto |
| S1 E125 | 240 / 104 / 1185 / 3207 | 1185×3192 | 2475×3192 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 15. Shortlist Table 与固定分页

[截图（匿名布局图）](diagrams/juicebox-shortlist-table-1440.svg) · [完整JSON](states/juicebox-shortlist-table-1440.json) · [AX](states/juicebox-shortlist-table-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集359/359节点，truncated=False。

**布局与互动**：主体1200宽。表格区域容器高796，其中内容窗口743、底部分页53；header40、数据行38。列总宽1266超过当前client1185，需水平滚动。分页按钮32×32，右边距20。搜索、排序、Filter与右侧操作保持同一toolbar，popover另起层。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 240 / 0 / 1200 / 48 | 0px 16px | 0px | 12px | flex / static / auto |
| E117 布局节点（语义见匿名化测量） | 240 / 48 / 1200 / 56 | 12px 20px | 0px | 8px | flex / static / auto |
| E119 布局节点（语义见匿名化测量） | 260 / 60 / 300 / 32 | 4px 32px | 0px | normal | inline-block / static / auto |
| E121 布局节点（语义见匿名化测量） | 568 / 60 / 169.75 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E123 布局节点（语义见匿名化测量） | 745.75 / 60 / 72.58 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E127 布局节点（语义见匿名化测量） | 1126.48 / 60 / 124.89 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E129 布局节点（语义见匿名化测量） | 1259.38 / 60 / 120.63 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E130 布局节点（语义见匿名化测量） | 1388 / 60 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E132 布局节点（语义见匿名化测量） | 240 / 104 / 1200 / 796 | 0px | 0px | normal | flex / static / auto |
| E133 布局节点（语义见匿名化测量） | 240 / 104 / 1200 / 743 | 0px | 0px | normal | block / static / auto |
| E136 布局节点（语义见匿名化测量） | 240 / 104 / 1266 / 40 | 0px | 0px | normal | table-header-group / sticky / 20 |
| E137 布局节点（语义见匿名化测量） | 240 / 104 / 1266 / 40 | 0px | 0px | normal | table-row / static / auto |
| E138 布局节点（语义见匿名化测量） | 240 / 104 / 50 / 40 | 0px 0px 0px 8px | 0px | normal | table-cell / sticky / 30 |
| E143 布局节点（语义见匿名化测量） | 302 / 114.22 / 78 / 18.56 | 0px | 0px | 4px | flex / static / auto |
| E147 布局节点（语义见匿名化测量） | 662 / 114.22 / 56.63 / 18.56 | 0px | 0px | 4px | flex / static / auto |
| E152 布局节点（语义见匿名化测量） | 1072 / 114.22 / 45.86 / 18.56 | 0px | 0px | 4px | flex / static / auto |
| E348 布局节点（语义见匿名化测量） | 1163.86 / 854 / 256.14 / 40 | 0px | 0px | 12px | flex / static / auto |
| E350 布局节点（语义见匿名化测量） | 1244 / 858 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E356 布局节点（语义见匿名化测量） | 1388 / 858 / 32 / 32 | 0px | 0px | normal | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E117 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E119 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E121 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E123 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E127 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E129 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E130 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E132 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E133 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E136 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E137 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E138 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E143 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E147 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E152 布局节点（语义见匿名化测量） | 13px / 18.5714px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E348 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E350 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 4px |
| E356 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 4px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E133 | 240 / 104 / 1200 / 743 | 1185×743 | 1185×1575 | 0 / 0 | auto / auto |
| S1 E134 | 240 / 104 / 1185 / 1575 | 1185×1560 | 1266×1560 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 16. Shortlist 列配置双层菜单

[截图（匿名布局图）](diagrams/juicebox-columns-menu-1440.svg) · [完整JSON](states/juicebox-columns-menu-1440.json) · [AX](states/juicebox-columns-menu-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集437/437节点，truncated=False。

**布局与互动**：右侧More主菜单224×218，x1196/y96；View子菜单向左展开到x968/y97，224×372，两menu间4px。Table/Board各102×28。native input只有1×1是辅助输入，不是视觉checkbox尺寸；可见checkbox span是16×16，不能用1px复刻。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E131 布局节点（语义见匿名化测量） | 1388 / 60 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E366 布局节点（语义见匿名化测量） | 1196 / 96 / 224 / 218 | 4px | 0px | normal | block / static / 50 |
| E367 布局节点（语义见匿名化测量） | 1200 / 100 / 216 / 32 | 6px 8px | 0px | 8px | flex / static / auto |
| E368 布局节点（语义见匿名化测量） | 1392 / 108 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E372 布局节点（语义见匿名化测量） | 1200 / 141 / 216 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E385 布局节点（语义见匿名化测量） | 968 / 97 / 224 / 372 | 8px | 0px | normal | block / static / 50 |
| E387 布局节点（语义见匿名化测量） | 978 / 107 / 102 / 28 | 4px 8px | 0px | 6px | flex / static / auto |
| E389 布局节点（语义见匿名化测量） | 1080 / 107 / 102 / 28 | 4px 8px | 0px | 6px | flex / static / auto |
| E391 布局节点（语义见匿名化测量） | 976 / 173 / 208 / 288 | 0px | 0px | normal | block / static / auto |
| E392 布局节点（语义见匿名化测量） | 976 / 173 / 193 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E393 布局节点（语义见匿名化测量） | 984 / 181 / 16 / 16 | 0px | 0px | normal | flex / relative / auto |
| E394 布局节点（语义见匿名化测量） | 984 / 181 / 16 / 16 | 0px | 0px | normal | grid / static / auto |
| E395 布局节点（语义见匿名化测量） | 984 / 181 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E397 布局节点（语义见匿名化测量） | 976 / 205 / 193 / 32 | 6px 8px | 0px | 8px | flex / relative / auto |
| E398 布局节点（语义见匿名化测量） | 984 / 213 / 16 / 16 | 0px | 0px | normal | flex / relative / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E131 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E366 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E367 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(7.78201 -0.0000149012 0) / lab(96.52 -0.0000298023 0.0000119209) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E368 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(7.78201 -0.0000149012 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E372 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E385 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E387 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E389 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E391 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E392 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E393 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid lab(33.6991 63.6233 -75.7861)'` | 4px |
| E394 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(97.5598 2.12467 -2.96893) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E395 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(97.5598 2.12467 -2.96893) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E397 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E398 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(97.5598 2.12467 -2.96893) / lab(33.6991 63.6233 -75.7861) | `'1px solid lab(33.6991 63.6233 -75.7861)'` | 4px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E137 | 240 / 104 / 1200 / 743 | 1185×743 | 1185×1575 | 0 / 0 | auto / auto |
| S1 E138 | 240 / 104 / 1185 / 1575 | 1185×1560 | 1266×1560 | 0 / 0 | auto / auto |
| S2 E391 | 976 / 173 / 208 / 288 | 193×288 | 193×320 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 17. Shortlist Board：横向列与列内滚动

[截图（匿名布局图）](diagrams/juicebox-shortlist-board-1440.svg) · [完整JSON](states/juicebox-shortlist-board-1440.json) · [AX](states/juicebox-shortlist-board-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集1363/1363节点，truncated=False。

**布局与互动**：看板scrollWidth2976，而viewport内主体1200宽；列宽320，横向列间8。Contacted列scrollHeight7811，clientHeight756；Interested列也有自己纵向scroll，空列没有伪造卡片。各列header与卡片区分别布局，不是一个页面大scroll同时移动所有列。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 240 / 0 / 1200 / 48 | 0px 16px | 0px | 12px | flex / static / auto |
| E117 布局节点（语义见匿名化测量） | 240 / 48 / 1200 / 56 | 12px 20px | 0px | 8px | flex / static / auto |
| E119 布局节点（语义见匿名化测量） | 260 / 60 / 300 / 32 | 4px 32px | 0px | normal | inline-block / static / auto |
| E123 布局节点（语义见匿名化测量） | 1126.48 / 60 / 293.52 / 32 | 0px | 0px | 8px | flex / static / auto |
| E127 布局节点（语义见匿名化测量） | 1388 / 60 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E129 布局节点（语义见匿名化测量） | 240 / 104 / 1200 / 796 | 16px | 0px | 8px | flex / static / auto |
| E130 布局节点（语义见匿名化测量） | 256 / 120 / 320 / 756 | 0px | 0px | normal | flex / static / auto |
| E132 布局节点（语义见匿名化测量） | 264 / 128 / 150.09 / 29 | 0px | 0px | normal | flex / static / auto |
| E133 布局节点（语义见匿名化测量） | 264 / 132.5 / 20 / 20 | 0px | 0px | normal | flex / relative / auto |
| E136 布局节点（语义见匿名化测量） | 284 / 128 / 130.09 / 29 | 4px 8px | 0px | 8px | flex / static / auto |
| E137 布局节点（语义见匿名化测量） | 545.22 / 131.8 / 22.78 / 22.78 | 2.4px | 0px | normal | inline-flex / relative / auto |
| E138 布局节点（语义见匿名化测量） | 548.61 / 135.19 / 16 / 16 | 0px | 0px | normal | block / static / auto |
| E139 布局节点（语义见匿名化测量） | 256 / 165 / 320 / 711 | 0px | 0px | normal | flex / static / auto |
| E140 布局节点（语义见匿名化测量） | 256 / 165 / 320 / 711 | 0px 8px 48px | 0px | normal | block / relative / auto |
| E141 布局节点（语义见匿名化测量） | 584 / 120 / 320 / 756 | 0px | 0px | normal | flex / static / auto |
| E142 布局节点（语义见匿名化测量） | 584 / 120 / 320 / 45 | 8px | 0px | normal | flex / static / auto |
| E143 布局节点（语义见匿名化测量） | 592 / 128 / 106.52 / 29 | 0px | 0px | normal | flex / static / auto |
| E144 布局节点（语义见匿名化测量） | 592 / 132.5 / 20 / 20 | 0px | 0px | normal | flex / relative / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E117 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E119 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E123 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E127 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E129 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E130 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0.02) | `'0px solid rgba(116, 185, 255, 0.25)'` | 4px |
| E132 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E133 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.396) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.396)'` | 50% |
| E136 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 64px |
| E137 布局节点（语义见匿名化测量） | 24px / 36px / 400 | rgb(107, 114, 128) / rgba(0, 0, 0, 0.02) | `'1px solid rgba(0, 0, 0, 0.125)'` | 4px |
| E138 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E139 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E140 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E141 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0.02) | `'0px solid rgba(162, 155, 254, 0.25)'` | 4px |
| E142 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E143 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E144 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.396) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.396)'` | 50% |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E129 | 240 / 104 / 1200 / 796 | 1200×788 | 2976×788 | 0 / 0 | auto / auto |
| S1 E162 | 912 / 165 / 320 / 756 | 305×756 | 305×7811 | 0 / 0 | auto / auto |
| S2 E1149 | 1568 / 165 / 320 / 756 | 305×756 | 305×1013 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 18. 候选人展开详情：双栏与两组Tab

[截图（匿名布局图）](diagrams/juicebox-profile-drawer-1440.svg) · [完整JSON](states/juicebox-profile-drawer-1440.json) · [AX](states/juicebox-profile-drawer-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集575/575节点，truncated=False。

**布局与互动**：展开宽1324.8=当前1440的92%，左边115.2，fixed右对齐；资料栏701.61，业务栏622.17。资料导航tab43高，业务tablist36高、每tab29高。主体有两个独立scroll区；遮挡/窄化的背景Shortlist仍在DOM，但不是当前主要工作区。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E351 布局节点（语义见匿名化测量） | 115.2 / 0 / 1324.8 / 900 | 0px | 0px | normal | flex / fixed / 1203 |
| E354 布局节点（语义见匿名化测量） | 116.2 / 0 / 701.61 / 900 | 0px | 0px | normal | flex / static / auto |
| E355 布局节点（语义见匿名化测量） | 116.2 / 12 / 701.61 / 50 | 0px 20px | 12px 0px 0px | 4px | flex / static / auto |
| E357 布局节点（语义见匿名化测量） | 136.2 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E359 布局节点（语义见匿名化测量） | 170.2 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E362 布局节点（语义见匿名化测量） | 693.81 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E365 布局节点（语义见匿名化测量） | 729.81 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E367 布局节点（语义见匿名化测量） | 765.81 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E369 布局节点（语义见匿名化测量） | 116.2 / 62 / 701.61 / 850 | 12px 0px 0px | 0px | normal | block / static / auto |
| E374 布局节点（语义见匿名化测量） | 148.2 / 74 / 637.61 / 30 | 0px | 0px | 8px | flex / static / auto |
| E390 布局节点（语义见匿名化测量） | 148.2 / 182 / 262.8 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E395 布局节点（语义见匿名化测量） | 451 / 182 / 269.81 / 32 | 0px 8px | 0px | normal | flex / relative / auto |
| E406 布局节点（语义见匿名化测量） | 132.2 / 226 / 669.61 / 43 | 0px | 0px | normal | flex / static / auto |
| E419 布局节点（语义见匿名化测量） | 246.2 / 296 / 112.7 / 25 | 2px 6px | 0px 0px 0px -6px | 6px | flex / static / auto |
| E436 布局节点（语义见匿名化测量） | 252.2 / 386 / 90.42 / 22 | 0px | 0px | 4px | flex / static / auto |
| E543 布局节点（语义见匿名化测量） | 817.81 / 0 / 622.17 / 900 | 24px 24px 0px 8px | 0px | normal | flex / static / auto |
| E547 布局节点（语义见匿名化测量） | 841.81 / 40 / 398.31 / 36 | 3px | 0px | 4px | flex / relative / auto |
| E548 布局节点（语义见匿名化测量） | 844.81 / 43.5 / 64.13 / 29 | 4px 12px | 0px | 6px | flex / relative / 10 |
| E556 布局节点（语义见匿名化测量） | 841.81 / 100 / 543.17 / 160 | 0px | 0px | normal | flex / relative / auto |
| E565 布局节点（语义见匿名化测量） | 841.81 / 276 / 543.17 / 786.5 | 0px | 0px | 12px | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E351 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgb(255, 255, 255) | `''` | 0px |
| E354 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E355 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E357 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E359 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E362 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E365 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E367 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E369 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E374 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E390 布局节点（语义见匿名化测量） | 14px / 20px / 500 | rgba(0, 0, 0, 0.87) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px 0px 0px 8px |
| E395 布局节点（语义见匿名化测量） | 13px / 22.75px / 500 | rgb(255, 255, 255) / rgb(118, 0, 188) | `''` | 8px 0px 0px 8px |
| E406 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E419 布局节点（语义见匿名化测量） | 14px / 21px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 4px |
| E436 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(33.6991 63.6233 -75.7861) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E543 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E547 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(48.496 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'0px solid lab(90.952 0 -0.0000119209)'` | 10px |
| E548 布局节点（语义见匿名化测量） | 14px / 20px / 400 | rgb(118, 0, 188) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E556 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E565 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E126 | 240 / 104 / 750 / 743 | 735×743 | 735×1575 | 0 / 0 | auto / auto |
| S1 E127 | 240 / 104 / 735 / 1575 | 735×1560 | 1266×1560 | 0 / 0 | auto / auto |
| S2 E387 | 116.2 / 174 / 701.61 / 738 | 702×738 | 702×1715 | 0 / 0 | auto / auto |
| S3 E555 | 825.81 / 84 / 590.17 / 816 | 575×816 | 575×995 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 19. 候选人收起详情

[截图（匿名布局图）](diagrams/juicebox-profile-collapsed-1440.svg) · [完整JSON](states/juicebox-profile-collapsed-1440.json) · [AX](states/juicebox-profile-collapsed-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集537/537节点，truncated=False。

**布局与互动**：Collapse不是关闭。收起后详情450宽且full-height，x990；背景Shortlist宽750。1024时仍450宽，x574，背景只剩334，toolbar会换行，表格起点从104变144。不要把这一次资料栏折叠误标为“移动版drawer”。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 240 / 0 / 750 / 48 | 0px 16px | 0px | 12px | flex / static / auto |
| E351 布局节点（语义见匿名化测量） | 990 / 0 / 450 / 900 | 0px | 0px | normal | flex / fixed / 1201 |
| E352 布局节点（语义见匿名化测量） | 991 / 0 / 449 / 900 | 0px | 0px | normal | flex / static / auto |
| E355 布局节点（语义见匿名化测量） | 991 / 12 / 449 / 50 | 0px 20px | 12px 0px 0px | 4px | flex / static / auto |
| E357 布局节点（语义见匿名化测量） | 1011 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E359 布局节点（语义见匿名化测量） | 1045 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E362 布局节点（语义见匿名化测量） | 1316 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E367 布局节点（语义见匿名化测量） | 1388 / 21 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E369 布局节点（语义见匿名化测量） | 991 / 62 / 449 / 850 | 12px 0px 0px | 0px | normal | block / static / auto |
| E374 布局节点（语义见匿名化测量） | 1023 / 74 / 385 / 30 | 0px | 0px | 8px | flex / static / auto |
| E390 布局节点（语义见匿名化测量） | 1023 / 182 / 136.5 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E395 布局节点（语义见匿名化测量） | 1199.5 / 182 / 143.5 / 32 | 0px 8px | 0px | normal | flex / relative / auto |
| E406 布局节点（语义见匿名化测量） | 1007 / 226 / 417 / 43 | 0px | 0px | normal | flex / static / auto |
| E407 布局节点（语义见匿名化测量） | 1007 / 226 / 88.2 / 43 | 10px 14px | 0px | normal | flex / relative / auto |
| E408 布局节点（语义见匿名化测量） | 1095.2 / 226 / 99.52 / 43 | 10px 14px | 0px | normal | flex / relative / auto |
| E409 布局节点（语义见匿名化测量） | 1194.72 / 226 / 92.31 / 43 | 10px 14px | 0px | normal | flex / relative / auto |
| E410 布局节点（语义见匿名化测量） | 1287.03 / 226 / 61.5 / 43 | 10px 14px | 0px | normal | flex / relative / auto |
| E419 布局节点（语义见匿名化测量） | 1121 / 296 / 112.7 / 25 | 2px 6px | 0px 0px 0px -6px | 6px | flex / static / auto |
| E436 布局节点（语义见匿名化测量） | 1127 / 386 / 90.42 / 22 | 0px | 0px | 4px | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E351 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgb(255, 255, 255) | `''` | 0px |
| E352 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E355 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E357 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E359 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E362 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E367 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.87)'` | 4px |
| E369 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E374 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E390 布局节点（语义见匿名化测量） | 14px / 20px / 500 | rgba(0, 0, 0, 0.87) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px 0px 0px 8px |
| E395 布局节点（语义见匿名化测量） | 13px / 22.75px / 500 | rgb(255, 255, 255) / rgb(118, 0, 188) | `''` | 8px 0px 0px 8px |
| E406 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E407 布局节点（语义见匿名化测量） | 14px / 21px / 400 | rgb(0, 0, 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E408 布局节点（语义见匿名化测量） | 14px / 21px / 400 | rgba(0, 0, 0, 0.46) / rgba(0, 0, 0, 0) | `''` | 0px |
| E409 布局节点（语义见匿名化测量） | 14px / 21px / 400 | rgba(0, 0, 0, 0.46) / rgba(0, 0, 0, 0) | `''` | 0px |
| E410 布局节点（语义见匿名化测量） | 14px / 21px / 400 | rgba(0, 0, 0, 0.46) / rgba(0, 0, 0, 0) | `''` | 0px |
| E419 布局节点（语义见匿名化测量） | 14px / 21px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 4px |
| E436 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(33.6991 63.6233 -75.7861) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, sans-serif`；`-apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E126 | 240 / 104 / 750 / 743 | 735×743 | 735×1575 | 0 / 0 | auto / auto |
| S1 E127 | 240 / 104 / 735 / 1575 | 735×1560 | 1266×1560 | 0 / 0 | auto / auto |
| S2 E387 | 991 / 174 / 449 / 738 | 449×738 | 449×1788 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 20. 候选人 Sequences Tab

[截图（匿名布局图）](diagrams/juicebox-profile-sequences-1440.svg) · [完整JSON](states/juicebox-profile-sequences-1440.json) · [AX](states/juicebox-profile-sequences-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集561/561节点，truncated=False。

**布局与互动**：只切右栏业务tab，左侧资料和全层宽度不变；Sequences tab需表现选中，邮件历史归该contact。当前内容是否溢出决定右栏scroll是否存在，不能强行复制Notes的995px高度。邮件Expand/Reply/Mark as Replied为独立控件。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E351 布局节点（语义见匿名化测量） | 115.2 / 0 / 1324.8 / 900 | 0px | 0px | normal | flex / fixed / 1203 |
| E354 布局节点（语义见匿名化测量） | 116.2 / 0 / 701.61 / 900 | 0px | 0px | normal | flex / static / auto |
| E406 布局节点（语义见匿名化测量） | 132.2 / 226 / 669.61 / 43 | 0px | 0px | normal | flex / static / auto |
| E543 布局节点（语义见匿名化测量） | 817.81 / 0 / 622.17 / 900 | 24px 24px 0px 8px | 0px | normal | flex / static / auto |
| E547 布局节点（语义见匿名化测量） | 841.81 / 40 / 398.31 / 36 | 3px | 0px | 4px | flex / relative / auto |
| E548 布局节点（语义见匿名化测量） | 844.81 / 43.5 / 64.13 / 29 | 4px 12px | 0px | 6px | flex / relative / 10 |
| E549 布局节点（语义见匿名化测量） | 912.94 / 43.5 / 97.3 / 29 | 4px 12px | 0px | 6px | flex / relative / 10 |
| E550 布局节点（语义见匿名化测量） | 1014.23 / 43.5 / 73.95 / 29 | 4px 12px | 0px | 6px | flex / relative / 10 |
| E551 布局节点（语义见匿名化测量） | 1092.19 / 43.5 / 78.58 / 29 | 4px 12px | 0px | 6px | flex / relative / 10 |
| E552 布局节点（语义见匿名化测量） | 1174.77 / 43.5 / 62.36 / 29 | 4px 12px | 0px | 6px | flex / relative / 10 |
| E554 布局节点（语义见匿名化测量） | 825.81 / 84 / 590.17 / 816 | 0px | 0px | normal | flex / static / auto |
| E555 布局节点（语义见匿名化测量） | 825.81 / 84 / 590.17 / 816 | 0px | 0px | normal | flex / static / auto |
| E556 布局节点（语义见匿名化测量） | 825.81 / 84 / 590.17 / 101 | 0px | 0px | normal | flex / relative / auto |
| E557 布局节点（语义见匿名化测量） | 1110.02 / 103.13 / 21.74 / 21.74 | 0px | 20px | normal | block / static / auto |
| E558 布局节点（语义见匿名化测量） | 1110.02 / 103.13 / 21.74 / 21.74 | 0px | 0px | normal | block / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E351 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgb(255, 255, 255) | `''` | 0px |
| E354 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E406 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E543 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgb(255, 255, 255) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E547 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(48.496 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'0px solid lab(90.952 0 -0.0000119209)'` | 10px |
| E548 布局节点（语义见匿名化测量） | 14px / 20px / 400 | oklab(0.145 -0.00000143796 0.00000340492 / 0.6) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E549 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E550 布局节点（语义见匿名化测量） | 14px / 20px / 400 | oklab(0.145 -0.00000143796 0.00000340492 / 0.6) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E551 布局节点（语义见匿名化测量） | 14px / 20px / 400 | oklab(0.145 -0.00000143796 0.00000340492 / 0.6) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E552 布局节点（语义见匿名化测量） | 14px / 20px / 400 | oklab(0.145 -0.00000143796 0.00000340492 / 0.6) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E554 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E555 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgb(250, 250, 250) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E556 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px 0px 5px 5px |
| E557 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.6) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E558 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.6) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

本状态上述组件未获得可唯一绑定的四边补充值；border shorthand不充分处保留未独立测量，避免将空串误读为0边框。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E126 | 240 / 104 / 750 / 743 | 735×743 | 735×1575 | 0 / 0 | auto / auto |
| S1 E127 | 240 / 104 / 735 / 1575 | 735×1560 | 1266×1560 | 0 / 0 | auto / auto |
| S2 E387 | 116.2 / 174 / 701.61 / 738 | 702×738 | 702×1715 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 21. Outreach Analytics：过滤、KPI、图表、聚合表

[截图（匿名布局图）](diagrams/juicebox-outreach-analytics-1440.svg) · [完整JSON](states/juicebox-outreach-analytics-1440.json) · [AX](states/juicebox-outreach-analytics-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集320/320节点，truncated=False。

**布局与互动**：标题与filter区总高148，下面body窗752高并独立纵滚。6KPI当前126高；中部两张图并排，单张556.5宽、412高，间隙24。聚合区先toolbar再横向表格；主页面window scrollY仍0。1024下filters会换行并下推内容，表格横向overflow继续保留。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E117 布局节点（语义见匿名化测量） | 240 / 0 / 1200 / 48 | 0px 16px | 0px | normal | flex / static / auto |
| E126 布局节点（语义见匿名化测量） | 264 / 72 / 1152 / 24 | 0px | 0px | normal | block / static / auto |
| E130 布局节点（语义见匿名化测量） | 264 / 112 / 160 / 36 | 0px 12px | 0px | 8px | flex / static / auto |
| E134 布局节点（语义见匿名化测量） | 432 / 112 / 160 / 36 | 0px 12px | 0px | 8px | flex / static / auto |
| E138 布局节点（语义见匿名化测量） | 600 / 112 / 160 / 36 | 0px 12px | 0px | 8px | flex / static / auto |
| E142 布局节点（语义见匿名化测量） | 768 / 112 / 160 / 36 | 0px 12px | 0px | 8px | flex / static / auto |
| E147 布局节点（语义见匿名化测量） | 1071.48 / 112 / 156.52 / 36 | 0px 12px | 0px | 8px | flex / static / auto |
| E150 布局节点（语义见匿名化测量） | 1236 / 112 / 180 / 36 | 8px 8px 8px 10px | 0px | 6px | flex / static / auto |
| E154 布局节点（语义见匿名化测量） | 240 / 148 / 1200 / 752 | 0px | 0px | normal | block / static / auto |
| E156 布局节点（语义见匿名化测量） | 264 / 172 / 1137 / 126 | 0px | 0px | 10px | flex / static / auto |
| E157 布局节点（语义见匿名化测量） | 264 / 172 / 181.16 / 126 | 16px 24px | 0px | 8px | flex / static / auto |
| E161 布局节点（语义见匿名化测量） | 455.16 / 172 / 181.17 / 126 | 16px 24px | 0px | 8px | flex / static / auto |
| E181 布局节点（语义见匿名化测量） | 264 / 322 / 1137 / 412 | 0px | 0px | 24px | grid / static / auto |
| E182 布局节点（语义见匿名化测量） | 264 / 322 / 556.5 / 412 | 16px 0px | 0px | 0px | flex / static / auto |
| E194 布局节点（语义见匿名化测量） | 844.5 / 322 / 556.5 / 412 | 16px 0px | 0px | 0px | flex / static / auto |
| E206 布局节点（语义见匿名化测量） | 264 / 758 / 1137 / 309 | 0px | 0px | normal | block / static / auto |
| E211 布局节点（语义见匿名化测量） | 306 / 772.5 / 294 / 36 | 4px 10px 4px 6px | 0px | normal | block / static / auto |
| E214 布局节点（语义见匿名化测量） | 609 / 772.5 / 186.36 / 36 | 8px 8px 8px 10px | 0px | 6px | flex / static / auto |
| E219 布局节点（语义见匿名化测量） | 803.36 / 772.5 / 161.72 / 36 | 8px 8px 8px 10px | 0px | 6px | flex / static / auto |
| E224 布局节点（语义见匿名化测量） | 973.08 / 772.5 / 143.97 / 36 | 8px 8px 8px 10px | 0px | 6px | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E117 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E126 布局节点（语义见匿名化测量） | 20px / 24px / 600 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E130 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E134 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E138 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E142 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E147 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E150 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E154 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E156 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E157 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(98.26 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E161 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(98.26 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E181 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E182 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgb(250, 250, 250) | `'0px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E194 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgb(250, 250, 250) | `'0px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E206 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 14px |
| E211 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E214 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E219 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E224 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

**四边实测示例 E117**：上0px solid lab(90.952 0 -0.0000119209)；右0px solid lab(90.952 0 -0.0000119209)；下1px solid lab(90.952 0 -0.0000119209)；左0px solid lab(90.952 0 -0.0000119209)。四角TL/TR/BR/BL=0px/0px/0px/0px。transition=all / 0s / ease。其他有唯一boxDetails的组件同样按E索引查，未唯一匹配项不补造。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E154 | 240 / 148 / 1200 / 752 | 1185×752 | 1185×967 | 0 / 0 | auto / auto |
| S1 E14,188,200 | 608.84 / 348 / 131.66 / 32 | 132×32 | 141×32 | 0 / 0 | auto / hidden |
| S2 E231 | 265 / 823 / 1135 / 243 | 1135×228 | 1186×228 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 22. Analytics Metric 菜单

[截图（匿名布局图）](diagrams/juicebox-analytics-metric-menu-1440.svg) · [完整JSON](states/juicebox-analytics-metric-menu-1440.json) · [AX](states/juicebox-analytics-metric-menu-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集335/335节点，truncated=False。

**布局与互动**：Metric为combobox，只在当前viewport边界内摆放listbox，具体rect以表中为准；Emails sent/Profiles enrolled是选择项，不是后端已切换成功的证据。下方表格保持原内容；menu的ariaExpanded与当前可见选项必须对应。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E214 布局节点（语义见匿名化测量） | 609 / 557.5 / 186.36 / 36 | 8px 8px 8px 10px | 0px | 6px | flex / static / auto |
| E320 布局节点（语义见匿名化测量） | 1325.38 / 787.38 / 103.63 / 33.75 | 0px | 0px | normal | flex / static / auto |
| E322 布局节点（语义见匿名化测量） | 0 / 0 / 1440 / 900 | 0px | 0px | normal | block / fixed / auto |
| E323 布局节点（语义见匿名化测量） | 609 / 598 / 186.36 / 72 | 0px | 0px | normal | block / absolute / 50 |
| E325 布局节点（语义见匿名化测量） | 609 / 598 / 186.36 / 72 | 0px | 0px | normal | block / relative / 50 |
| E326 布局节点（语义见匿名化测量） | 609 / 598 / 186.36 / 72 | 0px | 0px | normal | block / static / auto |
| E327 布局节点（语义见匿名化测量） | 609 / 598 / 186.36 / 72 | 4px | 0px | normal | block / static / auto |
| E328 布局节点（语义见匿名化测量） | 613 / 602 / 178.36 / 32 | 6px 32px 6px 8px | 0px | 8px | flex / relative / auto |
| E329 布局节点（语义见匿名化测量） | 621 / 608 / 138.36 / 20 | 0px | 0px | 8px | flex / static / auto |
| E330 布局节点（语义见匿名化测量） | 613 / 634 / 178.36 / 32 | 6px 32px 6px 8px | 0px | 8px | flex / relative / auto |
| E331 布局节点（语义见匿名化测量） | 621 / 640 / 138.36 / 20 | 0px | 0px | 8px | flex / static / auto |
| E332 布局节点（语义见匿名化测量） | 767.36 / 642 / 16 / 16 | 0px | 0px | 8px | flex / absolute / auto |
| E333 布局节点（语义见匿名化测量） | 767.36 / 642 / 16 / 16 | 0px | 0px | normal | block / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E214 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / lab(96.52 -0.0000298023 0.0000119209) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E320 布局节点（语义见匿名化测量） | 14px / 17.5px / 600 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E322 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E323 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E325 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / lab(100 0 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E326 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E327 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E328 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E329 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E330 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(7.78201 -0.0000149012 0) / lab(96.52 -0.0000298023 0.0000119209) | `'0px solid lab(90.952 0 -0.0000119209)'` | 6px |
| E331 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(7.78201 -0.0000149012 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E332 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(7.78201 -0.0000149012 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E333 布局节点（语义见匿名化测量） | 14px / 20px / 400 | lab(7.78201 -0.0000149012 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

**四边实测示例 E214**：上1px solid lab(90.952 0 -0.0000119209)；右1px solid lab(90.952 0 -0.0000119209)；下1px solid lab(90.952 0 -0.0000119209)；左1px solid lab(90.952 0 -0.0000119209)。四角TL/TR/BR/BL=8px/8px/8px/8px。transition=color, box-shadow / 0.15s / cubic-bezier(0.4, 0, 0.2, 1)。其他有唯一boxDetails的组件同样按E索引查，未唯一匹配项不补造。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E154 | 240 / 148 / 1200 / 752 | 1185×752 | 1185×967 | 0 / 215 | auto / auto |
| S1 E14,188,200 | 608.84 / 133 / 131.66 / 32 | 132×32 | 141×32 | 0 / 0 | auto / hidden |
| S2 E233 | 265 / 608 / 1135 / 243 | 1135×228 | 1186×228 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。
## 23. Talent Insights：地图、摘要与长页

[截图（匿名布局图）](diagrams/juicebox-insights-1440.svg) · [完整JSON](states/juicebox-insights-1440.json) · [AX](states/juicebox-insights-1440.txt)

基准viewport **1440×900**，outer 1440×900，DPR1。根document client 1440×900、scroll 1440×900；body client 1440×900、scroll 1440×900。window scrollX/Y=0/0。采集450/450节点，truncated=False。

**布局与互动**：根document只有900高，内部Insights容器scrollHeight5272，client900。首行布局按2/3与1/3占比：TopLocations外框779.33×516，KeyTakeaways389.66×516。位置列表宽184.83且独立滚动；不是把地图与列表当一个截图背景。scrollTop900后breadcrumb和顶部标题离开视口，说明此页header非sticky。

### 关键组件几何与留白

| 组件（E索引） | x / y / w / h | padding | margin | gap | display / position / z |
|---|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 240 / 0 / 1185 / 48 | 0px 16px | 0px | 12px | flex / static / auto |
| E121 布局节点（语义见匿名化测量） | 240 / 48 / 1185 / 5224 | 0px | 0px | normal | flex / static / auto |
| E124 布局节点（语义见匿名化测量） | 256 / 65 / 30 / 30 | 5px | 0px | normal | flex / relative / auto |
| E126 布局节点（语义见匿名化测量） | 290 / 70.66 / 141.61 / 18.67 | 0px | 0px | 8px | flex / static / auto |
| E127 布局节点（语义见匿名化测量） | 1268.45 / 64 / 140.55 / 32 | 0px 10px | 0px | 4px | flex / static / auto |
| E129 布局节点（语义见匿名化测量） | 240 / 96 / 1185 / 5176 | 8px | 0px | normal | flex / static / auto |
| E130 布局节点（语义见匿名化测量） | 248 / 104 / 1169 / 5160 | 0px | 0px | normal | block / static / auto |
| E132 布局节点（语义见匿名化测量） | 248 / 104 / 779.33 / 516 | 8px | 0px | normal | flex / relative / auto |
| E133 布局节点（语义见匿名化测量） | 256 / 112 / 763.33 / 500 | 12px | 0px | normal | flex / static / auto |
| E135 布局节点（语义见匿名化测量） | 280 / 134 / 715.33 / 24 | 0px | 0px 0px 5px | normal | flex / static / auto |
| E137 布局节点（语义见匿名化测量） | 268 / 194 / 739.33 / 406 | 0px | 0px | normal | flex / static / auto |
| E138 布局节点（语义见匿名化测量） | 268 / 194 / 184.83 / 406 | 0px 6px 0px 3px | 0px | normal | block / static / auto |
| E151 布局节点（语义见匿名化测量） | 464.83 / 206 / 30 / 30 | 0px | 0px | normal | block / static / auto |
| E155 布局节点（语义见匿名化测量） | 1027.33 / 104 / 389.66 / 516 | 8px | 0px | normal | flex / static / auto |
| E156 布局节点（语义见匿名化测量） | 1035.33 / 112 / 373.66 / 500 | 12px | 0px | normal | flex / static / auto |
| E158 布局节点（语义见匿名化测量） | 1059.33 / 134 / 325.66 / 24 | 0px | 0px 0px 5px | normal | flex / static / auto |
| E160 布局节点（语义见匿名化测量） | 1360.98 / 130 / 32 / 32 | 0px | 0px | normal | flex / static / auto |
| E167 布局节点（语义见匿名化测量） | 248 / 620 / 389.66 / 516 | 8px | 0px | normal | flex / relative / auto |
| E169 布局节点（语义见匿名化测量） | 256 / 628 / 373.66 / 242 | 12px | 0px | normal | flex / static / auto |
| E173 布局节点（语义见匿名化测量） | 268 / 710 / 349.66 / 148 | 0px | 0px | normal | flex / static / auto |

### 同一组件的文字、颜色与轮廓

| E索引 | font-size / line-height / weight | color / background | border shorthand | radius |
|---|---|---|---|---|
| E104 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `''` | 0px |
| E121 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E124 布局节点（语义见匿名化测量） | 18px / 27px / 400 | rgba(0, 0, 0, 0.6) / rgba(0, 0, 0, 0) | `'0px none rgba(0, 0, 0, 0.6)'` | 50% |
| E126 布局节点（语义见匿名化测量） | 16px / 18.672px / 500 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E127 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(2.75381 0 0) / lab(100 0 0) | `'1px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E129 布局节点（语义见匿名化测量） | 16px / 24px / 400 | lab(2.75381 0 0) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E130 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 8px |
| E132 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E133 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / lab(96.52 -0.0000298023 0.0000119209) | `'0px none rgba(0, 0, 0, 0.87)'` | 16px |
| E135 布局节点（语义见匿名化测量） | 16px / 24px / 500 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E137 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E138 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E151 布局节点（语义见匿名化测量） | 22px / 30px / 700 | rgb(0, 0, 0) / rgb(255, 255, 255) | `''` | 2px 2px 0px 0px |
| E155 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E156 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / lab(96.52 -0.0000298023 0.0000119209) | `'0px none rgba(0, 0, 0, 0.87)'` | 16px |
| E158 布局节点（语义见匿名化测量） | 16px / 24px / 500 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E160 布局节点（语义见匿名化测量） | 14px / 20px / 500 | lab(48.496 0 0) / rgba(0, 0, 0, 0) | `'1px solid rgba(0, 0, 0, 0)'` | 8px |
| E167 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |
| E169 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / lab(96.52 -0.0000298023 0.0000119209) | `'0px none rgba(0, 0, 0, 0.87)'` | 16px |
| E173 布局节点（语义见匿名化测量） | 16px / 24px / 400 | rgba(0, 0, 0, 0.87) / rgba(0, 0, 0, 0) | `'0px solid lab(90.952 0 -0.0000119209)'` | 0px |

本状态以上组件实际font-family：`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`；`Geist, "Geist Fallback", -apple-system, "system-ui", "Segoe UI", Roboto, sans-serif`；`"Lucida Console", Monaco, monospace`。letterSpacing、boxSizing、min/示例候选人、cursor、outline、shadow、transform、transition等逐项见同E索引RAW/JSON；不把不同按钮的样式统称一个默认token。

**四边实测示例 E104**：上0px solid lab(90.952 0 -0.0000119209)；右0px solid lab(90.952 0 -0.0000119209)；下1px solid lab(90.952 0 -0.0000119209)；左0px solid lab(90.952 0 -0.0000119209)。四角TL/TR/BR/BL=0px/0px/0px/0px。transition=all / 0s / ease。其他有唯一boxDetails的组件同样按E索引查，未唯一匹配项不补造。

### 滚动与内容高度

| 容器与E关联（selector可查JSON） | viewport x/y/w/h | client w×h | scroll w×h | scrollLeft / Top | overflow X/Y |
|---|---|---|---|---|---|
| S0 E103 | 240 / 0 / 1200 / 900 | 1185×900 | 1185×5272 | 0 / 0 | auto / auto |
| S1 E11,22,138 | 268 / 194 / 184.83 / 406 | 170×406 | 170×441 | 0 / 0 | auto / auto |

包含被遮挡背景的scroll容器时，其数值仅说明背景layout仍存在；不代表弹窗打开后允许用户滚动背景。要复刻弹层交互，应以最上层focus/遮罩/截图状态判断。

## 24. 高度、滚动与响应式对照的复刻规则

1. **编辑器高度**：1440×900外层852=900-48，1440×600外层552=600-48；四边24间距保留。短窗口通过内部滚动而不是缩小字号/所有节点。
2. **Enrollment高度**：标准514×570，矮窗口最大高536=600-64且margin32；加纵向滚动条后外宽529、client宽514。内容footer可通过滚动触达，不能把底部按钮裁掉。
3. **资料展开与收起**：展开当前92%viewport宽，收起450固定宽；1440/1024收起宽相同。背景可用列宽减少，触发工具条换行，是面板状态与viewport共同作用。
4. **列表横/纵双滚动**：Contacts列宽2475，对照可视1185/769；Shortlist1266，对照1185/735/319。不能只设置body overflow-y导致右侧历史列永久不可达。
5. **Board两层滚动**：整个看板横向到2976，每个非空列独立纵滚；列width320、gap8。列计数来自数据，不是当前屏幕卡片数量。
6. **Insights长页**：window与根document高度900，内部scrollHeight5272；scrollTop900后顶部title与breadcrumb上移出视口。不能把该页title固定化后再声称和原站一致。
7. **Outreach内容区**：顶部过滤区固定在其外层，内部统计/图表/表格可以纵滚；聚合表另有横滚。内部scrollTop的变化不能误记作window.scrollY。
8. **小屏**：相邻1000/999测得的是当前站点真实screen-size guard；若本产品决定提供手机业务流程，这是另一个明确产品决定，不能称当前Juicebox手机版逐像素复刻。

## 25. 完整状态矩阵与采样边界

下面所有viewport/window/document/coverage来自各自JSON，包含滚动状态与矮窗口。未列入正文的相同页面不同状态仍可在RAW与overlay inspector逐节点检查。

| 状态 | inner / outer | document client/scroll(w×h) | body scroll(w×h) | nodes recorded/eligible | text/SVG / 唯一boxDetails |
|---|---|---|---|---|---|
| [juicebox-analytics-metric-menu-1440](states/juicebox-analytics-metric-menu-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 335/335; trunc=False | 188 / 332 |
| [juicebox-columns-menu-1440](states/juicebox-columns-menu-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 437/437; trunc=False | 167 / 0 |
| [juicebox-contact-actions-1440](states/juicebox-contact-actions-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 318/318; trunc=False | 118 / 0 |
| [juicebox-contact-filter-1440](states/juicebox-contact-filter-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 347/347; trunc=False | 130 / 0 |
| [juicebox-contacts-1024](states/juicebox-contacts-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 296/296; trunc=False | 103 / 0 |
| [juicebox-contacts-1440](states/juicebox-contacts-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 296/296; trunc=False | 103 / 0 |
| [juicebox-contacts-scrolled-1440](states/juicebox-contacts-scrolled-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 299/299; trunc=False | 106 / 0 |
| [juicebox-editor-1024](states/juicebox-editor-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 619/619; trunc=False | 337 / 0 |
| [juicebox-editor-1440](states/juicebox-editor-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 619/619; trunc=False | 337 / 0 |
| [juicebox-editor-preview-1440](states/juicebox-editor-preview-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 644/644; trunc=False | 348 / 0 |
| [juicebox-editor-short-height](states/juicebox-editor-short-height.json) | 1440×600 / 1440×600 | 1440×600 / 1440×600 | 1440×600 | 619/619; trunc=False | 337 / 0 |
| [juicebox-editor-timing-popover-1440](states/juicebox-editor-timing-popover-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 633/633; trunc=False | 345 / 0 |
| [juicebox-enrollment-1024](states/juicebox-enrollment-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 335/335; trunc=False | 124 / 0 |
| [juicebox-enrollment-1440](states/juicebox-enrollment-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 336/336; trunc=False | 124 / 0 |
| [juicebox-enrollment-short-height](states/juicebox-enrollment-short-height.json) | 1440×600 / 1440×600 | 1440×600 / 1440×600 | 1440×600 | 335/335; trunc=False | 124 / 0 |
| [juicebox-guard-1023](states/juicebox-guard-1023.json) | 1023×768 / 1023×768 | 1023×768 / 1023×768 | 1023×768 | 450/450; trunc=False | 123 / 447 |
| [juicebox-insights-1024](states/juicebox-insights-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 450/450; trunc=False | 123 / 447 |
| [juicebox-insights-1440](states/juicebox-insights-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 450/450; trunc=False | 123 / 447 |
| [juicebox-insights-scrolled-1440](states/juicebox-insights-scrolled-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 452/452; trunc=False | 127 / 449 |
| [juicebox-outreach-analytics-1024](states/juicebox-outreach-analytics-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 320/320; trunc=False | 182 / 317 |
| [juicebox-outreach-analytics-1440](states/juicebox-outreach-analytics-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 320/320; trunc=False | 182 / 317 |
| [juicebox-outreach-analytics-390](states/juicebox-outreach-analytics-390.json) | 390×844 / 390×844 | 390×844 / 390×844 | 390×844 | 324/324; trunc=False | 184 / 321 |
| [juicebox-outreach-analytics-768](states/juicebox-outreach-analytics-768.json) | 768×1024 / 768×1024 | 768×1024 / 768×1024 | 768×1024 | 324/324; trunc=False | 184 / 321 |
| [juicebox-outreach-scrolled-1440](states/juicebox-outreach-scrolled-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 320/320; trunc=False | 182 / 317 |
| [juicebox-outreach-width-1000](states/juicebox-outreach-width-1000.json) | 1000×768 / 1000×768 | 1000×768 / 1000×768 | 1000×768 | 320/320; trunc=False | 182 / 317 |
| [juicebox-outreach-width-1023-stable](states/juicebox-outreach-width-1023-stable.json) | 1023×768 / 1023×768 | 1023×768 / 1023×768 | 1023×768 | 320/320; trunc=False | 182 / 317 |
| [juicebox-outreach-width-899](states/juicebox-outreach-width-899.json) | 899×900 / 899×900 | 899×900 / 899×900 | 899×900 | 326/326; trunc=False | 184 / 323 |
| [juicebox-outreach-width-900](states/juicebox-outreach-width-900.json) | 900×900 / 900×900 | 900×900 / 900×900 | 900×900 | 326/326; trunc=False | 184 / 323 |
| [juicebox-outreach-width-999](states/juicebox-outreach-width-999.json) | 999×768 / 999×768 | 999×768 / 999×768 | 999×768 | 328/328; trunc=False | 184 / 325 |
| [juicebox-profile-collapsed-1024](states/juicebox-profile-collapsed-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 537/537; trunc=False | 200 / 0 |
| [juicebox-profile-collapsed-1440](states/juicebox-profile-collapsed-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 537/537; trunc=False | 200 / 0 |
| [juicebox-profile-drawer-1440](states/juicebox-profile-drawer-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 575/575; trunc=False | 226 / 0 |
| [juicebox-profile-sequences-1440](states/juicebox-profile-sequences-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 561/561; trunc=False | 221 / 0 |
| [juicebox-review-modal-1440](states/juicebox-review-modal-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 379/379; trunc=False | 132 / 0 |
| [juicebox-run-filter-1440](states/juicebox-run-filter-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 342/342; trunc=False | 191 / 0 |
| [juicebox-sequence-1024](states/juicebox-sequence-1024.json) | 1024×768 / 1024×768 | 1024×768 / 1024×768 | 1024×768 | 276/276; trunc=False | 155 / 0 |
| [juicebox-sequence-1440](states/juicebox-sequence-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 276/276; trunc=False | 155 / 0 |
| [juicebox-sequence-1806](states/juicebox-sequence-1806.json) | 1806×1067 / 1806×1154 | 1806×1067 / 1806×1067 | 1806×1067 | 276/276; trunc=False | 0 / 0 |
| [juicebox-sequence-390](states/juicebox-sequence-390.json) | 390×844 / 390×844 | 390×844 / 390×844 | 390×844 | 284/284; trunc=False | 157 / 0 |
| [juicebox-sequence-768](states/juicebox-sequence-768.json) | 768×1024 / 768×1024 | 768×1024 / 768×1024 | 768×1024 | 284/284; trunc=False | 157 / 0 |
| [juicebox-sequence-contact-drawer-1440](states/juicebox-sequence-contact-drawer-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 632/632; trunc=False | 346 / 0 |
| [juicebox-sequence-detail-1440](states/juicebox-sequence-detail-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 321/321; trunc=False | 179 / 0 |
| [juicebox-shortlist-board-1440](states/juicebox-shortlist-board-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 1363/1363; trunc=False | 661 / 0 |
| [juicebox-shortlist-table-1440](states/juicebox-shortlist-table-1440.json) | 1440×900 / 1440×900 | 1440×900 / 1440×900 | 1440×900 | 359/359; trunc=False | 120 / 0 |

本次没有用raw CSS样式证明未实施的发送、邀请、拖拽保存或数据计费；业务事实与静态layout分别保留。200%浏览器zoom、所有hover/focus动画、所有已加载前的最终高度、私有付费页面、全部平台设备输入方式仍不因这些尺寸成为已完整验证。后续复刻用本文件的geometry与对应截图核对，互动按PRD逐步验收，不用“存在同名按钮”代替闭环。
