# Security scan

| Field | Value |
| --- | --- |
| Tool | [Cisco AI Defense MCP Scanner](https://github.com/cisco-ai-defense/mcp-scanner) 4.8.7 (Apache-2.0) |
| Analyzer | YARA rules (local, no data sent anywhere) |
| Target | Tintloom plugin 0.8.21, local stdio server (`plugins/tintloom/server/tintloom-mcp.mjs`) |
| Date | 2026-11-18 |
| Result | 12 tools scanned, 12 safe, 0 findings (no prompt-injection, tool-poisoning or hidden-instruction patterns) |

The hosted connector (https://mcp.tintloom.com/mcp) serves the same tool definitions. The scanner's read-only protocol check against it also reported no findings. The hosted tool list itself needs sign-in, so the local server was used for the tool-by-tool scan.

This is an automated pattern scan of tool descriptions and the protocol surface. It is not an audit and not a guarantee. Run it yourself:

```bash
uv tool install --python 3.13 cisco-ai-mcp-scanner
mcp-scanner --analyzers yara stdio --stdio-command node --stdio-arg plugins/tintloom/server/tintloom-mcp.mjs
```
