读取 `playbook/<your-playbook-name>.md`，严格按 Steps 执行；每步输出“步骤名/执行内容/结果/结论”；失败立即停止；最后按 Final Report Format 汇总。

示例：`playbook/human-in-loop-result-demo.md`

多人回路提示：`manual_gate` 建议在提问后输出 `WAITING_FOR_USER_INPUT` 并结束本轮回复，等待用户下一条消息继续。
