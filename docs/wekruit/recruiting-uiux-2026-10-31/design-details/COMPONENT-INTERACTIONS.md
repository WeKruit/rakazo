> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# 组件交互状态契约

本文件供工程师实现具体控件与状态，不重复业务 PRD。范围是本次已登录现场出现的 Juicebox 与 Metix 页面。本文将“控件存在”“展开后实际内容”“操作后数据改变”分开记录；出现按钮不等于已执行它，出现 loading 不等于最终空态，AX 中的隐藏副本不当作第二个可见组件。

## 1. 读取规则与全组件状态字典

每个组件使用稳定的文档 ID；ID 仅用于设计与验收，不要求产品新增对应实体或组件抽象。六种状态如下：

| 记号 | 状态 | 实现时需要回答 |
|---|---|---|
| D | default | 未激活时显示什么、位置是否占位、默认值来自哪里 |
| S | selected | 哪个值/对象被选中，文字、图标、边框与可访问语义如何共同表达 |
| X | expanded | 展开的是菜单、popover、正文、抽屉或下一级表单；锚点与关闭规则是什么 |
| I | disabled | 为什么不可用；不能只保留灰色而继续响应键盘或click |
| L | loading | 哪个对象正在读取/保存；旧内容是否可见，什么仍可操作 |
| E | error | 哪个操作失败；保留什么输入/选择，能否重试，是否已经产生业务结果 |

- **LIVE**：本次实际显示或操作到了的状态，按引用的 AX 与截图核对。
- **REQ**：复刻这个既有交互所需的明确工程约束；未声称竞品已经这样处理。
- **UNKNOWN**：本次未观察到原站该状态或操作后果，不能凭按钮、颜色或静态代码补成事实。
- **N/A**：该状态对组件没有语义，例如纯标签没有“展开”；不为凑六态新增交互。

下面各行的六态都适用：凡未单独注明的 **L/E 为 UNKNOWN**，同时继承第2节的 REQ 加载/错误契约。凡写“候选值展开 LIVE、选择 UNKNOWN”，不得把菜单已展开当作保存已验证。每个状态变体都应与同一对象 identity、范围和源数据关联，而不是为了渲染新状态复制一份业务数据。

具体位置、宽高、边距、字体和页面/容器高度以本目录 `states/*.json` 的对应状态记录为测量依据，见第14节；不要把本文件的功能ID误当作原站 DOM ID，不把截图宽度硬编码成响应式算法。

## 2. 共用输入输出和状态约束

### 2.1 数据范围与异步

**REQ**：组件事件携带当前 account/workspace、role/project、contact、sequence/run/thread/event 等其实际需要的 identity。更新前后都维持同一对象；A→B切换后的迟到A响应不得覆盖B。筛选、排序、分页与选中对象不是同一个字段；不要通过变更筛选而改写候选人阶段。

**REQ L**：

1. 正在加载的集合显示 loading/骨架，已有已确认数据可在刷新时保留，但必须能区分“旧数据刷新中”与“新范围已加载”。
2. 未取得数量不能显示0；未取得费用不能显示免费；未取得评价不能生成默认 Strong Match。
3. 弹层自己的查找/保存不应阻塞无关的关闭或取消动作；提交中需要防止重复提交。
4. 页面、列表、详情、局部字段各自有加载边界。表头可见但行尚未返回，不是空表成功态。

**REQ E**：

1. 读失败留在相同页面/范围，原有过滤与分页可读，提供重试，不自动跳入另一岗位/人。
2. 写失败保留用户输入与原持久化值，明确未保存，不伪造成功toast、邮件、run或日历事件。
3. 提交结果不确定时先读取原动作结果，不盲目重发。此次未执行真实发送/邀约，原站具体重试文案及服务端行为 UNKNOWN。
4. 字段错误靠近字段并用语义关联，表单级错误靠近当前提交区。无效字段、网络失败、无权限、额度不足不是同一个通用空态。

### 2.2 关闭与焦点

**REQ**：菜单/popover由触发按钮打开，焦点进入最适当控件；Escape先关最上层，回到原触发按钮。抽屉/dialog打开时，底层不可误点、不能Tab进入遮罩后的表单。关闭详情回到原列表位置；未保存的业务表单先保护输入，再允许关闭。原站每个popover是否支持outside-click以及精确focus trap未逐个实测，均非LIVE结论。

### 2.3 滚动与尺寸

**REQ**：标注 scroll owner。列表滚动不带走全局导航；详情正文滚动不带走关闭入口；菜单过长时菜单内部滚动，不能越过视口底部；多个可滚动区域必须有可辨识边界。固定/粘性操作栏不得遮住最后一行、输入或日历时段。全屏面板不是把内容裁到窗口高，长页必须保留其真实scrollHeight。

### 2.4 输入设备与单一动作

**REQ**：点击卡片/行、checkbox、内嵌link、三点、favorite、remove分别命中各自动作，不冒泡触发第二个动作。交互区域的视觉大小与实际hit area都需要标注；小图标可以有更大的透明点击区。所有图标有名称，当前导航用`aria-current`，tab用selected语义，checkbox有mixed状态；不得只靠颜色。

## 3. 共用基础组件

| ID / 组件 | 六态契约 | 触发与反馈 | 关闭、滚动、焦点 | 数据影响 |
|---|---|---|---|---|
| B01 侧栏链接与当前项 | D普通文字/图标 LIVE；S Juicebox浅紫、Metix浅灰选中 LIVE；X折叠按钮入口 LIVE、折叠结果UNKNOWN；I不为普通当前页自动禁用；L/E继承第2节 | 点击进入明确业务页；当前项与URL/范围一致 REQ | 侧栏和主区域滚动分开 REQ；关闭抽屉后恢复菜单焦点 REQ | 导航本身不创建任务、不发送消息 REQ |
| B02 页面范围选择 | D All Roles / All projects等 LIVE；S触发器显示当前值 LIVE；X菜单入口LIVE，未展开的值集UNKNOWN；I无权项不可选 REQ；L/E局部读取 | 选择后仅更新该页范围和关联数据 REQ | 菜单锚定触发器；长列表内滚；Esc回焦点 REQ | 查询条件，不写候选人业务状态 REQ |
| B03 文本搜索框 | D空白/placeholder LIVE；S输入与focus状态未输入测试UNKNOWN；X无独立扩展；I按真实查询权限 REQ；L/E继承 | 输入→过滤现有列表 REQ；debounce/Enter策略 UNKNOWN，不擅定毫秒 | 清除后恢复原集合 REQ；输入框不因列表更新丢焦点 | 查询条件；不自动开启新的付费搜索 REQ |
| B04 图标按钮 | D图标+可访问名 LIVE；S只有toggle类有选中；X按明确按钮用途；I原站显示disabled处LIVE；L/E局部 | Copy / Download / Close / Refresh / More语义分开 | Tooltip补充用途但不是唯一标签；焦点可见 REQ | Copy只写剪贴板；Refresh读；Download获取文件；业务动作按各自契约 |
| B05 tabs | D未选中、S选中LIVE；X无独立expanded；I实际禁用tab按源数据；L部分切换见loading LIVE；E UNKNOWN | 点击标签→对应内容可见，旧标签selected移除 REQ | tablist方向键与Tab进入内容 REQ；内容滚动不重置其他独立栏 | 同对象的显示状态，非业务阶段修改 |
| B06 checkbox / toggle | D0、S1、部分选中2 LIVE；X部分特殊角色显示成checkbox但单选行为需按具体组件；I按当前操作资格；L/E UNKNOWN | 点击toggle值；显示计数/工具栏或启用条件 | Space可操作；hit area不等同仅16px图形 REQ | 普通列表选择不保存候选人阶段；格式toggle改变编辑草稿 |
| B07 展开按钮 / accordion | D折叠摘要、X正文LIVE；S不适用；I按加载/权限；L/E UNKNOWN | 点击显示下级内容，图标方向/expanded语义同步 REQ | 再点收起；焦点留按钮；展开增加本scroll owner高度 | 只读展开不提交表单 |
| B08 toast / 保存状态 | D无toast；S N/A；X Juicebox Done后Sequence saved LIVE；I N/A；L自动保存态UNKNOWN；E失败文案UNKNOWN | 只在服务结果确认后显示成功 REQ | 不抢主编辑焦点 REQ；持续时间UNKNOWN | toast不是数据来源；保存/发送必须区分 |

## 4. Juicebox Sequence 总览与运行列表

证据：[总览（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[详情（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[筛选（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Response筛选（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[行Response菜单（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| J01 Overview日期范围 | D Last30days LIVE；S当前范围文字LIVE；X下拉入口LIVE，完整选项UNKNOWN；I UNKNOWN；L/E继承 | 选择日期→六KPI与日期范围一致 REQ | 锚定标题旁；关闭回焦点 REQ | 不把累计序列表改成仅近30天库存 REQ |
| J02 Overview六KPI | D标题+值+比较变化LIVE；S/X无已验证交互；I N/A；L/E UNKNOWN | Hover说明/点击钻取是否存在UNKNOWN | 数字不截断；卡片无交互时不强加tabstop REQ | 只读派生；0必须是真实0 |
| J03 Schedule周期/图例/时间轴 | D7dayperiod、sent/scheduled、Today虚线LIVE；S当前周期LIVE；X周期选项UNKNOWN；I UNKNOWN；L/E UNKNOWN | 周期选择改变显示范围 REQ；图例toggle/tooltip未实测 | 图内区域不得截掉横轴日期；若横滚保留图例 REQ | 不改变发送排期；可见日期不等于已排任务 |
| J04 序列搜索、Owner、Contact筛选、Show archived | D空搜索/AllOwners/filter/Showarchived LIVE；S筛选值结果UNKNOWN；X筛选入口LIVE；I UNKNOWN；L/E继承 | 查询只改变序列集合 REQ | 过滤器就地展开；列表保持工具条位置 | Show archived只改变是否包含归档；不是archive写动作 |
| J05 表头排序与列宽splitter | D列名/排序图标/resize入口LIVE；S方向需跟查询一致 REQ；X N/A；I不可排序文本表头不做按钮；L/E UNKNOWN | 排序点击更改同列方向 REQ；drag或键盘resize，reset入口在AX可见 | resize与sort两个命中区；手柄可键盘操作 REQ | 只改排序/列宽；是否持久化宽度UNKNOWN |
| J06 序列行链接与行尾三点 | D名称、owner/steps、累计值LIVE；S行focus不等同勾选；X三点入口LIVE、菜单未取；I UNKNOWN；L/E UNKNOWN | 点名称进入该sequence详情 LIVE | 返回保留列表上下文 REQ；长名完整可读 | 不把点名称变成恢复/启动sequence |
| J07 New sequence选择层 | D三个起点LIVE；S选项目/clone后续未执行；X项目/clone下拉入口LIVE；I UNKNOWN；L/E UNKNOWN | Newsequence→选择层 LIVE；项目生成/空白/克隆分别进入各自起点 REQ | Close实际回总览LIVE；overlay内滚/焦点约束第2节 | 未创建草稿、调AI、克隆或保存；后果UNKNOWN |
| J08 详情七个统计按钮 | D Contacts99及各状态数量/比例LIVE；S点击后过滤结果UNKNOWN；X N/A；I UNKNOWN；L初始“Loading stats…”LIVE；E UNKNOWN | 标题是button LIVE；具体查询过滤口径未点击 | 不用没有语义的div替代button REQ；KPI不因表格滚动串值 | 点击不能改run状态 REQ |
| J09 run选择checkbox | D全未选LIVE；S/mixed需与当前页集合一致 REQ；X N/A；I UNKNOWN；L/E UNKNOWN | 勾选行只改变选择集合 REQ | 选中不自动点Response或Re-enroll；焦点在checkbox | 全选具体跨页范围UNKNOWN，不能默认为全账户 |
| J10 Add filter维度菜单 | D折叠LIVE；S已加条件表现部分UNKNOWN；X6维度与Response子项LIVE；I UNKNOWN；L/E UNKNOWN | Sequence status / Response status / Added by / Opened&clicked / Engagement / Addedon；Response子项Interested/Notinterested | 子菜单锚定父项，左方向/Escape返回父级 REQ；长项不挤出屏幕 | 筛选无写入；其余五子菜单枚举UNKNOWN |
| J11 行Response下拉 | D Noresponse/Interested/Notinterested LIVE；S当前值LIVE；X三选项LIVE；I UNKNOWN；L/E写入需处理 | 点开显示三项LIVE；选值保存未执行 | 选后收起/回该行控件 REQ；失败保留原持久化值 | 这是run分类；不得伪造候选人来信；统计更新机制UNKNOWN |
| J12 Engagement和步骤状态 | DLow/Medium/High、计数、2of2/1of2、FinishedNoreply/Replied LIVE；S/X N/A；I N/A；L/E UNKNOWN | 只读；tooltip进一步说明UNKNOWN | 完整数值可访问；不得仅靠颜色表达 | Engagement不是候选人适合度；Replied可在未走完步骤时终止 |
| J13 Re-enroll / Export run | D两个图标按钮LIVE；S N/A；X确认层UNKNOWN；I资格UNKNOWN；L/E UNKNOWN | 不点击即re-enroll REQ；具体确认/导出内容UNKNOWN | 触发后焦点移入真实确认层 REQ | re-enroll会产生运行行为；此次未执行，不写成功承诺 |

## 5. Juicebox Sequence 编辑器

证据：[编辑器（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[时间popover（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Done结果（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| E01 编辑层/Composer splitter | D左Composer+步骤索引+正文LIVE；S当前步骤入口LIVE；X展开步骤LIVE；I N/A；L初始编辑内容loading LIVE；E UNKNOWN | Viewsequence进入编辑层 LIVE；splitter可resize入口LIVE，resize结果未执行 | Composer和正文有独立边界；关闭/Done不能被正文滚出 REQ | 面板宽度只属视图状态；持久化位置UNKNOWN |
| E02 Composer输入与发送 | D说明文案+MessageComposer空输入LIVE；S focus/输入未知；X Minimize入口LIVE，结果UNKNOWN；I空Senddisabled LIVE；L Loadingconversation LIVE；E UNKNOWN | 输入本身只改草稿 REQ；AI发送未执行 | 多行输入不应吞掉正文滚动；最小化后有恢复入口 REQ | AI请求和生成结果未验证，不能自动写回已发送邮件 |
| E03 序列名、visibility、Last saved、Done | D已有名/创建者/保存时间LIVE；S编辑值未执行；XShared入口disabled LIVE；Ivisibility禁用LIVE；L保存中UNKNOWN；E UNKNOWN | Done→详情+Sequencesaved LIVE，即使未改字段 | 回详情保留sequence identity；编辑未保存保护依实际能力 REQ | Done保存模板不启动发送；自动保存频率UNKNOWN |
| E04 步骤索引/折叠/添加/删除 | D序号渠道sender时间LIVE；S当前步语义需一致 REQ；X两步expanded LIVE；I删除资格UNKNOWN；L/E UNKNOWN | 索引定位/折叠只是浏览 REQ；Addstep/Deletestep入口LIVE未执行 | 删除按钮不能冒泡触发折叠；索引滚动与正文定位关系UNKNOWN | Add/Delete改模板；已存在run是否受影响UNKNOWN |
| E05 渠道Email与From下拉 | D Email / sender入口LIVE；S已有senderLIVE；X完整渠道/sender候选UNKNOWN；I无可用邮箱需说明 REQ；L/E UNKNOWN | 只改当前步骤sender/渠道 REQ | 菜单锚定行；若sender列表长则内部滚动 | 不能选择别人的邮箱越权发送；邮箱授权逻辑不由前端推断 |
| E06 Subject与Cc/Bcc | D首封subject、第二封ReplytoStep1 LIVE；S输入/selection未改；XShowCcBcc入口LIVE、展开字段未取；I UNKNOWN；L/E UNKNOWN | Subject改当前步草稿；CcBcc在该步内扩展 REQ | 文本焦点与光标位置保留；展开不重置正文 | 不将后续reply强行改成新主题；保存机制UNKNOWN |
| E07 变量chips/Show all/AI command | D六变量、AIcommand、Showall入口LIVE；S插入后chip状态UNKNOWN；X完整变量/AI命令层UNKNOWN；I UNKNOWN；L/E UNKNOWN | 点击变量应在当前编辑selection插入token REQ；不得插到别的步骤 | 变量菜单不夺走当前插入点；关闭回编辑位置 REQ | token与实值分开；缺变量处理UNKNOWN |
| E08 富文本格式按钮 | D工具栏LIVE；S Bold/Italic/Underline/List/Link/Image等checkbox在空selection为0LIVE；XLink/Image/Font/Size/Colors入口LIVE、选项未展开；IUndo/Redo禁用LIVE；L/E UNKNOWN | Bold/Italic/Underline/Numbered/Bulleted修改选中内容或后续输入样式 REQ；undo/redo按编辑历史 | toolbar点击保留编辑selection；Tab能回正文；菜单过长内滚 | 只改当前步骤草稿；不是发信动作；每种格式最终渲染未测 |
| E09 Message body | D原邮件+token+AI指令段落LIVE；S编辑光标/文字未输入；X长正文可见；I按实际权限；L/E UNKNOWN | 可编辑区只接收本步内容 REQ；正文已保存与草稿分开 | 正文长页滚动；不因切步清空；富文本剪贴板安全处理为实现约束 | 原始发送历史不随模板编辑被改写 REQ |
| E10 签名/Snippet/附件/退订 | D签名Noah、Snippet、Addattachment、unsubscribe0 LIVE；S勾选未执行；X签名/Snippet选择UNKNOWN；I UNKNOWN；L上传UNKNOWN；E上传失败UNKNOWN | 支持格式文案PDF/DOC/XLS/PPT/TXT/CSV/images LIVE；附件未上传 | 附件列表/移除/失败重试未观察；不能预填文件 REQ | 签名/退订只改模板；格式文案不证明服务端校验完成 |
| E11 时间条件摘要与popover | DStartimmediately / Wait2businessdays+9AM LIVE；S已有值LIVE；XDelay、unit、Sendat、Timezone四控件LIVE；I UNKNOWN；L/E UNKNOWN | 点延迟摘要展开popover LIVE；改数值未执行 | 锚定步骤之间条件条；关闭不折叠/删除步骤；焦点回摘要 REQ | Businessdays不等同48小时；DST按事件日期/时区计算 REQ；假日定义UNKNOWN |
| E12 步骤Preview | D按钮LIVE；S Preview contact样例示例候选人 LIVE；X Email preview层、From/To/Subject/iframe正文LIVE；I测试发送空地址禁用LIVE；L Generating AI content… LIVE；E UNKNOWN | 第二轮实际打开；姓名/公司token解析到样例人LIVE；AI指令仍呈生成中，不认定生成完成 | Close preview入口LIVE；预览层内正文滚动，关闭回原步骤/光标 REQ | 预览与测试发送分开；新证据[preview](states/juicebox-editor-preview-1440.txt)，不等于enrollment预览或真实发信 |
| E13 Preview contact / Test email | DFrom sender、To联系人、testaddress输入及SendTest LIVE；S当前示例候选人 LIVE；X AX列出联系人候选，真实下拉展开状态须结合截图；I空SendTestdisabled LIVE；L AI生成中LIVE；E UNKNOWN | 切contact改变渲染上下文 REQ；Send yourself a test email提示主题含[TEST EMAIL] LIVE | 列表长需内部滚；测试地址输入与预览正文分开；Close preview不触发发送 | 测试发送是明确外发动作，本次未填地址或发送；不把preview打开自动视为发送 |

## 6. Juicebox enrollment 与评审弹窗

证据：[enrollment（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[偏好菜单（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[credits展开（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[review（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| F01 enrollment整体dialog | D标题人数、项目提示、sequence、emailpreference、开始时间、说明和底部动作LIVE；S选择1人LIVE；Xdialog打开LIVE；I最终资格UNKNOWN；Lcredits估算初始loading LIVE；E UNKNOWN | Contacts勾人→Actions/AddtoSequence→dialog LIVE | Cancel返回同一列表与选择LIVE；dialog超高时正文内滚、底部不遮字段 REQ | 打开配置不等于enrolled；最终PreviewSteps后续未执行 |
| F02 sequence下拉 | D已有默认Photon模板LIVE；S显示完整/省略名称LIVE；X候选列表未展开UNKNOWN；I无可用序列REQ需明确；L/E UNKNOWN | 切模板应刷新开始时间/步骤与费用估计 REQ | menu锚定选择器；关闭保留前一选择 | 模板名不决定当前项目；黄色提示明确当前项目关系 |
| F03 四种邮箱偏好 | DPreferpersonal fallbackwork LIVE；S当前值选中LIVE；X四值完整LIVE；I UNKNOWN；L/E UNKNOWN | 下拉四项：personal→work、work→personal、onlywork、onlypersonal | 选值后触发器显示同一语义；Esc回焦点 REQ | only模式不得增加未要求的fallback；实际费用/可发送对象未提交 |
| F04 开始时间与Preview Steps | DStartimmediately(Sequencedefault) LIVE；S默认值LIVE；X开始时间popover未取；I UNKNOWN；L/E UNKNOWN | PreviewSteps进入预览的入口LIVE，未点击 | Cancel无提交；后续返回是否保留配置UNKNOWN | 预览本身不得被实现成立即enroll/发送 REQ |
| F05 credits与More Details | D估算文本LIVE；S N/A；XMoreDetails实际展开LIVE；I N/A；L初始Loading LIVE；E UNKNOWN | MoreDetails→三类不重复收费说明 LIVE；后续估算显示无消耗LIVE | Collapse原位收起；高度改变只影响dialog内容scroll | 未知不按0；显示不收费不证明后台扣费测试完成 |
| F06 Review人数与reviewer | D99待评、Select空LIVE；Sreviewer未选；Xreviewer入口LIVE、候选集UNKNOWN；I未选时Requestreviewdisabled LIVE；L/E UNKNOWN | 页面Requestreview打开LIVE；选定集合必须一致 REQ | focus先到Select LIVE；Cancel/Close返回原列表LIVE | 没有勾选的默认99是该样本；不能推成所有筛选状态都全项目 |
| F07 Review note与提交 | Doptional多行输入LIVE；S未输入；X N/A；I未选reviewer提交disabled LIVE；L/E UNKNOWN | note可选，reviewer必选；点击提交应只处理明确集合 REQ | 失败保留note与reviewer REQ；发送未执行 | 邀请通知、对方评审页、审批后加入sequence只属未知/历史STATIC |

## 7. Juicebox Contacts、Shortlist 表格与看板

证据：[Contacts（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Contact Filter（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Status（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Actions（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Shortlist（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Sort（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[列（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[批量（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Board（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| C01 Contacts页内选择 | D全不选LIVE；S选1人LIVE、表头mixed LIVE；X N/A；I按操作资格；L/E UNKNOWN | 行checkbox→选中集合→Actions可用项变化LIVE | checkbox不打开详情；全选label明确onpage LIVE | 不能扩大为全999人；跨页保留选择UNKNOWN |
| C02 Contacts Filter维度 | DFilter折叠LIVE；S选维度后出现chip LIVE；X21维度LIVE；I UNKNOWN；L/E UNKNOWN | 维度列表遵循PRD原顺序；不是所有维度共用一个猜测值集 | 菜单长时内部滚；选维度后焦点到其值输入 REQ | 组合AND/OR、其他autocomplete/日期运算符UNKNOWN |
| C03 Status filter chip | DFilterbyStatus LIVE；S当前值全未选LIVE；X搜索+9阶段+EditStatusList LIVE；I UNKNOWN；L/E UNKNOWN | RemoveStatusfilter清除该维度入口LIVE；选择具体值未测 | 移除chip后focus回Filter或邻近chip REQ | 阶段筛选与修改候选阶段是两件事 |
| C04 Contacts Actions | D未选时Import可用、其余disabled LIVE；S选1人后六项可用LIVE；X菜单展开LIVE；I真实disabled LIVE；L/E UNKNOWN | Import/Export/AddTag/ShortlistinProject/AddtoSequence/LogActivity | menu锚定右侧Actions；Escape关闭 | 仅AddtoSequence配置已展开；其他表单/提交未知 |
| C05 Profiles图标、项目chip、Tags | D按可用渠道显示LIVE；S tag存在LIVE；Xmoreprofiles入口LIVE、更多内容未知；I无资料不生成可用操作 REQ；L/E UNKNOWN | 每种图标执行其明确目的；EmailOutreach不等同复制email | 小图标与行点击分离；完整URL/对象可访问 REQ | reveal/打电话/发信可能有副作用；未触发，不以外观推定免费 |
| C06 Shortlist搜索/排序/Filter | D空搜索、DateNewest LIVE；S已选排序LIVE；X排序/Filter项LIVE；I UNKNOWN；L/E UNKNOWN | 只改同项目列表；排序具体项见原AX，不用近似名称替代 | popup锚定工具栏；筛选不使上下文丢失 | 不直接发起新搜索；查询结果未逐项执行 |
| C07 Table / Board与Display columns | DTable LIVE；SBoard/table切换LIVE；X两按钮+checkbox列清单LIVE；I UNKNOWN；LBoard初次全0后满态LIVE；E UNKNOWN | ViewTable/Board子菜单改变呈现；列开关只影响显示 REQ | menu两级退出；切回Table保留集合 REQ | AddedtoATS勾选但主表未显，显示条件UNKNOWN；不强制空列 |
| C08 Shortlist行姓名/Status/Favorite/Remove | D姓名/最近联系/阶段/结果chipLIVE；S已阶段LIVE；XStatus入口LIVE，完整编辑结果未测；I UNKNOWN；L/E UNKNOWN | 姓名打开详情LIVE；favorite/remove入口LIVE未执行 | 这些内嵌动作不互相触发 REQ；省略名可读全名 | Status改项目关系；Unshortlist不删除全局联系人 REQ |
| C09 批量底栏 | D未选隐藏LIVE；S1selected出现LIVE；XMoreactions完整11项LIVE；I按动作资格；L/E UNKNOWN | AddtoSequence、RequestReview、Findsimilar、Export、More、Clear | 固定底栏需为列表底部留空间 REQ；两个More必须按上下文区分 | selected人数与所有动作目标一致；不因点空白扩大集合 |
| C10 分页 | D1–40of99、3页LIVE；S页1LIVE；X N/A；I首屏Previousdisabled LIVE；L/E UNKNOWN | 点击页码/Next只查目标页 REQ；未翻页验证结果 | 翻页后焦点留分页或表格标题 REQ；滚动策略明确 | 每页40是样本；计数来自服务器集合，非当前DOM行数 |
| C11 Board列头与选择/settings | D九阶段+数量LIVE；S列选择入口LIVE，结果未测；Xsettings未展开；I UNKNOWN；L0→92/5/2完成态LIVE；E UNKNOWN | 列选择与settings不能触发卡片；数量总和99 LIVE | 看板横滚；列头要保留可辨性；列内纵滚 REQ | 拖放/列选择全量范围/懒加载边界UNKNOWN |
| C12 Board候选卡 | D姓名职位公司owner更新时间和sequencechipLIVE；Scheckbox入口LIVE；X点卡打开详情REQ，已在表格路径验证；I UNKNOWN；L/E UNKNOWN | 主卡片与内部checkbox/favorite/remove四种动作 | 不能用整卡遮住内嵌按钮；键盘能进入独立动作 REQ | 卡片不是新contact副本；NoReply/Replied不是阶段列 |

## 8. Juicebox 候选人详情与五个业务标签

证据：[资料（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Notes（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Sequences（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Activity（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Projects（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Tasks（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| P01 大资料面板与导航 | D左资料/右业务双栏LIVE；S当前人LIVE；Xexpanded=true与collapsed/Expand Profile切换结果第二轮LIVE；I Previous/Next边界UNKNOWN；L局部内容loading LIVE；E UNKNOWN | 姓名→面板、URLcontact/expanded/tab LIVE | Previous/Next、Collapse、More、Close入口；Close返回原列表LIVE；两栏scroll owner分开 REQ | 浏览自动留下Viewed活动LIVE，不能称绝对零写入；浏览不授权改状态 |
| P02 Shortlisted/Sequence快捷CTA/Hide | DShortlisted、Addto指定sequence、Hide LIVE；S当前项目关联LIVE；X不同项目/sequence下拉入口LIVE，内容未取；I UNKNOWN；L/E UNKNOWN | 目标project/sequence须显式可读 REQ | 下拉与主CTA分命中区；长名称不遮drop箭头 | 不能将Addto推荐模板解释为已在模板中；Hide不是删人 |
| P03 资料锚点tabs与履历展开 | DOverview/Experience/Education/Skills LIVE；SOverviewLIVE；XReadmore/+skills入口LIVE、展开结果未取；I UNKNOWN；L薪酬估计中LIVE；E UNKNOWN | tab在左资料范围内定位/展示对应专业材料 REQ | tab不切右Notes；履历长文在资料栏滚；完整日期/单位可读 | AIskill/compensation来源保留；估计中不显示0 |
| P04 五业务tabs | DNotes默认LIVE；S五个逐一切换LIVE；X内容面板LIVE；I UNKNOWN；LSequencesloading LIVE；E UNKNOWN | tab改变右栏内容与URLhashLIVE | 不因切右tab重置左资料/当前人；返回保留tab REQ | 仅显示切换，不修改候选阶段 |
| P05 Notes输入/附件/Add note | Dplaceholder、Attachfiles、dragdrop LIVE；S未输入；X附件选择未执行；I空Addnotedisabled LIVE；L/E UNKNOWN | 输入产生草稿；提交需作者/时间/项目明确 REQ | 失败保留草稿；切人/关闭有未保存保护 REQ | 未保存或上传；mention/edit/delete/字符限制UNKNOWN |
| P06 已有评估note卡 | D作者Agent、时间、条件/理由、项目LIVE；S N/A；X长正文可见；I N/A；L/E UNKNOWN | 不把Goodmatch/Notamatch/Potentialmatch与Metix档位混用 | 长正文可滚，不能只留下摘要 | 原评估展示，不表示本次重评或事实核实 |
| P07 Sequences历史 | D序列名、run摘要、sender/added信息、邮件卡LIVE；S当前runLIVE；XExpandemail入口LIVE未展开；I UNKNOWN；L真实loading→loaded LIVE；E UNKNOWN | 序列名/MarkasReplied/Replyto分别有入口 | 邮件历史在右栏内滚；返回当前contact | MarkasReplied不能伪造来信；历史正文不能用当前模板覆盖 |
| P08 Activity时间线 | DAllactivity7、重复打开、加入、unlock、Viewed LIVE；S N/A；XAddactivity表单UNKNOWN；I UNKNOWN；L/E UNKNOWN | 事件显示actor、时间、项目、step LIVE | 右栏内部滚，排序/分页边界UNKNOWN | 多次open是多个事件不等于多个profile；看资料有自动Viewed写入 |
| P09 Projects关系卡 | D项目名/Current/更新时间/Owner/阶段/Unshortlist/Viewshortlist LIVE；S当前项目标识LIVE；X下拉入口LIVE未操作；I UNKNOWN；L/E UNKNOWN | ViewShortlist应到该关系的项目 REQ | 标签在右栏；关闭保留原来源 | Unshortlist仅移除该项目关联；不是简历中的个人项目 |
| P10 Tasks分区 | DCreateReminder、Overdue0、Upcoming0、Viewall LIVE；S N/A；X提醒表单UNKNOWN；I UNKNOWN；L/E UNKNOWN | 0只属于当前contact；Viewall进入全局任务入口 REQ | 两分区空态分别显示；任务列表长时栏内滚 | 未创建提醒，不新增通知策略；due分类按真实时间 |

## 9. Juicebox Analytics 与 Talent Insights 控件

证据：[Outreach（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Metric（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Group（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Breakdown（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[TalentInsights（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Usage（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Projects（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Agents（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| A01 Analytics子页导航/切换 | DUsage/Projects/Outreach/Agents LIVE；S当前项LIVE；XAnalytics展开LIVE；I三页受套餐限制LIVE；L/E UNKNOWN | 点Outreach实际数据可读LIVE；其他三页升级墙LIVE | 导航与内容独立；不能把受限页当读失败 | Upgrade入口未点，不自动升级/付款 |
| A02 Outreach四筛选+日期+时间分组 | DAllsequences/projects/inboxes、StartedBy、Last1year、Months LIVE；S当前值LIVE；X完整值集未逐项展开UNKNOWN；I初始部分control禁用LIVE；L/E UNKNOWN | 过滤当前分析范围 REQ | 顶部工具区不随每次数字更新丢焦点；popover边界第2节 | 人数/run数/时段明确；不能静默平均不同集合 |
| A03 六指标卡 | D值、分子/分母、比较变化LIVE；S/X N/A；I N/A；L初次指标未显LIVE；E UNKNOWN | 数据完成显示239/238等LIVE；无点击验证 | 卡片自适应换行策略见几何测量；百分号/比较不挤压数值 REQ | 比率聚合用合计分子/分母；不是平均子行百分比 |
| A04 两张图的图例 | DAgents未选/Admin选中LIVE；Scheckbox1/0 LIVE；X图例tooltip未测；I UNKNOWN；L/E UNKNOWN | 图例toggle对图series的具体变化未执行 | 图例可读名字，键盘toggle；图高不挤掉横轴 REQ | 隐藏series不删除数据；是否同时影响KPIUNKNOWN |
| A05 Chart download / plot tooltip | D每图DownloadCSV入口LIVE；S N/A；Xtooltip内容UNKNOWN；I UNKNOWN；L下载UNKNOWN；E UNKNOWN | 单图导出只对应当前图和筛选 REQ；文件未下载核验 | 下载后不跳离分析页 REQ；图交互须保留可访问数据摘要 | 不输出屏幕外无权限人数据；内容格式UNKNOWN |
| A06 聚合表Metric/Group/Breakdown | DProfilesenrolled/Sequence/None LIVE；S当前值LIVE；XMetric2项、Group3项、Breakdown3项LIVE；I初始disabled后可用LIVE；L/E UNKNOWN | Metric Emails sent或Profilesenrolled；Group User/Project/Sequence；Breakdown None/User/Project | 选择器彼此独立；改变一个不清空Search REQ；表可横滚 | 新组合实际结果未点选；不能猜测依赖规则 |
| A07 聚合表搜索/排序/resize/Total | D列、Total、独立CSV LIVE；S默认sort图标LIVE；X N/A；I非排序列无按钮 REQ；L/E UNKNOWN | 表头/列宽按B/J05；search只影响本表或整体范围须按实际契约明确 | 横向scroll保留总计对齐；最后行不被sticky栏挡住 | Total同当前过滤口径；导出不能直接取DOM可见行 |
| A08 TalentInsights返回/导出/样本标题 | D99/Back/Export LIVE；S N/A；X N/A；I UNKNOWN；L此前Loading/Shortlist0瞬态LIVE；E UNKNOWN | Viewinsights→99真实完成态LIVE；Back到同shortlist | 是长分析页不是固定高度截屏；标题与返回入口保持可找 | 初始0不当样本为空；导出格式未验证 |
| A09 地点列表/地图zoom | D城市计数和map署名LIVE；S地图选择UNKNOWN；Xzoom按钮入口LIVE未操作；I UNKNOWN；L/E UNKNOWN | 城市列表与map同样本 REQ；zoom不改变Shortlist | 地点列表独立纵滚；地图自身交互不吞掉全页滚动 REQ | 地点聚合不是个人精确位置推断 |
| A10 KeyTakeaways复制 | DAI说明/文字高亮/Copy入口LIVE；S N/A；X N/A；I UNKNOWN；L生成过程UNKNOWN；E UNKNOWN | Copy只复制当前摘要 REQ，未点击 | 不因复制跳走或重生成；toast反馈原站UNKNOWN | AI摘要为观点不是原始候选人事实 |
| A11 分位提示/分布Expand | D平均/P25/Median/P75、各图Expand入口LIVE；S N/A；X提示按钮和Expand内容未取UNKNOWN；I N/A；L/E UNKNOWN | tooltip说明已出现在AXLIVE；真实弹层布局未知 | 大图展开后可关闭并回到原图 REQ，未执行原站 | 每模块按真实分母；不把语言/学校推导成敏感身份 |

## 10. Metix 候选卡、评级与资料抽屉

证据：[阶段/卡片（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Score菜单（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[WorthTalking结果（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Match分页（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Profile（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[展开criteria（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| M01 阶段tabs | D Interview/Interested/Contact/Match LIVE；SInterested6、Match307切换LIVE；X N/A；I部分阶段按钮禁用LIVE；L候选列表loading LIVE；E UNKNOWN | 切tab只选择既有阶段列表；计数与内容范围对应 | 列表内滚；切换scope/阶段不把旧人详情留在新表 REQ | tab不是把人移动到该阶段；Contact303与Outreach261不是同一口径 |
| M02 Score筛选 | DAllscores6 LIVE；S选WorthTalking后文字及3人结果LIVE；XAll/Strong3/Worth3/NotMatch0菜单LIVE；I零值项原站可选性未测；L/E UNKNOWN | 选WorthTalking→三人，阶段仍Interested LIVE | menu锚定Score；关闭回按钮；结果重排不丢scope | 不重新评分、不把WorthTalking当Interested |
| M03 候选摘要卡 | Davatar/name/rating/role/location/2jobs/education/status LIVE；S选中外框/checkbox1 LIVE；XInbox卡选择邮件、role卡选择资料需按所在页；I UNKNOWN；L/E UNKNOWN | 点Inbox卡→线程；点role候选卡→Profile相关内容 | 列表独立滚；内部链接/按钮避免多动作 REQ | 阅读可能改变未读LIVE；不修改评级或发送消息 |
| M04 评级标签 | DStrongMatch紫色/WorthTalking绿色LIVE；S不是用户toggle；X本tag是否tooltip可点UNKNOWN；I N/A；L无评级不默认填充 REQ；E UNKNOWN | 读标签与Profilecriteria核对；筛选由M02承担 | 文本与图标共同表达；不让颜色成为唯一信息 | 私有阈值UNKNOWN；示例候选人有Notmet仍WorthTalking是观察，不发明算法 |
| M05 材料和未读状态chips | DNewreply/Replied/Resumeprovided/Availabilityprovided LIVE；S未读紫点LIVE；Xchip是否可点UNKNOWN；I N/A；L/E UNKNOWN | 阅读线程的未读视觉变化现场可见；具体mark时机未测 | chip不与整个卡片抢不明交互；材料按钮在详情明确 | 获取availability与发出邀请是不同状态 |
| M06 资料抽屉 | DProfile标题/身份/links/actions/criteria/contactdetails/sections LIVE；S当前人LIVE；X右侧drawer LIVE；I某Downloaddisabled LIVE；LFindingemail LIVE；E UNKNOWN | Profile按钮→抽屉；Close→原线程LIVE | 自身纵滚/遮罩；Close可找；REQ trapfocus+restore | 自动Finding不是授权revealphone；未点击号码解锁 |
| M07 criteria三条/Show all | D前三条LIVE；S条件结果Met/Notmet与Preferred LIVE；X7/9criteria展开实测LIVE；I N/A；L/E UNKNOWN | 展开全部后出现Notmet等具体解释LIVE | 就地扩展抽屉内容，不独立导航；按钮expanded同步 | 仅展示原站评价，不当作已证实能力 |
| M08 Contact details折叠和专业分节 | DEmail/Phone、Experience等LIVE；S实际section入口LIVE；XContactdetails展开LIVE；I查找中buttondisabled LIVE；LFindingLIVE；E UNKNOWN | 联系方式和专业材料分开；PhoneShowphone未点 | section定位只在资料scroll owner；不能改底层Inboxscroll REQ | Profile长数据中的隐藏副本不渲染成双份信息 |
| M09 Resume / Download / Schedule | D按该人材料出现LIVE；S N/A；XSchedule两步展开LIVE，Resume内容未取；I无简历Downloaddisabled LIVE；L/E UNKNOWN | Resume读文件；Schedule另一个业务drawer；不得混同 | 回到原Profile或Inbox来源；保留人identity | 下载/安排分别有不同结果；未下载私人简历或发送邀请 |
| M10 候选人分页 | D1–50of307、Page1of7 LIVE；S页1LIVE；X N/A；IPreviousdisabled LIVE；L/E UNKNOWN | Next仅翻候选页 REQ；未遍历全7页 | 页码和总数可访问；不能用DOM50断言仅有50人 | 没有进行全站候选人批量提取 |

## 11. Metix Inbox、线程与回复编辑器

证据：[Inbox（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[材料线程（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Reply（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[示例候选人选中（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| N01 All / Unread与role筛选 | DAllselected LIVE；S两个checkbox当前值LIVE；Xrole入口LIVE；I UNKNOWN；L/E UNKNOWN | 切Unread只看未读集合 REQ；没有重新发送或产生回复 | 工具区与列表区分，focus不因刷新丢失 | badge和当前筛选计数不可混淆；具体已读时机UNKNOWN |
| N02 线程对象头 | D姓名/email/role/location+Profile/Reply/Schedule条件出现LIVE；S跟随所选卡LIVE；X通过动作打开对应层；I UNKNOWN；L/E UNKNOWN | 选择示例候选人显示Schedule，示例候选人未见Schedule LIVE | 线程滚动时对象头应可辨 REQ；小宽度保留姓名/返回 | 不允许旧人邮件正文配新人头部；拷贝只拷当前地址 |
| N03 自动邮件组摘要 | D3outreach/4followups灰条LIVE；S N/A；X带expanded入口LIVE，实际展开内容未取；I UNKNOWN；L/E UNKNOWN | 摘要点击应展开本组真实邮件 REQ；不拿汇总文案当正文 | 就地展开、再收起；增加线程scrollHeight | 不生成新邮件；不能把组数与候选人数混用 |
| N04 单封邮件卡 | Dsender/time/subject/body/NEW/quoted/Reply LIVE；S当前展开LIVE；X另一旧回复collapsed摘要LIVE；I UNKNOWN；L/E UNKNOWN | 折叠头部只展开/收起该封；Reply打开N06 | 日期/主题长文不遮collapse；组内邮件顺序稳定 | 原始message identity和正文保持，不以最新草稿覆盖 |
| N05 quoted text与历史终点 | Dquoted折叠三点、Nomoremessages LIVE；S N/A；XShowquoted入口LIVE、完整内容未展开；I N/A；L/E UNKNOWN | quoted展开增加本封正文高度；终点无动作 | 线程内滚；不重复嵌套已展示正文造成无限长 | Nomoremessages仅当前历史已尽，不是服务端故障 |
| N06 Reply输入与引介说明 | D空richtext、Mira引介说明、sender身份LIVE；S focus到编辑区LIVE；Xinlinecomposer LIVE；I空Sendintroduction&replydisabled LIVE；L/E UNKNOWN | Reply→当前线程内编辑器LIVE；Cancel收起LIVE；未输入发送 | toolbar/textarea/counter/actions属于同一编辑器；取消回Reply焦点 REQ | 未提交；引介和真实回复是一次用户明确发送操作，不可预先执行 |
| N07 Reply格式栏 | DUndo/Redo、List、Bold/Italic/Strike/Underline/Link、四种align LIVE；Scheckbox0 LIVE；XList/Link入口LIVE未展开；IUndoRedo disabled LIVE；L/E UNKNOWN | 格式只影响当前草稿selection REQ；各格式最终结果未测试 | 点击toolbar保存selection；linkdialog关闭回光标 REQ | 不把正文简单HTML未处理写进线程显示 |
| N08 字数、Cancel、提交快捷键 | D0/10000与Cancel LIVE；S有输入后值未测；X N/A；I空Senddisabled LIVE；L提交中UNKNOWN；E UNKNOWN | ⌘Enter提示LIVE；提交需与按钮相同校验 REQ | 到上限规则/文案UNKNOWN；不可截掉用户文本 REQ | 失败保留草稿；不确定结果先读回，不盲目重发 |

## 12. Metix Outreach 流程与列表空态

证据：[Outreach（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[JobPosting（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Sequence空态（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[邮箱前置（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Shortlist空态（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| O01 角色进度按钮 | DDescribe/Find/Outreach/Interview LIVE；S当前workspace入口disabled/选中表达LIVE；Xworkspace切换LIVE；IFind阶段按钮样例disabled LIVE；L切换loading LIVE；E UNKNOWN | Outreach按钮→workspace=outreach LIVE | 页面返回不丢role；非可编辑当前阶段不冒充提交步骤 | 点阶段入口不是启动自动任务 |
| O02 Completed横幅与统计按钮 | DOutreachcomplete+四统计+Review6 LIVE；S当前完成态LIVE；X按钮目标部分未点；I UNKNOWN；L/E UNKNOWN | 明确晚到reply仍进Inbox；Reviewinterested去对应集合 REQ | 统计横幅不遮下方流程；点击目标保留role | Contacted261/Replies19/Interested6/Failed17是该workspace结果，不强行凑Contact303 |
| O03 Email / Job Posting tabs | DEmailselected LIVE；SJobPosting切换LIVE；X不同panel LIVE；I UNKNOWN；L/E UNKNOWN | tab切换只显示workflow或职位内容 | 各panel内容长时主scroll；回Email保留步骤位置 REQ | 不发布职位、不重新发邮件 |
| O04 workflow步骤卡/等待/条件 | DIntro+2followups+waiting+condition+collectdetails LIVE；Scompleted与condition可辨LIVE；X邮件collapse入口LIVE，正文可读LIVE；I已结束不是允许编辑提示；L/E UNKNOWN | 步骤标题与内容可展开/折叠；等待和Ifinterested不是邮件输入 | 顺序不可改变以迁就布局；展开增加流程高度 | Anyreply停止remainingfollowups是页面明文；本次未用新回复实测 |
| O05 Sequence Active / Archived空列表 | DActive1/Archived0、Nosequencesyet LIVE；SActiveLIVE；XNewsequence→邮箱前置LIVE；I UNKNOWN；LLoadingsequences LIVE；E UNKNOWN | 空态仍有Newsequence，过滤归档不能当创建sequence | 选择与空态文案同scope；弹层关闭回页面 | 首轮列表空态；第二轮已进入原生新建与编辑器，见Q01–Q12。非空列表卡片/排序仍UNKNOWN |
| O06 Connect mailbox前置 | DConnectGmail/Microsoft/IMAP、MaybeLater、Close LIVE；S未选服务；Xdialog LIVE；I Gmail/Microsoftcomingsoon disabled LIVE；L/E UNKNOWN | MaybeLater→关闭LIVE；IMAP连接表单未打开 | 首轮前置层关闭后Sequence仍空LIVE；第二轮原生context可用Mira邮箱，见Q01；焦点回触发入口 REQ | 不连接服务、不授权邮箱；Mira邮箱文案不是新授权 |
| O07 Shortlist空态 | D标题、Noshortlisted、说明、StartSearch LIVE；S N/A；X N/A；I N/A；L初始空heading过渡LIVE；E UNKNOWN | StartSearch入口存在，未开新任务 | 空态在主内容有独立布局；无数据不绘制假的卡片 | 非空shortlist所有组件UNKNOWN，不能从role候选列表等同推导 |

### 12.1 Metix 原生 Sequence 新建、邮件编辑与收件人

第二轮已实际创建服务器草稿 **UI inspection draft — Backend Python Engineer sequence**，其URL已具有sequence ID，Recipients总数0；**未Publish、未发送邮件**。因此这里的“进入编辑器”包含创建草稿这一持久化结果，不能写成完全只读。三个步骤的模板正文是原站当前显示内容，不证明对应岗位事实或收件人变量已校验。

证据：[Context](states/metix-sequence-context-1440.txt)、[公司描述展开](states/metix-sequence-context-expanded-1440.txt)、[Sender菜单](states/metix-sequence-sender-menu-1440.txt)、[Editor](states/metix-sequence-editor-1440.txt)、[Variables](states/metix-sequence-variables-1440.txt)、[Timezone](states/metix-sequence-timezone-1440.txt)、[Recipients](states/metix-sequence-recipients-1440.txt)、[390首屏（匿名布局图）](diagrams/metix-sequence-editor-390.svg)、[390滚动后（匿名布局图）](diagrams/metix-sequence-editor-scrolled-390.svg)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| Q01 Tailor your sequence上下文 | DRole/Company两个区、Job title/description、可选posting URL/website、Company name与Continue to emails LIVE；S公司WeKruit及website填入LIVE；XShow/Hide company description原位展开textarea LIVE；I必填禁用/校验UNKNOWN；L/E UNKNOWN | Continue后进入有ID的原生editor LIVE；Change company入口存在，目标UNKNOWN | 1440上下文布局、390窄屏以各状态截图为准；展开公司描述增加内容高度；Cancel回sequence列表 | 进入editor已创建服务器草稿；自动保存频率、Previous后重新生成/覆盖规则UNKNOWN |
| Q02 Context Sender email菜单 | DMira’s mailbox LIVE；S其checkbox1/Assigned to your AI Agent LIVE；XSender for all steps、Connected mailboxes空态与Connect a mailbox LIVE；I无其他已连接邮箱可选LIVE；L/E UNKNOWN | 点sender展开菜单LIVE；新连接/选择后继未操作 | 菜单锚定sender；Esc/外点关闭和焦点回触发按钮为REQ；不把隐藏menu节点视为可见副本 | 无新邮箱授权；Mira可用与用户邮箱连接是不同状态；Manage mailboxes后续UNKNOWN |
| Q03 Editor/Recipients tabs与标题 | DEditor选中、Recipients0与Back to sequences LIVE；S切Recipients后选中LIVE；X各tab独立内容LIVE；I UNKNOWN；L/E UNKNOWN | Editor显示三步流程和settings；Recipients显示状态筛选/双空态；切tab不Publish | 1440页头在侧栏右；390无常驻侧栏、标题截断，tab下有选中下划线LIVE；完整标题需可读REQ | 同一sequence identity，切tab不复制草稿/创建收件人 |
| Q04 流程步卡与Wait整数输入 | DStart immediately after enrollment、Step1 Introduction/Step2 Follow-up1/Step3 Follow-up2、两段Wait2days LIVE；S当前值2LIVE；X起始pill可否展开UNKNOWN；I上下限/禁用UNKNOWN；L/E UNKNOWN | 每段Wait有整数stepper及One more/less day按钮LIVE；实际加减未执行 | 主流程纵滚，每步发件人/Subject/Message/toolbar同卡；390不并排挤压正文LIVE | 等待间隔针对对应follow-up；数值保存、跨日/工作日换算UNKNOWN；模板不是已启动排程 |
| Q05 Subject字段与token | D三步Subject为We are hiring: {job_title} at {company_name}，token灰底LIVE；S光标/文本选中UNKNOWN；X独立Insert variable→Q07 LIVE；I UNKNOWN；L/E UNKNOWN | Subject是可编辑字段；变量为独立视觉token；未实际改字/插入 | 窄屏subject换行，长token可跨行LIVE；菜单不能使字段失去插入目标REQ | 编辑/自动保存结果UNKNOWN；变量应保存结构键而非候选人的渲染值REQ |
| Q06 Message富文本与toolbar | D每步正文/变量chip、Undo/Redo/List options/Bold/Italic/Strike/Underline/Link/四对齐/Insert variable LIVE；S格式checkbox当前0 LIVE，真正格式切换未测；XList options/Link子层UNKNOWN；I初始Undo/Redo disabled LIVE；L/E UNKNOWN | toolbar对应本步正文；不把Subject的变量入口混为正文入口；选中文本后格式作用域需明确REQ | 正文内部纵滚，toolbar在编辑区底部；主流程也滚，二者不同owner；390toolbar是否横滚以截图/rect为准，不由AX推断 | 未编辑正文、未验证undo历史；四个对齐控件AX全0不证明段落同时四种对齐；选区/光标/键盘快捷键行为UNKNOWN |
| Q07 Insert variable菜单 | DSubject与Message各有入口LIVE；S未选择项；X八项{job_title}/{company_name}/{candidate_first_name}/{candidate_current_company}/{compensation_and_location}/{responsibility_list}/{sender_name}/{relevant_domain} LIVE；I UNKNOWN；L/E UNKNOWN | 触发后出现菜单，焦点实际到menu LIVE；选择→插入和位置保留为REQ，实测UNKNOWN | 菜单锚定当前入口；关闭还原当前字段光标REQ；不触发整个步骤提交 | 未插入变量，解析/缺值/重复/粘贴token与真实收件人预览UNKNOWN；不能用Juicebox变量集合替换 |
| Q08 Name/Description/Favorite设置 | D右侧Sequence Name必填星号、description、favorite星形/checkbox0 LIVE；S现草稿名LIVE；X N/A；I长度校验UNKNOWN；L/E UNKNOWN | Name计数54/50、description0/100为实测；未测超限提示/截断，不能宣称50是已验证硬限制 | 1440settings在流程右侧；窄屏后续位置必须按滚后状态检查，不由AX顺序断言可见；长名输入内部截断 | 改名/收藏保存触发及持久化UNKNOWN；不因计数超限自行删字 |
| Q09 Delivery发送窗口与Timezone | D09:00/21:00两个combo，Chicago+本地clock/GMT-5，Business days only switch0 LIVE；S当前值LIVE；XTimezone搜索框+长城市/本地日期时间/offset列表LIVE；I时间边界规则UNKNOWN；L/E UNKNOWN | Timezone展开后Search timezone combo与Timezones列表LIVE；选择/搜索结果未实测；start/end候选未打开 | 长列表内部滚；搜索可键盘输入REQ；关闭回Timezone；菜单必须在视口内且不被settings裁切REQ | 时区转换、跨午夜、夏令时、business-days定义UNKNOWN；offset显示有疑点，不能抄为算法；IANA与日期绑定REQ |
| Q10 Exit criteria与底部动作 | DReply received卡、Cancel/Previous/Publish LIVE；S N/A；XPublish后继UNKNOWN；I Publish在本状态AX未禁用，但校验触发未知；L/E UNKNOWN | Cancel是sequence列表链接，Previous是按钮；未点Publish；底部有快捷键提示，执行UNKNOWN | 1440/390底部动作条持续可见LIVE；主内容底部必须可滚到不被遮REQ；Cancel的草稿保留/丢弃策略UNKNOWN | Publish是业务提交边界，不能从0recipients推断无影响；已建草稿不等于已Publish/排程/送达 |
| Q11 Recipients搜索与状态筛选 | DSearch recipients输入+Search按钮、All0/Active0/Paused0/Exited0 LIVE；SActive1 LIVE；X切Recipients展开整个panel LIVE；I UNKNOWN；L/E UNKNOWN | 过滤对象是该sequence recipients，搜索按钮入口LIVE未提交；状态计数0 | 切status不改收件人生命周期REQ；窄屏非空列表/详情方式UNKNOWN；搜索清空规则UNKNOWN | 当前总数0；Active0不单独证明所有状态均空，须结合tab总数；未Enrollment、未创建联系人 |
| Q12 Recipients双空态 | D左No recipients in this status/Choose another status，右Select a recipient/Review their emails and sending progress here LIVE；S无recipient选中；X N/A；I无可选recipient LIVE；L/E UNKNOWN | 左侧集合空与右侧未选择是两个独立语义；不能合并成错误 | 1440左右panel布局LIVE；数据到来时保持列表/详情scope一致REQ | 非空recipient行、邮件记录、进度、暂停/退出操作均UNKNOWN；不能照搬Juicebox Run当作已观察 |

## 13. Metix Interview 与安排面试细颗粒契约

证据：[Interview（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[状态菜单（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[日期（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Step1（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[选时（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Multiple（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Advanced（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[时区（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Step2（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[退出（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| T01 日历role/status筛选 | DAllroles/Allstatus LIVE；SAllstatus及四项勾选1 LIVE；XAll/Invited/Confirmed/Declined/Expired LIVE；I UNKNOWN；L/E UNKNOWN | 勾选控制显示邀请集合 REQ；实际逐项筛选未执行 | popover内checkbox可键盘；不当作候选人matchstage | 状态过滤不接受/拒绝邀请，不发通知 |
| T02 Today/前后箭头/日期段 | D五天范围LIVE；S当前日期/范围LIVE；X日期按钮→月历LIVE；I当前范围Todaydisabled LIVE；L/E UNKNOWN | 月历选Oct21→Oct21–25，仍无事件LIVE | 月历锚定日期按钮；关后焦点回日期；日期grid应有键盘位置 REQ | 切日不创建事件；“week”文案不证明7列 |
| T03 五列时间grid与当前时间线 | D日期头/小时线/Today紫线LIVE；S当前日期紫色LIVE；X N/A；I过去时间可选规则UNKNOWN；L/E UNKNOWN | Calendar页无事件；选时drawer中点击格可生成时段LIVE | 时间grid独立纵滚；日期头保持对应列；scrollHeight不能等同viewport | 空grid不代表无availability；不能从Noevents推断未连接 |
| T04 timezone按钮/长列表/搜索 | DChicago+当前clock+GMT LIVE；S当前city LIVE；X搜索+长城市/本地日期时间/offset列表LIVE；I UNKNOWN；L/E UNKNOWN | 打开选择层LIVE；选城市实际转换未执行 | 长列表内部滚；搜索框先焦点；Esc回timezone按钮 REQ | 展示offset有疑点；时区算法必须基于IANA+事件日期 REQ |
| T05 All Activity栏与日历空态 | D独立Noactivityyet及Nointerviewsweek LIVE；S N/A；X活动详情UNKNOWN；I N/A；L/E UNKNOWN | 切历史范围仍空LIVE | 侧栏活动独立于日历垂直滚动 REQ | 本周空不等于所有历史空；不虚构示例会 |
| T06 Schedule整体drawer | D候选人标题+左grid+右Step1 LIVE；S当前候选人示例候选人 LIVE；X从InboxSchedule展开LIVE；I无Schedule的人不自动生成同按钮 REQ；L/E UNKNOWN | Schedule→Step1，没有发出邀请LIVE | 遮罩背景；左grid/右form分scroll owner；关闭见T16 | 草稿仅当前人；不能将Inbox未读/材料转换成已邀请 |
| T07 mode单选卡 | DSingle1/Multiple0 LIVE；S切Multiple1LIVE；XMultiple附加控件LIVE；I UNKNOWN；L/E UNKNOWN | 点击任一mode仅选一个；切Multiple保留已选1slot LIVE | 整卡和radio同一动作；不用checkbox多选语义实现两个同时选中 REQ | 不发送邀请；模式切换对已有event影响UNKNOWN |
| T08 单时间Start/End/date/time行 | D空Times说明、Nextdisabled LIVE；S点Nov2 11→11–11:30行和grid块LIVE；X日期/time有popup入口LIVE未展开；I空Nextdisabled LIVE；L/E UNKNOWN | 点grid生成一行；显示candidate9–9:30GMT-7 LIVE | 控件与块双向反映同一draft REQ；原站date/time编辑结果未测 | 默认30min仅样例；事件真实UTC写入未执行 |
| T09 Remove time / Add time range | D有行后两个入口LIVE；S N/A；X新增行结果未执行UNKNOWN；I去掉最后行后Next应与可提交条件一致 REQ；L/E UNKNOWN | 只操作当前草稿的range；remove不删已有邀约 REQ | 删除行后focus到相邻row/添加按钮 REQ；row多时表单内滚 | 多range重叠处理、最大数UNKNOWN |
| T10 Multiple Duration/slotcount/Preview | D30min/Times1slot/PreviewLIVE；SMultiple已选LIVE；XDuration候选/Preview画面UNKNOWN；I当前仅1slot时Nextdisabled LIVE；L/E UNKNOWN | duration与slot数关系需服务契约确定；不能从1次禁用推定阈值 | Preview不是提交；关预览回当前表单 REQ | slot拆分规则/最少数/最长区间UNKNOWN，不擅定 |
| T11 Advanced折叠 | DAdvanced按钮LIVE；S N/A；X展开MinimumNotice/Avoidconflicts/ConnectCalendar LIVE；I UNKNOWN；L/E UNKNOWN | 原位展开不跳步骤；收起保留草稿配置 REQ | 内容增加右表单高度；底部Next不盖字段 | 展开不连接calendar，不自动改用户全局偏好 |
| T12 Minimum Notice数值/单位 | D2hours LIVE；S现值LIVE；X单位选项UNKNOWN；I输入校验UNKNOWN；L/E UNKNOWN | 文案明确候选人不见起点早于notice的slot LIVE | 数字输入标签关联；错误靠近值 REQ | 负数/小数/单位换算规则未知；不能隐式改会期 |
| T13 Avoid conflicts +连接入口 | D勾选1 LIVE；Scheckbox状态LIVE；XConnectCalendar后续未点UNKNOWN；I UNKNOWN；L/E UNKNOWN | 文案OnlychecksMetixmeetings LIVE；连接后扩大检查不在已观察 | 勾选不立即跳外部登录 REQ；连接另有清楚流程 | 未连接不能宣称已查完整外部日历；不自动授权 |
| T14 Step1 Next / Step2 Back | D空Nextdisabled LIVE；S单range后Next可用LIVE；XNext→Step2、Back→Step1实测LIVE；I Multi1slotNextdisabled LIVE；L/E UNKNOWN | 切步骤保留单range/候选人 LIVE | 焦点到新步骤首字段 REQ；Back不丢notes/guest配置 REQ | 仅本地流程推进，无邀请发送 |
| T15 Step2 Guests/Location/Notes/Send | D两guestchips+email输入、Online/InPerson、link/location、optionalnotes、0/1000 LIVE；SOnline黑底LIVE；XInPerson结果未点UNKNOWN；I校验细则UNKNOWN；L/E未知 | 输入是draft；Sendinvitation是最终外发入口未点击；Notes上限1000为界面文案 | 内容scroll；Back与Send固定底部但不挡notes；guest chip删除规则UNKNOWN | 不凭默认2人推断所有邀请固定2人；不会提前通知任何人 |
| T16 未保存退出确认 | D未改时关闭规则UNKNOWN；S草稿有range后触发确认LIVE；XExit editingthisevent?+BacktoEdit/Exit LIVE；I UNKNOWN；L/E N/A | BacktoEdit回草稿；Exit丢弃并返回Inbox LIVE | 顶层对话框先获得焦点；Escape/关闭与外层取消关系须明确 REQ | Exit丢草稿不取消已存在event；此次无真实event生成 |

### 13.1 已实测390手机安排链路

这条链与桌面并排grid/form不同：**Inbox Schedule → 全屏Schedule日历 → 点选range → 底部Continue → Schedule details底部面板Step1 → Next → Step2 → 关闭编辑触发Exit确认**。下层Schedule容器仍留在AX树中，不等于在底部面板之上可操作。此次未点Send invitation。

证据：[calendar](states/metix-schedule-mobile-calendar-390.txt)、[selected](states/metix-schedule-mobile-selected-390.txt)、[pick-times](states/metix-schedule-mobile-pick-times-390.txt)、[customize](states/metix-schedule-mobile-customize-390.txt)、[exit](states/metix-schedule-exit-390.txt)。五状态的对应截图同名位于screenshots，几何数据见第14节。

| ID / 组件 | 六态契约 | 触发与可见反馈 | 关闭、滚动、焦点 | 数据影响 / 未知边界 |
|---|---|---|---|---|
| U01 手机全屏Schedule与三列grid | D390宽全屏Schedule标题/左返回箭头、Today、日期段、GMT-5、三天Oct31/Nov1/Nov2、底部preferred图例/candidateGMT-7 LIVE；S当前日期紫色LIVE；X日期/时区入口存在但手机展开未测；I Todaydisabled LIVE；L/E UNKNOWN | 从Inbox进入仅日历，未同步展示Step1表单LIVE；此390样例三列，不套桌面五列 | grid纵滚、日期头保持可辨；截图有独立滚动条；返回箭头的无改动关闭结果UNKNOWN；Top含Schedule Interview的AX标题并非截图第二个标题 | 未创建邀请；可见3天不代表断点精确值/所有手机固定3列；不同高度见JSON |
| U02 点选range与Continue条 | D未选时无range摘要LIVE；S点后Nov2 2–2:30PM块和1 range selected LIVE；XContinue→Step1底部面板LIVE；I未选时Continue入口不可见LIVE；L/E UNKNOWN | 点击时间格生成30min样例；选中块/计数/Continue同步LIVE | Continue在日历下部动作区；range增加后不能遮住最后可选时间REQ；拖动改时长未测 | 当前draft1range；candidate为12–12:30GMT-7，与日历GMT-5分开显示；无真实event写入 |
| U03 Step1底部面板/背景遮罩 | DSchedule details第二层、圆角顶/短drag-handle、Step1 Pick times、黑色Next底部按钮 LIVE；SSingle1 LIVE；X从Continue打开LIVE；I缺range规则沿T08但该状态有range；L/E UNKNOWN | 面板盖住大部分日历，背景变暗；只露上层Schedule头部；不能把AX背景控件当当前可点对象 | 面板自身长内容滚动、Next可达REQ；drag-handle存在不证明已验证拖拽关闭；手势/点遮罩/键盘弹出行为UNKNOWN | 进入面板不发送；选range与表单是同一草稿REQ；不是另建event |
| U04 手机Step1 mode/time行 | DSingle/Multiple卡、Start Nov2/2PM与End Nov2/2:30PM、Remove、candidate换算、Add time range LIVE；S卡边框与紫radio共同表达Single LIVE；X日期/time popup手机内容UNKNOWN；I Next当前可用LIVE；L/E UNKNOWN | Next→Step2实测；手机Multiple/Advanced展开未采，不把桌面展开几何标成手机LIVE | start/end在同一row紧凑排布，candidate独立灰条；控件label/点击范围仍关联REQ；溢出不能把Remove藏在不可达区REQ | 未改time、未add/remove；按钮语义同T07–T13，实际移动端后果仍未验证 |
| U05 手机Step2邀请字段与footer | DStep2标题、两guest分行chip、email输入、Online/InPerson、location输入、Notes与0/1000、Back/Send invitation LIVE；SOnline黑底LIVE；XNext进入LIVE；I最终校验UNKNOWN；L/E UNKNOWN | Step1→Step2仍同一底部面板；Back和Send并排置底，Send占更宽LIVE | 此状态focus实际为Back按钮；初始焦点不是已验证首字段；Notes在按钮上方，长内容/软键盘避让UNKNOWN，需实现并测REQ | 未输入额外guest、未发送；默认位置placeholder不是已生成有效会议链接 |
| U06 手机关闭与Exit确认层 | D有range草稿的calendar底层保留1range/Continue LIVE；S顶层Back to Edit实际focus LIVE；XExit editing this event?+Your changes…not be saved/Back to Edit/Exit LIVE；I UNKNOWN；L/E N/A | 从编辑关闭路径出现确认LIVE；两按钮存在，手机最终Exit后画面未在这五张采样证明；桌面Exit返回Inbox另见T16 | 顶层优先可操作，背景日历/Continue不接受输入REQ；取消退出恢复range和当前步骤REQ；Esc/系统返回键顺序未测 | 丢弃的是此次未提交草稿；不取消历史邀请、不标记发信；不得凭Exit按钮存在宣称服务器草稿已删除 |

## 14. 几何标注与交互的绑定方式

本文件只定义组件状态和动作边界；**宽高/坐标/布局变化必须绑定特定页面状态和视口**。主索引为同目录 [manifest.json](manifest.json)，逐状态数据位于 `states/{id}.json`。阅读时使用下表，而不是按组件名称猜一个统一尺寸。

| 组件组 | 必须找到的几何状态 | 需要比较的量 |
|---|---|---|
| B01/B02、C01–C12 | Contacts、Shortlist Table、选中工具栏、Board、打开菜单 | 侧栏宽；header/tool/table/footer各rect；行高；选中底栏占位；横纵scroll owner；菜单锚点和边界 |
| J01–J13 | Sequence总览、详情、run-filter、response菜单 | 内容最大宽和左右间距；KPI数量/宽高/gap；图高；表格列宽；菜单展开前后rect |
| E01–E12 | editor、timingpopover、composer收起（若采到） | 全屏层外边距/可用高；左panel宽；splitter；索引与step卡宽；富文本区min/scrollHeight；底部按钮位置 |
| F01–F07 | enrollment、偏好展开、more-details、review | dialog width/maxHeight；内容padding；字段高；菜单位置；footer高；展开对scrollHeight影响 |
| P01–P10 | expanded profile及五tabs | drawer起点/宽高；两栏分配；固定header；标签高；各栏scrollHeight与最底条可达性 |
| A01–A11 | Outreach、TalentInsights、筛选展开、受限页 | KPI和图表布局；图内部plot区；table横滚；长分析页真实高度；paywall容器 |
| M01–M10、N01–N08 | candidates、scoremenu、Inbox未选/已选、Profile、Reply | 三列宽；候选卡高/间距；线程头；Profile宽/遮罩；reply编辑区高/toolbar/footer |
| O01–O07 | Outreach Email/JobPosting、Sequence空态/mailgate、Shortlist空态 | 流程卡宽/间距/完整页高；tabs；空态中心定位；前置dialog尺寸 |
| Q01–Q12 | Context/editor/variables/timezone/recipients；1440与390 | editor主流程/settings分配、富文本内部滚动、toolbar与底部动作、变量菜单锚点、长timezone列表；手机真实可见状态 |
| U01–U06 | mobile-calendar/selected/pick-times/customize/exit390 | 三列日期宽、每小时高、选中块、Continue底栏、第二层sheet起点/高、遮罩与确认层；与桌面并排布局比较 |
| T01–T16 | Interview、date/timezonepopup、step1空/选中/multi/advanced、step2、discard | 五列宽、每小时像素高、grid真实scrollHeight；日历/表单分配；slot块坐标；expanded差值；底部固定动作位置 |

### 14.1 已采状态的直接索引

下列链接绑定到**具体状态**而非泛称页面。所标1440是该状态文件名中的视口系列，不代表任何组件固定宽1440；实际`window.innerWidth/innerHeight`以JSON记录为准。

| 组件ID | 直接测量证据 | 展开/压缩/高度差的核对点 |
|---|---|---|
| J01–J07 | [1806](states/juicebox-sequence-1806.json)、[1440](states/juicebox-sequence-1440.json)、[1024](states/juicebox-sequence-1024.json)、[768](states/juicebox-sequence-768.json)、[390](states/juicebox-sequence-390.json) | 同一总览跨视口的KPI布局、列最小宽、侧栏与溢出；不根据文件名推断断点 |
| J08–J13 | [详情1440](states/juicebox-sequence-detail-1440.json)、[Run filter](states/juicebox-run-filter-1440.json) | 七统计按钮、schedule、表格与filterpopup锚点 |
| E01–E13 | [Editor1440](states/juicebox-editor-1440.json)、[1024](states/juicebox-editor-1024.json)、[短窗口](states/juicebox-editor-short-height.json)、[Timingpopover](states/juicebox-editor-timing-popover-1440.json)、[Emailpreview](states/juicebox-editor-preview-1440.json) | splitter/Composer/步骤索引/正文分区、popover边界、低高度scrollowner、上层preview |
| F01–F05 | [Enrollment1440](states/juicebox-enrollment-1440.json)、[1024](states/juicebox-enrollment-1024.json)、[低高度](states/juicebox-enrollment-short-height.json) | modal固定/最大宽、正文和footer、视口底部可达性 |
| F06–F07 | [Review](states/juicebox-review-modal-1440.json) | reviewer、note、disabledprimary的实际rect及spacing |
| C01–C05 | [Contacts1440](states/juicebox-contacts-1440.json)、[1024](states/juicebox-contacts-1024.json)、[滚后](states/juicebox-contacts-scrolled-1440.json)、[Filter](states/juicebox-contact-filter-1440.json)、[Actions](states/juicebox-contact-actions-1440.json) | 主scroll与表内scroll、表头/列宽、菜单高度与viewport边界 |
| C06–C10 | [ShortlistTable](states/juicebox-shortlist-table-1440.json)、[Columns menu](states/juicebox-columns-menu-1440.json) | 表头与分页、两级菜单、列选择控件真实坐标 |
| P01–P10 | [Profile展开](states/juicebox-profile-drawer-1440.json)、[collapsed1440](states/juicebox-profile-collapsed-1440.json)、[collapsed1024](states/juicebox-profile-collapsed-1024.json)、[Sequences](states/juicebox-profile-sequences-1440.json)、[Sequence来源资料](states/juicebox-sequence-contact-drawer-1440.json) | 两栏变单栏/压缩结果、详情宽与独立滚动、相同组件不同来源页 |
| M03、N01–N08 | [Inbox1806](states/metix-inbox-1806.json)、[1440](states/metix-inbox-1440.json) | sidebar/list/thread三列，未选中与已选中应按实际AX识别 |

| Q01–Q02 | [Context1440](states/metix-sequence-context-1440.json)、[Context390](states/metix-sequence-context-390.json)、[公司描述](states/metix-sequence-context-expanded-1440.json)、[Sender](states/metix-sequence-sender-menu-1440.json) | 上下文各字段、折叠高度、菜单与触发器 |
| Q03–Q10 | [Editor1440](states/metix-sequence-editor-1440.json)、[Editor390](states/metix-sequence-editor-390.json)、[390滚后](states/metix-sequence-editor-scrolled-390.json)、[Settings](states/metix-sequence-editor-settings-1440.json)、[Variables](states/metix-sequence-variables-1440.json)、[Timezone](states/metix-sequence-timezone-1440.json) | 流程与settings宽高、正文内部scrollHeight、固定footer、token换行、菜单viewport边界 |
| Q11–Q12 | [Recipients1440](states/metix-sequence-recipients-1440.json) | 状态checkbox、搜索、双panel空态的rect；不是非空行证据 |
| U01–U06 | [Calendar390](states/metix-schedule-mobile-calendar-390.json)、[Selected390](states/metix-schedule-mobile-selected-390.json)、[PickTimes390](states/metix-schedule-mobile-pick-times-390.json)、[Customize390](states/metix-schedule-mobile-customize-390.json)、[Exit390](states/metix-schedule-exit-390.json) | 真实手机全链：3列grid→range→Continue→底部sheet两步→顶层确认；按viewport rect查看层叠而不是AX顺序 |

后续新状态继续加入manifest；表中没有的状态仍使用上一轮原始截图/AX，不能称已有精确CSS标注。尤其不从Juicebox的390px观察推断Metix手机行为。

### 14.2 每个状态必须配套的几何事实

**REQ设计标注验收**：记录 viewport宽高与DPR；页面根scrollWidth/scrollHeight；每个主要容器rect及computed overflow、scrollHeight/clientHeight；控件rect、字体/行高/字重、padding、border、radius；弹层与锚点rect；采样页面的scope/selectedtab/selectedperson状态。若测量仅有CSSrect而没有outerwindow尺寸，应明确只测了内容视口，不推导操作系统窗口边框。

不同视口的同一状态至少要能回答：固定的是侧栏宽、内容maxWidth还是列minWidth；哪一行换行；哪块出现横滚；哪块改为抽屉；哪个footer继续sticky。没有相邻视口观测不能倒推原站断点的精确px值。自适应行为可标LIVE，未见行为标UNKNOWN；复刻所需行为单列REQ。

### 14.3 六态截图与行为验收

每个确实有语义的D/S/X/I/L/E应能对应“截图/测量或明确UNKNOWN”，不要求原站没有提供的状态强行生成。对REQ实现时，最少回放：打开→展开→选择→关闭→返回；空输入→有效输入→提交中→失败保留→成功读回；筛选A→B→迟到A；有草稿→退出→取消退出；长文/长表→底部→关闭。此处是未来实现验收路径，不是本次已完成生产写操作的声明。

## 15. 不可据此补造的组件

1. Metix非空通用Shortlist卡片、非空sequence列表/recipient详情、邮箱配置提交界面仍UNKNOWN。第二轮原生Sequence context/editor/variables/timezone/0recipients已达，见Q01–Q12；不得再标整页不可达，也不把role Outreach当作同一编辑器。
2. Juicebox Usage/Projects/Agents三页只有套餐限制视图；其内部图表、表格、过滤、错误和响应式组件UNKNOWN。
3. 真正发送邮件/enrollment/review邀请/面试邀请后的成功、失败、排队、重试以及接收方页面未执行；按钮存在不能补造后端结果。
4. 多时段邀请的Preview、候选人选择时段、完整conflict检查、所有日期/时间候选项未实测。
5. 每个未被展开的More、菜单子级、tooltip、隐藏按钮和静态bundle中的字符串都不能当成新的可见状态。第二轮Emailpreview已实际打开，但enrollment的PreviewSteps和Metix多时段Preview仍未知，两者不能互相替代。
6. 原站hover动画的实际运行、完整手机/平板/深色设计仍须逐状态采集。390手机Schedule的日历/选中/Continue/两步面板/退出确认与390Sequence editor已有实测，见Q/U组；手机timezone/变量菜单展开、软键盘、旋转和未采页面仍UNKNOWN。CSS transition声明不等于动画实际已回放。
