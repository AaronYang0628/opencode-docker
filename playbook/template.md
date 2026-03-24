# Playbook: <PLAYBOOK_NAME>
## Meta
- version: 1.0
- mode: interactive
- on_error: stop                 # stop | continue
- dry_run: <true_or_false>       # true=演练，不做高风险实际写操作
- ask_before_destructive: true   # 删除/覆盖/生产变更前先确认
- default_timeout_sec: <TIMEOUT_SEC>
- owner: <TEAM_OR_PERSON>
- last_updated: <YYYY-MM-DD>
## Context
- objective: <THIS_PLAYBOOK_GOAL>
- scope: <IN_SCOPE_SYSTEMS_OR_DIRS>
- out_of_scope: <WHAT_NOT_TO_TOUCH>
- prerequisites:
  - <PREREQ_1>
  - <PREREQ_2>
## Variables
- env: <dev_or_staging_or_prod>
- service: <SERVICE_NAME>
- branch: <BRANCH_NAME>
- ticket: <TICKET_ID>
- extra:
  <KEY_1>: <VALUE_1>
  <KEY_2>: <VALUE_2>
---
## Steps
### 1) <STEP_1_TITLE>
- type: command
- run: <SHELL_COMMAND>
- workdir: <ABS_OR_REPO_RELATIVE_PATH>
- timeout_sec: <OPTIONAL_TIMEOUT>
- when:
  - <OPTIONAL_CONDITION_1>
- expect:
  - exit_code == 0
  - <OPTIONAL_ASSERTION_1>
- on_fail:
  - action: stop
  - guidance: <HOW_TO_FIX_IF_FAIL>
- report:
  - include:
    - <KEY_OUTPUT_1>
    - <KEY_OUTPUT_2>
### 2) <STEP_2_TITLE>
- type: mcp_call
- mcp:
  - server: <MCP_SERVER_NAME>
  - tool: <MCP_TOOL_NAME>
  - input:
      <INPUT_KEY_1>: <INPUT_VALUE_1>
      <INPUT_KEY_2>: <INPUT_VALUE_2>
- timeout_sec: <OPTIONAL_TIMEOUT>
- when:
  - <OPTIONAL_CONDITION_1>
- expect:
  - success == true
  - <OPTIONAL_ASSERTION_ON_RESULT>
- on_fail:
  - action: stop
  - guidance: <HOW_TO_FIX_IF_FAIL>
- report:
  - include:
    - <RESULT_FIELD_1>
    - <RESULT_FIELD_2>
  - redact:
    - <SENSITIVE_FIELD_1>
    - <SENSITIVE_FIELD_2>
### 3) <STEP_3_TITLE>
- type: manual_gate
- prompt: <QUESTION_FOR_HUMAN_CONFIRMATION>
- options:
  - continue
  - abort
- default: <continue_or_abort>
- on_abort:
  - action: stop
  - guidance: <WHAT_HAPPENS_IF_ABORTED>
### 4) <STEP_4_TITLE>
- type: command
- run: <SHELL_COMMAND>
- workdir: <PATH>
- expect:
  - exit_code == 0
- on_fail:
  - action: stop
  - guidance: <HOW_TO_FIX_IF_FAIL>
- report:
  - include:
    - <KEY_OUTPUT_1>
---
## Final Report Format
- playbook: <PLAYBOOK_NAME>
- run_id: <AUTO_OR_MANUAL_ID>
- env: <env>
- service: <service>
- overall_status: ready | not_ready
- step_results:
  - "<STEP_1_TITLE>": pass | fail | skip
  - "<STEP_2_TITLE>": pass | fail | skip
  - "<STEP_3_TITLE>": pass | fail | skip
  - "<STEP_4_TITLE>": pass | fail | skip
- risks_found:
  - <RISK_1_OR_NONE>
- next_actions:
  1. <ACTION_1>
  2. <ACTION_2>
## Rollback (Optional but recommended)
- trigger_condition:
  - <WHEN_TO_ROLLBACK>
- rollback_steps:
  1. <ROLLBACK_COMMAND_OR_MCP_CALL_1>
  2. <ROLLBACK_COMMAND_OR_MCP_CALL_2>
- verify_after_rollback:
  - <VERIFICATION_COMMAND_1>
你需要填的占位符（最关键）
- <PLAYBOOK_NAME>：流程名（如 Release-Precheck）
- <THIS_PLAYBOOK_GOAL>：这次流程目标
- <SHELL_COMMAND>：每步具体命令
- MCP 相关：
  - <MCP_SERVER_NAME>：MCP 服务名
  - <MCP_TOOL_NAME>：该服务下要调用的工具名
  - input 里的 <INPUT_KEY_*>：调用参数
- <OPTIONAL_ASSERTION_ON_RESULT>：结果断言（比如返回字段必须为 true）
- <QUESTION_FOR_HUMAN_CONFIRMATION>：人工确认点问题
- <HOW_TO_FIX_IF_FAIL>：失败时修复建议
- report.include：要打印的关键字段（避免整包日志）