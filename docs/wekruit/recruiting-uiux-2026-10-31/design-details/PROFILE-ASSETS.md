> 本公开版本只包含122个通用界面图标/社交渲染样本。以下资源导出数量描述的是私有研究阶段，不是本PR发布数量；人物照片、公司/学校与个人关联的来源数据不发布。

> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Profile / Contacts 媒体与图标设计清单

本页补充真实头像、公司/学校logo、社交品牌图标和它们的展示细节。数据补齐与现有组件复用见 [字段映射](../backend/DATA-FIELD-MAP.md)；后端整体见 [变更方案](../backend/BACKEND-CHANGE-PROPOSAL.md)。

- [本地素材查看页](assets/gallery.html)：可直接查看已经保存的图片、SVG与渲染样本。
- [素材索引（原始证据未公开）](../PRIVATE-EVIDENCE.md)：区分原始资源与截图样本，附来源与文件哈希。
- [Juicebox Contacts（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Juicebox Profile（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Metix Profile（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[我们当前Contacts（原始证据未公开）](../PRIVATE-EVIDENCE.md)。

## 资源覆盖与边界

浏览器资源工具已导出138份文件（包括界面SVG、品牌图、示例头像与公司图；含重复用途及非UI资源），查看页仅展示133份image资源和5份明确标记的渲染样本，共138条，不代表138个独立业务logo。Metix有51个资源未能导出，Juicebox有10个未能导出，失败原因完整保留在bundle.json。部分已缓存的DOM图片也没有出现在资源工具目录中。因此原始URL/原图文件/可见截图是三个分别核验的证据，不把采到URL称为已经拿到原图。

LinkedIn、Email、GitHub以及两枚组织logo额外保存了实际CSS像素截图样本，供比对形状与颜色，明确不是高分辨率原图。实际产品应复用自己的品牌静态资源与自己的候选人图片数据；竞品示例头像不固定绑定到我们的客户记录，也不复用竞品图片服务的授权参数。

## 必须复刻的组件行为

| 组件 | 展示与布局 | 互动与数据关联 |
|---|---|---|
| 候选人头像 | 列表姓名旁、Profile标题区、Inbox头部/消息发件人；各场景独立尺寸和容器裁切 | 头像与当前candidate key对应；是否打开详情以父控件契约为准；不能头像点A而资料是B |
| 公司logo | Contacts公司列、候选人卡当前公司、Profile逐段工作经历 | 使用该条工作经历的组织图；不把当前公司图复制给所有历史经历 |
| 学校logo | Contacts学校列、卡片教育摘要、Profile逐段教育 | 学校名、学位、日期与logo属于同一教育记录 |
| LinkedIn品牌图 | 独立小图标；与邮件/GitHub/个人站点并排；保持命中区域与可访问标签 | 以记录的LinkedIn URL打开新页，noopener/noreferrer；不是可点击就代表有邮箱 |
| 邮件/电话/GitHub/站点 | 按实际有值字段展示，菜单数量与项目一致；行内间距和more入口见截图 | 邮件/电话查看与发送是不同动作；不把打开Profile触发成外联 |
| 资料内容 | 姓名、headline、地点、当前职位、逐段经历和教育、链接、材料标记 | 原始资料、已有评分与人工选择分别展示；数据变化后列表/详情保持一致 |

## 当前实测尺寸（CSS px）

这些值来自本轮媒体专项采样；全页x/y见以下JSON，不应跨视口直接照搬固定坐标。图片本身borderRadius可能是0，圆形裁切通常在父容器，必须一起检查parentCss。

| 场景 | 实测媒体规格 |
|---|---|
| Juicebox Contacts社交图标 | LinkedIn/Email/GitHub 15×15；样本相邻x差25，即图形间净距10 |
| Juicebox Contacts公司/学校logo | 20×20，来自组织图片URL；与公司/学校文字并列 |
| Metix Inbox候选人卡头像 | 44×44；实例含默认头像与真实照片 |
| Metix Inbox候选人卡公司logo | 24×24，contain，图片圆角4 |
| Metix Inbox详情/消息头像 | 36×36 |
| Metix Profile头像 | 48×48；图片裁切由父容器约束 |
| Metix Profile经历logo | 48×48，contain，圆角8 |
| Metix Profile教育logo | 46×46，contain，圆角8.4 |
| 当前Headhunter全局Contacts | 本轮首屏DOM只有两张WeKruit品牌图片，联系人行没有头像/组织图；LinkedIn是文字链接 |

## DOM 图片、SVG与链接逐项表

完整记录保存在 [Juicebox Contacts（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Juicebox Profile（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Metix Profile（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[Headhunter Contacts（原始证据未公开）](../PRIVATE-EVIDENCE.md)。每项含来源、rect、natural尺寸、实际object-fit、图片与父容器样式，SVG保留markup，个人链接保留href及实际控件。隐藏模板、视口外和被遮挡元素必须结合截图识别，不能把所有DOM项当当前可见。

下表仅列有实际几何尺寸的媒体实例，重复图片仍保留各使用位置；不包含追踪像素。

| 页面 | alt / 文件 | x,y | w×h | object-fit | 图片圆角 | 父容器圆角 / overflow |
|---|---|---|---|---|---|---|
| juicebox-contacts | Juicebox | 24.00,20.00 | 21.34×24.00 | fill | 0px | 0px / visible |
| juicebox-contacts | ALV-UjW3xT4vTJ5Cp9KxlbfB8qekYyJUGKSyvrbQ2-i3kWWZzFk0XWV | 20.00,1027.00 | 16.00×16.00 | cover | 0px | 50% / hidden |
| juicebox-contacts | linkedin.png | 462.00,160.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,160.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,160.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | backops.ai | 1267.00,158.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | stevens.edu | 1507.00,158.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,205.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,205.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | akoya.com | 1267.00,203.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | northeastern.edu | 1507.00,203.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,250.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,250.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | oracle.com | 1267.00,248.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | northeastern.edu | 1507.00,248.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,295.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | stackoverflow.png | 537.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | dev_to.png | 562.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | zs.com | 1267.00,293.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | northeastern.edu | 1507.00,293.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,340.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,340.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | sunbit.com | 1267.00,338.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | calstatela.edu | 1507.00,338.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,385.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,385.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,385.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | linkedin.com | 1267.00,383.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | thapar.edu | 1507.00,383.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,430.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,430.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | multiscale.ai | 1267.00,428.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | stevens.edu | 1507.00,428.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,475.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,475.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,475.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | eightfold.ai | 1267.00,473.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | umass.edu | 1507.00,473.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,520.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,520.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | oracle.com | 1267.00,518.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | arizona.edu | 1507.00,518.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,565.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,565.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,565.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | twitter.webp | 537.00,565.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | ambra911.com | 1267.00,563.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | bu.edu | 1507.00,563.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,610.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,610.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | fortinet.com | 1267.00,608.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | usc.edu | 1507.00,608.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,655.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,655.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | sonatus.com | 1267.00,653.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | umich.edu | 1507.00,653.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,700.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,700.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | twitter.webp | 512.00,700.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | shipoway.com | 1267.00,698.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | tuni.fi | 1507.00,698.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,745.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,745.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | zscaler.com | 1267.00,743.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | asu.edu | 1507.00,743.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,790.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,790.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | tesla.com | 1267.00,788.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | cmu.edu | 1507.00,788.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,835.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,835.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | parakeethealth.com | 1267.00,833.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | ucsd.edu | 1507.00,833.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,880.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,880.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | banquethealth.com | 1267.00,878.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | illinois.edu | 1507.00,878.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,925.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,925.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | affirm.com | 1267.00,923.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | ucsd.edu | 1507.00,923.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,970.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,970.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 538.00,970.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | academia.edu | 1267.00,968.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | northseattle.edu | 1507.00,968.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1015.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1015.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | rippling.com | 1267.00,1013.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | pacific.edu | 1507.00,1013.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1060.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1060.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1060.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | mercury.com | 1267.00,1058.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | uwaterloo.ca | 1507.00,1058.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1105.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1105.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1105.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | snorkel.ai | 1267.00,1103.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | illinois.edu | 1507.00,1103.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1150.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1150.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | meta.com | 1267.00,1148.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | stonybrook.edu | 1507.00,1148.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1195.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1195.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | formally.com | 1267.00,1193.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | stanford.edu | 1507.00,1193.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1240.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1240.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1240.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | microsoft.com | 1267.00,1238.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | unimelb.edu.au | 1507.00,1238.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1285.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1285.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | cisco.com | 1267.00,1283.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | csueastbay.edu | 1507.00,1283.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1330.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1330.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | meta.com | 1267.00,1328.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | virginia.edu | 1507.00,1328.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1375.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1375.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1375.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | twitter.webp | 537.00,1375.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | orby.ai | 1267.00,1373.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | usc.edu | 1507.00,1373.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1420.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1420.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 538.00,1420.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | mercury.com | 1267.00,1418.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | gwu.edu | 1507.00,1418.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1465.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1465.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1465.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | uber.com | 1267.00,1463.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | northeastern.edu | 1507.00,1463.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1510.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1510.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 538.00,1510.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | tesla.com | 1267.00,1508.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | uwaterloo.ca | 1507.00,1508.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1555.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1555.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1555.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | higlobe.com | 1267.00,1553.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | brandeis.edu | 1507.00,1553.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1600.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1600.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 538.00,1600.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | informediq.com | 1267.00,1598.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | msu.edu | 1507.00,1598.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1645.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1645.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | sambanova.ai | 1267.00,1643.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | stanford.edu | 1507.00,1643.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | linkedin.png | 462.00,1690.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-contacts | email.png | 487.00,1690.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | githubblack.png | 512.00,1690.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-contacts | experianplc.com | 1267.00,1688.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-contacts | ufl.edu | 1507.00,1688.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | Juicebox | 24.00,20.00 | 21.34×24.00 | fill | 0px | 0px / visible |
| juicebox-profile | ALV-UjW3xT4vTJ5Cp9KxlbfB8qekYyJUGKSyvrbQ2-i3kWWZzFk0XWV | 20.00,1027.00 | 16.00×16.00 | cover | 0px | 50% / hidden |
| juicebox-profile | linkedin.png | 462.00,160.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,160.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,160.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | backops.ai | 1267.00,158.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | stevens.edu | 1507.00,158.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,205.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,205.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | akoya.com | 1267.00,203.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | northeastern.edu | 1507.00,203.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,250.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,250.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | oracle.com | 1267.00,248.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | northeastern.edu | 1507.00,248.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,295.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | stackoverflow.png | 537.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | dev_to.png | 562.00,295.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | zs.com | 1267.00,293.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | northeastern.edu | 1507.00,293.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,340.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,340.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | sunbit.com | 1267.00,338.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | calstatela.edu | 1507.00,338.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,385.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,385.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,385.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | linkedin.com | 1267.00,383.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | thapar.edu | 1507.00,383.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,430.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,430.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | multiscale.ai | 1267.00,428.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | stevens.edu | 1507.00,428.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,475.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,475.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,475.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | eightfold.ai | 1267.00,473.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | umass.edu | 1507.00,473.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,520.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,520.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | oracle.com | 1267.00,518.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | arizona.edu | 1507.00,518.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,565.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,565.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,565.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | twitter.webp | 537.00,565.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | ambra911.com | 1267.00,563.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | bu.edu | 1507.00,563.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,610.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,610.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | fortinet.com | 1267.00,608.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | usc.edu | 1507.00,608.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,655.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,655.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | sonatus.com | 1267.00,653.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | umich.edu | 1507.00,653.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,700.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,700.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | twitter.webp | 512.00,700.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | shipoway.com | 1267.00,698.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | tuni.fi | 1507.00,698.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,745.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,745.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | zscaler.com | 1267.00,743.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | asu.edu | 1507.00,743.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,790.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,790.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | tesla.com | 1267.00,788.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | cmu.edu | 1507.00,788.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,835.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,835.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | parakeethealth.com | 1267.00,833.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | ucsd.edu | 1507.00,833.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,880.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,880.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | banquethealth.com | 1267.00,878.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | illinois.edu | 1507.00,878.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,925.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,925.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | affirm.com | 1267.00,923.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | ucsd.edu | 1507.00,923.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,970.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,970.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 538.00,970.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | academia.edu | 1267.00,968.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | northseattle.edu | 1507.00,968.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1015.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1015.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | rippling.com | 1267.00,1013.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | pacific.edu | 1507.00,1013.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1060.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1060.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1060.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | mercury.com | 1267.00,1058.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | uwaterloo.ca | 1507.00,1058.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1105.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1105.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1105.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | snorkel.ai | 1267.00,1103.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | illinois.edu | 1507.00,1103.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1150.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1150.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | meta.com | 1267.00,1148.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | stonybrook.edu | 1507.00,1148.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1195.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1195.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | formally.com | 1267.00,1193.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | stanford.edu | 1507.00,1193.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1240.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1240.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1240.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | microsoft.com | 1267.00,1238.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | unimelb.edu.au | 1507.00,1238.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1285.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1285.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | cisco.com | 1267.00,1283.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | csueastbay.edu | 1507.00,1283.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1330.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1330.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | meta.com | 1267.00,1328.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | virginia.edu | 1507.00,1328.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1375.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1375.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1375.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | twitter.webp | 537.00,1375.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | orby.ai | 1267.00,1373.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | usc.edu | 1507.00,1373.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1420.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1420.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 538.00,1420.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | mercury.com | 1267.00,1418.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | gwu.edu | 1507.00,1418.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1465.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1465.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1465.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | uber.com | 1267.00,1463.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | northeastern.edu | 1507.00,1463.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1510.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1510.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 538.00,1510.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | tesla.com | 1267.00,1508.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | uwaterloo.ca | 1507.00,1508.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1555.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1555.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1555.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | higlobe.com | 1267.00,1553.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | brandeis.edu | 1507.00,1553.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1600.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1600.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 538.00,1600.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | informediq.com | 1267.00,1598.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | msu.edu | 1507.00,1598.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1645.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1645.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | sambanova.ai | 1267.00,1643.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | stanford.edu | 1507.00,1643.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 462.00,1690.50 | 15.00×15.00 | fill | 3px | 0px / visible |
| juicebox-profile | email.png | 487.00,1690.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | githubblack.png | 512.00,1690.50 | 15.00×15.00 | fill | 4px | 0px / visible |
| juicebox-profile | experianplc.com | 1267.00,1688.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | ufl.edu | 1507.00,1688.00 | 20.00×20.00 | contain | 20px | 0px / hidden |
| juicebox-profile | linkedin.png | 1955.00,80.00 | 18.00×18.00 | fill | 3px | 0px / visible |
| juicebox-profile | githubblack.png | 1983.00,80.00 | 18.00×18.00 | fill | 4px | 0px / visible |
| juicebox-profile | backops.ai | 1644.00,142.50 | 18.00×18.00 | cover | 4px | 0px / hidden |
| juicebox-profile | stevens.edu | 1756.81,142.50 | 18.00×18.00 | cover | 4px | 0px / hidden |
| juicebox-profile | backops ai logo | 1644.00,613.00 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | savign logo | 1644.00,864.59 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | intuit logo | 1644.00,1060.19 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | utility trailer manufacturing company logo | 1644.00,1286.78 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | stevens institute of technology logo | 1644.00,1508.38 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | infosys logo | 1644.00,1734.97 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | penna cement industries ltd logo | 1644.00,1956.56 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | bharat sanchar nigam limited logo | 1644.00,2152.16 | 38.00×38.00 | contain | 2px | 0px / visible |
| juicebox-profile | stevens.edu | 1644.00,2422.75 | 38.00×38.00 | contain | 4px | 0px / visible |
| juicebox-profile | vit.ac.in | 1644.00,2529.25 | 38.00×38.00 | contain | 4px | 0px / visible |
| juicebox-profile | GitHub | 1661.00,2725.75 | 15.00×15.00 | fill | 50% | 0px / visible |
| metix-profile | default.svg | 281.00,193.00 | 44.00×44.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | 示例对象20 | 281.00,274.50 | 24.00×24.00 | contain | 4px | 0px / visible |
| metix-profile | default.svg | 281.00,448.50 | 44.00×44.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | Workato | 281.00,530.00 | 24.00×24.00 | contain | 4px | 0px / visible |
| metix-profile | 2207349924054.jpg | 281.00,706.00 | 44.00×44.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | Amazon Web Services (AWS) | 281.00,787.50 | 24.00×24.00 | contain | 4px | 0px / visible |
| metix-profile | default.svg | 281.00,961.50 | 44.00×44.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | Capital One | 281.00,1043.00 | 24.00×24.00 | contain | 4px | 0px / visible |
| metix-profile | 4892375914130.jpg | 281.00,1217.00 | 44.00×44.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | TikTok | 281.00,1298.50 | 24.00×24.00 | contain | 4px | 0px / visible |
| metix-profile | default.svg | 281.00,1474.50 | 44.00×44.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | Amazon | 281.00,1556.00 | 24.00×24.00 | contain | 4px | 0px / visible |
| metix-profile | 示例对象1 | 764.00,13.50 | 36.00×36.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | 示例对象1 | 781.00,145.00 | 36.00×36.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | default.svg | 1978.00,84.00 | 48.00×48.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | 示例对象20 | 1366.00,775.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | Oracle | 1366.00,871.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象22 | 1366.00,1021.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象21 | 1366.00,1195.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象21 | 1366.00,1347.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象23 | 1366.00,1521.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | Best Buy | 1366.00,1673.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象23 | 1366.00,1847.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象23 | 1366.00,2021.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象21 | 1367.00,2257.00 | 46.00×46.00 | contain | 8.4px | 8.4px / visible |
| metix-profile | default.svg | -38136.00,-39968.00 | 48.00×48.00 | fill | 0px | 3.35544e+07px / hidden |
| metix-profile | 示例对象20 | -38634.00,-39284.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | Oracle | -38634.00,-39172.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象22 | -38634.00,-38962.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象21 | -38634.00,-38684.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象21 | -38634.00,-38516.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象23 | -38634.00,-38304.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | Best Buy | -38634.00,-38136.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象23 | -38634.00,-37902.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象23 | -38634.00,-37712.00 | 48.00×48.00 | contain | 8px | 8px / hidden |
| metix-profile | 示例对象21 | -38633.00,-37468.00 | 46.00×46.00 | contain | 8.4px | 8.4px / visible |
| headhunter-contacts | wekruit-logo.png | 19.00,25.50 | 23.00×34.00 | contain | 0px | 0px / visible |
| headhunter-contacts | wekruit-logo.png | 2005.00,955.00 | 32.00×32.00 | contain | 0px | 3.35544e+07px / visible |
