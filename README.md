```bash
npx @modelcontextprotocol/inspector http://localhost:8787/sse
```

```json
{
  "mcpServers": {
    "calculator": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8787/sse" // or remote-mcp-server-authless.your-account.workers.dev/sse
      ]
    }
  }
}
```
