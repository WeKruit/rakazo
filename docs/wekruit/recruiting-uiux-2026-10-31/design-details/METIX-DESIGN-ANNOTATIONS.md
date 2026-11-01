> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Metix 组件设计精确标注

本文件将已登录 Metix 的实际 DOM 几何、计算样式、滚动结构与已观察交互对应起来，供界面复刻使用。功能语义见 [METIX PRD](../METIX-PRD.md)，逐项验收见 [METIX ACCEPTANCE](../METIX-ACCEPTANCE.md)。本文件只使用 `states` 中的当前测量，不把旧截图目测尺寸提升为精确值。

## 测量口径

- 坐标为浏览器内容视口左上角的 CSS px，`x / y / w / h` 对应 `getBoundingClientRect`；包含边框，受当前滚动、布局和 transform 影响。不是屏幕物理坐标。
- 每章必须结合其 JSON 的 viewport。1806 × 1011 与 1440 × 900 属于不同捕获，不能把坐标混用。DPR 为实际记录值，不假定为所有设备常量。
- `P` 为 computed padding，`M` 为 computed margin，`gap` 保持浏览器返回值。字体写作 `size / weight / line-height`。颜色和边框保留浏览器原始 RGB/OKLCH 形式，不转换或猜测设计 token。
- `eN` 是该 JSON 的 `elements[N]`，只用于同一次捕获定位。完整 selector、类名、min/示例候选人 width/height、布局和其他样式在对应原始记录，不把运行时类名当稳定组件 API。
- `inViewport` 只说明 rect 与视口相交，不证明祖先 clip 内可见；`occludedAtCenter` 只检测中心点。抽屉打开时，底层页面即使仍有坐标，也不能当作前景可点击元素。
- 文本和语义的关系以当前 AX 与截图核对；文件名中含 Worth Talking 的旧 示例候选人 捕获不能作为 示例候选人 的评级证据。
- 采集器仅记录可测量且满足语义/结构条件的元素；每个 table row group 只保留前四行，最多 2000 个元素。元素记录不是全部 DOM 节点；伪元素、浏览器默认绘制细节和每个纯文本节点未逐一采集。
- 表内未列出的值不补推算。没有实际 measured state 的页面在末尾列为未测；文档中的交互说明只引用本次观察，不声称发送和排期已执行成功。

## 1 Inbox 桌面基线 1440 × 900

证据：[测量 JSON](states/metix-inbox-selected-1440.json)、[AX](states/metix-inbox-selected-1440.txt)、[截图（匿名布局图）](diagrams/metix-inbox-selected-1440.svg)。

窗口 `inner=1440×900`、`outer=1440×900`、`DPR=1`、`scrollX=0/scrollY=0`。文档 `client=1440×900`、`scroll=1440×900`；这不意味着列表没有长内容，长内容位于内部滚动容器。

### 1.1 组件框与间距


| 组件 / 记录 | x / y / w / h | P；M；gap | 布局 / 溢出 / 层级 |
| --- | --- | --- | --- |
| 固定侧栏外框 e2 | 0 / 0 / 244 / 900 | P `0px`；M `0px`；gap `normal` | `flex` / `fixed`；overflow `visible/visible`；z `10` |
| 品牌栏 e4 | 0 / 0 / 243 / 64 | P `0px`；M `0px`；gap `8px` | `flex` / `static`；overflow `visible/visible`；z `auto` |
| 品牌链接 e6 | 16 / 16 / 82 / 32 | P `0px`；M `0px`；gap `normal` | `flex` / `static`；overflow `visible/visible`；z `auto` |
| 收起侧栏 e8 | 195 / 16 / 32 / 32 | P `0px`；M `0px`；gap `8px` | `flex` / `static`；overflow `visible/visible`；z `auto` |
| New Role e15 | 8 / 68 / 227 / 34 | P `0px`；M `0px`；gap `0px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| Job Brief e22 | 8 / 106 / 227 / 34 | P `0px`；M `0px`；gap `0px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| Shortlist e27 | 8 / 144 / 227 / 34 | P `0px`；M `0px`；gap `0px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| Sequence e32 | 8 / 182 / 227 / 34 | P `0px`；M `0px`；gap `0px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| Inbox 当前导航 e37 | 8 / 220 / 227 / 34 | P `0px`；M `0px`；gap `0px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| Interview e43 | 8 / 258 / 227 / 34 | P `0px`；M `0px`；gap `0px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| All Roles 分组标题 e48 | 8 / 320 / 227 / 32 | P `0px 8px`；M `12px 0px 0px`；gap `normal` | `flex` / `static`；overflow `visible/visible`；z `auto` |
| 角色链接样例 e51 | 8 / 352 / 227 / 36 | P `0px 20px 0px 8px`；M `0px`；gap `8px` | `flex` / `relative`；overflow `hidden/hidden`；z `auto` |
| 角色菜单图标按钮 e55 | 203 / 358 / 24 / 24 | P `0px`；M `0px`；gap `normal` | `flex` / `static`；overflow `visible/visible`；z `auto` |
| 账户区外框 e85 | 0 / 828 / 243 / 72 | P `8px`；M `0px`；gap `12px` | `flex` / `static`；overflow `visible/visible`；z `auto` |
| 账户菜单按钮 e87 | 8 / 836 / 227 / 56 | P `0px 8px`；M `0px`；gap `8px` | `flex` / `static`；overflow `hidden/hidden`；z `auto` |
| 正文呈现区 e259 | 829 / 195 / 574 / 176.5 | P `0px`；M `0px`；gap `normal` | `block` / `static`；overflow `visible/visible`；z `auto` |
| 引用文本展开 e262 | 829 / 351.5 / 31 / 20 | P `0px 8px`；M `0px`；gap `3px` | `inline-flex` / `static`；overflow `visible/visible`；z `auto` |
| Reply 邮件内按钮 e263 | 829 / 387.5 / 83.38 / 36 | P `0px 12px`；M `0px`；gap `6px` | `inline-flex` / `static`；overflow `visible/visible`；z `auto` |
| 外联折叠组 e265 | 764 / 452.5 / 656 / 40 | P `0px`；M `0px`；gap `normal` | `block` / `static`；overflow `visible/visible`；z `auto` |
| 已加载到底提示 e268 | 764 / 508.5 / 656 / 16 | P `0px 4px`；M `4px 0px 0px`；gap `12px` | `flex` / `static`；overflow `visible/visible`；z `auto` |

### 1.2 字体、边框与颜色

以下为同一捕获的计算值。透明背景意味着从祖先或底层透出，不能改记成白色；`border` 空串表示该简写未序列化，不代表无单侧边框。圆形元素的极大 computed radius 保留在 JSON，几何上呈圆或胶囊。

| 组件 / 记录 | 字体 size / weight / line-height | 前景 / 背景 | border；radius；shadow |
| --- | --- | --- | --- |
| 固定侧栏外框 e2 | `16px / 400 / 24px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | ``；r `0px`；shadow `none` |
| 品牌栏 e4 | `16px / 400 / 24px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `0px`；shadow `none` |
| 品牌链接 e6 | `16px / 400 / 24px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `0px`；shadow `none` |
| 收起侧栏 e8 | `14px / 500 / 20px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8.4px`；shadow `none` |
| New Role e15 | `14px / 500 / 20px` | `rgb(98, 98, 98)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| Job Brief e22 | `14px / 500 / 20px` | `rgb(98, 98, 98)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| Shortlist e27 | `14px / 500 / 20px` | `rgb(98, 98, 98)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| Sequence e32 | `14px / 500 / 20px` | `rgb(98, 98, 98)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| Inbox 当前导航 e37 | `14px / 600 / 20px` | `rgb(34, 34, 34)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| Interview e43 | `14px / 500 / 20px` | `rgb(98, 98, 98)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| All Roles 分组标题 e48 | `11px / 500 / 14.3px` | `rgb(115, 115, 115)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8.4px`；shadow `none` |
| 角色链接样例 e51 | `14px / 400 / 20px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `14.4px`；shadow `none` |
| 角色菜单图标按钮 e55 | `16px / 400 / 24px` | `rgb(102, 102, 102)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8.4px`；shadow `none` |
| 账户区外框 e85 | `16px / 400 / 24px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `0px`；shadow `none` |
| 账户菜单按钮 e87 | `14px / 400 / 20px` | `rgb(16, 13, 53)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `8px`；shadow `none` |
| 正文呈现区 e259 | `16px / 400 / 24px` | `rgb(51, 51, 51)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `0px`；shadow `none` |
| 引用文本展开 e262 | `16px / 400 / 24px` | `rgb(51, 51, 51)` / `rgb(237, 237, 237)` | `0px solid oklch(0.92 0.004 286.32)`；r `7px`；shadow `none` |
| Reply 邮件内按钮 e263 | `13px / 600 / 19.5px` | `rgb(34, 34, 34)` / `rgba(0, 0, 0, 0)` | `1px solid rgb(34, 34, 34)`；r `8px`；shadow `none` |
| 外联折叠组 e265 | `16px / 400 / 24px` | `rgb(51, 51, 51)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `0px`；shadow `none` |
| 已加载到底提示 e268 | `12px / 400 / 16px` | `rgb(176, 180, 187)` / `rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；r `0px`；shadow `none` |

### 1.3 结构、滚动和交互

- 固定侧栏外框宽 244；主区从 x=244 开始。Inbox 列表外框宽500，线程区从x=744开始；500包括边框，列表标题可用宽499。
- 列表标题行高64；角色筛选位于y=76、高44；All/Unread位于y=132、高32。候选人滚动区从y=176延伸到视口底端。
- 列表内容左右padding20，卡片边框内再padding16，因此第一张卡的外框x=264，内部x=281。卡片间gap10；选中边框rgb(34,34,34)，未选中边框rgb(235,235,235)。
- 线程标题行高64；正文外框左右padding由对应记录保留。收到邮件卡在相同宽度下可能因为正文换行增高，不能把1806宽截图中的高度硬编码到1440。
- Profile和Reply属于当前线程。候选人卡片点击改变当前选择；评级badge单独负责展示，不能因其颜色触发阶段迁移。点击Profile右侧打开资料，Reply在线程内展开富文本编辑器；完整交互参见PRD第5、6节。

| 内部滚动容器 | rect x/y/w/h | client w/h | scroll w/h | 当前left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| s0 `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 244 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 0 | `hidden/auto` |
| s1 `div:nth-child(3) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 281 / 1396.5 / 414 / 34 | 414 / 34 | 425 / 34 | 0 / 0 | `auto/hidden` |

### 1.4 同页 1806 × 1011 对照

证据：[1806测量](states/metix-inbox-1806.json)、[截图（匿名布局图）](diagrams/metix-inbox-1806.svg)。同一次页面在较宽视口中，侧栏与列表栏宽度保持244和500，线程栏从x744开始由696增加到1062；相同正文可因换行变化产生不同高度。以下仅陈列两个捕获的实际值，不推导CSS断点。

| 组件 | 1440×900 x/y/w/h | 1806×1011 x/y/w/h |
| --- | --- | --- |
| 侧栏 | 0 / 0 / 244 / 900 | 0 / 0 / 244 / 1011 |
| 主区 | 244 / 0 / 1196 / 900 | 244 / 0 / 1562 / 1011 |
| 列表栏 | 244 / 0 / 500 / 900 | 244 / 0 / 500 / 1011 |
| 列表滚动框 | 244 / 176 / 499 / 724 | 244 / 176 / 499 / 835 |
| 第一张候选人卡 | 264 / 176 / 448 / 245.5 | 264 / 176 / 448 / 245.5 |
| 线程栏 | 744 / 0 / 696 / 900 | 744 / 0 / 1062 / 1011 |
| Profile | 1239.39 / 13.5 / 89.23 / 36 | 1605.39 / 13.5 / 89.23 / 36 |
| 收到邮件卡 | 764 / 128 / 656 / 312.5 | 764 / 128 / 1022 / 288.5 |
| 外联折叠组 | 764 / 452.5 / 656 / 40 | 764 / 428.5 / 1022 / 40 |
| 账户菜单 | 8 / 836 / 227 / 56 | 8 / 947 / 227 / 56 |

完整扩展组件表见 [METIX DESIGN RAW](METIX-DESIGN-RAW.md)；每个原始JSON包含本次采集的完整E/T记录。

## 2 字体与文本叶子测量

测量采样补充 `textAndIcons.samples` 后，`Tn` 指该数组第 n 项；它是文字或图标的真实计算样式，不能使用父 flex 容器的 fontWeight 代替。下面以 `metix-inbox-selected-1440.json` 为准：

| 文本 / T记录 | x / y / w / h | font size / weight / line-height | color |
| --- | --- | --- | --- |
| 侧栏当前导航Inbox T23 | 42 / 227 / 173 / 20 | `14px / 600 / 20px` | `rgb(34, 34, 34)` |
| 卡片候选人姓名 T64 | 337 / 195 / 96.61 / 20 | `16px / 600 / 20px` | `rgb(36, 36, 36)` |
| Worth Talking T65 | 441.61 / 193 / 107.34 / 24 | `11px / 600 / 11px` | `rgb(0, 163, 124)` |
| Strong Match T86 | 402.14 / 448.5 / 105.86 / 24 | `11px / 600 / 11px` | `rgb(119, 65, 255)` |
| 邮件卡发件人姓名 T201 | 829 / 145 / 91.22 / 22.5 | `15px / 600 / 22.5px` | `rgb(26, 26, 26)` |

侧栏文本的计算 font-family 是 `Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`；Inbox 主区样本的计算 family 是 `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"`。这是浏览器字体候选栈，不证明最终每个字形实际使用同一个字体文件。

## 3 Inbox 未选中、窄视口及手机列表

`metix-inbox-1440` 是右侧未选中状态，显示 Select a candidate；`metix-inbox-selected-1440` 才是示例候选人已选中线程。两者外框相同，不能将默认空选择误记为收件箱没有邮件。

| 捕获 | 视口 | 主体及当前前景 | 页面/内部高度含义 |
| --- | --- | --- | --- |
| [默认1440](states/metix-inbox-1440.json) | 1440×900 | sidebar244 + list500 + empty pane696 | document900，列表内部scrollHeight1589 |
| [已选1024](states/metix-inbox-1024.json) | 1024×768 | sidebar64 + list500 + thread460 | document768，list592高/1589内容 |
| [已选768](states/metix-inbox-768.json) | 768×1024 | 前景为全宽线程；原列表留在DOM | 线程自y64起高960；背景列表不是可见双栏 |
| [已选390](states/metix-inbox-390.json) | 390×844 | 前景全宽线程；顶部Back、Profile、Reply为图标按钮 | 线程自y64起高780；document844 |
| [返回列表390](states/metix-inbox-list-390.json) | 390×844 | 顶部Inbox/角色/AllUnread，下方单列卡片 | 列表框700高，内部内容1804高 |

390手机返回列表的首卡 `e19=(16,144,347,275)`，padding20、radius16；内部内容从 `(37,165)` 起，宽305。桌面首卡padding16，手机不同，不能将同一全局padding套到所有状态。390列表内容可用宽379，其中横向padding16×2使卡片宽347；滚动条占用11px。不同高度主要来自手机文本换行和更大的卡片留白，不是同一固定卡片高度。

手机线程从列表卡片进入，并可用 Back to inbox list 返回；两种视图在DOM可能同时存在。响应式报告负责跨宽度行为判断，此处只记录各捕获实际前景。

## 4 Profile 桌面稳定展开态

证据：[JSON](states/metix-profile-criteria-expanded-1440.json)、[AX](states/metix-profile-criteria-expanded-1440.txt)、[截图（匿名布局图）](diagrams/metix-profile-criteria-expanded-1440.svg)。

视口 `1440×900`，outer `1440×900`，DPR `1`，window scroll `0/0`；document client `1440×900`、scroll `1440×900`。采集 `606` 个元素，truncated=`false`。

稳定dialog为 `(720,0,720,900)`，right0/width720；header64、正文滚动框836。外框左边框1px，正文x721；左右padding24后内容x745、宽660。全七项展开使Recommendation高446；条件间距和逐项内容高度由实际文本换行决定。最下面Profile sections位于y890，已在首屏下边界，不能说仍在资料首屏中央。

`metix-profile-1440` 的初开捕获x741.95且transform=`matrix(1,0,0,1,21.9451,0)`，是进入动画中间帧；不把该偏移当终态定位。关闭按钮、Show less、Contact details对应已观察关闭、折叠和详情展开，不触发联系。已出现个人/工作邮箱以及复制/发送可用性图标，本文只标布局，不授权解锁或发送。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e227 | 0 / 0 / 1440 / 900 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Profile Candidate profile Profile 示例对象1 Programmer at AF… e228 | 720 / 0 / 720 / 900 | `0px`；`0px`；`0px` | `flex/fixed`；`hidden/hidden`；`50` |
| Profile e230 | 721 / 0 / 719 / 64 | `0px 24px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e233 | 721 / 64 / 719 / 836 | `0px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e235 | 745 / 84 / 660 / 88 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| 示例对象1 e237 | 745 / 84 / 612 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Programmer at AFI e238 | 745 / 124 / 612 / 20 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Kansas City, Missouri, United States 示例候选人-示例候选人 e241 | 745 / 152 / 612 / 20 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 示例候选人-示例候选人 e248 | 1041.17 / 152 / 83.08 / 20 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e249 | 1357 / 84 / 48 / 48 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Download e252 | 745 / 184 / 115.58 / 36 | `10px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Candidate criteria evaluation e254 | 745 / 232 / 660 / 446 | `0px`；`12px 0px 0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Mira's Recommendation e255 | 745 / 232 / 660 / 20 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Met 7+ years The candidate has approximately 9.8 years of tota… e256 | 745 / 260 / 660 / 40 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Met e257 | 745 / 262 / 16 / 16 | `0px`；`2px 0px 0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| [email] Personal [email] Work e297 | 761 / 770 / 628 / 68 | `2px 0px 0px 24px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Copy [email] e301 | 1026.05 / 772 / 32 / 32 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Copy [email] e306 | 959.52 / 806 / 32 / 32 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Sending availability for [email] e308 | 992.52 / 806 / 32 / 32 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Show phone e313 | 1269 / 850 / 120 / 28 | `3px 8px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e227 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Profile Candidate profile Profile 示例对象1 Programmer at AF… e228 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | ``；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px` |
| Profile e230 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e233 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e235 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象1 e237 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Programmer at AFI e238 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Kansas City, Missouri, United States 示例候选人-示例候选人 e241 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例候选人-示例候选人 e248 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SPAN容器 e249 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Download e252 | `14px / 500 / 20px` | `rgb(0, 0, 0)`；`rgb(255, 255, 255)` | `1px solid rgb(0, 0, 0)`；`10.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px` |
| Candidate criteria evaluation e254 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Mira's Recommendation e255 | `14px / 500 / 20px` | `rgb(119, 65, 255)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Met 7+ years The candidate has approximately 9.8 years of tota… e256 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Met e257 | `16px / 400 / 24px` | `rgb(22, 138, 91)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| [email] Personal [email] Work e297 | `14px / 400 / 21px` | `rgb(48, 48, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Copy [email] e301 | `14px / 400 / 21px` | `rgb(119, 119, 127)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`5px`；`none` |
| Copy [email] e306 | `14px / 400 / 21px` | `rgb(119, 119, 127)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`5px`；`none` |
| Sending availability for [email] e308 | `14px / 400 / 21px` | `rgb(119, 119, 127)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`5px`；`none` |
| Show phone e313 | `12px / 500 / 20px` | `rgb(68, 68, 75)`；`rgba(0, 0, 0, 0)` | `1px solid rgb(214, 214, 218)`；`6px`；`none` |

| 实际文字 / T记录 | x / y / w / h | 字体 / weight / line-height | color |
| --- | --- | --- | --- |
| 示例对象1 T182 | 745 / 84 / 139.78 / 32 | `24px / 600 / 32px` | `rgb(23, 29, 38)` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 64 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 0 | `hidden/auto` |
| `div#radix-«ra3» > div:nth-child(4)` | 721 / 64 / 719 / 836 | 708 / 836 | 708 / 3009 | 0 / 0 | `auto/auto` |

## 5 Profile 手机底部面板

证据：[JSON](states/metix-profile-390.json)、[AX](states/metix-profile-390.txt)、[截图（匿名布局图）](diagrams/metix-profile-390.svg)。

视口 `390×844`，outer `390×844`，DPR `1`，window scroll `0/0`；document client `390×844`、scroll `390×844`。采集 `551` 个元素，truncated=`false`。

390×844时资料从右侧抽屉变为底部面板：rect `(0,168.81,390,675.19)`，顶部有drag handle区，Profile标题栏从y190.81起64高。正文可视框589.19高，内部内容3493高；左右内容padding16。地点与LinkedIn分为两行，头部信息由桌面88高变为手机116高。Download按钮在这次手机捕获为44高，不能沿用桌面的36高。评价三项因手机换行而高294。截图中Contact details仅其标题和上部可见，余下需内滚。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e183 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Profile Profile 示例对象1 Programmer at AFI Kansas City, Mis… e184 | 0 / 168.81 / 390 / 675.19 | `0px`；`0px`；`0px` | `flex/fixed`；`hidden/hidden`；`50` |
| Profile e186 | 0 / 190.81 / 390 / 64 | `0px 24px`；`0px`；`normal` | `flex/sticky`；`hidden/hidden`；`10` |
| Close profile e187 | 338 / 208.31 / 28 / 28 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e189 | 0 / 254.81 / 390 / 589.19 | `0px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e190 | 0 / 254.81 / 375 / 3493 | `20px 16px 0px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e191 | 16 / 274.81 / 343 / 690 | `0px`；`0px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e192 | 16 / 274.81 / 343 / 116 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| 示例对象1 e194 | 16 / 274.81 / 295 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Programmer at AFI e195 | 16 / 314.81 / 295 / 20 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Kansas City, Missouri, United States 示例候选人-示例候选人 e198 | 16 / 342.81 / 295 / 48 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 示例候选人-示例候选人 e202 | 16 / 370.81 / 111.08 / 20 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 示例候选人-示例候选人 e205 | 44 / 370.81 / 83.08 / 20 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e206 | 311 / 274.81 / 48 / 48 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Download e209 | 16 / 402.81 / 115.58 / 44 | `10px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Mira's Recommendation e212 | 16 / 458.81 / 343 / 20 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Met 7+ years The candidate has approximately 9.8 years of tota… e213 | 16 / 486.81 / 343 / 60 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Show all 7 criteria e225 | 16 / 728.81 / 122.88 / 24 | `0px`；`6px 0px 0px`；`4px` | `inline-flex/static`；`visible/visible`；`auto` |
| Contact details Email [email] Personal [email] Work Phone Show… e227 | 16 / 768.81 / 343 / 196 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Contact details e228 | 16 / 768.81 / 343 / 44 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e183 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Profile Profile 示例对象1 Programmer at AFI Kansas City, Mis… e184 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | ``；`10.4px 10.4px 0px 0px`；`none` |
| Profile e186 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| Close profile e187 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`none` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e189 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e190 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`12px`；`none` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e191 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象1 Programmer at AFI Kansas City, Missouri, United St… e192 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象1 e194 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Programmer at AFI e195 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Kansas City, Missouri, United States 示例候选人-示例候选人 e198 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例候选人-示例候选人 e202 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例候选人-示例候选人 e205 | `14px / 400 / 20px` | `rgba(0, 0, 0, 0.6)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SPAN容器 e206 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Download e209 | `14px / 500 / 21px` | `rgb(0, 0, 0)`；`rgb(255, 255, 255)` | `1px solid rgb(0, 0, 0)`；`10.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px` |
| Mira's Recommendation e212 | `14px / 500 / 20px` | `rgb(119, 65, 255)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Met 7+ years The candidate has approximately 9.8 years of tota… e213 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Show all 7 criteria e225 | `12px / 600 / 16px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Contact details Email [email] Personal [email] Work Phone Show… e227 | `14px / 400 / 21px` | `rgb(48, 48, 51)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Contact details e228 | `14px / 500 / 20px` | `rgb(82, 82, 82)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |

| 实际文字 / T记录 | x / y / w / h | 字体 / weight / line-height | color |
| --- | --- | --- | --- |
| 示例对象1 T160 | 16 / 274.81 / 139.78 / 32 | `24px / 600 / 32px` | `rgb(23, 29, 38)` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 | `hidden/auto` |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 | `auto/hidden` |
| `div#radix-«r7c» > div:nth-child(4)` | 0 / 254.81 / 390 / 589.19 | 375 / 589 | 375 / 3493 | 0 / 0 | `auto/auto` |
| `div#«r83»` | 16 / 988.81 / 343 / 42 | 343 / 42 | 379 / 42 | 0 / 0 | `auto/auto` |

## 6 Reply 桌面富文本编辑器

证据：[JSON](states/metix-reply-1440.json)、[AX](states/metix-reply-1440.txt)、[截图（匿名布局图）](diagrams/metix-reply-1440.svg)。

视口 `1440×900`，outer `1440×900`，DPR `1`，window scroll `0/0`；document client `1440×900`、scroll `1440×900`。采集 `316` 个元素，truncated=`false`。

编辑卡从线程正文顶端y76插入，高405，外框宽656。介绍提示横条622×58，正文输入外框620×201，其中可编辑呈现区高160，工具行41；下面Cancel与Send introduction & reply高36。编辑器下面历史邮件另成402高滚动框，从y498到视口底。点击Reply只是打开；空正文提交禁用、Cancel退出。表中label `⌘ + Enter` 对应发送按钮的title，视觉文案仍是 Send introduction & reply。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Reply to 示例对象1 e245 | 764 / 76 / 656 / 405 | `16px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Mira will introduce you to 示例对象1 first Your reply will b… e246 | 781 / 93 / 622 / 58 | `10px 12px`；`0px`；`10px` | `flex/static`；`visible/visible`；`auto` |
| A 示例对象16 e247 | 781 / 165 / 622 / 36 | `0px`；`14px 0px 0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| A e248 | 781 / 165 / 36 / 36 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| 示例对象16 e250 | 829 / 173 / 106.61 / 20 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Write your reply to 示例对象1... 0/10000 e251 | 782 / 214 / 620 / 201 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| presentation容器 e252 | 782 / 214 / 620 / 160 | `0px`；`0px`；`normal` | `block/relative`；`auto/auto`；`auto` |
| Reply content area, start typing to enter text. e253 | 782 / 214 / 620 / 150 | `10px 12px`；`0px`；`normal` | `block/relative`；`visible/visible`；`auto` |
| 0/10000 e254 | 782 / 374 / 620 / 41 | `0px 10px 0px 0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| toolbar e255 | 782 / 375 / 527 / 40 | `4px 6px`；`0px`；`4px` | `flex/static`；`auto/auto`；`10` |
| Cancel Send introduction & reply e288 | 781 / 428 / 622 / 36 | `0px`；`12px 0px 0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Cancel e289 | 1103.23 / 428 / 66.5 / 36 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| ⌘ + Enter e290 | 1177.73 / 428 / 225.27 / 36 | `8px 16px`；`0px`；`0px` | `flex/static`；`visible/visible`；`auto` |
| 4 recruiting follow-ups were sent. 5 days ago 示例对象1 <[em… e294 | 744 / 498 / 696 / 402 | `0px`；`0px`；`normal` | `block/static`；`hidden/auto`；`auto` |
| Undo e257 | 829 / 379 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Align left e280 | 1128 / 379 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Align center e282 | 1162 / 379 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Align right e284 | 1196 / 379 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Align justify e286 | 1230 / 379 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| 4 recruiting follow-ups were sent. 5 days ago e297 | 764 / 510 / 645 / 40 | `0px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Reply to 示例对象1 e245 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`12px`；`none` |
| Mira will introduce you to 示例对象1 first Your reply will b… e246 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(244, 240, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`10px`；`none` |
| A 示例对象16 e247 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| A e248 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| 示例对象16 e250 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Write your reply to 示例对象1... 0/10000 e251 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| presentation容器 e252 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Reply content area, start typing to enter text. e253 | `14px / 400 / 22.4px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 0/10000 e254 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| toolbar e255 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px none rgb(51, 51, 51)`；`0px`；`none` |
| Cancel Send introduction & reply e288 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Cancel e289 | `13px / 500 / 19.5px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| ⌘ + Enter e290 | `13px / 600 / 19.5px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| 4 recruiting follow-ups were sent. 5 days ago 示例对象1 <[em… e294 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Undo e257 | `14px / 500 / 16.1px` | `rgba(40, 44, 51, 0.42)`；`rgba(255, 255, 255, 0)` | `0px none rgba(40, 44, 51, 0.42)`；`12px`；`none` |
| Align left e280 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| Align center e282 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| Align right e284 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| Align justify e286 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| 4 recruiting follow-ups were sent. 5 days ago e297 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(244, 244, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |

| 实际文字 / T记录 | x / y / w / h | 字体 / weight / line-height | color |
| --- | --- | --- | --- |
| 0/10000 T216 | 1317 / 389 / 75 / 12 | `12px / 400 / 12px` | `rgb(144, 150, 160)` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 244 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 0 | `hidden/auto` |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(3)` | 744 / 498 / 696 / 402 | 685 / 402 | 685 / 457 | 0 / 0 | `hidden/auto` |

## 7 Reply 手机与工具栏裁切

证据：[JSON](states/metix-reply-390.json)、[AX](states/metix-reply-390.txt)、[截图（匿名布局图）](diagrams/metix-reply-390.svg)。

视口 `390×844`，outer `390×844`，DPR `1`，window scroll `0/0`；document client `390×844`、scroll `390×844`。采集 `228` 个元素，truncated=`false`。

手机线程头部64高，左右padding16，Profile/Reply为36×36图标按钮。回复卡从 `(16,76)` 起宽358、高441；介绍提示因换行增为94高；输入正文仍160高，整编辑框201。截图中的工具栏仅部分图标可见，计数固定在右侧；某些图标rect落到屏外或被父容器裁切，不能把它们当成首屏全显示。Cancel和发送按钮在y464；历史邮件滚动框从y534起，而非整个document变长。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| 示例对象1 <[email]> e144 | 0 / 0 / 390 / 64 | `0px 16px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| 示例对象1 <[email]> e145 | 16 / 10.5 / 358 / 42 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Back to inbox list e147 | 16 / 13.5 / 36 / 36 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e149 | 64 / 13.5 / 36 / 36 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| 示例对象1 <[email]> e150 | 112 / 10.5 / 170 / 42 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| DIV容器 e154 | 294 / 13.5 / 80 / 36 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Profile e155 | 294 / 13.5 / 36 / 36 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Reply e157 | 338 / 13.5 / 36 / 36 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Reply to 示例对象1 e159 | 16 / 76 / 358 / 441 | `16px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Mira will introduce you to 示例对象1 first Your reply will b… e160 | 33 / 93 / 324 / 94 | `10px 12px`；`0px`；`10px` | `flex/static`；`visible/visible`；`auto` |
| A 示例对象16 e161 | 33 / 201 / 324 / 36 | `0px`；`14px 0px 0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Write your reply to 示例对象1... 0/10000 e165 | 34 / 250 / 322 / 201 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| presentation容器 e166 | 34 / 250 / 322 / 160 | `0px`；`0px`；`normal` | `block/relative`；`auto/auto`；`auto` |
| Reply content area, start typing to enter text. e167 | 34 / 250 / 322 / 150 | `10px 12px`；`0px`；`normal` | `block/relative`；`visible/visible`；`auto` |
| 0/10000 e168 | 34 / 410 / 322 / 41 | `0px 10px 0px 0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Strike e186 | 234 / 415 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Align left e194 | 343 / 415 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| Align center e196 | 377 / 415 / 32 / 32 | `8px`；`0px`；`2px` | `flex/static`；`visible/visible`；`auto` |
| 4 recruiting follow-ups were sent. 5 days ago e209 | 16 / 546 / 347 / 40 | `0px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 示例对象1 <[email]> 8 days ago Re: We are hiring: Software E… e212 | 31 / 611 / 317 / 42.5 | `0px`；`0px`；`10px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| 示例对象1 <[email]> e144 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| 示例对象1 <[email]> e145 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back to inbox list e147 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`10px`；`none` |
| SPAN容器 e149 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| 示例对象1 <[email]> e150 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| DIV容器 e154 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Profile e155 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `1px solid rgb(34, 34, 34)`；`8px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Reply e157 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgb(250, 250, 250)` | `1px solid rgb(34, 34, 34)`；`8px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Reply to 示例对象1 e159 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`12px`；`none` |
| Mira will introduce you to 示例对象1 first Your reply will b… e160 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(244, 240, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`10px`；`none` |
| A 示例对象16 e161 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Write your reply to 示例对象1... 0/10000 e165 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| presentation容器 e166 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Reply content area, start typing to enter text. e167 | `14px / 400 / 22.4px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 0/10000 e168 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| Strike e186 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| Align left e194 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| Align center e196 | `14px / 500 / 16.1px` | `rgba(36, 39, 46, 0.78)`；`rgba(255, 255, 255, 0)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`none` |
| 4 recruiting follow-ups were sent. 5 days ago e209 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(244, 244, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| 示例对象1 <[email]> 8 days ago Re: We are hiring: Software E… e212 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |

| 实际文字 / T记录 | x / y / w / h | 字体 / weight / line-height | color |
| --- | --- | --- | --- |
| 0/10000 T158 | 271 / 425 / 75 / 12 | `12px / 400 / 12px` | `rgb(144, 150, 160)` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 | `hidden/auto` |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 | `auto/hidden` |
| `section:nth-child(1) > div:nth-child(3) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1)` | 34 / 411 / 229 / 40 | 229 / 40 | 458 / 40 | 0 / 0 | `auto/auto` |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(3)` | 0 / 534 / 390 / 310 | 379 / 310 | 379 / 475 | 0 / 0 | `hidden/auto` |

## 8 安排面试 桌面第一步

证据：[JSON](states/metix-schedule-step1-1440.json)、[AX](states/metix-schedule-step1-1440.txt)、[截图（匿名布局图）](diagrams/metix-schedule-step1-1440.svg)。

视口 `1440×900`，outer `1440×900`，DPR `1`，window scroll `0/0`；document client `1440×900`、scroll `1440×900`。采集 `369` 个元素，truncated=`false`。

桌面排期dialog总宽1150、right0：`x=1440−1150=290`，z200；遮罩z50。内部左侧708，1px分隔线，右侧440；左padding24、上下16，日历内容宽660；右侧padding24后控件宽392。两列左右不是各占一半。右标题栏64高，内容框自y64起、底部Next固定在y844高40，底留16。日历时间网格是内部滚动，采样时scrollTop608，总时间内容1344。当前初态未选时间，Next禁用。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e279 | 0 / 0 / 1440 / 900 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e280 | 290 / 0 / 1150 / 900 | `0px`；`0px`；`16px` | `flex/fixed`；`visible/visible`；`200` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e281 | 291 / 0 / 1149 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e285 | 291 / 0 / 708 / 900 | `16px 24px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e286 | 315 / 16 / 660 / 868 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e299 | 315 / 64 / 660 / 788 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 e306 | 315 / 64 / 660 / 50 | `0px`；`0px`；`normal` | `block/relative`；`hidden/auto`；`auto` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e324 | 315 / 115 / 660 / 736 | `0px`；`0px`；`normal` | `block/absolute`；`hidden/auto`；`auto` |
| Step 1: Pick times e351 | 1000 / 0 / 440 / 64 | `24px 24px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Step 1: Pick times e352 | 1024 / 28 / 356 / 24 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Scheduling mode e356 | 1024 / 72 / 392 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e357 | 1024 / 74 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Single time One specific interview time. Multiple options Prop… e358 | 1024 / 98 / 392 / 136 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Next e367 | 1024 / 844 / 392 / 40 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Today e288 | 315 / 18 / 65.59 / 32 | `0px 12px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Single time One specific interview time. e359 | 1024 / 98 / 392 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| radio e361 | 1383 / 122 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Multiple options Propose several slots. Candidate picks one. e362 | 1024 / 170 / 392 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| radio e364 | 1383 / 194 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Next e368 | 1024 / 844 / 392 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e279 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e280 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | ``；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklch(0.141 0.005 285.823) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e281 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e285 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e286 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e299 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 e306 | `16px / 700 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e324 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 1: Pick times e351 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 1: Pick times e352 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Scheduling mode e356 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e357 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Single time One specific interview time. Multiple options Prop… e358 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Next e367 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today e288 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Single time One specific interview time. e359 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgb(34, 34, 34) 0px 0px 0px 1.5px inset` |
| radio e361 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px none oklch(0.141 0.005 285.823)`；`0px`；`none` |
| Multiple options Propose several slots. Candidate picks one. e362 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`none` |
| radio e364 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px none oklch(0.141 0.005 285.823)`；`0px`；`none` |
| Next e368 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 244 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 786 | `hidden/auto` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 315 / 115 / 660 / 736 | 649 / 736 | 649 / 1344 | 0 / 608 | `hidden/auto` |

## 9 安排面试 已选单时间

证据：[JSON](states/metix-schedule-selected-1440.json)、[AX](states/metix-schedule-selected-1440.txt)、[截图（匿名布局图）](diagrams/metix-schedule-selected-1440.svg)。

视口 `1440×900`，outer `1440×900`，DPR `1`，window scroll `0/0`；document client `1440×900`、scroll `1440×900`。采集 `389` 个元素，truncated=`false`。

延续同宽桌面dialog。当前时段是12:00 PM–12:30 PM；这是本次新测量的实际选择，不能沿用前一轮截图的11:00或手机版2:00。侧栏新增Start/End日期与时间、Remove time、候选人本地时间和Add time range。已选块坐标受日历scrollTop影响，应该使用记录中的网格/滚动关系，不能绝对定位到页面y值实现。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e280 | 290 / 0 / 1150 / 900 | `0px`；`0px`；`16px` | `flex/fixed`；`visible/visible`；`200` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e285 | 291 / 0 / 708 / 900 | `16px 24px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e299 | 315 / 64 / 660 / 788 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e324 | 315 / 115 / 660 / 736 | `0px`；`0px`；`normal` | `block/absolute`；`hidden/auto`；`auto` |
| 12:00 PM - 12:30 PM e338 | 315 / -493 / 645 / 1344 | `0px`；`0px`；`normal` | `table/static`；`visible/visible`；`auto` |
| Propose times side panel e351 | 1000 / 0 / 440 / 900 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Scheduling mode Single time One specific interview time. Multi… e356 | 1000 / 64 / 440 / 764 | `8px 24px 16px`；`0px`；`24px` | `flex/static`；`auto/auto`；`auto` |
| Close e354 | 1388 / 24 / 32 / 32 | `0px`；`0px -4px 0px 0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Single time One specific interview time. e360 | 1024 / 98 / 392 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| radio e362 | 1383 / 122 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Multiple options Propose several slots. Candidate picks one. e363 | 1024 / 170 / 392 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| radio e365 | 1383 / 194 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Nov 2 e372 | 1033 / 321 / 56.14 / 32 | `0px 8px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 12:00 PM e373 | 1093.14 / 321 / 103.95 / 32 | `8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Nov 2 e377 | 1202 / 321 / 56.14 / 32 | `0px 8px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 12:30 PM e378 | 1262.14 / 321 / 103.81 / 32 | `8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Remove time e381 | 1371 / 297 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Add time range e385 | 1024 / 410 / 392 / 36 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Next e388 | 1024 / 844 / 392 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e280 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | ``；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklch(0.141 0.005 285.823) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e285 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e299 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e324 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 12:00 PM - 12:30 PM e338 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| Propose times side panel e351 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Scheduling mode Single time One specific interview time. Multi… e356 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Close e354 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Single time One specific interview time. e360 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgb(34, 34, 34) 0px 0px 0px 1.5px inset` |
| radio e362 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px none oklch(0.141 0.005 285.823)`；`0px`；`none` |
| Multiple options Propose several slots. Candidate picks one. e363 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`none` |
| radio e365 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px none oklch(0.141 0.005 285.823)`；`0px`；`none` |
| Nov 2 e372 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| 12:00 PM e373 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Nov 2 e377 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| 12:30 PM e378 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Remove time e381 | `14px / 500 / 20px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Add time range e385 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Next e388 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 244 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 786 | `hidden/auto` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 315 / 115 / 660 / 736 | 649 / 736 | 649 / 1344 | 0 / 608 | `hidden/auto` |

## 10 安排面试 桌面定制邀请

证据：[JSON](states/metix-schedule-step2-1440.json)、[AX](states/metix-schedule-step2-1440.txt)、[截图（匿名布局图）](diagrams/metix-schedule-step2-1440.svg)。

视口 `1440×900`，outer `1440×900`，DPR `1`，window scroll `0/0`；document client `1440×900`、scroll `1440×900`。采集 `378` 个元素，truncated=`false`。

Step2保持1150×900大dialog与左侧日历；右侧Guests与两位身份chip、额外邮箱、Location、Online/InPerson、地点/会议地址、Notes依次排列。底部Back宽66.52，gap8，Send invitation317.48。布局不表明后台已发邀请，用户未提交。Notes实测64高，示例候选人1000只来自产品校验文案，非textarea高度限制。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e279 | 0 / 0 / 1440 / 900 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e280 | 290 / 0 / 1150 / 900 | `0px`；`0px`；`16px` | `flex/fixed`；`visible/visible`；`200` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e281 | 291 / 0 / 1149 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e285 | 291 / 0 / 708 / 900 | `16px 24px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Propose times side panel e351 | 1000 / 0 / 440 / 900 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Step 2: Customize invite e352 | 1000 / 0 / 440 / 64 | `24px 24px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Step 2: Customize invite e353 | 1024 / 28 / 356 / 24 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Guests (2) 示例对象2 (Candidate) 示例对象16 (You) Locatio… e356 | 1000 / 64 / 440 / 764 | `8px 24px 16px`；`0px`；`24px` | `flex/static`；`auto/auto`；`auto` |
| Guests (2) e357 | 1024 / 72 / 392 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e358 | 1024 / 74 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| 示例对象2 (Candidate) e360 | 1024 / 98 / 188.22 / 28 | `4px 10px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| 示例对象16 (You) e361 | 1218.22 / 98 / 157.02 / 28 | `4px 10px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Enter email to invite others... e362 | 1024 / 134 / 392 / 36 | `8px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| Location e363 | 1024 / 194 / 392 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Online In Person e365 | 1024 / 220 / 392 / 36 | `2px`；`0px 0px 8px`；`normal` | `inline-flex/static`；`visible/visible`；`auto` |
| Any additional information for the candidate... e373 | 1024 / 350 / 392 / 64 | `8px 12px`；`0px`；`normal` | `flex/static`；`auto/auto`；`auto` |
| Maximum 1000 characters. 0/1000 e374 | 1024 / 418 / 392 / 16 | `0px`；`4px 0px 0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Back Send invitation e375 | 1024 / 844 / 392 / 40 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Back e376 | 1024 / 844 / 66.52 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Send invitation e377 | 1098.52 / 844 / 317.48 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e279 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e280 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | ``；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px` |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e281 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today Oct 31 – Nov 4, 2026 Chicago 10:59 PM GMT-5 SAT 31 SUN 1… e285 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Propose times side panel e351 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 2: Customize invite e352 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 2: Customize invite e353 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Guests (2) 示例对象2 (Candidate) 示例对象16 (You) Locatio… e356 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Guests (2) e357 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e358 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象2 (Candidate) e360 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| 示例对象16 (You) e361 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Enter email to invite others... e362 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Location e363 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Online In Person e365 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Any additional information for the candidate... e373 | `14px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Maximum 1000 characters. 0/1000 e374 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back Send invitation e375 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back e376 | `14px / 500 / 21px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Send invitation e377 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(26, 26, 26)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 244 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 786 | `hidden/auto` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 315 / 115 / 660 / 736 | 649 / 736 | 649 / 1344 | 0 / 608 | `hidden/auto` |

## 11 安排面试 1024 宽桌面态裁切

证据：[JSON](states/metix-schedule-step2-1024.json)、[AX](states/metix-schedule-step2-1024.txt)、[截图（匿名布局图）](diagrams/metix-schedule-step2-1024.svg)。

视口 `1024×768`，outer `1024×768`，DPR `1`，window scroll `0/0`；document client `1024×768`、scroll `1024×768`。采集 `336` 个元素，truncated=`false`。

该捕获AX和控件确认为Step2。视口宽1024但dialog仍宽1150、right0，因此x=-126：左侧126px被视口裁掉。右侧面板仍440宽，从x584开始，控件x608宽392；顶部和底部结构保留，底部动作y712。document.scrollWidth仍1024，说明是视口裁切而不是document横向滚动；不能把该状态描述成已适配到1024的流式dialog。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e238 | -126 / 0 / 1150 / 768 | `0px`；`0px`；`16px` | `flex/fixed`；`visible/visible`；`200` |
| BUTTON容器 e250 | 4.59 / 20 / 28 / 28 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Oct 31 – Nov 4, 2026 e252 | 40.59 / 20 / 185.83 / 28 | `4px 12px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Chicago 10:59 PM GMT-5 e254 | 355.89 / 16 / 203.11 / 36 | `0px 10px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |
| Close e312 | 972 / 24 / 32 / 32 | `0px`；`0px -4px 0px 0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Enter email to invite others... e320 | 608 / 134 / 392 / 36 | `8px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| Online e324 | 610 / 222 / 194 / 32 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| In Person e326 | 804 / 222 / 194 / 32 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| https://example.invalid/resource e328 | 608 / 264 / 392 / 36 | `8px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| Any additional information for the candidate... e331 | 608 / 350 / 392 / 64 | `8px 12px`；`0px`；`normal` | `flex/static`；`auto/auto`；`auto` |
| Back e334 | 608 / 712 / 66.52 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Send invitation e335 | 682.52 / 712 / 317.48 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Schedule Interview - 示例对象2 Today Oct 31 – Nov 4, 2026 Ch… e238 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | ``；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px` |
| BUTTON容器 e250 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Oct 31 – Nov 4, 2026 e252 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Chicago 10:59 PM GMT-5 e254 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Close e312 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Enter email to invite others... e320 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Online e324 | `14px / 500 / 20px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| In Person e326 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| https://example.invalid/resource e328 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Any additional information for the candidate... e331 | `14px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Back e334 | `14px / 500 / 21px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Send invitation e335 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 64 / 176 / 499 / 592 | 488 / 592 | 488 / 1589 | 0 / 786 | `hidden/auto` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | -101 / 115 / 660 / 604 | 649 / 604 | 649 / 1344 | 0 / 608 | `hidden/auto` |

## 12 Multiple options 与 Advanced

证据：[JSON](states/metix-schedule-multiple-advanced-1440.json)、[AX](states/metix-schedule-multiple-advanced-1440.txt)、[截图（匿名布局图）](diagrams/metix-schedule-multiple-advanced-1440.svg)。

视口 `1440×900`，outer `1440×900`，DPR `1`，window scroll `0/0`；document client `1440×900`、scroll `1440×900`。采集 `344` 个元素，truncated=`false`。

该新测量在模式区下面出现Duration36高、当前30min、Advanced28高；展开后Minimum Notice数值与单位各182宽，中间gap8，Avoid conflicts16×16，连接日历为文内按钮。此捕获没有已选时段卡，不把前轮1slot的状态叠加到当前几何。Next当前禁用。Advanced补充只检查Metix AI meetings，连接完整日历入口未执行。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Propose times side panel e308 | 1000 / 0 / 440 / 900 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Step 1: Pick times e309 | 1000 / 0 / 440 / 64 | `24px 24px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Step 1: Pick times e310 | 1024 / 28 / 356 / 24 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Scheduling mode Single time One specific interview time. Multi… e313 | 1000 / 64 / 440 / 764 | `8px 24px 16px`；`0px`；`24px` | `flex/static`；`auto/auto`；`auto` |
| Scheduling mode e314 | 1024 / 72 / 392 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Single time One specific interview time. Multiple options Prop… e316 | 1024 / 98 / 392 / 136 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Duration e323 | 1024 / 258 / 392 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 30 min e325 | 1024 / 284 / 392 / 36 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Times e328 | 1024 / 344 / 392 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Advanced e330 | 1024 / 464 / 392 / 28 | `4px 0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| hours e332 | 1044 / 530 / 372 / 36 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 2 e333 | 1044 / 530 / 182 / 36 | `4px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| hours e334 | 1234 / 530 / 182 / 36 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Avoid conflicts e337 | 1044 / 602 / 372 / 20 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| checkbox容器 e338 | 1044 / 604 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Next e343 | 1024 / 844 / 392 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Single time One specific interview time. e317 | 1024 / 98 / 392 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| radio e319 | 1383 / 122 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Multiple options Propose several slots. Candidate picks one. e320 | 1024 / 170 / 392 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| radio e322 | 1383 / 194 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Propose times side panel e308 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 1: Pick times e309 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 1: Pick times e310 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Scheduling mode Single time One specific interview time. Multi… e313 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Scheduling mode e314 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Single time One specific interview time. Multiple options Prop… e316 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Duration e323 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 30 min e325 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Times e328 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Advanced e330 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| hours e332 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 2 e333 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| hours e334 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Avoid conflicts e337 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| checkbox容器 e338 | `14px / 500 / 20px` | `oklch(0.969 0.016 293.756)`；`rgb(119, 65, 255)` | `1px solid rgb(119, 65, 255)`；`4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px` |
| Next e343 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Single time One specific interview time. e317 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`none` |
| radio e319 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px none oklch(0.141 0.005 285.823)`；`0px`；`none` |
| Multiple options Propose several slots. Candidate picks one. e320 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgb(34, 34, 34) 0px 0px 0px 1.5px inset` |
| radio e322 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px none oklch(0.141 0.005 285.823)`；`0px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 64 / 176 / 499 / 724 | 488 / 724 | 488 / 1589 | 0 / 0 | `hidden/auto` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 315 / 115 / 660 / 736 | 649 / 736 | 649 / 1344 | 0 / 608 | `hidden/auto` |

## 13 低高度1440 × 600

证据：[JSON](states/metix-schedule-short-height.json)、[AX](states/metix-schedule-short-height.txt)、[截图（匿名布局图）](diagrams/metix-schedule-short-height.svg)。

视口 `1440×600`，outer `1440×600`，DPR `1`，window scroll `0/0`；document client `1440×600`、scroll `1440×600`。采集 `344` 个元素，truncated=`false`。

低高度捕获用于确认内部滚动，不将900高度的y844底部按钮坐标套用到600。下表列出dialog和配置/日历的实际滚动框，完整元素定位见JSON。其模式仍为Multiple/Advanced状态；不是自动切换为手机流程。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)` | 64 / 176 / 499 / 424 | 488 / 424 | 488 / 1589 | 0 / 0 | `hidden/auto` |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(2)` | 564 / 64 / 876 / 536 | 865 / 536 | 865 / 653 | 0 / 0 | `hidden/auto` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 315 / 115 / 660 / 436 | 649 / 436 | 649 / 1344 | 0 / 608 | `hidden/auto` |
| `div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(3) > div:nth-child(2)` | 1000 / 64 / 440 / 464 | 429 / 464 | 429 / 612 | 0 / 0 | `auto/auto` |

## 14 手机排期 全屏三日日历

证据：[JSON](states/metix-schedule-mobile-calendar-390.json)、[AX](states/metix-schedule-mobile-calendar-390.txt)、[截图（匿名布局图）](diagrams/metix-schedule-mobile-calendar-390.svg)。

视口 `390×844`，outer `390×844`，DPR `1`，window scroll `0/0`；document client `390×844`、scroll `390×844`。采集 `254` 个元素，truncated=`false`。

手机打开的是单独全屏Schedule面板，z260，宽390高844。页头44高；主体横padding12，日历可用宽366；显示三列Oct31/Nov1/Nov2而非桌面五列。日历head46高，时间网格的viewport从y139开始，内容仍1344高，需要内部滚动。初始未选时没有桌面右侧配置栏；必须点时间后继续手机原生链路。`metix-schedule-step2-390` 是桌面Step2 resize之后重挂载成这个手机日历的捕获，不作为手机Step2证据。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e193 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | 0 / 0 / 390 / 844 | `0px`；`0px`；`0px` | `block/fixed`；`hidden/hidden`；`260` |
| Schedule e197 | 0 / 0 / 390 / 44 | `0px`；`0px`；`normal` | `block/sticky`；`visible/visible`；`50` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e201 | 0 / 44 / 390 / 800 | `8px 12px 0px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e202 | 12 / 52 / 366 / 792 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e210 | 12 / 92 / 366 / 712 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e217 | 12 / 92 / 366 / 46 | `0px`；`0px`；`normal` | `block/relative`；`hidden/auto`；`auto` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e231 | 12 / 139 / 366 / 664 | `0px`；`0px`；`normal` | `block/absolute`；`hidden/auto`；`auto` |
| Preferred interview times e253 | 45.73 / 816 / 165.92 / 16 | `0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Today e205 | 12 / 52 / 56.58 / 32 | `0px 10px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 2026 Oct – Nov e206 | 74.58 / 54 / 149.47 / 28 | `4px 12px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| GMT-5 e208 | 292.59 / 52 / 85.41 / 32 | `0px 10px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e193 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Schedule e197 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e201 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e202 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e210 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e217 | `16px / 700 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e231 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Preferred interview times e253 | `12px / 500 / 16px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today e205 | `12px / 500 / 16px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| 2026 Oct – Nov e206 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| GMT-5 e208 | `14px / 400 / 20px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 | `hidden/auto` |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 | `auto/hidden` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 12 / 139 / 366 / 664 | 355 / 664 | 355 / 1344 | 0 / 680 | `hidden/auto` |

## 15 手机排期 选时间后的Continue

证据：[JSON](states/metix-schedule-mobile-selected-390.json)、[AX](states/metix-schedule-mobile-selected-390.txt)、[截图（匿名布局图）](diagrams/metix-schedule-mobile-selected-390.svg)。

视口 `390×844`，outer `390×844`，DPR `1`，window scroll `0/0`；document client `390×844`、scroll `390×844`。采集 `258` 个元素，truncated=`false`。

选择2:00 PM–2:30 PM后，日历上出现对应时间块e252。底部固定操作区 `(0,748,390,96)`、z40，padding12/16；Continue按钮179×44，位于x105.5/y788，下面留12。该区域使日历可用内容区缩短；不是把整个日历页做document无限增高。Continue之后才弹出手机配置Step1。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | 0 / 0 / 390 / 844 | `0px`；`0px`；`0px` | `block/fixed`；`hidden/hidden`；`260` |
| Schedule e197 | 0 / 0 / 390 / 44 | `0px`；`0px`；`normal` | `block/sticky`；`visible/visible`；`50` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e201 | 0 / 44 / 390 / 800 | `8px 12px 88px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e202 | 12 / 52 / 366 / 704 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e210 | 12 / 92 / 366 / 624 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e217 | 12 / 92 / 366 / 46 | `0px`；`0px`；`normal` | `block/relative`；`hidden/auto`；`auto` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e231 | 12 / 139 / 366 / 576 | `0px`；`0px`；`normal` | `block/absolute`；`hidden/auto`；`auto` |
| 2:00 PM - 2:30 PM e252 | 265.5 / 243 / 90.97 / 27 | `0px`；`0px 0px 1px`；`normal` | `block/absolute`；`visible/visible`；`auto` |
| Preferred interview times  /  Candidate: GMT-7 e253 | 12 / 716 / 366 / 40 | `12px 0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| 1 range selected Continue e255 | 0 / 748 / 390 / 96 | `12px 16px`；`0px`；`normal` | `flex/fixed`；`visible/visible`；`40` |
| 1 range selected Continue e256 | 16 / 760 / 358 / 72 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Continue e257 | 105.5 / 788 / 179 / 44 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Schedule e197 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e201 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM… e202 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7… e210 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e217 | `16px / 700 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 PM… e231 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 2:00 PM - 2:30 PM e252 | `10px / 600 / 15px` | `rgb(119, 65, 255)`；`rgba(0, 0, 0, 0)` | `2px solid rgb(119, 65, 255)`；`6px`；`none` |
| Preferred interview times  /  Candidate: GMT-7 e253 | `12px / 500 / 16px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 1 range selected Continue e255 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px -2px 10px 0px` |
| 1 range selected Continue e256 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Continue e257 | `16px / 600 / 24px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 | `hidden/auto` |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 | `auto/hidden` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 12 / 139 / 366 / 576 | 355 / 576 | 355 / 1344 | 0 / 680 | `hidden/auto` |

## 16 手机排期 Bottom sheet Step1

证据：[JSON](states/metix-schedule-mobile-pick-times-390.json)、[AX](states/metix-schedule-mobile-pick-times-390.txt)、[截图（匿名布局图）](diagrams/metix-schedule-mobile-pick-times-390.svg)。

视口 `390×844`，outer `390×844`，DPR `1`，window scroll `0/0`；document client `390×844`、scroll `390×844`。采集 `294` 个元素，truncated=`false`。

第二层dialog的z265高于手机日历z260；rect `(0,101.28,390,742.72)`，即本次屏高的88%近似结果，只确认当前computed尺寸，不推导所有机型规则。面板内容宽388，左右padding24后控件宽340、x25；Single/Multiple各64高，间gap8。Start/End一行两个日期/时间组，候选人时间另为浅灰底条。Next固定在y787高40，底部17。前景只有底部sheet可操作，下面的日历仅背景。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | 0 / 0 / 390 / 844 | `0px`；`0px`；`0px` | `block/fixed`；`hidden/hidden`；`260` |
| Step 1: Pick times Scheduling mode Single time One specific in… e256 | 0 / 101.28 / 390 / 742.72 | `0px`；`0px`；`normal` | `flex/fixed`；`hidden/hidden`；`265` |
| Step 1: Pick times Scheduling mode Single time One specific in… e257 | 1 / 123.28 / 388 / 719.72 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| Propose times side panel e258 | 1 / 123.28 / 388 / 719.72 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Step 1: Pick times e259 | 1 / 123.28 / 388 / 40 | `8px 24px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Scheduling mode Single time One specific interview time. Multi… e261 | 1 / 163.28 / 388 / 607.72 | `8px 24px 16px`；`0px`；`24px` | `flex/static`；`auto/auto`；`auto` |
| Scheduling mode e262 | 25 / 171.28 / 340 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Single time One specific interview time. Multiple options Prop… e264 | 25 / 197.28 / 340 / 136 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Single time One specific interview time. e265 | 25 / 197.28 / 340 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Multiple options Propose several slots. Candidate picks one. e268 | 25 / 269.28 / 340 / 64 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Times e271 | 25 / 357.28 / 340 / 20 | `0px`；`0px 0px 6px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Times e272 | 25 / 357.28 / 61.89 / 20 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e273 | 25 / 359.28 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Start Nov 2 2:00 PM End Nov 2 2:30 PM e274 | 38 / 396.28 / 314 / 56 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Start Nov 2 2:00 PM End Nov 2 2:30 PM e275 | 38 / 396.28 / 274 / 56 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Remove time e286 | 320 / 396.28 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Add time range e290 | 25 / 509.28 / 340 / 36 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e291 | 130.69 / 519.28 / 16 / 16 | `0px`；`0px 4px 0px 0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Next e292 | 25 / 787 / 340 / 40 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Next e293 | 25 / 787 / 340 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Step 1: Pick times Scheduling mode Single time One specific in… e256 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `1px solid rgb(235, 235, 235)`；`10.4px 10.4px 0px 0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.18) 0px -12px 40px 0px` |
| Step 1: Pick times Scheduling mode Single time One specific in… e257 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Propose times side panel e258 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 1: Pick times e259 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Scheduling mode Single time One specific interview time. Multi… e261 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Scheduling mode e262 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Single time One specific interview time. Multiple options Prop… e264 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Single time One specific interview time. e265 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`rgb(34, 34, 34) 0px 0px 0px 1.5px inset` |
| Multiple options Propose several slots. Candidate picks one. e268 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgba(0, 0, 0, 0)`；`8.4px`；`none` |
| Times e271 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Times e272 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e273 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Start Nov 2 2:00 PM End Nov 2 2:30 PM e274 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Start Nov 2 2:00 PM End Nov 2 2:30 PM e275 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Remove time e286 | `14px / 500 / 20px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Add time range e290 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| svg容器 e291 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Next e292 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Next e293 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 | `hidden/auto` |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 | `auto/hidden` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 12 / 139 / 366 / 664 | 355 / 664 | 355 / 1344 | 0 / 680 | `hidden/auto` |

## 17 手机排期 Bottom sheet Step2

证据：[JSON](states/metix-schedule-mobile-customize-390.json)、[AX](states/metix-schedule-mobile-customize-390.txt)、[截图（匿名布局图）](diagrams/metix-schedule-mobile-customize-390.svg)。

视口 `390×844`，outer `390×844`，DPR `1`，window scroll `0/0`；document client `390×844`、scroll `390×844`。采集 `283` 个元素，truncated=`false`。

由手机Step1点击Next实际进入的定制邀请，不是resize推测。底部sheet位置与大小保持；两个Guests身份chip因窄宽度换成上下两行，邮箱输入y267.28，Location切换y355.28，Notes y483.28。Back66.52、gap8、发送265.48，合为340可用宽；底部y787。Cancel/关闭和发送结果参见PRD，不在测量时提交。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | 0 / 0 / 390 / 844 | `0px`；`0px`；`0px` | `block/fixed`；`hidden/hidden`；`260` |
| Step 2: Customize invite Guests (2) 示例对象2 (Candidate) Ad… e256 | 0 / 101.28 / 390 / 742.72 | `0px`；`0px`；`normal` | `flex/fixed`；`hidden/hidden`；`265` |
| Step 2: Customize invite Guests (2) 示例对象2 (Candidate) Ad… e257 | 1 / 123.28 / 388 / 719.72 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| Propose times side panel e258 | 1 / 123.28 / 388 / 719.72 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Step 2: Customize invite e259 | 1 / 123.28 / 388 / 40 | `8px 24px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Guests (2) 示例对象2 (Candidate) 示例对象16 (You) Locatio… e261 | 1 / 163.28 / 388 / 607.72 | `8px 24px 16px`；`0px`；`24px` | `flex/static`；`auto/auto`；`auto` |
| Guests (2) e262 | 25 / 171.28 / 340 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 示例对象2 (Candidate) 示例对象16 (You) e264 | 25 / 197.28 / 340 / 62 | `0px`；`0px 0px 8px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 示例对象2 (Candidate) e265 | 25 / 197.28 / 188.22 / 28 | `4px 10px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Enter email to invite others... e267 | 25 / 267.28 / 340 / 36 | `8px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| Location e268 | 25 / 327.28 / 340 / 20 | `0px`；`0px 0px 6px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Online In Person e270 | 25 / 353.28 / 340 / 36 | `2px`；`0px 0px 8px`；`normal` | `inline-flex/static`；`visible/visible`；`auto` |
| Online e271 | 27 / 355.28 / 168 / 32 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| In Person e273 | 195 / 355.28 / 168 / 32 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| https://example.invalid/resource e275 | 25 / 397.28 / 340 / 36 | `8px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| Any additional information for the candidate... e278 | 25 / 483.28 / 340 / 64 | `8px 12px`；`0px`；`normal` | `flex/static`；`auto/auto`；`auto` |
| Maximum 1000 characters. 0/1000 e279 | 25 / 551.28 / 340 / 16 | `0px`；`4px 0px 0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Back Send invitation e280 | 25 / 787 / 340 / 40 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Back e281 | 25 / 787 / 66.52 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Send invitation e282 | 99.52 / 787 / 265.48 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Schedule Interview Pick interview times for this candidate. Sc… e194 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Step 2: Customize invite Guests (2) 示例对象2 (Candidate) Ad… e256 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `1px solid rgb(235, 235, 235)`；`10.4px 10.4px 0px 0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.18) 0px -12px 40px 0px` |
| Step 2: Customize invite Guests (2) 示例对象2 (Candidate) Ad… e257 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Propose times side panel e258 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Step 2: Customize invite e259 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Guests (2) 示例对象2 (Candidate) 示例对象16 (You) Locatio… e261 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Guests (2) e262 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象2 (Candidate) 示例对象16 (You) e264 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 示例对象2 (Candidate) e265 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Enter email to invite others... e267 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Location e268 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Online In Person e270 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Online e271 | `14px / 500 / 20px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| In Person e273 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| https://example.invalid/resource e275 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Any additional information for the candidate... e278 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Maximum 1000 characters. 0/1000 e279 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back Send invitation e280 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back e281 | `14px / 500 / 21px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Send invitation e282 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(26, 26, 26)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

内部实际滚动框如下。底层Inbox若被遮罩盖住，虽记录在此，也不属于当前可操作前景。

| selector | rect x/y/w/h | client w/h | scroll w/h | left/top | overflow x/y |
| --- | --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 | `hidden/auto` |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 | `auto/hidden` |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 12 / 139 / 366 / 664 | 355 / 664 | 355 / 1344 | 0 / 680 | `hidden/auto` |

## 18 属性和交互复刻注意

- 单侧边框和四角半径以各文件 `boxDetails` 对应 eN 为准。只有 `matched=1` 的记录可明确关联当前selector；简写border为空不能解释为四边均为0。
- 元素显式disabled、ariaChecked、ariaSelected、ariaExpanded均在原记录；不能仅凭颜色判断。工具栏按钮可能在DOM中有rect但被祖先overflow裁掉，首屏显示必须结合截图。
- 进入动画的中间坐标、隐藏AX副本坐标、被遮罩盖住的背景都不是最终设计尺寸。负四万坐标附近的Profile副本是离屏副本，绝不能生成到复刻页面。
- transform/transition记录只证明计算样式，不证明动画完整时序或交互已经执行。本次观察不包括鼠标悬停、按下和所有focus-visible的独立截图，未知态不得填造。
- 页面高度必须同时看document与scrollContainers。document等于viewport时，内部列表、资料正文和日历时间轴仍可能有数千像素内容。

## 19 Interview 桌面日历与活动栏

证据：[JSON](states/metix-interview-1440.json)、[AX](states/metix-interview-1440.txt)、[截图（匿名布局图）](diagrams/metix-interview-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `132`，truncated=`false`。

本次侧栏人为保持收起状态，宽64；不能据此说1440必定只有64侧栏。主体区域1376宽，在x92处进入1320宽内容：日历1004、gap16、活动栏300。日历外框padding16使内框972；内容区高808，即从y72到880，距视口底20。日历时间区viewport高676，总内容1344、scrollTop668。空态卡280×219.59浮在时间网格内，右栏空态单独呈现。Today/前后箭头/范围/时区同行。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Interview All Roles All Status Today Oct 31 – Nov 4, 2026 Ch… e50 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Interview All Roles All Status e52 | 92 / 24 / 1320 / 32 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| All Roles e54 | 1191.69 / 24 / 103.13 / 32 | `6px 14px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| All Status e56 | 1302.81 / 24 / 109.19 / 32 | `6px 14px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Today Oct 31 – Nov 4, 2026 Chicago 11:02 PM GMT-5 SAT 31 SUN… e58 | 92 / 72 / 1320 / 808 | `0px`；`0px 8px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| Today Oct 31 – Nov 4, 2026 Chicago 11:02 PM GMT-5 SAT 31 SUN… e59 | 92 / 72 / 1004 / 808 | `16px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| Today Oct 31 – Nov 4, 2026 Chicago 11:02 PM GMT-5 SAT 31 SUN… e60 | 108 / 88 / 972 / 776 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/auto`；`auto` |
| Today e64 | 108 / 90 / 65.59 / 32 | `0px 12px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| BUTTON容器 e66 | 181.59 / 92 / 28 / 28 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| BUTTON容器 e68 | 213.59 / 92 / 28 / 28 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Oct 31 – Nov 4, 2026 e70 | 249.59 / 92 / 185.83 / 28 | `4px 12px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Chicago 11:02 PM GMT-5 e72 | 879.34 / 88 / 200.66 / 36 | `0px 10px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 e79 | 108 / 136 / 972 / 51 | `0px`；`0px`；`normal` | `table-header-group/static`；`visible/visible`；`auto` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 e82 | 108 / 136 / 972 / 50 | `0px`；`0px`；`normal` | `block/relative`；`hidden/auto`；`auto` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 … e101 | 108 / -481 / 957 / 1344 | `0px`；`0px`；`normal` | `table/static`；`visible/visible`；`auto` |
| No interviews this week Try another week. e124 | 454 / 366.2 / 280 / 219.59 | `16px 20px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| All Activity No activity yet e126 | 1112 / 72 / 300 / 808 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| All Activity e127 | 1128 / 84 / 268 / 20 | `0px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| No activity yet e129 | 1112 / 117 / 300 / 763 | `12px 0px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| No activity yet e130 | 1112 / 129 / 300 / 221.59 | `32px 16px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Interview All Roles All Status Today Oct 31 – Nov 4, 2026 Ch… e50 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Interview All Roles All Status e52 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| All Roles e54 | `13px / 500 / 19.5px` | `rgb(91, 90, 84)`；`rgb(255, 255, 255)` | `1px solid rgb(231, 229, 223)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| All Status e56 | `13px / 500 / 19.5px` | `rgb(91, 90, 84)`；`rgb(255, 255, 255)` | `1px solid rgb(231, 229, 223)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Today Oct 31 – Nov 4, 2026 Chicago 11:02 PM GMT-5 SAT 31 SUN… e58 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today Oct 31 – Nov 4, 2026 Chicago 11:02 PM GMT-5 SAT 31 SUN… e59 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`16px`；`none` |
| Today Oct 31 – Nov 4, 2026 Chicago 11:02 PM GMT-5 SAT 31 SUN… e60 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today e64 | `14px / 500 / 20px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| BUTTON容器 e66 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| BUTTON容器 e68 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Oct 31 – Nov 4, 2026 e70 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Chicago 11:02 PM GMT-5 e72 | `14px / 400 / 20px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 e79 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT 31 SUN 1 MON 2 TUE 3 WED 4 e82 | `16px / 700 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| 1 AM 2 AM 3 AM 4 AM 5 AM 6 AM 7 AM 8 AM 9 AM 10 AM 11 AM 12 … e101 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| No interviews this week Try another week. e124 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`8px`；`rgba(0, 0, 0, 0.08) 0px 1px 10px 0px` |
| All Activity No activity yet e126 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`16px`；`none` |
| All Activity e127 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No activity yet e129 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No activity yet e130 | `14px / 400 / 20px` | `rgb(153, 153, 153)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 108 / 187 / 972 / 676 | 961 / 676 | 961 / 1344 | 0 / 668 |

## 20 Interview 手机三日历与Activity折叠入口

证据：[JSON](states/metix-interview-390.json)、[AX](states/metix-interview-390.txt)、[截图（匿名布局图）](diagrams/metix-interview-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `76`，truncated=`false`。

手机全宽390，顶标题44加筛选行46合为sticky90高；主体从y90到844，可用754。日历宽358、左右外边16；内部再padding16，可用时间网格326宽，显示三日，不是桌面五列。活动区从桌面右侧300宽栏变为日历下方358×58的Activity按钮。当前截图没有展开Activity详情，不推导其展开内容。图表时间轴内部544高、总1344、scrollTop800；document仍844。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Interview All Roles All Status Today 2026 Oct – Nov GMT-5 SA… e1 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/static`；`hidden/auto`；`auto` |
| Interview All Roles All Status e4 | 0 / 0 / 390 / 90 | `0px`；`0px`；`normal` | `block/sticky`；`visible/visible`；`20` |
| Interview e5 | 0 / 0 / 390 / 44 | `0px 20px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| All Roles All Status e8 | 0 / 44 / 390 / 46 | `2px 16px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| All Roles e9 | 16 / 46 / 91.67 / 32 | `6px 10px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| All Status e11 | 115.67 / 46 / 97.34 / 32 | `6px 10px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e13 | 0 / 90 / 390 / 754 | `0px 16px 16px`；`0px`；`normal` | `flex/static`；`auto/auto`；`auto` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e14 | 16 / 90 / 358 / 738 | `0px`；`0px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e15 | 16 / 90 / 358 / 664 | `16px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e16 | 32 / 106 / 326 / 632 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/auto`；`auto` |
| Today e21 | 32 / 106 / 56.58 / 32 | `0px 10px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| 2026 Oct – Nov e22 | 94.58 / 108 / 149.47 / 28 | `4px 12px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| GMT-5 e24 | 272.59 / 106 / 85.41 / 32 | `0px 10px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e30 | 32 / 146 / 326 / 47 | `0px`；`0px`；`normal` | `table-header-group/static`；`visible/visible`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e33 | 32 / 146 / 326 / 46 | `0px`；`0px`；`normal` | `block/relative`；`hidden/auto`；`auto` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e34 | 32 / 146 / 311 / 46 | `0px`；`0px`；`normal` | `table/static`；`visible/visible`；`auto` |
| No interviews this week Try another week. e69 | 55 / 312.2 / 280 / 219.59 | `16px 20px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Activity No activity yet e71 | 16 / 770 / 358 / 58 | `10px 12px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Interview All Roles All Status Today 2026 Oct – Nov GMT-5 SA… e1 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Interview All Roles All Status e4 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Interview e5 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| All Roles All Status e8 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| All Roles e9 | `12px / 500 / 16px` | `rgb(68, 68, 68)`；`rgb(255, 255, 255)` | `1px solid rgb(224, 224, 224)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| All Status e11 | `12px / 500 / 16px` | `rgb(68, 68, 68)`；`rgb(255, 255, 255)` | `1px solid rgb(224, 224, 224)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e13 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e14 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e15 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`16px`；`none` |
| Today 2026 Oct – Nov GMT-5 SAT Oct 31 SUN Nov 1 MON Nov 2 1 … e16 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Today e21 | `12px / 500 / 16px` | `rgb(34, 34, 34)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| 2026 Oct – Nov e22 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.606 0.25 292.717)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklab(0.606 0.096545 -0.230606 / 0.5) 0px 0px 0px 3px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| GMT-5 e24 | `14px / 400 / 20px` | `oklch(0.21 0.006 285.885)`；`oklch(0.967 0.001 286.375)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e30 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e33 | `16px / 700 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SAT Oct 31 SUN Nov 1 MON Nov 2 e34 | `16px / 700 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| No interviews this week Try another week. e69 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`8px`；`rgba(0, 0, 0, 0.08) 0px 1px 10px 0px` |
| Activity No activity yet e71 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`14.4px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 32 / 193 / 326 / 544 | 315 / 544 | 315 / 1344 | 0 / 800 |

## 21 Interview 状态菜单

证据：[JSON](states/metix-interview-status-menu-1440.json)、[AX](states/metix-interview-status-menu-1440.txt)、[截图（匿名布局图）](diagrams/metix-interview-status-menu-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `151`，truncated=`false`。

状态弹层由All Status触发，外框 `(1232,60,180,183)`，z50；每个可点击状态行162×28，水平内缩9。All Status在顶，分隔后Invited/Confirmed/Declined/Expired，各行32步进。实际checkbox选中态在ariaChecked中，不能从方框图标猜测。菜单在页面右上就近展开，不是居中modal。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| All Status e56 | 1302.81 / 24 / 109.19 / 32 | `6px 14px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| All Status Invited Confirmed Declined Expired e132 | 1232 / 60 / 180 / 183 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| All Status Invited Confirmed Declined Expired e133 | 1232 / 60 / 180 / 183 | `8px`；`0px`；`normal` | `block/static`；`visible/visible`；`50` |
| All Status Invited Confirmed Declined Expired e134 | 1241 / 69 / 162 / 165 | `0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| All Status e135 | 1241 / 69 / 162 / 28 | `6px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e136 | 1249 / 75 / 16 / 16 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e137 | 1251 / 77 / 12 / 12 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Invited e139 | 1241 / 110 / 162 / 28 | `6px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e140 | 1249 / 116 / 16 / 16 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Confirmed e142 | 1241 / 142 / 162 / 28 | `6px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e143 | 1249 / 148 / 16 / 16 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Declined e145 | 1241 / 174 / 162 / 28 | `6px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e146 | 1249 / 180 / 16 / 16 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Expired e148 | 1241 / 206 / 162 / 28 | `6px 8px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e149 | 1249 / 212 / 16 / 16 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| All Status e56 | `13px / 500 / 19.5px` | `rgb(91, 90, 84)`；`rgb(255, 255, 255)` | `1px solid rgb(216, 215, 209)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| All Status Invited Confirmed Declined Expired e132 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| All Status Invited Confirmed Declined Expired e133 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgb(255, 255, 255)` | `1px solid rgb(224, 224, 224)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px` |
| All Status Invited Confirmed Declined Expired e134 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| All Status e135 | `12px / 500 / 16px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`none` |
| SPAN容器 e136 | `12px / 500 / 16px` | `oklch(0.969 0.016 293.756)`；`oklch(0.606 0.25 292.717)` | `1px solid oklch(0.606 0.25 292.717)`；`4px`；`none` |
| svg容器 e137 | `12px / 500 / 16px` | `oklch(0.969 0.016 293.756)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Invited e139 | `12px / 400 / 16px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`none` |
| SPAN容器 e140 | `12px / 400 / 16px` | `oklch(0.969 0.016 293.756)`；`oklch(0.606 0.25 292.717)` | `1px solid oklch(0.606 0.25 292.717)`；`4px`；`none` |
| Confirmed e142 | `12px / 400 / 16px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`none` |
| SPAN容器 e143 | `12px / 400 / 16px` | `oklch(0.969 0.016 293.756)`；`oklch(0.606 0.25 292.717)` | `1px solid oklch(0.606 0.25 292.717)`；`4px`；`none` |
| Declined e145 | `12px / 400 / 16px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`none` |
| SPAN容器 e146 | `12px / 400 / 16px` | `oklch(0.969 0.016 293.756)`；`oklch(0.606 0.25 292.717)` | `1px solid oklch(0.606 0.25 292.717)`；`4px`；`none` |
| Expired e148 | `12px / 400 / 16px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`none` |
| SPAN容器 e149 | `12px / 400 / 16px` | `oklch(0.969 0.016 293.756)`；`oklch(0.606 0.25 292.717)` | `1px solid oklch(0.606 0.25 292.717)`；`4px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 108 / 187 / 972 / 676 | 961 / 676 | 961 / 1344 | 0 / 668 |

## 22 Interview 日期选择器

证据：[JSON](states/metix-interview-datepicker-1440.json)、[AX](states/metix-interview-datepicker-1440.txt)、[截图（匿名布局图）](diagrams/metix-interview-datepicker-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `212`，truncated=`false`。

日期范围下方弹出月历。月份导航按钮32×32，日格实测约36.56–36.58方形；分数像素来自七列分配，不能全部四舍五入后强行整齐导致累积误差。仅列首周部分格和已观察选择样例，其余日期相同来源见完整JSON。日期弹层与日历主体是不同组件，不把日期格坐标当面试事件格。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Oct 31 – Nov 4, 2026 e70 | 249.59 / 92 / 185.83 / 28 | `4px 12px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| October 2026 Su Mo Tu We Th Fr Sa 27 28 29 30 1 2 3 4 5 6 7 … e73 | 262.59 / 137 / 256 / 290.08 | `0px`；`0px`；`16px` | `flex/relative`；`visible/visible`；`auto` |
| Navigation bar e74 | 262.59 / 137 / 256 / 32 | `0px`；`0px`；`4px` | `flex/absolute`；`visible/visible`；`auto` |
| Go to the Previous Month e75 | 262.59 / 137 / 32 / 32 | `0px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Go to the Next Month e77 | 486.59 / 137 / 32 / 32 | `0px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| October 2026 Su Mo Tu We Th Fr Sa 27 28 29 30 1 2 3 4 5 6 7 … e79 | 262.59 / 137 / 256 / 290.08 | `0px`；`0px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| October 2026 e80 | 262.59 / 137 / 256 / 32 | `0px 32px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| October 2026 e82 | 262.59 / 185 / 256 / 242.08 | `0px`；`0px`；`normal` | `table/static`；`visible/visible`；`auto` |
| Su Mo Tu We Th Fr Sa e83 | 262.59 / 185 / 256 / 19.19 | `0px`；`0px`；`normal` | `table-header-group/static`；`visible/visible`；`auto` |
| Su Mo Tu We Th Fr Sa e84 | 262.59 / 185 / 256 / 19.19 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Sunday, September 27th, 2026 e94 | 262.59 / 212.19 / 36.58 / 36.58 | `0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Monday, September 28th, 2026 e96 | 299.17 / 212.19 / 36.56 / 36.56 | `0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Thursday, October 1st, 2026 e102 | 408.88 / 212.19 / 36.58 / 36.58 | `0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |
| Wednesday, October 21st, 2026 e145 | 372.31 / 345.92 / 36.56 / 36.56 | `0px`；`0px`；`4px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Oct 31 – Nov 4, 2026 e70 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| October 2026 Su Mo Tu We Th Fr Sa 27 28 29 30 1 2 3 4 5 6 7 … e73 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Navigation bar e74 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Go to the Previous Month e75 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px` |
| Go to the Next Month e77 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px` |
| October 2026 Su Mo Tu We Th Fr Sa 27 28 29 30 1 2 3 4 5 6 7 … e79 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| October 2026 e80 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| October 2026 e82 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Su Mo Tu We Th Fr Sa e83 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Su Mo Tu We Th Fr Sa e84 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Sunday, September 27th, 2026 e94 | `14px / 400 / 14px` | `oklch(0.552 0.016 285.938)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Monday, September 28th, 2026 e96 | `14px / 400 / 14px` | `oklch(0.552 0.016 285.938)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Thursday, October 1st, 2026 e102 | `14px / 400 / 14px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Wednesday, October 21st, 2026 e145 | `14px / 400 / 14px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 108 / 187 / 972 / 676 | 961 / 676 | 961 / 1344 | 0 / 668 |

## 23 Candidate List 桌面两列网格

证据：[JSON](states/metix-candidates-1440.json)、[AX](states/metix-candidates-1440.txt)、[截图（匿名布局图）](diagrams/metix-candidates-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `433`，truncated=`false`。

1440下侧栏244，角色头64，列表header64、阶段tab32、评分32，候选人区域从y233起高667。网格 `(288.5,233,1096,750)`，computed两列540和540、columnGap16；首卡540×238，第二卡540×240，行高由较高卡决定。卡片整体padding16px 0px，内部header再有水平20px等结构，不能把Inbox整卡padding16直接复用于此。背景chat在DOM仍有独立滚动与高度，不是当前可见内容栏。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e92 | 244 / 0 / 1196 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Software Engineer, Data Infra Describe the role Find Candida… e95 | 244 / 0 / 1196 / 64 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Software Engineer, Data Infra Describe the role Find Candida… e96 | 244 / 0 / 1196 / 63 | `0px 24px`；`0px`；`20px` | `flex/static`；`visible/visible`；`auto` |
| Software Engineer, Data Infra e98 | 268 / 14.13 / 339.28 / 34.75 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Edit role name e100 | 589.28 / 23.88 / 18 / 18 | `2px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| https://example.invalid/resource e120 | 244 / 64 / 1196 / 836 | `0px`；`0px`；`normal` | `grid/static`；`hidden/hidden`；`auto` |
| Candidate List e285 | 244 / 64 / 1196 / 64 | `20px 16px 12px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Back to chat e287 | 260 / 84 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Candidate List e291 | 304 / 88 / 109.31 / 24 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Interview e294 | 260 / 128 / 88.44 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Interested 6 e295 | 352.44 / 128 / 109 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Contact 303 e296 | 465.44 / 128 / 108.42 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Match 307 e297 | 577.86 / 128 / 96.45 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Score: All scores e299 | 294 / 185 / 208 / 32 | `0px 10px`；`0px`；`6px` | `inline-flex/static`；`visible/visible`；`auto` |
| 示例对象1 Worth Talking Kansas City, Missouri, United Stat… e301 | 244 / 233 / 1196 / 667 | `0px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Candidate list e303 | 288.5 / 233 / 1096 / 750 | `0px`；`0px 28.5px`；`16px` | `grid/static`；`visible/visible`；`auto` |
| Open 示例对象1's profile e304 | 288.5 / 233 / 540 / 238 | `16px 0px`；`0px`；`normal` | `block/relative`；`hidden/hidden`；`auto` |
| 示例对象1 Worth Talking Kansas City, Missouri, United States e306 | 309.5 / 250 / 502 / 54 | `0px`；`0px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| Software Engineer  /  示例对象20 Dec 2025 – Presen… e313 | 309.5 / 316 / 502 / 86 | `0px`；`12px 0px 0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Open 示例对象9's profile e325 | 844.5 / 233 / 540 / 240 | `16px 0px`；`0px`；`normal` | `block/relative`；`hidden/hidden`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e92 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Software Engineer, Data Infra Describe the role Find Candida… e95 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| Software Engineer, Data Infra Describe the role Find Candida… e96 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Software Engineer, Data Infra e98 | `24px / 600 / 32px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Edit role name e100 | `24px / 600 / 32px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`none` |
| https://example.invalid/resource e120 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Candidate List e285 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back to chat e287 | `14px / 500 / 20px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Candidate List e291 | `16px / 600 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Interview e294 | `15px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Interested 6 e295 | `15px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Contact 303 e296 | `15px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Match 307 e297 | `15px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Score: All scores e299 | `13px / 500 / 19.5px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`none` |
| 示例对象1 Worth Talking Kansas City, Missouri, United Stat… e301 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Candidate list e303 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Open 示例对象1's profile e304 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`16px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| 示例对象1 Worth Talking Kansas City, Missouri, United States e306 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Software Engineer  /  示例对象20 Dec 2025 – Presen… e313 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Open 示例对象9's profile e325 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`16px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 244 / 64 / 520 / 836 | 509 / 836 | 509 / 3945 | 0 / 3093 |
| `div:nth-child(1) > section:nth-child(1) > div:nth-child(1) > div:nth-child(3) > div:nth-child(1)` | 281 / 402 / 435 / 54.5 | 435 / 40 | 446 / 40 | 0 / 0 |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(4) > div:nth-child(1)` | 244 / 233 / 1196 / 667 | 1185 / 667 | 1185 / 774 | 0 / 0 |

## 24 Candidate List 手机与横向阶段条

证据：[JSON](states/metix-candidates-390.json)、[AX](states/metix-candidates-390.txt)、[截图（匿名布局图）](diagrams/metix-candidates-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `179`，truncated=`false`。

手机角色头44，进度条第二行，Candidate List面板从y89开始。阶段标签容器宽358、overflow auto，四个标签总宽超过容器，因此Match标签一部分可在屏外，用户需要横向滚动；不能把屏外tab坐标当已完全可见。评分从y221开始，候选人区y269高575，内部总内容1588。网格改为单列，首卡347宽。1024捕获仍为桌面结构，具体双列宽/控件位置见metix-candidates-1024，不能只用390与1440线性插值。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e1 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/static`；`hidden/auto`；`auto` |
| Software Engineer, Data Infra e5 | 0 / 0 / 390 / 44 | `0px 20px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Open navigation menu e7 | 20 / 7 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Open role overview e11 | 338 / 6 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Describe the role e16 | 95.39 / 48 / 26 / 32 | `0px 4px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Find Candidates e20 | 145.39 / 48 / 132.61 / 32 | `0px 10px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Outreach e24 | 302 / 48 / 26 / 32 | `0px 4px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Interview e28 | 352 / 48 / 26 / 32 | `0px 4px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Candidate List Interview Interested 6 Contact 303 Match 307 … e30 | 0 / 89 / 390 / 755 | `0px`；`0px`；`normal` | `flex/absolute`；`hidden/hidden`；`auto` |
| Candidate List e32 | 0 / 89 / 390 / 64 | `20px 16px 12px`；`0px`；`10px` | `flex/static`；`visible/visible`；`auto` |
| Back e33 | 16 / 109 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Candidate List e37 | 58 / 115 / 103.3 / 20 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Candidate stages e38 | 0 / 153 / 390 / 52 | `0px 16px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Interview Interested 6 Contact 303 Match 307 e39 | 16 / 153 / 358 / 52 | `0px 0px 8px`；`0px`；`4px` | `flex/static`；`auto/auto`；`auto` |
| Interview e40 | 16 / 153 / 88.44 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Interested 6 e41 | 108.44 / 153 / 109 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Contact 303 e42 | 221.44 / 153 / 108.42 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Match 307 e43 | 333.86 / 153 / 96.45 / 32 | `0px 12px`；`0px`；`6px` | `flex/relative`；`visible/visible`；`auto` |
| Score: All scores e45 | 16 / 221 / 208 / 32 | `0px 10px`；`0px`；`6px` | `inline-flex/static`；`visible/visible`；`auto` |
| Open 示例对象1's profile e50 | 16 / 269 / 347 / 238 | `16px 0px`；`0px`；`normal` | `block/relative`；`hidden/hidden`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e1 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Software Engineer, Data Infra e5 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Open navigation menu e7 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Open role overview e11 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Describe the role e16 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Find Candidates e20 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(243, 243, 243)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Outreach e24 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Interview e28 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Candidate List Interview Interested 6 Contact 303 Match 307 … e30 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Candidate List e32 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back e33 | `14px / 500 / 20px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Candidate List e37 | `15px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Candidate stages e38 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Interview Interested 6 Contact 303 Match 307 e39 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| Interview e40 | `15px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Interested 6 e41 | `15px / 500 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Contact 303 e42 | `15px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Match 307 e43 | `15px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Score: All scores e45 | `13px / 500 / 19.5px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`none` |
| Open 示例对象1's profile e50 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`16px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > nav:nth-child(2) > div:nth-child(1)` | 16 / 153 / 358 / 52 | 358 / 40 | 414 / 40 | 0 / 0 |
| `div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(4) > div:nth-child(1)` | 0 / 269 / 390 / 575 | 379 / 575 | 379 / 1588 | 0 / 0 |

## 25 评分菜单

证据：[JSON](states/metix-score-menu-1440.json)、[AX](states/metix-score-menu-1440.txt)、[截图（匿名布局图）](diagrams/metix-score-menu-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `443`，truncated=`false`。

评分菜单absolute/z50，rect `(294,221,176,138)`，四项各166×32，x299、y226/258/290/322，当前计数6/3/3/0；不在UI层重算评级。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 244 / 64 / 520 / 836 | 509 / 836 | 509 / 3945 | 0 / 3093 |
| `div:nth-child(1) > section:nth-child(1) > div:nth-child(1) > div:nth-child(3) > div:nth-child(1)` | 281 / 402 / 435 / 54.5 | 435 / 40 | 446 / 40 | 0 / 0 |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(4) > div:nth-child(1)` | 244 / 233 / 1196 / 667 | 1185 / 667 | 1185 / 774 | 0 / 0 |

| 组件 / E记录 | x / y / w / h | padding；margin；gap | 字体size/weight/line-height；color | border；radius；background；overflow；z |
| --- | --- | --- | --- | --- |
| Score: All scores e299 | 294 / 185 / 208 / 32 | `0px 10px`；`0px`；`6px` | `13px/500/19.5px`；`rgb(51, 51, 51)` | `1px solid rgb(207, 207, 207)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| All scores 6 Strong Match 3 Worth Talking … e301 | 294 / 221 / 176 / 138 | `4px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`50` |
| All scores 6 e302 | 299 / 226 / 166 / 32 | `0px 8px`；`0px`；`8px` | `13px/500/19.5px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Strong Match 3 e305 | 299 / 258 / 166 / 32 | `0px 8px`；`0px`；`8px` | `13px/500/19.5px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Worth Talking 3 e307 | 299 / 290 / 166 / 32 | `0px 8px`；`0px`；`8px` | `13px/500/19.5px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Not Match 0 e309 | 299 / 322 / 166 / 32 | `0px 8px`；`0px`；`8px` | `13px/500/19.5px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

## 26 Outreach 桌面条件流程

证据：[JSON](states/metix-outreach-1440.json)、[AX](states/metix-outreach-1440.txt)、[截图（匿名布局图）](diagrams/metix-outreach-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `168`，truncated=`false`。

该状态侧栏64，角色头64；外联正文内部scroll框836高、内容909高。主内容1256宽；完成状态卡高164，统计四列各303。Email流程grid由左584、中心连线间距、右584组成，两边各节点前留28给状态竖线/图标。邮件卡外框556×88，内部按钮554×86，有1px边框；标题/摘要折叠显示，DOM中正文有rect也不等于当前展开可见。任意回复停止后续followups的文案归右侧分支，不能画成所有邮件依次发完后才等回复。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e50 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Software Engineer, Data Infra Describe the role Find Candida… e53 | 64 / 0 / 1376 / 64 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Outreach Outreach complete Completed Automated outreach has … e78 | 64 / 64 / 1376 / 836 | `0px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| Back e80 | 118.5 / 88 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Outreach e82 | 158.5 / 92 / 70.44 / 24 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Outreach complete Completed Automated outreach has ended. No… e85 | 118.5 / 132 / 1256 / 164 | `16px 20px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Outreach complete Completed Automated outreach has ended. No… e86 | 139.5 / 149 / 1214 / 52 | `0px`；`0px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| Outreach complete e88 | 139.5 / 149 / 145.28 / 24 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Review 6 interested e91 | 1191.23 / 157 / 162.27 / 36 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 261 Contacted 19 Replies 6 Interested 17 Failed e92 | 139.5 / 217 / 1214 / 62 | `0px`；`16px 0px 0px`；`normal` | `grid/static`；`hidden/hidden`；`auto` |
| 261 Contacted e93 | 140.5 / 218 / 303 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 19 Replies e94 | 443.5 / 218 / 303 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 6 Interested e95 | 746.5 / 218 / 303 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 17 Failed e96 | 1049.5 / 218 / 303 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Email e99 | 118.5 / 316 / 40.45 / 40 | `0px 2px`；`0px`；`8px` | `flex/relative`；`visible/visible`；`auto` |
| Job Posting e100 | 186.95 / 316 / 81.91 / 40 | `0px 2px`；`0px`；`8px` | `flex/relative`；`visible/visible`；`auto` |
| Introduction email Oct 13, 4:25 PM Mira Senior Recruiter We … e102 | 126.5 / 385 / 1240 / 476 | `0px`；`0px`；`0px` | `grid/relative`；`visible/visible`；`auto` |
| Mira Senior Recruiter We are hiring: Software Engineer, Data… e109 | 154.5 / 413 / 556 / 88 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Waiting for reply Any reply stops their remaining follow-ups… e146 | 782.5 / 385 / 584 / 476 | `0px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`1` |
| Mira Senior Recruiter Application link · Software Engineer, … e161 | 810.5 / 657 / 556 / 88 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e50 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Software Engineer, Data Infra Describe the role Find Candida… e53 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| Outreach Outreach complete Completed Automated outreach has … e78 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back e80 | `14px / 500 / 20px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Outreach e82 | `16px / 600 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Outreach complete Completed Automated outreach has ended. No… e85 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(250, 250, 250)` | `1px solid rgb(229, 229, 229)`；`12px`；`none` |
| Outreach complete Completed Automated outreach has ended. No… e86 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Outreach complete e88 | `16px / 600 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Review 6 interested e91 | `14px / 500 / 20px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| 261 Contacted 19 Replies 6 Interested 17 Failed e92 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklab(0.999994 0.0000455677 0.0000200868 / 0.8)` | `1px solid oklab(0 0 0 / 0.06)`；`9px`；`none` |
| 261 Contacted e93 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`8.4px`；`none` |
| 19 Replies e94 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`8.4px`；`none` |
| 6 Interested e95 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`8.4px`；`none` |
| 17 Failed e96 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklab(0 0 0 / 0.06)`；`8.4px`；`none` |
| Email e99 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Job Posting e100 | `14px / 500 / 20px` | `rgb(119, 119, 119)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Introduction email Oct 13, 4:25 PM Mira Senior Recruiter We … e102 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Mira Senior Recruiter We are hiring: Software Engineer, Data… e109 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`12px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.04) 0px 2px 10px 0px` |
| Waiting for reply Any reply stops their remaining follow-ups… e146 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Mira Senior Recruiter Application link · Software Engineer, … e161 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`12px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.04) 0px 2px 10px 0px` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1)` | 64 / 64 / 1376 / 836 | 1365 / 836 | 1365 / 909 | 0 / 0 |

## 27 Outreach 手机单列与2×2统计

证据：[JSON](states/metix-outreach-390.json)、[AX](states/metix-outreach-390.txt)、[截图（匿名布局图）](diagrams/metix-outreach-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `120`，truncated=`false`。

手机主内容实际宽339，而不是390：外联滚动框因滚动条有379内宽，再左右padding20形成339。顶部完成卡高316，Review按钮下移单独一行；统计从桌面4×1改成2×2，单格151.5×60。流程从双列条件图改成纵向内容；初始屏只见Introduction和Follow-up1上部，右侧分支没有消失，而在长内容下方。scrollHeight1367，viewport755。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e1 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/static`；`hidden/auto`；`auto` |
| Software Engineer, Data Infra e5 | 0 / 0 / 390 / 44 | `0px 20px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| Open navigation menu e7 | 20 / 7 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Open role overview e11 | 338 / 6 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Outreach e24 | 233.34 / 48 / 94.66 / 32 | `0px 10px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Outreach Outreach complete Completed Automated outreach has … e30 | 0 / 89 / 390 / 755 | `0px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| Back e32 | 20 / 113 / 32 / 32 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Outreach e34 | 60 / 119 / 66.5 / 20 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Outreach complete Completed Automated outreach has ended. No… e37 | 20 / 157 / 339 / 316 | `16px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Outreach complete Completed Automated outreach has ended. No… e38 | 37 / 174 / 305 / 144 | `0px`；`0px`；`16px` | `flex/static`；`visible/visible`；`auto` |
| Outreach complete e40 | 37 / 174 / 145.28 / 24 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Review 6 interested e43 | 37 / 282 / 162.27 / 36 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 261 Contacted 19 Replies 6 Interested 17 Failed e44 | 37 / 334 / 305 / 122 | `0px`；`16px 0px 0px`；`normal` | `grid/static`；`hidden/hidden`；`auto` |
| 261 Contacted e45 | 38 / 335 / 151.5 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 19 Replies e46 | 189.5 / 335 / 151.5 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 6 Interested e47 | 38 / 395 / 151.5 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| 17 Failed e48 | 189.5 / 395 / 151.5 / 60 | `0px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Email e51 | 20 / 493 / 40.45 / 40 | `0px 2px`；`0px`；`8px` | `flex/relative`；`visible/visible`；`auto` |
| Job Posting e52 | 88.45 / 493 / 81.91 / 40 | `0px 2px`；`0px`；`8px` | `flex/relative`；`visible/visible`；`auto` |
| Mira Senior Recruiter We are hiring: Software Engineer, Data… e60 | 52 / 590 / 303 / 88 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Software Engineer, Data Infra Describe the role Find Candida… e1 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Software Engineer, Data Infra e5 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Open navigation menu e7 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Open role overview e11 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Outreach e24 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(243, 243, 243)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`none` |
| Outreach Outreach complete Completed Automated outreach has … e30 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back e32 | `14px / 500 / 20px` | `rgb(128, 128, 128)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Outreach e34 | `15px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Outreach complete Completed Automated outreach has ended. No… e37 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(250, 250, 250)` | `1px solid rgb(229, 229, 229)`；`12px`；`none` |
| Outreach complete Completed Automated outreach has ended. No… e38 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Outreach complete e40 | `16px / 600 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Review 6 interested e43 | `14px / 500 / 20px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| 261 Contacted 19 Replies 6 Interested 17 Failed e44 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklab(0.999994 0.0000455677 0.0000200868 / 0.8)` | `1px solid oklab(0 0 0 / 0.06)`；`9px`；`none` |
| 261 Contacted e45 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`8.4px`；`none` |
| 19 Replies e46 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`8.4px`；`none` |
| 6 Interested e47 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`8.4px`；`none` |
| 17 Failed e48 | `14px / 500 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklab(0 0 0 / 0.06)`；`8.4px`；`none` |
| Email e51 | `14px / 600 / 20px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Job Posting e52 | `14px / 500 / 20px` | `rgb(119, 119, 119)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Mira Senior Recruiter We are hiring: Software Engineer, Data… e60 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`12px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.04) 0px 2px 10px 0px` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(1)` | 0 / 89 / 390 / 755 | 379 / 755 | 379 / 1367 | 0 / 0 |

## 28 全局Sequence空列表桌面

证据：[JSON](states/metix-sequence-empty-1440.json)、[AX](states/metix-sequence-empty-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-empty-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `69`，truncated=`false`。

此捕获确为 `/hire/sequence` 空列表，侧栏64。标题行显示Sequences、新建按钮；Active/Archived在y86.5。空态是图标与说明内容块，不是统计看板。顶部New sequence高36，空态内按钮高44，不能把两个同文案按钮合并成同尺寸规则。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Sequences Build reusable email workflows and track every enr… e50 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Sequences Build reusable email workflows and track every enr… e51 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Sequences Build reusable email workflows and track every enr… e52 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Sequences Build reusable email workflows and track every enr… e53 | 64 / 0 / 1376 / 74.5 | `12px 20px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Sequences e54 | 84 / 12 / 354.72 / 24 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| New sequence e55 | 1281.02 / 18.75 / 138.98 / 36 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Active Archived e58 | 84 / 86.5 / 1336 / 32 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Sequence status e59 | 84 / 86.5 / 169.2 / 32 | `0px`；`0px`；`8px` | `flex/static`；`auto/auto`；`auto` |
| Active e60 | 84 / 86.5 / 72.52 / 32 | `0px 16px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Archived e61 | 164.52 / 86.5 / 88.69 / 32 | `0px 16px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| No sequences yet Create a reusable email sequence to contact… e62 | 64 / 130.5 / 1376 / 769.5 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| No sequences yet Create a reusable email sequence to contact… e63 | 64 / 130.5 / 1376 / 769.5 | `0px 24px 40px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| No sequences yet Create a reusable email sequence to contact… e64 | 442 / 433.78 / 620 / 122.94 | `0px`；`0px`；`32px` | `grid/static`；`visible/visible`；`auto` |
| DIV容器 e65 | 442 / 434.45 / 192 / 121.59 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e66 | 461.2 / 434.45 / 153.59 / 121.59 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| No sequences yet e67 | 666 / 433.78 / 396 / 27.55 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| New sequence e68 | 666 / 512.72 / 135.17 / 44 | `0px 18px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Sequences Build reusable email workflows and track every enr… e50 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Sequences Build reusable email workflows and track every enr… e51 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Sequences Build reusable email workflows and track every enr… e52 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Sequences Build reusable email workflows and track every enr… e53 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| Sequences e54 | `24px / 600 / 24px` | `rgb(17, 17, 17)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| New sequence e55 | `13px / 500 / 19.5px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |
| Active Archived e58 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Sequence status e59 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Active e60 | `13px / 500 / 19.5px` | `rgb(255, 255, 255)`；`rgb(0, 0, 0)` | `1px solid rgb(0, 0, 0)`；`3.35544e+07px`；`none` |
| Archived e61 | `13px / 500 / 19.5px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`3.35544e+07px`；`none` |
| No sequences yet Create a reusable email sequence to contact… e62 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No sequences yet Create a reusable email sequence to contact… e63 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No sequences yet Create a reusable email sequence to contact… e64 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| DIV容器 e65 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e66 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No sequences yet e67 | `19px / 550 / 27.55px` | `rgb(52, 59, 70)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| New sequence e68 | `14px / 500 / 21px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `1px solid rgba(0, 0, 0, 0)`；`9px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| 无实际溢出的auto/scroll框 | — | — | — | — |

## 29 邮箱前置弹窗桌面

证据：[JSON](states/metix-mailbox-modal-1440.json)、[AX](states/metix-mailbox-modal-1440.txt)、[截图（匿名布局图）](diagrams/metix-mailbox-modal-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `90`，truncated=`false`。

遮罩上居中固定480×339.5弹窗，中心点为viewport中心 `(720,450)`；外框x480/y280.25，非动画偏移。正文padding24，表单行430×45.5，行间gap8；底部69高独立分隔区。Gmail/Microsoft禁用，IMAP可用，Maybe later关闭前置。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e69 | 0 / 0 / 1440 / 900 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Connect your mailbox Connect your mailbox, or get started wi… e70 | 480 / 280.25 / 480 / 339.5 | `0px`；`0px`；`0px` | `flex/fixed`；`hidden/hidden`；`50` |
| Close e71 | 907 / 297.25 / 32 / 32 | `0px`；`0px`；`normal` | `flex/absolute`；`visible/visible`；`auto` |
| svg容器 e72 | 915 / 305.25 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Connect your mailbox Connect your mailbox, or get started wi… e73 | 481 / 281.25 / 478 / 268.5 | `24px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| Connect your mailbox Connect your mailbox, or get started wi… e74 | 505 / 305.25 / 430 / 48 | `0px 36px 0px 0px`；`0px 0px 20px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Connect your mailbox Connect your mailbox, or get started wi… e75 | 505 / 305.25 / 394 / 48 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e76 | 505 / 311.25 / 36 / 36 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e77 | 515 / 321.25 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Connect your mailbox e78 | 553 / 305.25 / 344.31 / 24 | `0px`；`0px 0px 4px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Connect Gmail (coming soon) e79 | 505 / 373.25 / 430 / 45.5 | `12px 16px`；`0px 0px 8px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Connect Microsoft (coming soon) e82 | 505 / 426.75 / 430 / 45.5 | `12px 16px`；`0px 0px 8px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Connect IMAP e85 | 505 / 480.25 / 430 / 45.5 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Use Mira’s mailbox for now. Replies appear in Inbox. Maybe l… e88 | 481 / 549.75 / 478 / 69 | `16px 24px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Maybe later e89 | 828.27 / 566.75 / 106.73 / 36 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e69 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e70 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`16px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.14) 0px 20px 64px 0px` |
| Close e71 | `16px / 400 / 24px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(255, 255, 255) 0px 0px 0px 0px, rgb(102, 102, 102) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| svg容器 e72 | `16px / 400 / 24px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e73 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e74 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e75 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SPAN容器 e76 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgb(250, 250, 250)` | `1px solid rgb(235, 235, 235)`；`8px`；`none` |
| svg容器 e77 | `16px / 400 / 24px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox e78 | `16px / 600 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect Gmail (coming soon) e79 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Connect Microsoft (coming soon) e82 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Connect IMAP e85 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Use Mira’s mailbox for now. Replies appear in Inbox. Maybe l… e88 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| Maybe later e89 | `13px / 500 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`8px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| 无实际溢出的auto/scroll框 | — | — | — | — |

## 30 邮箱前置弹窗手机

证据：[JSON](states/metix-mailbox-modal-390.json)、[AX](states/metix-mailbox-modal-390.txt)、[截图（匿名布局图）](diagrams/metix-mailbox-modal-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `44`，truncated=`false`。

手机弹窗仍居中而非bottomsheet：358宽、355.5高、左右16、y244.25，中心点 `(195,422)`。正文左右padding16，行宽324；副文案换行使头区68高。底部73高，Maybe later与说明在同一flex布局；不能套用Profile或Schedule bottomsheet定位。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e23 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`50` |
| Connect your mailbox Connect your mailbox, or get started wi… e24 | 16 / 244.25 / 358 / 355.5 | `0px`；`0px`；`0px` | `flex/fixed`；`hidden/hidden`；`50` |
| Close e25 | 325 / 261.25 / 32 / 32 | `0px`；`0px`；`normal` | `flex/absolute`；`visible/visible`；`auto` |
| svg容器 e26 | 333 / 269.25 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Connect your mailbox Connect your mailbox, or get started wi… e27 | 17 / 245.25 / 356 / 280.5 | `20px 16px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| Connect your mailbox Connect your mailbox, or get started wi… e28 | 33 / 265.25 / 324 / 68 | `0px 36px 0px 0px`；`0px 0px 20px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Connect your mailbox Connect your mailbox, or get started wi… e29 | 33 / 265.25 / 288 / 68 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| SPAN容器 e30 | 33 / 281.25 / 36 / 36 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e31 | 43 / 291.25 / 16 / 16 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Connect your mailbox e32 | 81 / 265.25 / 240 / 24 | `0px`；`0px 0px 4px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Connect Gmail (coming soon) e33 | 33 / 353.25 / 324 / 45.5 | `12px 16px`；`0px 0px 8px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Connect Microsoft (coming soon) e36 | 33 / 406.75 / 324 / 45.5 | `12px 16px`；`0px 0px 8px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Connect IMAP e39 | 33 / 460.25 / 324 / 45.5 | `12px 16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Use Mira’s mailbox for now. Replies appear in Inbox. Maybe l… e42 | 17 / 525.75 / 356 / 73 | `16px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| Maybe later e43 | 250.27 / 544.75 / 106.73 / 36 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e23 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e24 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`16px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.14) 0px 20px 64px 0px` |
| Close e25 | `16px / 400 / 24px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(255, 255, 255) 0px 0px 0px 0px, rgb(102, 102, 102) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| svg容器 e26 | `16px / 400 / 24px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e27 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e28 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox Connect your mailbox, or get started wi… e29 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| SPAN容器 e30 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgb(250, 250, 250)` | `1px solid rgb(235, 235, 235)`；`8px`；`none` |
| svg容器 e31 | `16px / 400 / 24px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect your mailbox e32 | `16px / 600 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect Gmail (coming soon) e33 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Connect Microsoft (coming soon) e36 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Connect IMAP e39 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Use Mira’s mailbox for now. Replies appear in Inbox. Maybe l… e42 | `16px / 400 / 24px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| Maybe later e43 | `13px / 500 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(229, 229, 229)`；`8px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| 无实际溢出的auto/scroll框 | — | — | — | — |

## 31 新建Sequence上下文表单 手机真实页面

证据：[JSON](states/metix-sequence-empty-390.json)、[AX](states/metix-sequence-empty-390.txt)、[截图（匿名布局图）](diagrams/metix-sequence-empty-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `43`，truncated=`false`。

文件名虽含empty，该捕获URL实际为 `/hire/sequence/new`，前景是Tailor your sequence，不是390空列表。顶部New sequence栏65高；正文从y65开始715高、scrollHeight1000；底部动作区从y780开始64高。Sender email可使用Mira’s mailbox并有Connect a mailbox，Role卡含必填Job title、可选Job posting URL、Role description，Company卡含Change company及既有公司资料。该捕获时尚未提交Continue；后续已完成生成并创建草稿，见第42–48节，未Publish。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| New sequence Tailor your sequence Share the role and company… e1 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/static`；`hidden/auto`；`auto` |
| New sequence e4 | 0 / 0 / 390 / 65 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| New sequence e5 | 0 / 0 / 390 / 64 | `12px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| New sequence e8 | 64 / 18.5 / 119.45 / 27 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Tailor your sequence Share the role and company details, and… e9 | 0 / 65 / 390 / 715 | `16px`；`0px`；`normal` | `block/static`；`auto/auto`；`auto` |
| Tailor your sequence e10 | 16 / 81 / 347 / 28 | `0px`；`0px 0px 8px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Sender email Connect a mailbox Mira’s mailbox e11 | 33 / 202 / 313 / 80 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Connect a mailbox e13 | 186 / 202 / 160 / 32 | `0px 10px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Sender email: Mira’s mailbox e15 | 33 / 246 / 313 / 36 | `0px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e17 | 47 / 257 / 14 / 14 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| Role Job title * Job posting URL Optional Role description * e19 | 16 / 319 / 347 / 355.5 | `16px`；`0px 0px 20px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Role e20 | 33 / 336 / 313 / 21 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| e.g. Software Engineer e22 | 33 / 398.5 / 313 / 36 | `4px 12px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| https://example.invalid/resource e25 | 33 / 472 / 313 / 36 | `4px 12px 4px 36px`；`0px`；`normal` | `flex/static`；`clip/clip`；`auto` |
| What the role involves and who you are looking for e27 | 33 / 545.5 / 313 / 112 | `8px 12px`；`0px`；`normal` | `flex/static`；`auto/auto`；`auto` |
| Company Change company Company name * Website (optional) Sho… e28 | 16 / 694.5 / 347 / 354.5 | `16px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Company e30 | 33 / 721 / 63.94 / 21 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Change company e31 | 207.14 / 711.5 / 138.86 / 40 | `0px 12px`；`0px`；`6px` | `flex/static`；`visible/visible`；`auto` |
| Cancel e41 | 137.86 / 792 / 69.36 / 40 | `8px 12px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Continue to emails e42 | 219.22 / 792 / 154.78 / 40 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| New sequence Tailor your sequence Share the role and company… e1 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| New sequence e4 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | ``；`0px`；`none` |
| New sequence e5 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| New sequence e8 | `18px / 600 / 27px` | `rgb(17, 17, 17)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Tailor your sequence Share the role and company details, and… e9 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Tailor your sequence e10 | `20px / 600 / 28px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Sender email Connect a mailbox Mira’s mailbox e11 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Connect a mailbox e13 | `14px / 500 / 21px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Sender email: Mira’s mailbox e15 | `13px / 400 / 19.5px` | `rgb(34, 34, 34)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(255, 255, 255) 0px 0px 0px 0px, rgb(34, 34, 34) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| svg容器 e17 | `13px / 400 / 19.5px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Role Job title * Job posting URL Optional Role description * e19 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.03) 0px 1px 2px 0px` |
| Role e20 | `14px / 600 / 21px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| e.g. Software Engineer e22 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `1px solid rgb(153, 153, 153)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklab(0.606 0.096545 -0.230606 / 0.5) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| https://example.invalid/resource e25 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| What the role involves and who you are looking for e27 | `16px / 400 / 20px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px` |
| Company Change company Company name * Website (optional) Sho… e28 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.03) 0px 1px 2px 0px` |
| Company e30 | `14px / 600 / 21px` | `rgb(34, 34, 34)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Change company e31 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Cancel e41 | `14px / 500 / 20px` | `rgb(102, 102, 102)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |
| Continue to emails e42 | `14px / 500 / 20px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(1) > main:nth-child(1) > div:nth-child(1) > main:nth-child(1) > div:nth-child(2)` | 0 / 65 / 390 / 715 | 379 / 715 | 379 / 1000 | 0 / 0 |

## 32 Shortlist 空态桌面

证据：[JSON](states/metix-shortlist-empty-1440.json)、[AX](states/metix-shortlist-empty-1440.txt)、[截图（匿名布局图）](diagrams/metix-shortlist-empty-1440.svg)。

窗口inner `1440×900`、outer `1440×900`，DPR `1`，window scroll `0/0`；document scroll `1440×900`。记录元素 `63`，truncated=`false`。

本次侧栏64；Shortlist标题行64高。空态所在区域836高，内容grid620×122.94，横向图标/文字分配；空态标题在x666/y400.53。Start Search为链接而不是自动启动搜索。没有非空Shortlist行或卡片，本批不填造其列、筛选和操作尺寸。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Shortlist No shortlisted candidates yet Save candidates from… e50 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Shortlist e54 | 64 / 0 / 1376 / 64 | `0px 0px 0px 20px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| Shortlist e55 | 84 / 19.5 / 92.56 / 24 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| No shortlisted candidates yet Save candidates from a search … e56 | 64 / 64 / 1376 / 836 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| No shortlisted candidates yet Save candidates from a search … e57 | 64 / 64 / 1376 / 836 | `0px 24px 40px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| No shortlisted candidates yet Save candidates from a search … e58 | 442 / 400.53 / 620 / 122.94 | `0px`；`0px`；`32px` | `grid/static`；`visible/visible`；`auto` |
| DIV容器 e59 | 442 / 401.2 / 192 / 121.59 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e60 | 461.2 / 401.2 / 153.59 / 121.59 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| No shortlisted candidates yet e61 | 666 / 400.53 / 396 / 27.55 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Start Search e62 | 666 / 479.47 / 132.39 / 44 | `8px 24px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Shortlist No shortlisted candidates yet Save candidates from… e50 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`oklch(1 0 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Shortlist e54 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | ``；`0px`；`none` |
| Shortlist e55 | `24px / 600 / 24px` | `rgb(17, 17, 17)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet Save candidates from a search … e56 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet Save candidates from a search … e57 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet Save candidates from a search … e58 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| DIV容器 e59 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e60 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet e61 | `19px / 550 / 27.55px` | `rgb(52, 59, 70)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Start Search e62 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| 无实际溢出的auto/scroll框 | — | — | — | — |

## 33 Shortlist 空态手机

证据：[JSON](states/metix-shortlist-empty-390.json)、[AX](states/metix-shortlist-empty-390.txt)、[截图（匿名布局图）](diagrams/metix-shortlist-empty-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `17`，truncated=`false`。

手机标题栏44高，主空态转为图标在上、标题说明在下；标题rect `(35,417.63,320,27.55)`。桌面空态图文横排结构不能直接等比缩小。该页面没有表格或候选人卡，因此不存在可测量的非空列表组件。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| Shortlist No shortlisted candidates yet Save candidates from… e3 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Shortlist No shortlisted candidates yet Save candidates from… e4 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/relative`；`hidden/hidden`；`auto` |
| Shortlist No shortlisted candidates yet Save candidates from… e5 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| Shortlist e6 | 0 / 0 / 390 / 44 | `0px`；`0px`；`normal` | `block/sticky`；`visible/visible`；`20` |
| Shortlist e7 | 0 / 0 / 390 / 44 | `0px 20px`；`0px`；`normal` | `flex/relative`；`visible/visible`；`auto` |
| DIV容器 e8 | 20 / 9 / 32 / 26 | `2px 0px 0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e9 | 20 / 11 / 24 / 24 | `0px`；`0px`；`normal` | `block/static`；`hidden/hidden`；`auto` |
| No shortlisted candidates yet Save candidates from a search … e10 | 0 / 44 / 390 / 800 | `0px`；`0px`；`normal` | `flex/static`；`hidden/hidden`；`auto` |
| No shortlisted candidates yet Save candidates from a search … e11 | 0 / 44 / 390 / 800 | `0px 24px 40px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| No shortlisted candidates yet Save candidates from a search … e12 | 24 / 284.03 / 342 / 279.92 | `0px`；`0px`；`12px` | `flex/static`；`visible/visible`；`auto` |
| DIV容器 e13 | 99 / 284.03 / 192 / 121.59 | `0px`；`0px`；`normal` | `flex/static`；`visible/visible`；`auto` |
| svg容器 e14 | 118.2 / 284.03 / 153.59 / 121.59 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| No shortlisted candidates yet e15 | 35 / 417.63 / 320 / 27.55 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Start Search e16 | 85 / 519.95 / 220 / 44 | `8px 24px`；`0px`；`8px` | `inline-flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| Shortlist No shortlisted candidates yet Save candidates from… e3 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Shortlist No shortlisted candidates yet Save candidates from… e4 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Shortlist No shortlisted candidates yet Save candidates from… e5 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Shortlist e6 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgb(245, 245, 245)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Shortlist e7 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| DIV容器 e8 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e9 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet Save candidates from a search … e10 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet Save candidates from a search … e11 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet Save candidates from a search … e12 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| DIV容器 e13 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| svg容器 e14 | `16px / 400 / 24px` | `rgb(51, 51, 51)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| No shortlisted candidates yet e15 | `19px / 550 / 27.55px` | `rgb(52, 59, 70)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Start Search e16 | `14px / 600 / 21px` | `rgb(255, 255, 255)`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| 无实际溢出的auto/scroll框 | — | — | — | — |

## 34 手机排期退出未保存确认

证据：[JSON](states/metix-schedule-exit-390.json)、[AX](states/metix-schedule-exit-390.txt)、[截图（匿名布局图）](diagrams/metix-schedule-exit-390.svg)。

窗口inner `390×844`、outer `390×844`，DPR `1`，window scroll `0/0`；document scroll `390×844`。记录元素 `265`，truncated=`false`。

手机在前景确认Exit editing this event?，两个动作竖排，各308×36；截图中Exit在上、Back to Edit在下（DOM按钮顺序相反不能用DOM顺序推断视觉顺序）。底层Schedule dialog仍保留在DOM，但不是当前可操作前景。点击Exit实际放弃未保存排期，未发送邀请。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | display / position；overflow x/y；z |
| --- | --- | --- | --- |
| DIV容器 e258 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `block/fixed`；`visible/visible`；`300` |
| Exit editing this event? Your changes to this event will not… e259 | 16 / 321 / 358 / 202 | `24px`；`0px`；`16px` | `grid/fixed`；`auto/auto`；`300` |
| Exit editing this event? Your changes to this event will not… e260 | 41 / 346 / 308 / 56 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Exit editing this event? e261 | 41 / 346 / 308 / 28 | `0px`；`0px`；`normal` | `block/static`；`visible/visible`；`auto` |
| Back to Edit Exit e262 | 41 / 418 / 308 / 80 | `0px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Back to Edit e263 | 41 / 462 / 308 / 36 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |
| Exit e264 | 41 / 418 / 308 / 36 | `8px 16px`；`0px`；`8px` | `flex/static`；`visible/visible`；`auto` |

| 组件 / E记录 | font size / weight / line-height | color；background | border；radius；shadow |
| --- | --- | --- | --- |
| DIV容器 e258 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklab(0 0 0 / 0.5)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Exit editing this event? Your changes to this event will not… e259 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | `1px solid oklch(0.92 0.004 286.32)`；`10.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px` |
| Exit editing this event? Your changes to this event will not… e260 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Exit editing this event? e261 | `18px / 600 / 28px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back to Edit Exit e262 | `16px / 400 / 24px` | `oklch(0.141 0.005 285.823)`；`rgba(0, 0, 0, 0)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`none` |
| Back to Edit e263 | `14px / 500 / 20px` | `oklch(0.141 0.005 285.823)`；`oklch(1 0 0)` | `1px solid oklch(0.606 0.25 292.717)`；`8.4px`；`rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklab(0.606 0.096545 -0.230606 / 0.5) 0px 0px 0px 3px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px` |
| Exit e264 | `14px / 500 / 20px` | `rgb(255, 255, 255)`；`rgb(227, 59, 84)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`none` |

| 滚动框 selector | rect x/y/w/h | client w/h | scroll w/h | left/top |
| --- | --- | --- | --- | --- |
| `div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2)` | 0 / 144 / 390 / 700 | 379 / 700 | 379 / 1820 | 0 / 0 |
| `div:nth-child(2) > div:nth-child(1) > div:nth-child(5) > div:nth-child(1) > div:nth-child(4)` | 37 / 1538 / 305 / 38 | 305 / 38 | 412 / 38 | 0 / 0 |
| `tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(1) > div:nth-child(1) > div:nth-child(1)` | 12 / 139 / 366 / 576 | 355 / 576 | 355 / 1344 | 0 / 680 |

## 35 响应式与状态切换的归因

1. Sidebar收起/展开是有状态交互。本批Inbox1440为244宽、Interview/Outreach/Sequence1440为64宽，不能把两个值直接当成同一breakpoint规则。相同宽度下要同时看当前sidebar状态。
2. 宽度变化与用户步骤是两个维度。`schedule-step2-390` 的URL未变，但resize触发手机流程重挂载；要复刻手机Step2，使用真正Continue→Step1→Next后的 `schedule-mobile-customize-390`。
3. 1440×600、1024×768、390×844的document高度大多仍为viewport。列表、邮件历史、Profile正文、日历和配置表单各自滚动，不能把文档总高当成全部页面内容高。
4. 卡片数、模板内容和展开状态随实际操作变化。滚动加载、文本换行和数据追加都可能改变scrollHeight；不能仅凭高度差就判定响应式布局规则。
5. 本文与完整JSON仅标注采集状态。hover/pressed、所有错误态、键盘focus路径、未观察菜单、Sequence发布结果和已保存面试事件仍不虚构。更多宽度对照见同目录响应式报告。

## 36 Profile 默认三项的稳定终态

证据：[JSON](states/metix-profile-stable-1440.json)、[AX](states/metix-profile-stable-1440.txt)、[截图（匿名布局图）](diagrams/metix-profile-stable-1440.svg)。视口1440×900，DPR1。

本捕获已稳定，dialog `(720,0,720,900)`，transform none。默认三项Recommendation高214、Show all y422。联系人已读出个人/工作邮箱，Contact details高196、段落导航y670；与旧初开Finding态y606的差别来自数据完成，不来自视口。复制/发送可用性图标仅记录位置，未执行发送。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | 字体size/weight/line-height；color | border；radius；background；overflow；z |
| --- | --- | --- | --- | --- |
| Profile Candidate profile Profile 示例候选人 Dowl… e228 | 720 / 0 / 720 / 900 | `0px`；`0px`；`0px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | ``；`0px`；`rgb(255, 255, 255)`；`hidden/hidden`；`50` |
| Profile e230 | 721 / 0 / 719 / 64 | `0px 24px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Close profile e231 | 1376 / 11.5 / 40 / 40 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`10.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| 示例对象1 Programmer at AFI Kansas City,… e233 | 721 / 64 / 719 / 836 | `0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| 示例对象1 Programmer at AFI Kansas City,… e235 | 745 / 84 / 660 / 88 | `0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| 示例对象1 e237 | 745 / 84 / 612 / 32 | `0px`；`0px`；`8px` | `14px/400/20px`；`rgba(0, 0, 0, 0.6)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Kansas City, Missouri, United States 示例候选人-d… e241 | 745 / 152 / 612 / 20 | `0px`；`0px`；`8px` | `14px/400/20px`；`rgba(0, 0, 0, 0.6)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| SPAN e249 | 1357 / 84 / 48 / 48 | `0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`3.35544e+07px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Download e252 | 745 / 184 / 115.58 / 36 | `10px 12px`；`0px`；`8px` | `14px/500/20px`；`rgb(0, 0, 0)` | `1px solid rgb(0, 0, 0)`；`10.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Candidate criteria evaluation e254 | 745 / 232 / 660 / 214 | `0px`；`12px 0px 0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Mira's Recommendation e255 | 745 / 232 / 660 / 20 | `0px`；`0px`；`normal` | `14px/500/20px`；`rgb(119, 65, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Show all 7 criteria e268 | 745 / 422 / 122.88 / 24 | `0px`；`6px 0px 0px`；`4px` | `12px/600/16px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Contact details Email [email] Personal [em… e270 | 745 / 462 / 660 / 196 | `0px`；`0px`；`normal` | `14px/400/21px`；`rgb(48, 48, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgb(245, 245, 245)`；`hidden/hidden`；`auto` |
| Contact details e271 | 745 / 462 / 660 / 44 | `12px 16px`；`0px`；`12px` | `14px/500/20px`；`rgb(82, 82, 82)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Copy [email] e283 | 1026.05 / 540 / 32 / 32 | `0px`；`0px`；`normal` | `14px/400/21px`；`rgb(119, 119, 127)` | `0px solid oklch(0.92 0.004 286.32)`；`5px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Copy [email] e288 | 959.52 / 574 / 32 / 32 | `0px`；`0px`；`normal` | `14px/400/21px`；`rgb(119, 119, 127)` | `0px solid oklch(0.92 0.004 286.32)`；`5px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sending availability for [email] e290 | 992.52 / 574 / 32 / 32 | `0px`；`0px`；`normal` | `14px/400/21px`；`rgb(119, 119, 127)` | `0px solid oklch(0.92 0.004 286.32)`；`5px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Show phone e295 | 1269 / 618 / 120 / 28 | `3px 8px`；`0px`；`6px` | `12px/500/20px`；`rgb(68, 68, 75)` | `1px solid rgb(214, 214, 218)`；`6px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Experience Education Skills Projects Courses e300 | 745 / 670 / 660 / 42 | `0px`；`0px`；`24px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Experience e301 | 745 / 670 / 73.25 / 42 | `4px 0px 12px`；`0px`；`normal` | `14px/500/24px`；`rgb(34, 34, 34)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

## 37 Sequence 新建上下文桌面

证据：[JSON](states/metix-sequence-context-1440.json)、[AX](states/metix-sequence-context-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-context-1440.svg)。视口1440×900，DPR1。

Maybe later之后稳定导航可到 `/hire/sequence/new`，不能沿用瞬时空列表快照解释为被阻断。收起侧栏64，表单主宽720，控件686。正文内部滚动，底部Cancel与Continue to emails固定在y848附近；该状态尚未点Continue，后续生成编辑器见第42–48节。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | 字体size/weight/line-height；color | border；radius；background；overflow；z |
| --- | --- | --- | --- | --- |
| New sequence Tailor your sequence Share th… e50 | 64 / 0 / 1376 / 900 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`oklch(1 0 0)`；`hidden/hidden`；`auto` |
| New sequence e53 | 64 / 0 / 1376 / 65 | `20px 24px 12px`；`0px`；`12px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Back to sequences e54 | 88 / 20.5 / 32 / 32 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| New sequence e56 | 132 / 20 / 142.56 / 33 | `0px`；`0px`；`normal` | `22px/600/33px`；`rgb(17, 17, 17)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Tailor your sequence Share the role and co… e57 | 64 / 66 / 1376 / 766 | `20px 24px 32px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Tailor your sequence e58 | 386.5 / 86 / 720 / 28 | `0px`；`0px 0px 8px`；`normal` | `20px/600/28px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sender email Connect a mailbox Mira’s mail… e59 | 403.5 / 183 / 686 / 80 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Connect a mailbox e61 | 929.5 / 183 / 160 / 32 | `0px 10px`；`0px`；`6px` | `14px/500/21px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sender email: Mira’s mailbox e63 | 403.5 / 227 / 686 / 36 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Role Job title * Job posting URL Optional … e67 | 386.5 / 300 / 720 / 355.5 | `16px`；`0px 0px 20px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Role e68 | 403.5 / 317 / 686 / 21 | `0px`；`0px`；`normal` | `14px/600/21px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| e.g. Software Engineer e70 | 403.5 / 379.5 / 686 / 36 | `4px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(153, 153, 153)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| https://example.invalid/resource e73 | 403.5 / 453 / 686 / 36 | `4px 12px 4px 36px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| What the role involves and who you are loo… e75 | 403.5 / 526.5 / 686 / 112 | `8px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Company Change company Company name * Webs… e76 | 386.5 / 675.5 / 720 / 267.5 | `16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Company e78 | 403.5 / 698 / 63.94 / 21 | `0px`；`0px`；`normal` | `14px/600/21px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Change company e79 | 950.64 / 692.5 / 138.86 / 32 | `0px 12px`；`0px`；`6px` | `14px/500/20px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Acme Inc. e83 | 487.5 / 768.5 / 602 / 36 | `4px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| Cancel e89 | 835.86 / 848 / 69.36 / 36 | `8px 12px`；`0px`；`8px` | `14px/500/20px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Continue to emails e90 | 917.22 / 848 / 194.78 / 36 | `8px 16px`；`0px`；`8px` | `14px/500/20px`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgb(34, 34, 34)`；`visible/visible`；`auto` |

## 38 Sequence 展开侧栏和公司说明

证据：[JSON](states/metix-sequence-context-expanded-1440.json)、[AX](states/metix-sequence-context-expanded-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-context-expanded-1440.svg)。视口1440×900，DPR1。

展开侧栏244后，表单仍720宽，主区居中移动90px。公司description已展开；内部滚动框从y66起766高、scrollHeight1037、scrollTop143。因此当前输入y236.5是已滚143的坐标，不是初始布局。Company description部分位于底部，需要内滚。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | 字体size/weight/line-height；color | border；radius；background；overflow；z |
| --- | --- | --- | --- | --- |
| New sequence Tailor your sequence Share th… e92 | 244 / 0 / 1196 / 900 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`oklch(1 0 0)`；`hidden/hidden`；`auto` |
| New sequence e95 | 244 / 0 / 1196 / 65 | `20px 24px 12px`；`0px`；`12px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| New sequence e98 | 312 / 20 / 142.56 / 33 | `0px`；`0px`；`normal` | `22px/600/33px`；`rgb(17, 17, 17)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Tailor your sequence Share the role and co… e99 | 244 / 66 / 1196 / 766 | `20px 24px 32px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Sender email Connect a mailbox Mira’s mail… e101 | 493.5 / 40 / 686 / 80 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sender email: Mira’s mailbox e105 | 493.5 / 84 / 686 / 36 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Role Job title * Job posting URL Optional … e109 | 476.5 / 157 / 720 / 355.5 | `16px`；`0px 0px 20px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Role e110 | 493.5 / 174 / 686 / 21 | `0px`；`0px`；`normal` | `14px/600/21px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| e.g. Software Engineer e112 | 493.5 / 236.5 / 686 / 36 | `4px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| https://example.invalid/resource e115 | 493.5 / 310 / 686 / 36 | `4px 12px 4px 36px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| What the role involves and who you are loo… e117 | 493.5 / 383.5 / 686 / 112 | `8px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Company Change company Company name * Webs… e118 | 476.5 / 532.5 / 720 / 395.5 | `16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Company e120 | 493.5 / 555 / 63.94 / 21 | `0px`；`0px`；`normal` | `14px/600/21px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Change company e121 | 1040.64 / 549.5 / 138.86 / 32 | `0px 12px`；`0px`；`6px` | `14px/500/20px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Acme Inc. e125 | 577.5 / 625.5 / 602 / 36 | `4px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| https://example.invalid/resource e127 | 493.5 / 703 / 686 / 36 | `4px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| Hide company description e128 | 493.5 / 755 / 179.89 / 28 | `0px`；`0px 0px 16px`；`4px` | `13px/500/19.5px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Company description e130 | 493.5 / 799 / 686 / 112 | `8px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Cancel e132 | 925.86 / 848 / 69.36 / 36 | `8px 12px`；`0px`；`8px` | `14px/500/20px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Continue to emails e133 | 1007.22 / 848 / 194.78 / 36 | `8px 16px`；`0px`；`8px` | `14px/500/20px`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgb(34, 34, 34)`；`visible/visible`；`auto` |

## 39 Sequence 发送人菜单

证据：[JSON](states/metix-sequence-sender-menu-1440.json)、[AX](states/metix-sequence-sender-menu-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-sender-menu-1440.svg)。视口1440×900，DPR1。

菜单紧随Sender字段，rect `(494,269,686,234.5)`、z50。顶部Sender for all steps in this sequence；Mira’s mailbox单选并标Assigned to your AI Agent。Connected mailboxes当前No mailbox connected，下有Connect a mailbox。这里说明发送人适用所有步骤，但不表示步骤已生成或邮件已发送。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | 字体size/weight/line-height；color | border；radius；background；overflow；z |
| --- | --- | --- | --- | --- |
| Sender email: Mira’s mailbox e105 | 493.5 / 227 / 686 / 36 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(153, 153, 153)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Sender for all steps in this sequence Mira… e137 | 494 / 269 / 686 / 234.5 | `0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`50` |
| Sender for all steps in this sequence Mira… e138 | 494 / 269 / 686 / 234.5 | `4px`；`0px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `1px solid rgb(229, 229, 229)`；`8px`；`rgb(255, 255, 255)`；`hidden/auto`；`50` |
| Mira’s mailbox Assigned to your AI Agent C… e139 | 499 / 304 / 676 / 150 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Mira’s mailbox Assigned to your AI Agent e140 | 499 / 304 / 676 / 53.5 | `8px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgb(245, 245, 245)`；`visible/visible`；`auto` |
| svg e141 | 507 / 323.75 / 14 / 14 | `0px`；`0px`；`normal` | `13px/400/19.5px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| DIV e142 | 495 / 361.5 / 684 / 1 | `0px`；`4px -4px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(235, 235, 235)`；`visible/visible`；`auto` |
| DIV e143 | 495 / 458 / 684 / 1 | `0px`；`4px -4px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(235, 235, 235)`；`visible/visible`；`auto` |
| Connect a mailbox e144 | 499 / 463 / 676 / 35.5 | `8px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| svg e145 | 507 / 473.75 / 14 / 14 | `0px`；`0px`；`normal` | `13px/400/19.5px`；`oklch(0.552 0.016 285.938)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |

## 40 Sequence 手机上下文表单 正确命名重采

证据：[JSON](states/metix-sequence-context-390.json)、[AX](states/metix-sequence-context-390.txt)、[截图（匿名布局图）](diagrams/metix-sequence-context-390.svg)。视口390×844，DPR1。

对应旧sequence-empty-390的真实表单。顶部64/65高，正文viewport715高，内部内容需要滚动，底部64高动作栏。Role和Company纵向卡片；Change company手机40高、桌面32高。Company description已展开。用户未填写职位或提交Continue；字段值来自账号既有公司资料。

| 组件 / E记录 | x / y / w / h | padding；margin；gap | 字体size/weight/line-height；color | border；radius；background；overflow；z |
| --- | --- | --- | --- | --- |
| New sequence Tailor your sequence Share th… e1 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/auto`；`auto` |
| New sequence e4 | 0 / 0 / 390 / 65 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| New sequence e5 | 0 / 0 / 390 / 64 | `12px 16px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| New sequence e8 | 64 / 18.5 / 119.45 / 27 | `0px`；`0px`；`normal` | `18px/600/27px`；`rgb(17, 17, 17)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Tailor your sequence Share the role and co… e9 | 0 / 65 / 390 / 715 | `16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Tailor your sequence e10 | 16 / 81 / 347 / 28 | `0px`；`0px 0px 8px`；`normal` | `20px/600/28px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sender email Connect a mailbox Mira’s mail… e11 | 33 / 202 / 313 / 80 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Connect a mailbox e13 | 186 / 202 / 160 / 32 | `0px 10px`；`0px`；`6px` | `14px/500/21px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sender email: Mira’s mailbox e15 | 33 / 246 / 313 / 36 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(153, 153, 153)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Role Job title * Job posting URL Optional … e19 | 16 / 319 / 347 / 355.5 | `16px`；`0px 0px 20px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Role e20 | 33 / 336 / 313 / 21 | `0px`；`0px`；`normal` | `14px/600/21px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| e.g. Software Engineer e22 | 33 / 398.5 / 313 / 36 | `4px 12px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| https://example.invalid/resource e25 | 33 / 472 / 313 / 36 | `4px 12px 4px 36px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| What the role involves and who you are loo… e27 | 33 / 545.5 / 313 / 112 | `8px 12px`；`0px`；`normal` | `16px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Company Change company Company name * Webs… e28 | 16 / 694.5 / 347 / 482.5 | `16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Company e30 | 33 / 721 / 63.94 / 21 | `0px`；`0px`；`normal` | `14px/600/21px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Change company e31 | 207.14 / 711.5 / 138.86 / 40 | `0px 12px`；`0px`；`6px` | `14px/500/20px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Company description e40 | 33 / 1048 / 313 / 112 | `8px 12px`；`0px`；`normal` | `16px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Cancel Continue to emails e41 | 16 / 792 / 358 / 40 | `0px`；`0px`；`12px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Continue to emails e43 | 219.22 / 792 / 154.78 / 40 | `8px 16px`；`0px`；`8px` | `14px/500/20px`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgb(34, 34, 34)`；`visible/visible`；`auto` |

## 41 低高度和中等宽度补充

| 捕获 | 直接测量 |
| --- | --- |
| [Schedule1440×600](states/metix-schedule-short-height.json) | dialog1150×600/x290；Next=(1024,544,392,40)；右侧内容scrollbar使部分字段宽381，整体面板仍440 |
| [Interview1440×600](states/metix-interview-short-height.json) | 时间区viewport376高、内容1344、scrollTop968；保持桌面日历与右侧Activity结构 |
| [Interview1024×768](states/metix-interview-1024.json) | sidebar64；Today x100/y90、范围x241.59/y92、timezone x471.34/y88 |
| [Candidate1024×768](states/metix-candidates-1024.json) | sidebar64；候选人滚动框960×535，自(64,233)起，总774；底层chat滚动不属于列表前景 |

以上包含原站裁切和工具栏溢出等实际表现，不将其美化成已经完善适配。完整响应式规则的未知部分仍保持未知。


## Sequence 新增证据范围（更新）

以下补充替代前文“Continue之后编辑器未知”的早期边界；非空收件人、Publish结果、真实发送仍未知。

## 42 Sequence 编辑器：桌面结构

LIVE。Continue to emails 已生成邮件并创建服务器草稿 `sample-object`，标题 `UI inspection draft — Backend Python Engineer sequence`，Recipients 0。未点击 Publish，未发送邮件。URL 为 `/hire/sequence/{sequenceId}`。这是草稿创建证据，不是发布或外联成功证据。

1440×900、DPR1下：侧栏244，主区1196；主区头116、底栏68，内容高716。内容分左836和右360；左区内padding32，邮件卡宽761（滚动条占去其余空间）。头部名称与Editor/Recipients标签在内容滚动之外。左侧三个邮件卡纵向排布：Introduction email、Follow-up 1、Follow-up 2；初始“Start immediately after enrollment”，两段卡间Wait2days。第三卡不是单次已发送结果。

证据：[JSON](states/metix-sequence-editor-1440.json)、[AX](states/metix-sequence-editor-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-editor-1440.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| UI inspection draft — Backend Python Engin e92 | 244 / 0 / 1196 / 900 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`oklch(1 0 0)`；`hidden/hidden`；`auto` |
| UI inspection draft — Backend Python Engin e95 | 244 / 0 / 1196 / 116 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| UI inspection draft — Backend Python Engin e96 | 244 / 0 / 1196 / 65 | `20px 24px 12px`；`0px`；`12px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Back to sequences e97 | 268 / 20.5 / 32 / 32 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| UI inspection draft — Backend Python Engin e99 | 312 / 20 / 548.27 / 33 | `0px`；`0px`；`normal` | `22px/600/33px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Editor Recipients 0 e100 | 244 / 65 / 1196 / 51 | `0px 24px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Editor e102 | 268 / 65 / 38.38 / 51 | `14px 0px`；`0px`；`6px` | `14px/500/21px`；`rgb(34, 34, 34)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Recipients 0 e103 | 338.38 / 65 / 82.3 / 51 | `14px 0px`；`0px`；`6px` | `14px/500/21px`；`rgb(138, 138, 138)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Start immediately after enrollment Step 1  e104 | 244 / 116 / 1196 / 716 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Start immediately after enrollment Step 1  e105 | 244 / 116 / 836 / 716 | `20px 32px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Start immediately after enrollment e106 | 276 / 136 / 761 / 32 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Start immediately after enrollment e107 | 533.45 / 136 / 246.09 / 32 | `0px 10px 0px 14px`；`0px`；`8px` | `12px/500/18px`；`rgb(102, 102, 102)` | `1px solid rgb(235, 235, 235)`；`3.35544e+07px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Step 1 Introduction email Sender email Mir e109 | 276 / 184 / 761 / 623 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`14px`；`rgb(255, 255, 255)`；`hidden/hidden`；`auto` |
| Step 1 Introduction email e110 | 277 / 185 / 759 / 44 | `0px 16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sender email Mira’s mailbox Manage e112 | 293 / 245 / 727 / 66 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Mira’s mailbox Manage e114 | 293 / 275 / 727 / 36 | `0px 12px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(250, 250, 250)`；`visible/visible`；`auto` |
| Manage mailboxes e117 | 950.09 / 279 / 56.91 / 28 | `0px 6px`；`0px`；`6px` | `12px/400/18px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| We are hiring: {job_title} at {company_nam e119 | 293 / 350.5 / 727 / 37 | `0px`；`4px 0px 0px`；`normal` | `14px/400/21px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Subject e120 | 294 / 351.5 / 604.63 / 35 | `7px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Hi {candidate_first_name}, I noticed your  e123 | 294 / 428 / 725 / 361 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |
| 244 / 116 / 836 / 716 | 825/716 | 825/2133 | 0/0 | auto/auto |
| 294 / 428 / 725 / 320 | 710/320 | 710/424 | 0/0 | auto/auto |
| 294 / 1139 / 725 / 320 | 710/320 | 710/401 | 0/0 | auto/auto |
| 294 / 1850 / 725 / 320 | 710/320 | 710/357 | 0/0 | auto/auto |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T64 文字或图标样本 | Introduction email | 340.08/197.5/101.98/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T71 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/358.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T72 文字或图标样本 | {job_title} variable | 398.62/360.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T80 文字或图标样本 | {job_title} variable | 306/575.95/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T107 文字或图标样本 | Follow-up 1 | 341.83/908.5/65/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T114 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1069.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T115 文字或图标样本 | {job_title} variable | 398.62/1071.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T121 文字或图标样本 | {job_title} variable | 334.45/1241.77/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T147 文字或图标样本 | Follow-up 2 | 342.14/1619.5/66.67/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T154 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1780.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T155 文字或图标样本 | {job_title} variable | 398.62/1782.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T162 文字或图标样本 | {job_title} variable | 672.83/1907.98/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T181 文字或图标样本 | Sequence Name *54/50 | 1101/136/319/83.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/24px | `rgb(51, 51, 51)` |
| T182 文字或图标样本 | Sequence Name * | 1101/136/319/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/500/19.5px | `rgb(34, 34, 34)` |
| T194 文字或图标样本 | Chicago | 1138/497.75/162.94/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/19.5px | `rgb(34, 34, 34)` |

## 43 Sequence 富文本与交付设置

主题和正文均带变量插入入口；Subject可编辑区域与Insert variable分开。正文有独立320高滚动区，工具栏在其下；初始Undo/Redo禁用，工具栏包含列表、粗体、斜体、删除线、下划线、链接、四种对齐及变量。后两卡重复此结构；每段延迟有数字2、增减按钮和days单位。

右侧设置列含Favorite sequence、Sequence Name必填、Sequence Description、Delivery及Exit criteria。实际名称计数54/50、描述0/100；这只证明显示值，未测试名称长度限制或发布校验。发送窗口09:00–21:00；Business days only开关初始关闭；Exit criteria显示Reply received。底栏Cancel/Previous/Publish，桌面Publish带快捷键提示。`metix-sequence-editor-settings-1440`与本状态主滚动位置相同，不是滚到底部或另一个设置弹窗。

REQ。编辑模板时保持变量边界；延迟变更影响对应下一步；发送窗口、时区与Business days共同约束计划；发布前校验和提交结果必须真实。UNKNOWN。未实测编辑后保存时机、发布校验、发布结果、启停、入序列和实际发信。

证据：[JSON](states/metix-sequence-editor-1440.json)、[AX](states/metix-sequence-editor-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-editor-1440.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| Hi {candidate_first_name}, I noticed your  e124 | 294 / 428 / 725 / 320 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Message e125 | 294 / 428 / 710 / 424.25 | `10px 12px`；`0px`；`normal` | `14px/400/22.4px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Insert variable e126 | 294 / 748 / 725 / 41 | `0px 10px 0px 0px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| toolbar e127 | 294 / 749 / 715 / 40 | `4px 6px`；`0px`；`4px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px none rgb(51, 51, 51)`；`0px`；`rgb(255, 255, 255)`；`auto/auto`；`10` |
| Undo e129 | 374.81 / 753 / 32 / 32 | `8px`；`0px`；`2px` | `14px/500/16.1px`；`rgba(40, 44, 51, 0.42)` | `0px none rgba(40, 44, 51, 0.42)`；`12px`；`rgba(255, 255, 255, 0)`；`visible/visible`；`auto` |
| Redo e131 | 408.81 / 753 / 32 / 32 | `8px`；`0px`；`2px` | `14px/500/16.1px`；`rgba(40, 44, 51, 0.42)` | `0px none rgba(40, 44, 51, 0.42)`；`12px`；`rgba(255, 255, 255, 0)`；`visible/visible`；`auto` |
| List options e135 | 449.81 / 753 / 38 / 32 | `8px 4px 8px 8px`；`0px`；`0px` | `14px/500/16.1px`；`rgba(36, 39, 46, 0.78)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`rgba(255, 255, 255, 0)`；`visible/visible`；`auto` |
| Bold e140 | 496.81 / 753 / 32 / 32 | `8px`；`0px`；`2px` | `14px/500/16.1px`；`rgba(36, 39, 46, 0.78)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`rgba(255, 255, 255, 0)`；`visible/visible`；`auto` |
| Link e148 | 632.81 / 753 / 32 / 32 | `8px`；`0px`；`2px` | `14px/500/16.1px`；`rgba(36, 39, 46, 0.78)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`rgba(255, 255, 255, 0)`；`visible/visible`；`auto` |
| Align left e152 | 673.81 / 753 / 32 / 32 | `8px`；`0px`；`2px` | `14px/500/16.1px`；`rgba(36, 39, 46, 0.78)` | `0px none rgba(36, 39, 46, 0.78)`；`12px`；`rgba(255, 255, 255, 0)`；`visible/visible`；`auto` |
| Insert variable e161 | 886.63 / 755 / 116.38 / 28 | `0px 8px`；`0px`；`4px` | `12px/500/18px`；`rgb(75, 85, 99)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sequence Name * 54/50 Sequence Description e291 | 1080 / 116 / 360 / 716 | `20px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgb(255, 255, 255)`；`auto/auto`；`auto` |
| Favorite sequence e293 | 1404 / 136 / 16 / 16 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(128, 128, 128)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sequence name e296 | 1101 / 161.5 / 319 / 36 | `4px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| Sequence description e298 | 1101 / 257 / 319 / 60 | `8px 12px`；`0px`；`normal` | `14px/400/20px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Sending window start e302 | 1101 / 445.5 / 155.5 / 36 | `8px 12px`；`0px`；`8px` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Sending window end e305 | 1264.5 / 445.5 / 155.5 / 36 | `8px 12px`；`0px`；`8px` | `14px/400/20px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Timezone e308 | 1101 / 489.5 / 319 / 36 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| BUTTON e311 | 1388 / 542.05 / 32 / 18.39 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgba(0, 0, 0, 0)`；`3.35544e+07px`；`rgb(235, 235, 235)`；`visible/visible`；`auto` |
| Reply received e314 | 1101 / 641.5 / 319 / 45.5 | `12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`10px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |
| 244 / 116 / 836 / 716 | 825/716 | 825/2133 | 0/0 | auto/auto |
| 294 / 428 / 725 / 320 | 710/320 | 710/424 | 0/0 | auto/auto |
| 294 / 1139 / 725 / 320 | 710/320 | 710/401 | 0/0 | auto/auto |
| 294 / 1850 / 725 / 320 | 710/320 | 710/357 | 0/0 | auto/auto |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T64 文字或图标样本 | Introduction email | 340.08/197.5/101.98/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T71 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/358.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T72 文字或图标样本 | {job_title} variable | 398.62/360.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T80 文字或图标样本 | {job_title} variable | 306/575.95/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T107 文字或图标样本 | Follow-up 1 | 341.83/908.5/65/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T114 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1069.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T115 文字或图标样本 | {job_title} variable | 398.62/1071.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T121 文字或图标样本 | {job_title} variable | 334.45/1241.77/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T147 文字或图标样本 | Follow-up 2 | 342.14/1619.5/66.67/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T154 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1780.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T155 文字或图标样本 | {job_title} variable | 398.62/1782.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T162 文字或图标样本 | {job_title} variable | 672.83/1907.98/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T181 文字或图标样本 | Sequence Name *54/50 | 1101/136/319/83.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/24px | `rgb(51, 51, 51)` |
| T182 文字或图标样本 | Sequence Name * | 1101/136/319/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/500/19.5px | `rgb(34, 34, 34)` |
| T194 文字或图标样本 | Chicago | 1138/497.75/162.94/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/19.5px | `rgb(34, 34, 34)` |

## 44 Sequence 变量菜单

LIVE。Subject的Insert variable打开浮层，八项依次为`{job_title}`、`{company_name}`、`{candidate_first_name}`、`{candidate_current_company}`、`{compensation_and_location}`、`{responsibility_list}`、`{sender_name}`、`{relevant_domain}`。208.55宽浮层位于触发区域下方。未点击插入，不推断光标位置、缺失值替换规则或模板渲染服务。

证据：[JSON](states/metix-sequence-variables-1440.json)、[AX](states/metix-sequence-variables-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-variables-1440.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| We are hiring: {job_title} at {company_nam e119 | 293 / 350.5 / 727 / 37 | `0px`；`4px 0px 0px`；`normal` | `14px/400/21px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Insert variable e121 | 898.63 / 355 / 116.38 / 28 | `0px 8px`；`0px`；`4px` | `12px/500/18px`；`rgb(75, 85, 99)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgb(243, 244, 246)`；`visible/visible`；`auto` |
| {job_title} {company_name} {candidate_firs e326 | 806 / 387 / 208.55 / 262 | `4px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `1px solid oklch(0.92 0.004 286.32)`；`8.4px`；`oklch(1 0 0)`；`hidden/auto`；`50` |
| {job_title} e327 | 811 / 392 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {company_name} e328 | 811 / 423.5 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {candidate_first_name} e329 | 811 / 455 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {candidate_current_company} e330 | 811 / 486.5 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {compensation_and_location} e331 | 811 / 518 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {responsibility_list} e332 | 811 / 549.5 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {sender_name} e333 | 811 / 581 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| {relevant_domain} e334 | 811 / 612.5 / 198.55 / 31.5 | `6px 8px`；`0px`；`8px` | `13px/400/19.5px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |
| 244 / 116 / 836 / 716 | 825/716 | 825/2133 | 0/0 | auto/auto |
| 294 / 428 / 725 / 320 | 710/320 | 710/424 | 0/0 | auto/auto |
| 294 / 1139 / 725 / 320 | 710/320 | 710/401 | 0/0 | auto/auto |
| 294 / 1850 / 725 / 320 | 710/320 | 710/357 | 0/0 | auto/auto |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T64 文字或图标样本 | Introduction email | 340.08/197.5/101.98/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T71 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/358.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T72 文字或图标样本 | {job_title} variable | 398.62/360.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T80 文字或图标样本 | {job_title} variable | 306/575.95/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T107 文字或图标样本 | Follow-up 1 | 341.83/908.5/65/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T114 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1069.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T115 文字或图标样本 | {job_title} variable | 398.62/1071.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T121 文字或图标样本 | {job_title} variable | 334.45/1241.77/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T147 文字或图标样本 | Follow-up 2 | 342.14/1619.5/66.67/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T154 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1780.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T155 文字或图标样本 | {job_title} variable | 398.62/1782.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T162 文字或图标样本 | {job_title} variable | 672.83/1907.98/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T181 文字或图标样本 | Sequence Name *54/50 | 1101/136/319/83.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/24px | `rgb(51, 51, 51)` |
| T182 文字或图标样本 | Sequence Name * | 1101/136/319/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/500/19.5px | `rgb(34, 34, 34)` |
| T194 文字或图标样本 | Chicago | 1138/497.75/162.94/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/19.5px | `rgb(34, 34, 34)` |

## 45 Sequence 时区菜单

LIVE。Timezone打开可搜索城市列表，Search timezone输入框与列表分区。此快照列表scrollTop4352，不能将已滚出视口的城市当可见项。E采集1802/1802、无截断；T样本1400，可能达到文本采集上限，不能宣称完整城市排版库存。可见城市包括Cayenne/Cayman/Chicago/Chihuahua/Ciudad Juarez。仅记录原站展示的时区/偏移，不由城市文本推断其换算算法正确性。

证据：[JSON](states/metix-sequence-timezone-1440.json)、[AX](states/metix-sequence-timezone-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-timezone-1440.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| Timezone e308 | 1101 / 489.5 / 319 / 36 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(119, 65, 255)`；`8.4px`；`rgb(250, 250, 250)`；`visible/visible`；`auto` |
| Abidjan 01/11 4:10 AM GMT+1 Accra 01/11 4: e325 | 1101 / 163 / 319 / 323 | `0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`50` |
| Abidjan 01/11 4:10 AM GMT+1 Accra 01/11 4: e326 | 1101 / 163 / 319 / 323 | `0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `1px solid rgb(235, 235, 235)`；`10px`；`oklch(1 0 0)`；`hidden/hidden`；`50` |
| DIV e327 | 1102 / 164 / 317 / 41 | `8px 12px`；`0px`；`8px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Search timezone e329 | 1136 / 172 / 271 / 24 | `0px`；`0px`；`normal` | `13px/400/19.5px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| Timezones e330 | 1102 / 205 / 317 / 280 | `4px 0px`；`0px`；`normal` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Cayenne 01/11 1:10 AM GMT-3 e604 | 1106 / 225 / 298 / 48 | `0px 10px`；`0px`；`12px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Cayman 31/10 11:10 PM GMT-5 e607 | 1106 / 273 / 298 / 48 | `0px 10px`；`0px`；`12px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Chicago 31/10 11:10 PM GMT-5 e610 | 1106 / 321 / 298 / 48 | `0px 10px`；`0px`；`12px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgb(245, 245, 245)`；`visible/visible`；`auto` |
| Chihuahua 31/10 10:10 PM GMT-6 e614 | 1106 / 369 / 298 / 48 | `0px 10px`；`0px`；`12px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Ciudad Juarez 31/10 10:10 PM GMT-6 e617 | 1106 / 417 / 298 / 48 | `0px 10px`；`0px`；`12px` | `16px/400/24px`；`oklch(0.141 0.005 285.823)` | `0px solid oklch(0.92 0.004 286.32)`；`6px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |
| 244 / 116 / 836 / 716 | 825/716 | 825/2133 | 0/0 | auto/auto |
| 294 / 428 / 725 / 320 | 710/320 | 710/424 | 0/0 | auto/auto |
| 294 / 1139 / 725 / 320 | 710/320 | 710/401 | 0/0 | auto/auto |
| 294 / 1850 / 725 / 320 | 710/320 | 710/357 | 0/0 | auto/auto |
| 1102 / 205 / 317 / 280 | 306/280 | 306/23528 | 0/4352 | auto/auto |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T64 文字或图标样本 | Introduction email | 340.08/197.5/101.98/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T71 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/358.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T72 文字或图标样本 | {job_title} variable | 398.62/360.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T80 文字或图标样本 | {job_title} variable | 306/575.95/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T107 文字或图标样本 | Follow-up 1 | 341.83/908.5/65/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T114 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1069.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T115 文字或图标样本 | {job_title} variable | 398.62/1071.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T121 文字或图标样本 | {job_title} variable | 334.45/1241.77/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T147 文字或图标样本 | Follow-up 2 | 342.14/1619.5/66.67/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T154 文字或图标样本 | We are hiring: {job_title} at {company_name} | 306/1780.5/580.62/21 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14px/400/20px | `rgb(34, 34, 34)` |
| T155 文字或图标样本 | {job_title} variable | 398.62/1782.5/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20px | `rgb(75, 85, 99)` |
| T162 文字或图标样本 | {job_title} variable | 672.83/1907.98/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T181 文字或图标样本 | Sequence Name *54/50 | 1101/136/319/83.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/24px | `rgb(51, 51, 51)` |
| T182 文字或图标样本 | Sequence Name * | 1101/136/319/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/500/19.5px | `rgb(34, 34, 34)` |
| T194 文字或图标样本 | Chicago | 1138/497.75/162.94/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/19.5px | `rgb(34, 34, 34)` |

## 46 Sequence Recipients 空态

LIVE。Recipients标签计数0，主区高784直到视口底部，没有Editor底部发布栏。左收件人栏380、右详情816。左侧Search recipients和Search按钮，下方All、Active0、Paused0、Exited0；Active初始选中。列表空态“No recipients in this status / Choose another status to view recipients.”；右侧“Select a recipient / Review their emails and sending progress here.”。没有非空收件人列表或入序列操作证据，不能补写批量动作。

证据：[JSON](states/metix-sequence-recipients-1440.json)、[AX](states/metix-sequence-recipients-1440.txt)、[截图（匿名布局图）](diagrams/metix-sequence-recipients-1440.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| UI inspection draft — Backend Python Engin e95 | 244 / 0 / 1196 / 116 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| UI inspection draft — Backend Python Engin e99 | 312 / 20 / 548.27 / 33 | `0px`；`0px`；`normal` | `22px/600/33px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Editor Recipients 0 e100 | 244 / 65 / 1196 / 51 | `0px 24px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Editor e102 | 268 / 65 / 38.38 / 51 | `14px 0px`；`0px`；`6px` | `14px/500/21px`；`rgb(138, 138, 138)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Recipients 0 e103 | 338.38 / 65 / 82.3 / 51 | `14px 0px`；`0px`；`6px` | `14px/500/21px`；`rgb(34, 34, 34)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| All Active 0 Paused 0 Exited 0 No recipien e104 | 244 / 116 / 1196 / 784 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| All Active 0 Paused 0 Exited 0 No recipien e106 | 244 / 116 / 380 / 784 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | ``；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| FORM e107 | 260 / 136 / 347 / 44 | `0px 6px 0px 14px`；`0px 0px 16px`；`2px` | `16px/400/24px`；`rgb(34, 34, 34)` | `1px solid rgb(229, 229, 229)`；`10px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Search recipients e108 | 275 / 138 / 291 / 40 | `4px 0px`；`0px`；`normal` | `14px/400/20px`；`rgb(34, 34, 34)` | `0px solid rgb(235, 235, 235)`；`0px`；`rgba(0, 0, 0, 0)`；`clip/clip`；`auto` |
| Search e109 | 568 / 142 / 32 / 32 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Filter recipients by status e111 | 260 / 196 / 347 / 32 | `0px`；`0px`；`6px` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| All e112 | 260 / 196 / 40.73 / 32 | `0px 12px`；`0px`；`4px` | `12px/500/18px`；`rgb(34, 34, 34)` | `1px solid rgb(229, 229, 229)`；`3.35544e+07px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Active 0 e113 | 306.73 / 196 / 73.72 / 32 | `0px 12px`；`0px`；`4px` | `12px/500/18px`；`rgb(255, 255, 255)` | `1px solid rgb(34, 34, 34)`；`3.35544e+07px`；`rgb(34, 34, 34)`；`visible/visible`；`auto` |
| Paused 0 e114 | 386.45 / 196 / 80.17 / 32 | `0px 12px`；`0px`；`4px` | `12px/500/18px`；`rgb(34, 34, 34)` | `1px solid rgb(229, 229, 229)`；`3.35544e+07px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Exited 0 e115 | 472.63 / 196 / 73.61 / 32 | `0px 12px`；`0px`；`4px` | `12px/500/18px`；`rgb(34, 34, 34)` | `1px solid rgb(229, 229, 229)`；`3.35544e+07px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| No recipients in this status Choose anothe e116 | 244 / 248 / 379 / 652 | `12px`；`0px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/auto`；`auto` |
| No recipients in this status Choose anothe e117 | 256 / 260 / 355 / 206 | `48px 16px`；`0px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| No recipients in this status e120 | 308.09 / 368 / 250.8 / 24 | `0px`；`16px 0px 0px`；`normal` | `16px/600/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Select a recipient Review their emails and e121 | 624 / 116 / 816 / 784 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Select a recipient e125 | 889.33 / 513 / 285.33 / 24 | `0px`；`16px 0px 0px`；`normal` | `16px/600/24px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T67 文字或图标样本 | Choose another status to view recipients. | 308.09/398/250.8/20 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/20px | `rgb(102, 102, 102)` |

## 47 Sequence 手机编辑器与嵌套滚动

390×844、DPR1。侧栏不显示；头115，底栏64，中央滚动视窗665。标题单行省略，返回按钮40×40。卡片外边距12，卡宽355；主题换成58高，变量按钮为30×28图标入口。正文仍320高，内容宽304，底部工具栏宽309，不能把桌面工具栏简单同比缩小。桌面右设置列改排在三封邮件之后；其Timezone在此快照y2725.5，处于主容器裁切外，不是首屏可见控件。底栏Cancel/Previous/Publish始终可见，Publish手机宽80.52且无桌面快捷键。

`metix-sequence-editor-scrolled-390`主编辑区scrollTop仍0；实际改变的是第一封正文内滚动：scrollTop216，内容高536.41，视窗320。它证明正文嵌套滚动，不证明滚到页面末尾、设置区或后两封邮件。相关对照见下一节。

证据：[JSON](states/metix-sequence-editor-390.json)、[AX](states/metix-sequence-editor-390.txt)、[截图（匿名布局图）](diagrams/metix-sequence-editor-390.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| UI inspection draft — Backend Python Engin e0 | 0 / 0 / 390 / 844 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(255, 255, 255)`；`auto/auto`；`auto` |
| UI inspection draft — Backend Python Engin e5 | 0 / 0 / 390 / 115 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| UI inspection draft — Backend Python Engin e6 | 0 / 0 / 390 / 64 | `12px 16px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Back to sequences e7 | 16 / 12 / 40 / 40 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| UI inspection draft — Backend Python Engin e9 | 64 / 18.5 / 310 / 27 | `0px`；`0px`；`normal` | `18px/600/27px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Editor Recipients 0 e10 | 0 / 64 / 390 / 51 | `0px 16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Editor e12 | 16 / 64 / 38.38 / 51 | `14px 0px`；`0px`；`6px` | `14px/500/21px`；`rgb(34, 34, 34)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Recipients 0 e13 | 86.38 / 64 / 82.3 / 51 | `14px 0px`；`0px`；`6px` | `14px/500/21px`；`rgb(138, 138, 138)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Start immediately after enrollment Step 1  e14 | 0 / 115 / 390 / 665 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Start immediately after enrollment Step 1  e15 | 0 / 115 / 390 / 665 | `16px 12px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Start immediately after enrollment e16 | 12 / 131 / 355 / 44 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Start immediately after enrollment e17 | 66.45 / 131 / 246.09 / 44 | `0px 10px 0px 14px`；`0px`；`8px` | `12px/500/18px`；`rgb(102, 102, 102)` | `1px solid rgb(235, 235, 235)`；`3.35544e+07px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Step 1 Introduction email Sender email Mir e19 | 12 / 191 / 355 / 644 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(204, 204, 204)`；`14px`；`rgb(255, 255, 255)`；`hidden/hidden`；`auto` |
| Step 1 Introduction email e20 | 13 / 192 / 353 / 44 | `0px 16px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Mira’s mailbox Manage e24 | 29 / 282 / 321 / 36 | `0px 12px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(250, 250, 250)`；`visible/visible`；`auto` |
| We are hiring: {job_title} at {company_nam e29 | 29 / 357.5 / 321 / 58 | `0px`；`4px 0px 0px`；`normal` | `14px/400/21px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Subject e30 | 30 / 358.5 / 285 / 56 | `7px 12px`；`0px`；`normal` | `16px/400/20px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Insert variable e31 | 315 / 372.5 / 30 / 28 | `0px 8px`；`0px`；`4px` | `12px/500/18px`；`rgb(75, 85, 99)` | `0px solid oklch(0.92 0.004 286.32)`；`4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Hi {candidate_first_name}, I noticed your  e34 | 30 / 456 / 319 / 320 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Cancel Previous Publish e228 | 16 / 792 / 358 / 40 | `0px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |
| 0 / 115 / 390 / 665 | 379/665 | 379/2845 | 0/0 | auto/auto |
| 30 / 456 / 319 / 320 | 304/320 | 304/536 | 0/0 | auto/auto |
| 30 / 777 / 309 / 40 | 309/40 | 492/40 | 0/0 | auto/auto |
| 30 / 1200 / 319 / 320 | 304/320 | 304/558 | 0/0 | auto/auto |
| 30 / 1521 / 309 / 40 | 309/40 | 492/40 | 0/0 | auto/auto |
| 30 / 1944 / 319 / 320 | 304/320 | 304/491 | 0/0 | auto/auto |
| 30 / 2265 / 309 / 40 | 309/40 | 492/40 | 0/0 | auto/auto |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T4 文字或图标样本 | Introduction email | 76.08/204.5/101.98/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T11 文字或图标样本 | We are hiring: {job_title} at {company_name} | 42/365.5/261/42 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/20px | `rgb(34, 34, 34)` |
| T12 文字或图标样本 | {job_title} variable | 145.73/366.5/77.52/19 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14.72px/500/20px | `rgb(75, 85, 99)` |
| T19 文字或图标样本 | {job_title} variable | 247.02/671.12/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T45 文字或图标样本 | Follow-up 1 | 77.83/948.5/65/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T52 文字或图标样本 | We are hiring: {job_title} at {company_name} | 42/1109.5/261/42 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/20px | `rgb(34, 34, 34)` |
| T53 文字或图标样本 | {job_title} variable | 145.73/1110.5/77.52/19 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14.72px/500/20px | `rgb(75, 85, 99)` |
| T58 文字或图标样本 | {job_title} variable | 70.45/1347.55/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T83 文字或图标样本 | Follow-up 2 | 78.14/1692.5/66.67/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T90 文字或图标样本 | We are hiring: {job_title} at {company_name} | 42/1853.5/261/42 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/20px | `rgb(34, 34, 34)` |
| T91 文字或图标样本 | {job_title} variable | 145.73/1854.5/77.52/19 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14.72px/500/20px | `rgb(75, 85, 99)` |
| T97 文字或图标样本 | {job_title} variable | 162.14/2024.38/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T115 文字或图标样本 | Sequence Name *54/50 | 25/2368/329/83.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/24px | `rgb(51, 51, 51)` |
| T116 文字或图标样本 | Sequence Name * | 25/2368/329/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/500/19.5px | `rgb(34, 34, 34)` |
| T128 文字或图标样本 | Chicago | 62/2735.75/172.94/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/19.5px | `rgb(34, 34, 34)` |

## 48 Sequence 手机正文滚动后

LIVE。与手机初始页对照：主容器未滚动，第一封邮件正文滚动216；正文下工具栏仍在原位置。设置区仍在主滚动内容下方。当前截图不能用于验收末尾设置区的实际触达和布局。任何eN的负坐标或超出祖先裁切范围坐标只说明测量到DOM，不代表前景可见。

证据：[JSON](states/metix-sequence-editor-scrolled-390.json)、[AX](states/metix-sequence-editor-scrolled-390.txt)、[截图（匿名布局图）](diagrams/metix-sequence-editor-scrolled-390.svg)。

| 组件 / 索引 | x / y / w / h | padding；margin；gap | 字号/字重/行高；颜色 | 边框；圆角；背景；overflowX/Y；z |
| --- | --- | --- | --- | --- |
| Start immediately after enrollment Step 1  e14 | 0 / 115 / 390 / 665 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Start immediately after enrollment Step 1  e15 | 0 / 115 / 390 / 665 | `16px 12px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Step 1 Introduction email Sender email Mir e19 | 12 / 191 / 355 / 644 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgb(204, 204, 204)`；`14px`；`rgb(255, 255, 255)`；`hidden/hidden`；`auto` |
| We are hiring: {job_title} at {company_nam e29 | 29 / 357.5 / 321 / 58 | `0px`；`4px 0px 0px`；`normal` | `14px/400/21px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Hi {candidate_first_name}, I noticed your  e33 | 30 / 456 / 319 / 361 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgba(0, 0, 0, 0)`；`hidden/hidden`；`auto` |
| Hi {candidate_first_name}, I noticed your  e34 | 30 / 456 / 319 / 320 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`auto/auto`；`auto` |
| Message e35 | 30 / 240 / 304 / 536.41 | `10px 12px`；`0px`；`normal` | `14px/400/22.4px`；`rgb(34, 34, 34)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Insert variable e36 | 30 / 776 / 319 / 41 | `0px 10px 0px 0px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| toolbar e37 | 30 / 777 / 309 / 40 | `4px 6px`；`0px`；`4px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px none rgb(51, 51, 51)`；`0px`；`rgb(255, 255, 255)`；`auto/auto`；`10` |
| Timezone e220 | 25 / 2725.5 / 329 / 40 | `0px 12px`；`0px`；`8px` | `13px/400/19.5px`；`rgb(34, 34, 34)` | `1px solid rgb(235, 235, 235)`；`8.4px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| BUTTON e223 | 322 / 2782.05 / 32 / 18.39 | `0px`；`0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | `1px solid rgba(0, 0, 0, 0)`；`3.35544e+07px`；`rgb(235, 235, 235)`；`visible/visible`；`auto` |
| Exit criteria Reply received e224 | 25 / 2829 / 329 / 98 | `20px 0px 0px`；`24px 0px 0px`；`normal` | `16px/400/24px`；`rgb(51, 51, 51)` | ``；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Cancel Previous Publish e228 | 16 / 792 / 358 / 40 | `0px`；`0px`；`8px` | `16px/400/24px`；`rgb(51, 51, 51)` | `0px solid oklch(0.92 0.004 286.32)`；`0px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Cancel e230 | 121.16 / 792 / 69.36 / 40 | `8px 12px`；`0px`；`8px` | `14px/500/20px`；`rgb(102, 102, 102)` | `0px solid oklch(0.92 0.004 286.32)`；`8.4px`；`rgba(0, 0, 0, 0)`；`visible/visible`；`auto` |
| Previous e232 | 202.52 / 792 / 82.97 / 40 | `8px 12px`；`0px`；`8px` | `14px/500/20px`；`rgb(68, 68, 68)` | `1px solid rgb(229, 229, 229)`；`8px`；`rgb(255, 255, 255)`；`visible/visible`；`auto` |
| Publish e233 | 293.48 / 792 / 80.52 / 40 | `8px 16px`；`0px`；`8px` | `14px/500/20px`；`rgb(255, 255, 255)` | `0px solid oklch(0.92 0.004 286.32)`；`8px`；`rgb(34, 34, 34)`；`visible/visible`；`auto` |

滚动容器实测：

| rect x/y/w/h | client w/h | scroll w/h | scrollLeft/Top | overflowX/Y |
| --- | --- | --- | --- | --- |
| 0 / 115 / 390 / 665 | 379/665 | 379/2845 | 0/0 | auto/auto |
| 30 / 456 / 319 / 320 | 304/320 | 304/536 | 0/216 | auto/auto |
| 30 / 777 / 309 / 40 | 309/40 | 492/40 | 0/0 | auto/auto |
| 30 / 1200 / 319 / 320 | 304/320 | 304/558 | 0/0 | auto/auto |
| 30 / 1521 / 309 / 40 | 309/40 | 492/40 | 0/0 | auto/auto |
| 30 / 1944 / 319 / 320 | 304/320 | 304/491 | 0/0 | auto/auto |
| 30 / 2265 / 309 / 40 | 309/40 | 492/40 | 0/0 | auto/auto |

文字与图标样本（T为本文件samples序号，仅列相关实际文本，非父容器样式推断）：

| T | 文本 | x/y/w/h | 字体 | 字号/字重/行高 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| T4 文字或图标样本 | Introduction email | 76.08/204.5/101.98/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T11 文字或图标样本 | We are hiring: {job_title} at {company_name} | 42/365.5/261/42 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/20px | `rgb(34, 34, 34)` |
| T12 文字或图标样本 | {job_title} variable | 145.73/366.5/77.52/19 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14.72px/500/20px | `rgb(75, 85, 99)` |
| T19 文字或图标样本 | {job_title} variable | 247.02/455.12/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T45 文字或图标样本 | Follow-up 1 | 77.83/948.5/65/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T52 文字或图标样本 | We are hiring: {job_title} at {company_name} | 42/1109.5/261/42 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/20px | `rgb(34, 34, 34)` |
| T53 文字或图标样本 | {job_title} variable | 145.73/1110.5/77.52/19 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14.72px/500/20px | `rgb(75, 85, 99)` |
| T58 文字或图标样本 | {job_title} variable | 70.45/1347.55/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T83 文字或图标样本 | Follow-up 2 | 78.14/1692.5/66.67/18 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12px/400/18px | `rgb(128, 128, 128)` |
| T90 文字或图标样本 | We are hiring: {job_title} at {company_name} | 42/1853.5/261/42 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/20px | `rgb(34, 34, 34)` |
| T91 文字或图标样本 | {job_title} variable | 145.73/1854.5/77.52/19 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 14.72px/500/20px | `rgb(75, 85, 99)` |
| T97 文字或图标样本 | {job_title} variable | 162.14/2024.38/70.38/17 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 12.88px/500/20.608px | `rgb(75, 85, 99)` |
| T115 文字或图标样本 | Sequence Name *54/50 | 25/2368/329/83.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 16px/400/24px | `rgb(51, 51, 51)` |
| T116 文字或图标样本 | Sequence Name * | 25/2368/329/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/500/19.5px | `rgb(34, 34, 34)` |
| T128 文字或图标样本 | Chicago | 62/2735.75/172.94/19.5 | `ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` | 13px/400/19.5px | `rgb(34, 34, 34)` |
