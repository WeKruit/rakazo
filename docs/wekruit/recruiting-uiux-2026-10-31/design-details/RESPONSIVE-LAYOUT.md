> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# 窗口、页面高度与响应式实测

本表中的尺寸是浏览器 CSS 视口，不是设备型号。只把实际测试到的断点行为写为事实；未扫描到的边界不推定为某个常见框架断点。

## 布局规则

| 区域 | 实测行为 | 实现与验收约束 |
|---|---|---|
| Juicebox 窄屏 | 1000px 正常，999px 出现全屏 Switch to a larger screen 提示；768/390 同样阻挡 | 小于1000px的底层 DOM 不能当作可用手机 UI |
| Juicebox Sequence KPI | 1440px 六列，1024px 三列 | 容器换行；具体卡片边界见两状态 E 表 |
| Juicebox Profile | 收起时右侧450px，展开状态更宽 | 保留列表上下文；按收起/展开状态核对右边界与遮罩 |
| Juicebox 表格/看板 | 外窗固定高度，内容区独立滚动；表格横滚，看板列内纵滚 | 分清页面、表格、列、抽屉滚动责任 |
| Metix Inbox | 1440px展开侧栏；1024px图标侧栏，邮件列表与正文并列；390px列表/正文切换 | 手机用 Back to inbox list 返回；不是压缩三列 |
| Metix Profile | 桌面侧向面板，手机占主要视口 | 用 stable 状态坐标；进入动画位置不能作最终宽度 |
| Metix Interview | 桌面五天日历+活动列；手机三天日历，活动移至下方 | 保留日期/状态筛选与日历内部滚动 |
| Metix Schedule | 桌面主要工作区1150px；1024px Step2曾出现左侧裁切x=-126 | 裁切是竞品实测缺陷，记录事实；不推为期望响应式规范 |
| Metix 手机排期 | 三日日历选区→Continue→Pick times底部表单→Customize invitation底部表单 | 两个表单状态要分别验收；固定底部返回/发送区域 |
| Metix Sequence editor | 桌面步骤区/设置区分区；390px改为纵向内容并保留底部动作 | 富文本正文和工具栏有独立滚动；不是整页所有内容等比缩小 |
| 1440×600短窗口 | editor、enrollment、calendar、schedule分别测试 | 可滚内容缩短，主要动作位置与容器 overflow 逐页核对 |

## 全部状态的高度记录

表中“容器”按 `clientWidth×clientHeight → scrollWidth×scrollHeight @ scrollLeft,scrollTop` 记录；它们随数据状态变化。完整 selector 与组件关系见每行 JSON。

| 实测状态 | 视口 | 文档滚动尺寸 | 内部滚动容器 |
|---|---|---|---|
| [juicebox-analytics-metric-menu-1440](states/juicebox-analytics-metric-menu-1440.json) | 1440×900 | 1440×900 | 1185×752 → 1185×967 @ 0,215; 132×32 → 141×32 @ 0,0; 1135×228 → 1186×228 @ 0,0 |
| [juicebox-columns-menu-1440](states/juicebox-columns-menu-1440.json) | 1440×900 | 1440×900 | 1185×743 → 1185×1575 @ 0,0; 1185×1560 → 1266×1560 @ 0,0; 193×288 → 193×320 @ 0,0 |
| [juicebox-contact-actions-1440](states/juicebox-contact-actions-1440.json) | 1440×900 | 1440×900 | 1185×796 → 1185×3207 @ 0,0; 1185×3192 → 2475×3192 @ 0,0 |
| [juicebox-contact-filter-1440](states/juicebox-contact-filter-1440.json) | 1440×900 | 1440×900 | 1185×796 → 1185×1632 @ 0,0; 1185×1617 → 2475×1617 @ 0,0 |
| [juicebox-contacts-1024](states/juicebox-contacts-1024.json) | 1024×768 | 1024×768 | 769×664 → 769×3207 @ 0,0; 769×3192 → 2475×3192 @ 0,0 |
| [juicebox-contacts-1440](states/juicebox-contacts-1440.json) | 1440×900 | 1440×900 | 1185×796 → 1185×1632 @ 0,0; 1185×1617 → 2475×1617 @ 0,0 |
| [juicebox-contacts-scrolled-1440](states/juicebox-contacts-scrolled-1440.json) | 1440×900 | 1440×900 | 1185×743 → 1185×1632 @ 0,836; 1185×1617 → 2475×1617 @ 0,0 |
| [juicebox-editor-1024](states/juicebox-editor-1024.json) | 1024×768 | 1024×768 | 769×720 → 769×3942 @ 0,0; 721×93 → 1068×93 @ 0,0; 721×103 → 1088×103 @ 0,0; 721×3226 → 1088×3226 @ 0,0; 547×602 → 640×1923 @ 0,0 |
| [juicebox-editor-1440](states/juicebox-editor-1440.json) | 1440×900 | 1440×900 | 1185×852 → 1185×3873 @ 0,0; 890×749 → 890×1845 @ 0,0 |
| [juicebox-editor-preview-1440](states/juicebox-editor-preview-1440.json) | 1440×900 | 1440×900 | 1185×852 → 1185×3873 @ 0,0; 890×749 → 890×1845 @ 0,0; 835×545 → 835×798 @ 0,0 |
| [juicebox-editor-short-height](states/juicebox-editor-short-height.json) | 1440×600 | 1440×600 | 224×325 → 224×356 @ 0,0; 1185×552 → 1185×3873 @ 0,0; 890×449 → 890×1845 @ 0,0 |
| [juicebox-editor-timing-popover-1440](states/juicebox-editor-timing-popover-1440.json) | 1440×900 | 1440×900 | 1185×852 → 1185×3873 @ 0,0; 890×749 → 890×1845 @ 0,764 |
| [juicebox-enrollment-1024](states/juicebox-enrollment-1024.json) | 1024×768 | 1024×768 | 769×664 → 769×3207 @ 0,0; 769×3192 → 2475×3192 @ 0,0 |
| [juicebox-enrollment-1440](states/juicebox-enrollment-1440.json) | 1440×900 | 1440×900 | 1185×796 → 1185×3207 @ 0,0; 1185×3192 → 2475×3192 @ 0,0 |
| [juicebox-enrollment-short-height](states/juicebox-enrollment-short-height.json) | 1440×600 | 1440×600 | 224×325 → 224×356 @ 0,0; 1185×496 → 1185×3207 @ 0,0; 1185×3192 → 2475×3192 @ 0,0; 514×536 → 514×570 @ 0,0 |
| [juicebox-guard-1023](states/juicebox-guard-1023.json) | 1023×768 | 1023×768 | 768×768 → 768×9916 @ 0,900; 163×406 → 163×441 @ 0,0 |
| [juicebox-insights-1024](states/juicebox-insights-1024.json) | 1024×768 | 1024×768 | 769×768 → 769×9916 @ 0,900; 163×406 → 163×441 @ 0,0 |
| [juicebox-insights-1440](states/juicebox-insights-1440.json) | 1440×900 | 1440×900 | 1185×900 → 1185×5272 @ 0,0; 170×406 → 170×441 @ 0,0 |
| [juicebox-insights-scrolled-1440](states/juicebox-insights-scrolled-1440.json) | 1440×900 | 1440×900 | 1185×900 → 1185×5272 @ 0,900; 170×406 → 170×441 @ 0,0 |
| [juicebox-outreach-analytics-1024](states/juicebox-outreach-analytics-1024.json) | 1024×768 | 1024×768 | 769×576 → 769×1103 @ 0,0; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 719×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-analytics-1440](states/juicebox-outreach-analytics-1440.json) | 1440×900 | 1440×900 | 1185×752 → 1185×967 @ 0,0; 132×32 → 141×32 @ 0,0; 1135×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-analytics-390](states/juicebox-outreach-analytics-390.json) | 390×844 | 390×844 | 135×549 → 171×2119 @ 0,0; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 85×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-analytics-768](states/juicebox-outreach-analytics-768.json) | 768×1024 | 768×1024 | 513×744 → 513×1139 @ 0,0; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 463×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-scrolled-1440](states/juicebox-outreach-scrolled-1440.json) | 1440×900 | 1440×900 | 1185×752 → 1185×967 @ 0,215; 132×32 → 141×32 @ 0,0; 1135×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-width-1000](states/juicebox-outreach-width-1000.json) | 1000×768 | 1000×768 | 745×576 → 745×1123 @ 0,371; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 695×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-width-1023-stable](states/juicebox-outreach-width-1023-stable.json) | 1023×768 | 1023×768 | 768×576 → 768×1103 @ 0,351; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 718×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-width-899](states/juicebox-outreach-width-899.json) | 899×900 | 899×900 | 644×620 → 644×1103 @ 0,351; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 594×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-width-900](states/juicebox-outreach-width-900.json) | 900×900 | 900×900 | 645×620 → 645×1103 @ 0,351; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 595×228 → 1186×228 @ 0,0 |
| [juicebox-outreach-width-999](states/juicebox-outreach-width-999.json) | 999×768 | 999×768 | 744×576 → 744×1123 @ 0,371; 16×32 → 141×32 @ 0,0; 16×32 → 141×32 @ 0,0; 694×228 → 1186×228 @ 0,0 |
| [juicebox-profile-collapsed-1024](states/juicebox-profile-collapsed-1024.json) | 1024×768 | 1024×768 | 319×571 → 319×1575 @ 0,0; 319×1560 → 1266×1560 @ 0,0; 449×606 → 449×1788 @ 0,0 |
| [juicebox-profile-collapsed-1440](states/juicebox-profile-collapsed-1440.json) | 1440×900 | 1440×900 | 735×743 → 735×1575 @ 0,0; 735×1560 → 1266×1560 @ 0,0; 449×738 → 449×1788 @ 0,0 |
| [juicebox-profile-drawer-1440](states/juicebox-profile-drawer-1440.json) | 1440×900 | 1440×900 | 735×743 → 735×1575 @ 0,0; 735×1560 → 1266×1560 @ 0,0; 702×738 → 702×1715 @ 0,0; 575×816 → 575×995 @ 0,0 |
| [juicebox-profile-sequences-1440](states/juicebox-profile-sequences-1440.json) | 1440×900 | 1440×900 | 735×743 → 735×1575 @ 0,0; 735×1560 → 1266×1560 @ 0,0; 702×738 → 702×1715 @ 0,0 |
| [juicebox-review-modal-1440](states/juicebox-review-modal-1440.json) | 1440×900 | 1440×900 | 1185×743 → 1185×1575 @ 0,0; 1185×1560 → 1266×1560 @ 0,0 |
| [juicebox-run-filter-1440](states/juicebox-run-filter-1440.json) | 1440×900 | 1440×900 | 1185×852 → 1185×3873 @ 0,0 |
| [juicebox-sequence-1024](states/juicebox-sequence-1024.json) | 1024×768 | 1024×768 | 769×720 → 769×996 @ 0,0; 721×38 → 1160×38 @ 0,0; 721×129 → 1160×129 @ 0,0 |
| [juicebox-sequence-1440](states/juicebox-sequence-1440.json) | 1440×900 | 1440×900 | 1152×38 → 1160×38 @ 0,0; 1152×129 → 1160×129 @ 0,0 |
| [juicebox-sequence-1806](states/juicebox-sequence-1806.json) | 1806×1067 | 1806×1067 | 无采到溢出容器 |
| [juicebox-sequence-390](states/juicebox-sequence-390.json) | 390×844 | 390×844 | 135×781 → 154×1836 @ 0,0; 103×38 → 1160×38 @ 0,0; 103×129 → 1160×129 @ 0,0 |
| [juicebox-sequence-768](states/juicebox-sequence-768.json) | 768×1024 | 768×1024 | 513×976 → 513×1168 @ 0,0; 465×38 → 1160×38 @ 0,0; 465×129 → 1160×129 @ 0,0 |
| [juicebox-sequence-contact-drawer-1440](states/juicebox-sequence-contact-drawer-1440.json) | 1440×900 | 1440×900 | 1185×852 → 1185×3873 @ 0,438; 702×738 → 702×3655 @ 0,0; 590×50 → 647×50 @ 0,0 |
| [juicebox-sequence-detail-1440](states/juicebox-sequence-detail-1440.json) | 1440×900 | 1440×900 | 1185×852 → 1185×3873 @ 0,0 |
| [juicebox-shortlist-board-1440](states/juicebox-shortlist-board-1440.json) | 1440×900 | 1440×900 | 1200×788 → 2976×788 @ 0,0; 305×756 → 305×7811 @ 0,0; 305×756 → 305×1013 @ 0,0 |
| [juicebox-shortlist-table-1440](states/juicebox-shortlist-table-1440.json) | 1440×900 | 1440×900 | 1185×743 → 1185×1575 @ 0,0; 1185×1560 → 1266×1560 @ 0,0 |
| [metix-availability-thread-1440](states/metix-availability-thread-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,786 |
| [metix-candidates-1024](states/metix-candidates-1024.json) | 1024×768 | 1024×768 | 509×704 → 509×3945 @ 0,3093; 435×40 → 446×40 @ 0,0; 949×535 → 949×774 @ 0,0 |
| [metix-candidates-1440](states/metix-candidates-1440.json) | 1440×900 | 1440×900 | 509×836 → 509×3945 @ 0,3093; 435×40 → 446×40 @ 0,0; 1185×667 → 1185×774 @ 0,0 |
| [metix-candidates-390](states/metix-candidates-390.json) | 390×844 | 390×844 | 358×40 → 414×40 @ 0,0; 379×575 → 379×1588 @ 0,0 |
| [metix-inbox-1024](states/metix-inbox-1024.json) | 1024×768 | 1024×768 | 488×592 → 488×1589 @ 0,0 |
| [metix-inbox-1440](states/metix-inbox-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0 |
| [metix-inbox-1806](states/metix-inbox-1806.json) | 1806×1011 | 1806×1011 | 488×835 → 488×1589 @ 0,0; 414×34 → 425×34 @ 0,0 |
| [metix-inbox-390](states/metix-inbox-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0 |
| [metix-inbox-768](states/metix-inbox-768.json) | 768×1024 | 768×1024 | 757×930 → 757×959 @ 0,0; 315×38 → 412×38 @ 0,0 |
| [metix-inbox-list-390](states/metix-inbox-list-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0 |
| [metix-inbox-selected-1440](states/metix-inbox-selected-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0 |
| [metix-interview-1024](states/metix-interview-1024.json) | 1024×768 | 1024×768 | 561×544 → 561×1344 @ 0,668 |
| [metix-interview-1440](states/metix-interview-1440.json) | 1440×900 | 1440×900 | 961×676 → 961×1344 @ 0,668 |
| [metix-interview-390](states/metix-interview-390.json) | 390×844 | 390×844 | 315×544 → 315×1344 @ 0,800 |
| [metix-interview-datepicker-1440](states/metix-interview-datepicker-1440.json) | 1440×900 | 1440×900 | 961×676 → 961×1344 @ 0,668 |
| [metix-interview-short-height](states/metix-interview-short-height.json) | 1440×600 | 1440×600 | 961×376 → 961×1344 @ 0,968 |
| [metix-interview-status-menu-1440](states/metix-interview-status-menu-1440.json) | 1440×900 | 1440×900 | 961×676 → 961×1344 @ 0,668 |
| [metix-mailbox-modal-1440](states/metix-mailbox-modal-1440.json) | 1440×900 | 1440×900 | 无采到溢出容器 |
| [metix-mailbox-modal-390](states/metix-mailbox-modal-390.json) | 390×844 | 390×844 | 无采到溢出容器 |
| [metix-outreach-1440](states/metix-outreach-1440.json) | 1440×900 | 1440×900 | 1365×836 → 1365×909 @ 0,0 |
| [metix-outreach-390](states/metix-outreach-390.json) | 390×844 | 390×844 | 379×755 → 379×1367 @ 0,0 |
| [metix-profile-1440](states/metix-profile-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0; 708×836 → 708×2713 @ 0,0 |
| [metix-profile-390](states/metix-profile-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 375×589 → 375×3493 @ 0,0; 343×42 → 379×42 @ 0,0 |
| [metix-profile-criteria-expanded-1440](states/metix-profile-criteria-expanded-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0; 708×836 → 708×3009 @ 0,0 |
| [metix-profile-stable-1440](states/metix-profile-stable-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0; 708×836 → 708×2777 @ 0,0 |
| [metix-reply-1440](states/metix-reply-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0; 685×402 → 685×457 @ 0,0 |
| [metix-reply-390](states/metix-reply-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 229×40 → 458×40 @ 0,0; 379×310 → 379×475 @ 0,0 |
| [metix-schedule-exit-390](states/metix-schedule-exit-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 355×576 → 355×1344 @ 0,680 |
| [metix-schedule-mobile-calendar-390](states/metix-schedule-mobile-calendar-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 355×664 → 355×1344 @ 0,680 |
| [metix-schedule-mobile-customize-390](states/metix-schedule-mobile-customize-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 355×664 → 355×1344 @ 0,680 |
| [metix-schedule-mobile-pick-times-390](states/metix-schedule-mobile-pick-times-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 355×664 → 355×1344 @ 0,680 |
| [metix-schedule-mobile-selected-390](states/metix-schedule-mobile-selected-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 355×576 → 355×1344 @ 0,680 |
| [metix-schedule-multiple-advanced-1440](states/metix-schedule-multiple-advanced-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,0; 649×736 → 649×1344 @ 0,608 |
| [metix-schedule-selected-1440](states/metix-schedule-selected-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,786; 649×736 → 649×1344 @ 0,608 |
| [metix-schedule-short-height](states/metix-schedule-short-height.json) | 1440×600 | 1440×600 | 488×424 → 488×1589 @ 0,0; 865×536 → 865×653 @ 0,0; 649×436 → 649×1344 @ 0,608; 429×464 → 429×612 @ 0,0 |
| [metix-schedule-step1-1440](states/metix-schedule-step1-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,786; 649×736 → 649×1344 @ 0,608 |
| [metix-schedule-step2-1024](states/metix-schedule-step2-1024.json) | 1024×768 | 1024×768 | 488×592 → 488×1589 @ 0,786; 649×604 → 649×1344 @ 0,608 |
| [metix-schedule-step2-1440](states/metix-schedule-step2-1440.json) | 1440×900 | 1440×900 | 488×724 → 488×1589 @ 0,786; 649×736 → 649×1344 @ 0,608 |
| [metix-schedule-step2-390](states/metix-schedule-step2-390.json) | 390×844 | 390×844 | 379×700 → 379×1820 @ 0,0; 305×38 → 412×38 @ 0,0; 355×664 → 355×1344 @ 0,680 |
| [metix-score-menu-1440](states/metix-score-menu-1440.json) | 1440×900 | 1440×900 | 509×836 → 509×3945 @ 0,3093; 435×40 → 446×40 @ 0,0; 1185×667 → 1185×774 @ 0,0 |
| [metix-sequence-context-1440](states/metix-sequence-context-1440.json) | 1440×900 | 1440×900 | 1365×766 → 1365×909 @ 0,0 |
| [metix-sequence-context-390](states/metix-sequence-context-390.json) | 390×844 | 390×844 | 379×715 → 379×1128 @ 0,0 |
| [metix-sequence-context-expanded-1440](states/metix-sequence-context-expanded-1440.json) | 1440×900 | 1440×900 | 1185×766 → 1185×1037 @ 0,143 |
| [metix-sequence-editor-1440](states/metix-sequence-editor-1440.json) | 1440×900 | 1440×900 | 825×716 → 825×2133 @ 0,0; 710×320 → 710×424 @ 0,0; 710×320 → 710×401 @ 0,0; 710×320 → 710×357 @ 0,0 |
| [metix-sequence-editor-390](states/metix-sequence-editor-390.json) | 390×844 | 390×844 | 379×665 → 379×2845 @ 0,0; 304×320 → 304×536 @ 0,0; 309×40 → 492×40 @ 0,0; 304×320 → 304×558 @ 0,0; 309×40 → 492×40 @ 0,0; 304×320 → 304×491 @ 0,0; 309×40 → 492×40 @ 0,0 |
| [metix-sequence-editor-scrolled-390](states/metix-sequence-editor-scrolled-390.json) | 390×844 | 390×844 | 379×665 → 379×2845 @ 0,0; 304×320 → 304×536 @ 0,216; 309×40 → 492×40 @ 0,0; 304×320 → 304×558 @ 0,0; 309×40 → 492×40 @ 0,0; 304×320 → 304×491 @ 0,0; 309×40 → 492×40 @ 0,0 |
| [metix-sequence-editor-settings-1440](states/metix-sequence-editor-settings-1440.json) | 1440×900 | 1440×900 | 825×716 → 825×2133 @ 0,0; 710×320 → 710×424 @ 0,0; 710×320 → 710×401 @ 0,0; 710×320 → 710×357 @ 0,0 |
| [metix-sequence-empty-1440](states/metix-sequence-empty-1440.json) | 1440×900 | 1440×900 | 无采到溢出容器 |
| [metix-sequence-empty-390](states/metix-sequence-empty-390.json) | 390×844 | 390×844 | 379×715 → 379×1000 @ 0,0 |
| [metix-sequence-recipients-1440](states/metix-sequence-recipients-1440.json) | 1440×900 | 1440×900 | 无采到溢出容器 |
| [metix-sequence-sender-menu-1440](states/metix-sequence-sender-menu-1440.json) | 1440×900 | 1440×900 | 1185×766 → 1185×1037 @ 0,0 |
| [metix-sequence-timezone-1440](states/metix-sequence-timezone-1440.json) | 1440×900 | 1440×900 | 825×716 → 825×2133 @ 0,0; 710×320 → 710×424 @ 0,0; 710×320 → 710×401 @ 0,0; 710×320 → 710×357 @ 0,0; 306×280 → 306×23528 @ 0,4352 |
| [metix-sequence-variables-1440](states/metix-sequence-variables-1440.json) | 1440×900 | 1440×900 | 825×716 → 825×2133 @ 0,0; 710×320 → 710×424 @ 0,0; 710×320 → 710×401 @ 0,0; 710×320 → 710×357 @ 0,0 |
| [metix-shortlist-empty-1440](states/metix-shortlist-empty-1440.json) | 1440×900 | 1440×900 | 无采到溢出容器 |
| [metix-shortlist-empty-390](states/metix-shortlist-empty-390.json) | 390×844 | 390×844 | 无采到溢出容器 |
