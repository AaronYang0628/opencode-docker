# Playbook: Human-In-Loop-Result-Demo
## Meta
- version: 1.0
- mode: interactive
- on_error: stop
- dry_run: true
- ask_before_destructive: true
- default_timeout_sec: 120
- owner: opencode-team
- last_updated: 2026-03-25
## Context
- objective: 演示“人在回路”：先询问用户、接收简单指令、再继续输出结果
- scope: 仅输出文本结果，不修改代码
- out_of_scope: 不执行删除/覆盖/生产变更
- human_gate_protocol: 遇到 manual_gate 时，先提问，再输出 WAITING_FOR_USER_INPUT，然后结束本轮回复等待用户下一条消息
- prerequisites:
  - 当前会话可与用户交互
  - 可执行基础命令
## Variables
- env: dev
- service: opencode
- branch: main
- ticket: DEMO-HIL-001
- extra:
  output_lang: zh-CN
  output_style: concise
---
## Steps
### 1) 询问用户目标
- type: manual_gate
- prompt: "请用户用一句话给出目标结果；收到后再继续。"
- options:
  - continue
  - abort
- default: continue
- on_abort:
  - action: stop
  - guidance: 用户终止，结束流程。
### 2) 接收简单指令
- type: manual_gate
- prompt: "请用户给一个简单指令：continue | shorter | add_examples | abort"
- options:
  - continue
  - shorter
  - add_examples
  - abort
- default: continue
- on_abort:
  - action: stop
  - guidance: 用户终止，结束流程。
### 3) 打印执行状态
- type: command
- run: printf "已接收用户目标和指令，开始生成结果。\n"
- workdir: /home/opencode/workspace
- expect:
  - exit_code == 0
- on_fail:
  - action: stop
  - guidance: 检查 shell 环境是否可用。
- report:
  - include:
    - stdout
### 4) 输出最终结果
- type: manual_gate
- prompt: "根据用户目标 + 简单指令输出最终结果；输出后等待用户确认是否继续下一轮。"
- options:
  - continue
  - abort
- default: continue
- on_abort:
  - action: stop
  - guidance: 用户终止，结束流程。
---
## Final Report Format
- playbook: Human-In-Loop-Result-Demo
- run_id: <AUTO_OR_MANUAL_ID>
- env: <env>
- service: <service>
- overall_status: ready | not_ready
- step_results:
  - "询问用户目标": pass | fail | skip
  - "接收简单指令": pass | fail | skip
  - "打印执行状态": pass | fail | skip
  - "输出最终结果": pass | fail | skip
- risks_found:
  - none
- next_actions:
  1. 如用户确认继续，进入下一轮目标收集。
  2. 如用户提出修改，回到步骤 2 重新执行。
