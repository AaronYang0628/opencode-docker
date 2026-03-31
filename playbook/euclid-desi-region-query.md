# Playbook: Euclid-DESI Region Query
## Meta
- version: 1.1
- mode: interactive
- on_error: stop
- dry_run: false
- ask_before_destructive: false
- default_timeout_sec: 120
- owner: astronomy-team
- last_updated: 2026-03-31
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
- type: input
- prompt: "请提供查询输入：\n- Euclid S3 路径 (例如: s3://bucket/path/to/catalog.fits)\n- 或直接坐标 (RA,DEC 例如: 57.6,-51.2)"
- placeholder: "s3://... 或 RA,DEC"
- required: true
- on_abort:
  - action: stop
  - guidance: "需要提供 S3 路径或 RA/DEC 坐标才能继续"
- report:
  - include:
      - input_source
      - s3_path
      - input_coordinates

### 2) Parse Euclid Catalog (S3 Path)
- type: mcp_call
- mcp:
  - server: euclid-catalog
  - tool: get_catalog_info_with_stats
  - input:
      catalog_path: "{{s3_path}}"
- timeout_sec: 60
- when:
  - input_source == "s3_path"
- expect:
  - success == true
- on_fail:
  - action: continue
  - guidance: "get_catalog_info_with_stats 不可用，尝试 fallback 到 parse_fits_header_only"
- report:
  - include:
      - num_objects
      - coordinate_ranges.ra_min
      - coordinate_ranges.ra_max
      - coordinate_ranges.dec_min
      - coordinate_ranges.dec_max

### 2-Fallback) Parse Euclid Catalog Fallback
- type: mcp_call
- mcp:
  - server: euclid-catalog
  - tool: parse_fits_header_only
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
    # If S3: use parsed footprint from Step 2
    # If direct RA/DEC: build radius window (default 10 arcsec)
    
    # 从 Step 1/2 获取的坐标区域
    RA_MIN="{{ra_min}}"
    RA_MAX="{{ra_max}}"
    DEC_MIN="{{dec_min}}"
    DEC_MAX="{{dec_max}}"
    
    # 计算中心点
    CENTER_RA=$(python3 -c "print(($RA_MIN + $RA_MAX) / 2)")
    CENTER_DEC=$(python3 -c "print(($DEC_MIN + $DEC_MAX) / 2)")
    
    echo "=== 查询窗口参数 ==="
    echo "输入坐标区域:"
    echo "  RA_MIN: $RA_MIN"
    echo "  RA_MAX: $RA_MAX"
    echo "  DEC_MIN: $DEC_MIN"
    echo "  DEC_MAX: $DEC_MAX"
    echo ""
    echo "查询中心点:"
    echo "  CENTER_RA: $CENTER_RA"
    echo "  CENTER_DEC: $CENTER_DEC"
    echo ""
    echo "DESI 查询区域:"
    echo "  RA_MIN: $RA_MIN"
    echo "  RA_MAX: $RA_MAX"
    echo "  DEC_MIN: $DEC_MIN"
    echo "  DEC_MAX: $DEC_MAX"
    echo "=================="
- expect:
  - exit_code == 0
- report:
  - include:
      - RA_MIN
      - RA_MAX
      - DEC_MIN
      - DEC_MAX
      - CENTER_RA
      - CENTER_DEC

### 4) Query DESI DR10
- type: mcp_call
- mcp:
  - server: astro_k3s
  - tool: es_query
  - input:
      catalog: desi-dr10-tractor
      mode: count
      body:
        query:
          bool:
            filter:
              - range:
                  ra:
                    gte: "{{ra_min}}"
                    lte: "{{ra_max}}"
              - range:
                  dec:
                    gte: "{{dec_min}}"
                    lte: "{{dec_max}}"
              - term:
                  brick_primary: true
- timeout_sec: 30
- expect:
  - success == true
- report:
  - include:
      - catalog
      - mode
      - query_ra_min
      - query_ra_max
      - query_dec_min
      - query_dec_max
      - desi_hits

### 4-Print) Print Query Details
- type: command
- run: |
    # 打印查询接口详细信息
    CATALOG="desi-dr10-tractor"
    MODE="count"
    RA_MIN="{{ra_min}}"
    RA_MAX="{{ra_max}}"
    DEC_MIN="{{dec_min}}"
    DEC_MAX="{{dec_max}}"
    
    echo "========================================"
    echo "       DESI DR10 查询接口详情"
    echo "========================================"
    echo ""
    echo "【API 信息】"
    echo "  服务: astro_k3s"
    echo "  接口: es_query"
    echo "  Catalog: $CATALOG"
    echo "  Mode: $MODE"
    echo ""
    echo "【请求参数】"
    echo "  query.bool.filter:"
    echo "    - range.ra: gte=$RA_MIN, lte=$RA_MAX"
    echo "    - range.dec: gte=$DEC_MIN, lte=$DEC_MAX"
    echo "    - term.brick_primary: true"
    echo ""
    echo "【查询 JSON】"
    cat << 'QUERY_EOF'
    {
      "query": {
        "bool": {
          "filter": [
            {"range": {"ra": {"gte": ${RA_MIN}, "lte": ${RA_MAX}}}},
            {"range": {"dec": {"gte": ${DEC_MIN}, "lte": ${DEC_MAX}}}},
            {"term": {"brick_primary": true}}
          ]
        }
      }
    }
    QUERY_EOF
    echo "========================================"
- expect:
  - exit_code == 0

### 5) Generate Final Report
- type: command
- run: |
    # 生成详细的中文报告
    
    # 输入信息 (从变量获取)
    INPUT_SOURCE="{{input_source}}"
    S3_PATH="{{s3_path}}"
    EUCLID_OBJECTS="{{euclid_objects}}"
    
    # 查询参数 (从变量获取)
    RA_MIN="{{ra_min}}"
    RA_MAX="{{ra_max}}"
    DEC_MIN="{{dec_min}}"
    DEC_MAX="{{dec_max}}"
    
    # 查询结果 (从变量获取)
    DESI_HITS="{{desi_hits}}"
    
    echo "========================================"
    echo "       Euclid-DESI 区域查询报告"
    echo "========================================"
    echo ""
    echo "【Part 1: 输入解析】"
    echo "  输入类型: $INPUT_SOURCE"
    if [ "$INPUT_SOURCE" = "s3_path" ]; then
      echo "  S3 路径: $S3_PATH"
      echo "  Euclid 对象数: $EUCLID_OBJECTS"
    else
      echo "  输入坐标: $RA_MIN, $DEC_MIN"
    fi
    echo ""
    echo "【Part 2: 查询条件】"
    echo "  目标星表: DESI DR10 Tractor"
    echo "  RA 范围: $RA_MIN ~ $RA_MAX"
    echo "  DEC 范围: $DEC_MIN ~ $DEC_MAX"
    echo "  过滤条件: brick_primary=true"
    echo ""
    echo "【Part 3: 查询结果】"
    echo "  匹配对象数: $DESI_HITS"
    if [ "$DESI_HITS" = "0" ] || [ -z "$DESI_HITS" ]; then
      echo "  状态: 该区域暂无 DESI 数据覆盖"
      echo "  建议: DESI 巡天正在进行中，后续会增加覆盖"
    else
      echo "  状态: 查询成功"
    fi
    echo ""
    echo "========================================"
    echo "         报告生成完成"
    echo "========================================"
    
    # 输出 JSON 格式结果 (供下游使用)
    echo ""
    echo "RESULT_JSON: {\"euclid_objects\": $EUCLID_OBJECTS, \"desi_hits\": $DESI_HITS, \"ra_min\": $RA_MIN, \"ra_max\": $RA_MAX, \"dec_min\": $DEC_MIN, \"dec_max\": $DEC_MAX}"
- expect:
  - exit_code == 0
- report:
  - include:
      - input_source
      - s3_path
      - euclid_objects
      - query_ra_min
      - query_ra_max
      - query_dec_min
      - query_dec_max
      - desi_hits
      - status
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
  2. 准备测试用 S3 路径或 RA/DEC 坐标$ 