# Playbook: Euclid-DESI Region Query
## Meta
- version: 1.0
- mode: interactive
- on_error: stop
- dry_run: false
- ask_before_destructive: false
- default_timeout_sec: 120
- owner: astronomy-team
- last_updated: 2026-03-30
## Context
- objective: Parse Euclid catalog input and query DESI DR10 sky region to return astronomical object counts
- scope: S3 Euclid catalogs or direct RA/DEC coordinates
- out_of_scope: Large header dumps, full catalog object lists
- prerequisites:
  - MCP server available with astro_k3s tools
  - Valid Euclid S3 path or RA/DEC coordinates from user
## Variables
- env: production
- service: euclid-desi-query
- branch: main
- ticket: ""
- extra:
  catalog_name: desi-dr10-tractor
  default_radius_arcsec: 10
  max_euclid_calls: 1
  max_desi_calls: 1
---
## Steps
### 1) Parse Input - Extract Source
- type: manual_gate
- prompt: "请提供查询输入：\n1. Euclid S3 路径 (s3://...)，或\n2. 直接坐标 (RA/DEC)"
- options:
  - s3_path
  - direct_coordinates
  - abort
- default: s3_path
- on_abort:
  - action: stop
  - guidance: "需要提供 S3 路径或 RA/DEC 坐标才能继续"

### 2) Parse Euclid Catalog (S3 Path)
- type: mcp_call
- mcp:
  - server: astro_k3s
  - tool: get_catalog_info_with_stats
  - input:
      catalog_path: "{{s3_path}}"
      tool: get_catalog_info_with_stats
- timeout_sec: 60
- when:
  - input_source == "s3_path"
- expect:
  - success == true
- on_fail:
  - action: continue
  - guidance: "get_catalog_info_with_stats 不可用，尝试 fallback 到 parse_fits_catalog"
- report:
  - include:
      - num_objects
      - ra_min
      - ra_max
      - dec_min
      - dec_max

### 2-Fallback) Parse Euclid Catalog Fallback
- type: mcp_call
- mcp:
  - server: astro_k3s
  - tool: parse_fits_catalog
  - input:
      catalog_path: "{{s3_path}}"
- timeout_sec: 60
- when:
  - previous_step_failed == true
- expect:
  - success == true
- on_fail:
  - action: stop
  - guidance: "无法解析 Euclid catalog，请检查 S3 路径是否有效"
- report:
  - include:
      - num_objects
      - coordinate_ranges.ra_min
      - coordinate_ranges.ra_max
      - coordinate_ranges.dec_min
      - coordinate_ranges.dec_max

### 3) Build Query Window
- type: command
- run: |
    # Calculate center and range for DESI query
    # If S3: use parsed footprint
    # If direct RA/DEC: build radius window (default 10 arcsec)
    echo "RA_MIN: $RA_MIN"
    echo "RA_MAX: $RA_MAX"  
    echo "DEC_MIN: $DEC_MIN"
    echo "DEC_MAX: $DEC_MAX"
    echo "CENTER_RA: $CENTER_RA"
    echo "CENTER_DEC: $CENTER_DEC"
- expect:
  - exit_code == 0
- report:
  - include:
      - RA_MIN
      - RA_MAX
      - DEC_MIN
      - DEC_MAX

### 4) Query DESI DR10
- type: mcp_call
- mcp:
  - server: astro_k3s
  - tool: astro_k3s_mcp_es_query
  - input:
      catalog: desi-dr10-tractor
      mode: search
      filters:
        ra:
          gte: "{{ra_min}}"
          lte: "{{ra_max}}"
        dec:
          gte: "{{dec_min}}"
          lte: "{{dec_max}}"
        brick_primary: true
- timeout_sec: 90
- expect:
  - success == true
- on_fail:
  - action: stop
  - guidance: "DESI 查询失败，请检查查询参数"
- report:
  - include:
      - search.result.hits.total.value
      - search.result.hits.total.relation
      - search.result.hits.hits.length

### 5) Generate Final Report
- type: command
- run: |
    # Output Chinese report with 3 parts
    # Part 1: 输入解析
    # Part 2: 查询条件  
    # Part 3: 查询结果
    # Plus RESULT_JSON line
    echo "=== 报告生成完成 ==="
- expect:
  - exit_code == 0
- report:
  - include:
      - total_objects
      - preview_count
      - warning
---
## Final Report Format
- playbook: Euclid-DESI Region Query
- run_id: auto
- env: production
- service: euclid-desi-query
- overall_status: ready | not_ready
- step_results:
  - "Parse Input": pass | fail | skip
  - "Parse Euclid Catalog": pass | fail | skip
  - "Build Query Window": pass | fail | skip
  - "Query DESI DR10": pass | fail | skip
  - "Generate Final Report": pass | fail | skip
- risks_found: none
- next_actions:
  1. 演示时确保 MCP 服务正常运行
  2. 准备测试用 S3 路径或 RA/DEC 坐标