# SAP B1 MCP Connector — Claude Desktop Setup (this laptop)

## Current state

Claude Desktop is installed as a **Windows Store (MSIX) app** on this machine, so its
config file lives at a sandboxed path, not the usual `%APPDATA%\Claude`:

```
C:\Users\STTL\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

A connector named **`sap-b1-wms-dev-uk`** is registered there, pointing at:

```
node d:/akhshat/MCP/dist/server.js
```

with SAP Service Layer credentials (`SL_BASE_URL`, `SL_COMPANY`, `SL_USER`, `SL_PASSWORD`)
for the **WMS Dev UK** company at `silverdemo.silvertouch.com`, pulled from this
project's `.env`.

Verified working: a fresh Claude Desktop chat can call the connector's tools and
return live SAP data.

## Reinstalling / refreshing the connector

Run this any time — after pulling code changes, after a Claude Desktop
update/reinstall, or if the connector disappears from Claude Desktop:

```powershell
cd d:\akhshat\MCP
powershell -ExecutionPolicy Bypass -File .\install-desktop-mcp.ps1
```

It will:
1. Rebuild `dist/server.js` (`npm run build`)
2. Re-read credentials from `.env` (so if you rotate the SAP password, just
   update `.env` and re-run this script — no manual JSON editing)
3. Back up the existing `claude_desktop_config.json` next to itself
   (`*.bak-<timestamp>`)
4. Write/refresh the `sap-b1-wms-dev-uk` entry under `mcpServers`, leaving all
   other Claude Desktop preferences untouched
5. Remind you to fully quit (system tray, not just close the window) and
   reopen Claude Desktop

## Verifying it's connected

In a new Claude Desktop chat, check the tools/connector icon near the message
box, or ask:

```
Use the SAP B1 MCP tool to get the customer/business partner list (first 5 records) from WMS Dev UK.
```

If it returns real BP data, the connector is live.

## Notes

- The MCP server process only talks to **one SAP company per connector
  instance** — the company is fixed by the `SL_COMPANY`/`SL_BASE_URL` env vars
  at launch. To also expose `ME0925_SADP` (the other company in `.env`) as a
  separate connector, a second `mcpServers` entry with its own name and
  `COMPANY_1_*` credentials would be needed — not set up yet, ask if you want it.
- Credentials are stored in plaintext inside `claude_desktop_config.json`
  (this is how Claude Desktop's MCP config works — same as any local MCP
  client). Treat that file with the same care as `.env`.
