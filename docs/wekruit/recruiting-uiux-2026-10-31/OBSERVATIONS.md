> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

> **组件级设计增补（本轮实测）**：尺寸、页面高度、响应式、组件状态与互动以 [设计交付入口](design-details/README.md)、[逐页标注](design-details/inspector.html) 为准。新增 99 个配对截图/DOM 状态。Metix Maybe later 可进入 Tailor 表单，Continue to emails 可进入三步邮件编辑器；旧记录中的“未进入编辑器/手机未测”仅表示当时的覆盖范围。本轮已创建一个 UI inspection 未发布草稿，0收件人，未发送。

# 观察记录与证据说明

## 采集方式

两个目标为用户已打开并登录的 Chrome 标签：app.juicebox.ai 与 metix.ai。页面交互和截图使用 cua_repl；浏览器 DOM 的只读计算样式读取用于记录字体、尺寸和间距。没有复用浏览器 cookie 进行外部 HTTP/API 请求。

manifest.json 按采集顺序保存页面地址、截图和完整可访问性树。文件名用于定位，不构成对内容的最终判定。部分文件为加载中、菜单打开中或动画过渡态；满态以 loaded/final 文件以及正文关联证据为准。截图是视口截图，完整文字结构在对应 txt 内，不应假定一张视口截图展示了整页所有内容。

## 对误名捕获的更正

`metix-worth-talking-profile.txt` 与 `metix-worth-talking-criteria-expanded.txt` 实际仍展示 示例对象2；此前点名字文本没有完成线程切换。这两份文件可用于其资料/Resume/Schedule 结构，不可用来证明 Worth Talking 的条件分布。随后按候选人条目选择、核实当前线程，再取 示例候选人 资料；正确证据为 `metix-示例候选人-thread-selected.txt`、`metix-示例候选人-profile.txt`、`metix-示例候选人-worth-talking-criteria.txt`。

## 可见副作用

- Metix 打开邮件改变未读/新回复显示；初始侧栏截图为4，后续为3、2。未发任何回复。
- Juicebox 的资料 Activity 中出现 Viewed by 示例对象16 的浏览记录。未提交 Notes、标签、评审或招聘状态。
- Juicebox 已有 Sequence 的 Done 退出按钮显示 Sequence saved；未更改标题、正文、步骤、延迟或发送账号。
- 打开 Juicebox Talent Insights 后显示 AI takeaways，属于该页自动加载行为；未点击 Smart report、付费解锁或数据导出。
- Metix 排期在表单中选取了临时时间，查看两步流程和 Multiple/Advanced 后，通过 Exit 放弃；未点击 Send invitation。

## 权限和样本限制

Juicebox Usage / Projects / Agents Analytics 受 Business plan 限制；Outreach Analytics 可访问且有真实结果。Metix 全局 Shortlist 和可复用 Sequences 当前为空；New sequence 的邮箱前置可观察，未连接新邮箱。没有新建对象来制造非空竞品样本，也未改变真实候选人的业务状态来测持久化。

REA 静态输入保留原始保存日期，详见 rea/REPORT.md。该分析和实时页面分别存档，不能通过静态字符串声称某端点本次实际调用或功能已成功执行。
