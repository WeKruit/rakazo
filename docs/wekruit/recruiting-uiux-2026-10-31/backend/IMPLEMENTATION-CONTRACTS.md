# 评审后实施合同

本文件落实#750评审，替代历史盘点中未定或冲突的口径。实现使用现有业务服务，不引入新的评分器、发送器、导航机制或Sequence持久化真相源。

## Sequence

现有原生draft campaign就是草稿，允许0个收件人。create/ensure_role_campaign/add_leads/pause均沿用原生非发送操作；步骤、窗口、stopOnReply仍只存campaign。UI读写指定campaign，不按名称猜对象，不新增RecruitingSequence表，不复制steps/delivery/publishedRevision。保存不发送；正式启动走现有原生执行器和确切内容/收件人确认。

## 评分

| 数据 | 显示/分组 | 排序 |
|---|---|---|
| 当前职位版本的Reviewer Strong | Strong Match | 当前版本同组score降序 |
| 当前职位版本的Reviewer Promising | Worth Talking | 当前版本同组score降序 |
| 当前版本Partial/Uncertain | 保留原义，不改称Not Match | 同版本对应组内排序 |
| 旧职位版本Reviewer结果 | 标为旧版本，单列 | 不与当前版本混排 |
| 非Reviewer旧来源结果 | 未经Reviewer评分 | 经matchScore100/SQL已有规范统一刻度后，仅在该组内排序 |
| 缺分 | 未评分 | 不当0分；同分以candidateKey稳定排序 |

标签只看tier，不另设80分/前N阈值。筛选、排序、计数先于分页并在同一授权范围内执行；默认展示不能只对当前页重排。来源、职位版本和人工Shortlist/候选人Interested独立保留。

## 未读

用户×space×来源邮件线程为阅读identity，不把roleId放入主键；同一线程出现在多职位读一次即可。只有新入站信触发未读，不因发件触发，不回写供应商unread。不以subject/姓名猜来源线程。

首次启用为该用户/space持久记录基线时间，基线之前的历史邮件默认已读。之后的新入站消息晚于lastReadAt才未读；标为未读可显式回退游标，直至下一次真实阅读。已读推进到实际看到的最新入站时间，保留并发新信。未知日期或来源identity不编造状态。

## 排期

- 现有Cal.com plan仍单时段；Google沿用create_event，不强塞入Cal.com plan。
- 多个可选时间进入提议邮件，不创建多个预约；候选人选择后只book一个时段。
- 来宾复用已有add_booking_attendee或Google attendees；确认卡列完整实际受邀者。
- Cal.com地点由event type决定；不提供无效的每次自由地点输入。Google location按原生能力传递。
- notes原样进入受支持的description/booking notes，并在确认卡完整显示。
- booking与confirmation分开回读；不把发邀请成功当预约成功。

## Analytics

| 指标 | 分子/数量 | 分母 | 时间口径 |
|---|---|---|---|
| Contacted | 有可证明首次外联的去重人 | 无 | 首次发送时间落入窗口 |
| Replied | Contacted cohort中有真实人工入站回复的人 | Contacted | 归属原发送cohort；不按回复日期截断 |
| Reply rate | Replied | Contacted | 同一cohort；0分母无百分比 |
| Interested | cohort中有明确兴趣证据的人 | Contacted | cohort当前已观察结果，不猜兴趣发生日期 |
| Shortlisted | shortlistedAt在窗口内的入选人 | 无 | shortlist日期cohort |
| Shortlist→Contacted | shortlist cohort中有明确外联的人 | Shortlisted cohort | 同一入选集合 |
| Opened/Clicked | 仅真实可归属事件/人员 | 对应已证明cohort | 次要展示；不能从累计stats拆日期 |

职位去重(role,person)，账户总计去重person。累计campaign.stats不能用作日期cohort；首次观测发送不等于首次发送，历史不完整时标为部分/未知，不伪造完整分母。导入历史外联纳入同一证据路径；无法覆盖时明确范围。来源若标注自动回复/OOO，排除人工回复指标；未知分类保留覆盖说明。

## 并行与迁移

Contacts同步/排序由既有线程完成；sidebar/shell归corner，Kruit卡片和深链沿用现有实现。新增阅读记录等必要持久化只加表/可空字段，不改名或删现有列；不新增双写兼容层。每个实现PR用隔离测试验证保存→投影→读取→展示，并检查320/1440与长文本。
