## OpenCode Bridge

Bridge exposes OpenCode through compatibility endpoints:

- `POST /chat` - non-stream JSON
- `POST /chat/stream` - SSE stream
- `POST /chat/n8n` - n8n tool-friendly JSON
- `GET /chat/n8n/stream` - n8n SSE (query params)
- `POST /v1/chat/completions` - OpenAI-compatible (supports `stream: true`)
- `GET /v1/models` - OpenAI-compatible model list

### Local smoke test

```bash
curl -N http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-test" \
  -d '{
    "model": "openai/gpt-5.3-codex-spark",
    "stream": true,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

### Build and push

```shell
podman build -t crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/opencode-bridge:v20260324 .
```

```shell
podman push crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/opencode-bridge:v20260324
```
