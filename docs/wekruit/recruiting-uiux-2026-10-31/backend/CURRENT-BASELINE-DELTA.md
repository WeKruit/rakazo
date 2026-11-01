# 当前 stage 对历史审计基线的增量

最初后端盘点基于已获取的主线 `55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d`。创建PR前已重新fetch，PR基于stage `b7648f0de`；主线为`dbb62ff7a`。旧快照章节保留为历史证据，实施判断须结合本增量，不能以旧缺口重复建设。

## 已确认的新能力

- `RecruitingGradeRowSchema`已有`match_score`（0–100整数）、`match_tier`（Strong、Promising、Partial、Uncertain）、fit_reasons、concerns、requirements_assessment；`save_grades`将Reviewer结果保存在当前职位。搜索与Reviewer负责评分，展示层复用，不另建JEV/LLM重评链。
- 旧来源的`match.rank/score/tier`仍需保持来源/结果可比性。Reviewer分数展示必须带当前职位版本与评分来源；不能把历史供应商分值和当前Reviewer分值混为同一排名。
- **建议评审的映射**：Strong→Strong Match，Promising→Worth Talking。Partial/Uncertain保持原含义，不能自动映射为Not Match。用户已认可“复用高分做优先联系分组”的方向，具体分界和最终标签映射尚待确认；本PR没有把建议当作既定规则。
- `RecruitingContactTag`已经存在。标签必须接现有owner/space/contact身份，不新增同用途表。
- 全局Contacts已有`AllContacts.tsx`，相关工作正在并行；Profile已有`PersonAvatar`、`CompanyLogo`和媒体提取。媒体缺口先核对该页面实际接线、读取投影及已有数据，不另建组件/组织logo服务。
- Profile保存已采用有界分页查找工具结果。按职位复用既有保存资料的能力仍在；旧的全库启动扫描函数已移除。不得依据历史文档恢复启动时全量回填或为本次设计增加隐式全库工作。
- stage还包含通知、面板、历史定位等并行工作。本PR仅文档，不改这些现有行为或覆盖其实现。

## 仍属提案、需要明确验证

Sequence零收件人可编辑草稿、应用用户阅读状态、多时段/额外来宾/地点notes的排期合同、完整Analytics时间桶与来源事件，仍须逐个业务服务核对，才决定具体schema/API改动。

代码存在、已部署、真实数据库版本与当前账号可用是不同证据。本次fetch与代码比较不构成生产库迁移或真实发送/预约验收。
